import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultGitInspectionLimits, inspectGitWorkspace } from "../src"
import {
  buildSandboxInvocation,
  copyOpenedExecutable,
  inspectGitWorkspaceWithDependencies,
  observeGit,
  prepareTrustedBinaries,
  type GitInspectorDependencies,
  validatePreparedGit,
} from "../src/inspect"

const roots: Array<string> = []
const realGit = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("bounded read-only Git inspection", () => {
  test("keeps the large-workspace boundary bounded with production defaults", () => {
    expect(defaultGitInspectionLimits).toMatchObject({
      maxBoundaryEntries: 250_000,
      maxBoundaryDurationMs: 15_000,
    })
  })

  test("passes the exact Git path as a sandbox parameter without profile interpolation", () => {
    const hostilePath = '/trusted/git") (allow network*) (allow file-write*)'
    const invocation = buildSandboxInvocation({
      gitPath: hostilePath,
      sandboxPath: "/usr/bin/sandbox-exec",
      workspaceRoot: "/workspace",
      command: "status",
      limits: {
        timeoutMs: 1,
        maxStdoutBytes: 1,
        maxStderrBytes: 1,
        maxEntries: 1,
        maxBoundaryEntries: 1,
        maxBoundaryDurationMs: 1,
        maxGitBinaryBytes: 1,
      },
    })

    expect(invocation.arguments[2]).toBe(`GIT_PATH=${hostilePath}`)
    expect(invocation.arguments[4]).toBe("WORKSPACE_ROOT=/workspace")
    expect(invocation.arguments[6]).toContain('(param "GIT_PATH")')
    expect(invocation.arguments[6]).toContain('(param "WORKSPACE_ROOT")')
    expect(invocation.arguments[6]).toContain("(deny file-read*)")
    expect(invocation.arguments[6]).not.toContain(hostilePath)
    expect(invocation.arguments[7]).toBe(hostilePath)
    expect(invocation.environment.GIT_ATTR_NOSYSTEM).toBe("1")

    const indexInvocation = buildSandboxInvocation({
      gitPath: hostilePath,
      sandboxPath: "/usr/bin/sandbox-exec",
      workspaceRoot: "/workspace",
      command: "index-assume-unchanged",
      limits: {
        timeoutMs: 1,
        maxStdoutBytes: 1,
        maxStderrBytes: 1,
        maxEntries: 1,
        maxBoundaryEntries: 1,
        maxBoundaryDurationMs: 1,
        maxGitBinaryBytes: 1,
      },
    })
    expect(indexInvocation.arguments).toContain("--full-name")
    expect(indexInvocation.arguments.slice(-2)).toEqual(["--", ":(top)"])
  })

  test("clamps each Git process to the remaining overall deadline", async () => {
    const observedTimeouts: Array<number> = []
    const binaries = {
      gitPath: "/trusted/git",
      sandboxPath: "/usr/bin/sandbox-exec",
      gitIdentity: {
        device: "1",
        inode: "2",
        size: 1,
        digest: `sha256:${"a".repeat(64)}` as const,
        directoryDevice: "1",
        directoryInode: "3",
      },
      async cleanup() {
        return true
      },
    }
    const fake: GitInspectorDependencies = {
      platform: "darwin",
      async prepareTrustedBinaries() {
        return binaries
      },
      async validatePreparedGit() {
        return true
      },
      async runSandboxedGit(input) {
        observedTimeouts.push(input.limits.timeoutMs)
        await Bun.sleep(20)
        return { ok: true, stdout: new Uint8Array() }
      },
    }

    const result = await observeGit(fake, binaries, "/workspace", defaultGitInspectionLimits, performance.now() + 10)

    expect(result).toMatchObject({ ok: false, reason: "git_process_timeout" })
    expect(observedTimeouts).toHaveLength(1)
    expect(observedTimeouts[0]).toBeLessThanOrEqual(10)
  })

  test("seals the real Git executable outside the workspace and removes it", async () => {
    const root = await repository()
    const prepared = await prepareTrustedBinaries(root, defaultGitInspectionLimits)
    expect(prepared).not.toBeNull()
    if (!prepared) throw new Error("The ephemeral Git executable was not prepared")

    const fileFacts = await lstat(prepared.gitPath)
    const directoryFacts = await lstat(join(prepared.gitPath, ".."))
    expect(fileFacts.mode & 0o777).toBe(0o500)
    expect(directoryFacts.mode & 0o777).toBe(0o500)
    expect(prepared.gitPath.startsWith(root)).toBeFalse()
    expect(await validatePreparedGit(prepared, defaultGitInspectionLimits)).toBeTrue()

    await chmod(join(prepared.gitPath, ".."), 0o700)
    await chmod(prepared.gitPath, 0o700)
    await writeFile(prepared.gitPath, "tampered")
    await chmod(prepared.gitPath, 0o500)
    await chmod(join(prepared.gitPath, ".."), 0o500)
    expect(await validatePreparedGit(prepared, defaultGitInspectionLimits)).toBeFalse()

    expect(await prepared.cleanup()).toBeTrue()
    expect(await exists(prepared.gitPath)).toBeFalse()
  })

  test("rejects a Git source that exceeds the bounded copy size", async () => {
    const root = await repository()

    expect(await inspectGitWorkspace(root, { maxGitBinaryBytes: 1 })).toMatchObject({
      status: "blocked",
      reason: "git_binary_untrusted",
    })
  })

  test("copies bytes from the already-open source when its path is replaced", async () => {
    const root = await temporaryDirectory("astra-git-open-source-")
    const sourcePath = join(root, "source")
    const movedPath = join(root, "opened-source")
    const destinationPath = join(root, "destination")
    await writeFile(sourcePath, "original bytes")
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    )
    await rename(sourcePath, movedPath)
    await writeFile(sourcePath, "replacement bytes")

    try {
      await copyOpenedExecutable(source, destination, Buffer.byteLength("original bytes"))
      await destination.sync()
    } finally {
      await source.close()
      await destination.close()
    }

    expect(await readFile(destinationPath, "utf8")).toBe("original bytes")
    expect(await readFile(sourcePath, "utf8")).toBe("replacement bytes")
  })

  test("observes staged plus unstaged changes and leaves the whole repository unchanged", async () => {
    const root = await repository()
    await writeFile(join(root, "tracked.txt"), "staged\n")
    await git(root, "add", "tracked.txt")
    await writeFile(join(root, "tracked.txt"), "staged then modified again\n")
    await writeFile(join(root, "untracked.txt"), "untracked\n")
    const before = await directoryDigest(root)

    const result = await inspectGitWorkspace(root)

    expect(result).toMatchObject({
      status: "complete",
      mode: "bounded_read_only",
      baseline: "not_captured",
      activationAllowed: false,
      verification: "not_verified",
      submodules: "not_inspected",
      branch: { head: "main", aheadBehindScope: "local_ref_only" },
    })
    if (result.status !== "complete") throw new Error(result.reason)
    expect(result.staged.map((entry) => entry.path)).toContain("tracked.txt")
    expect(result.unstaged.map((entry) => entry.path)).toContain("tracked.txt")
    expect(result.untracked).toEqual(["untracked.txt"])
    expect(result.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.diff).toMatchObject({
      source: "status_porcelain_v2",
      format: "metadata_only",
      renames: "disabled",
      durability: "ephemeral",
      verification: "not_verified",
      untrackedContent: "not_inspected",
      conflictContent: "not_inspected",
      observationDigest: result.outputDigest,
      staged: [
        {
          path: "tracked.txt",
          change: "modified",
          before: { location: "head", state: "object" },
          after: { location: "index", state: "object" },
        },
      ],
      unstaged: [
        {
          path: "tracked.txt",
          change: "modified",
          before: { location: "index", state: "object" },
          after: { location: "worktree", state: "unhashed" },
        },
      ],
    })
    expect(await directoryDigest(root)).toBe(before)
  })

  test("blocks index flags that make ordinary status falsely clean", async () => {
    const assumed = await repository()
    await git(assumed, "update-index", "--assume-unchanged", "tracked.txt")
    await writeFile(join(assumed, "tracked.txt"), "hidden by assume-unchanged\n")
    expect(await git(assumed, "status", "--porcelain")).toBe("")
    expect(await inspectGitWorkspace(assumed)).toMatchObject({
      status: "blocked",
      reason: "git_index_assume_unchanged",
    })

    const skipped = await repository()
    await git(skipped, "update-index", "--skip-worktree", "tracked.txt")
    await writeFile(join(skipped, "tracked.txt"), "hidden by skip-worktree\n")
    expect(await git(skipped, "status", "--porcelain")).toBe("")
    expect(await inspectGitWorkspace(skipped)).toMatchObject({
      status: "blocked",
      reason: "git_index_skip_worktree",
    })

    const fsmonitor = await repository()
    await git(fsmonitor, "config", "core.fsmonitor", "true")
    await git(fsmonitor, "update-index", "--fsmonitor")
    await git(fsmonitor, "update-index", "--fsmonitor-valid", "tracked.txt")
    expect(await inspectGitWorkspace(fsmonitor)).toMatchObject({
      status: "blocked",
      reason: "git_index_fsmonitor_uninspectable",
    })
  })

  test("blocks metadata that disagrees with the exact index observation", async () => {
    const root = await repository()
    const other = "fedcba9876543210fedcba9876543210fedcba98"
    const status = new TextEncoder().encode(
      [
        `# branch.oid ${other}\0# branch.head main\0`,
        `1 M. N... 100644 100644 100644 ${other} ${other} tracked.txt\0`,
      ].join(""),
    )
    const index = new TextEncoder().encode(`H 100644 0123456789abcdef0123456789abcdef01234567 0\ttracked.txt\0`)

    const result = await inspectGitWorkspaceWithDependencies(
      root,
      {},
      dependencies(async (input) => ({ ok: true, stdout: input.command === "status" ? status : index })),
    )

    expect(result).toMatchObject({ status: "blocked", reason: "git_index_observation_mismatch" })
  })

  test("blocks intent-to-add instead of inventing a worktree object identity", async () => {
    const root = await repository()
    await writeFile(join(root, "intent.txt"), "intent\n")
    await git(root, "add", "--intent-to-add", "intent.txt")

    expect(await inspectGitWorkspace(root)).toMatchObject({
      status: "blocked",
      reason: "git_index_observation_mismatch",
    })
  })

  test("forces file mode inspection even when repository config disables it", async () => {
    const root = await repository()
    await git(root, "config", "core.filemode", "false")
    await chmod(join(root, "tracked.txt"), 0o755)
    expect(await git(root, "status", "--porcelain")).toBe("")

    const result = await inspectGitWorkspace(root)

    expect(result).toMatchObject({ status: "complete" })
    if (result.status !== "complete") throw new Error(result.reason)
    expect(result.unstaged.map((entry) => entry.path)).toContain("tracked.txt")
  })

  test("observes unborn and detached branches without inventing a branch identity", async () => {
    const unborn = await temporaryDirectory("astra-git-unborn-")
    await git(unborn, "init", "-q", "--initial-branch=main")
    const unbornResult = await inspectGitWorkspace(unborn)
    expect(unbornResult).toMatchObject({ status: "complete", branch: { oid: null, head: "main" } })

    const detached = await repository()
    await git(detached, "checkout", "-q", "--detach")
    const detachedResult = await inspectGitWorkspace(detached)
    expect(detachedResult).toMatchObject({ status: "complete", branch: { head: null } })
  })

  test("blocks hostile repository helpers without executing canaries or inheriting parent Git environment", async () => {
    const root = await repository()
    const canaries = join(root, "canaries")
    await mkdir(canaries)
    const helper = join(root, "helper.sh")
    await writeFile(helper, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(join(canaries, "executed"))}\n`)
    await chmod(helper, 0o755)
    await writeFile(
      join(root, ".git", "config"),
      (await readFile(join(root, ".git", "config"), "utf8")) +
        `\n[core]\n\tfsmonitor = ${helper}\n\tpager = ${helper}\n\thooksPath = ${join(root, ".git", "hooks")}\n` +
        `[credential]\n\thelper = !${helper}\n[diff]\n\texternal = ${helper}\n`,
    )
    await writeFile(join(root, ".git", "hooks", "post-checkout"), `#!/bin/sh\n${helper}\n`)
    await chmod(join(root, ".git", "hooks", "post-checkout"), 0o755)
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_TRACE: process.env.GIT_TRACE,
    }
    process.env.GIT_DIR = join(root, "wrong")
    process.env.GIT_WORK_TREE = join(root, "wrong")
    process.env.GIT_CONFIG_GLOBAL = join(root, "hostile-global")
    process.env.GIT_TRACE = join(canaries, "trace")

    try {
      const result = await inspectGitWorkspace(root)
      expect(result.status).toBe("blocked")
      expect(await readdir(canaries)).toEqual([])
    } finally {
      restoreEnvironment(previous)
    }
  })

  test("blocks process filters and remote canaries without process or network effects", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        return new Response("unexpected")
      },
    })
    const root = await repository()
    const canary = join(root, "filter-executed")
    const helper = join(root, "filter.sh")
    await writeFile(helper, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(canary)}\n/bin/cat\n`)
    await chmod(helper, 0o755)
    await writeFile(join(root, ".gitattributes"), "*.txt filter=hostile\n")
    await writeFile(
      join(root, ".git", "config"),
      (await readFile(join(root, ".git", "config"), "utf8")) +
        `\n[filter "hostile"]\n\tprocess = ${helper}\n\trequired = true\n` +
        `[remote "origin"]\n\turl = http://127.0.0.1:${server.port}/repository\n\tpromisor = true\n` +
        `[extensions]\n\tpartialClone = origin\n`,
    )
    await writeFile(join(root, "tracked.txt"), "changed\n")

    try {
      const result = await inspectGitWorkspace(root)
      expect(result).toMatchObject({ status: "blocked", activationAllowed: false, baseline: "not_captured" })
      expect(await exists(canary)).toBeFalse()
      expect(requests).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test("blocks a gitlink because submodules are not inspected", async () => {
    const root = await repository()
    const oid = (await git(root, "rev-parse", "HEAD")).trim()
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${oid},vendor/dependency`)

    expect(await inspectGitWorkspace(root)).toMatchObject({
      status: "blocked",
      reason: "submodules_uninspected",
      activationAllowed: false,
    })
  })

  test("rejects unsupported repository boundaries before starting a process", async () => {
    const cases: Array<Readonly<{ root: string; reason: string }>> = []

    const metadataFile = await temporaryDirectory("astra-git-file-")
    await writeFile(join(metadataFile, ".git"), "gitdir: elsewhere\n")
    cases.push({ root: metadataFile, reason: "git_metadata_not_directory" })

    const caseVariant = await temporaryDirectory("astra-git-case-")
    await mkdir(join(caseVariant, ".Git"))
    cases.push({ root: caseVariant, reason: "git_metadata_case_variant" })

    const nested = await repository()
    await mkdir(join(nested, "packages", "child", ".git"), { recursive: true })
    cases.push({ root: nested, reason: "nested_git_repository" })

    const commonDirectory = await repository()
    await writeFile(join(commonDirectory, ".git", "commondir"), "../shared\n")
    cases.push({ root: commonDirectory, reason: "git_commondir_unsupported" })

    const alternates = await repository()
    await mkdir(join(alternates, ".git", "objects", "info"), { recursive: true })
    await writeFile(join(alternates, ".git", "objects", "info", "alternates"), "/outside/objects\n")
    cases.push({ root: alternates, reason: "git_alternates_unsupported" })

    const objectsLink = await repository()
    const outsideObjects = await temporaryDirectory("astra-git-outside-objects-")
    await rename(join(objectsLink, ".git", "objects"), join(outsideObjects, "objects"))
    await symlink(join(outsideObjects, "objects"), join(objectsLink, ".git", "objects"))
    cases.push({ root: objectsLink, reason: "git_metadata_symlink" })

    const configLink = await repository()
    const outsideConfig = join(await temporaryDirectory("astra-git-outside-config-"), "config")
    await rename(join(configLink, ".git", "config"), outsideConfig)
    await symlink(outsideConfig, join(configLink, ".git", "config"))
    cases.push({ root: configLink, reason: "git_metadata_symlink" })

    const metadataCaseVariant = await repository()
    await rename(join(metadataCaseVariant, ".git", "objects"), join(metadataCaseVariant, ".git", "Objects"))
    cases.push({ root: metadataCaseVariant, reason: "git_metadata_case_variant" })

    const linkedWorktreeMetadata = await repository()
    await mkdir(join(linkedWorktreeMetadata, ".git", "worktrees"))
    cases.push({ root: linkedWorktreeMetadata, reason: "git_worktree_metadata_unsupported" })

    const parent = await repository()
    const child = join(parent, "packages", "child")
    await mkdir(join(child, ".git"), { recursive: true })
    cases.push({ root: child, reason: "ancestor_git_repository" })

    const real = await repository()
    const aliasParent = await temporaryDirectory("astra-git-alias-")
    const alias = join(aliasParent, "workspace")
    await symlink(real, alias)
    cases.push({ root: alias, reason: "workspace_not_canonical" })

    for (const fixture of cases) {
      let processes = 0
      const result = await inspectGitWorkspaceWithDependencies(
        fixture.root,
        {},
        dependencies(async () => {
          processes += 1
          return { ok: false, reason: "git_process_failed" }
        }),
      )
      expect(result).toMatchObject({ status: "blocked", reason: fixture.reason })
      expect(processes).toBe(0)
    }
  })

  test("applies one boundary deadline before preparing or starting Git", async () => {
    const root = await repository()
    await Promise.all(
      Array.from({ length: 5_000 }, (_, index) =>
        writeFile(join(root, `entry-${index.toString().padStart(4, "0")}`), ""),
      ),
    )
    let processes = 0
    let preparations = 0
    const fake = dependencies(async () => {
      processes += 1
      return { ok: false, reason: "git_process_failed" }
    })

    const result = await inspectGitWorkspaceWithDependencies(
      root,
      { maxBoundaryDurationMs: 1, maxBoundaryEntries: 10_000 },
      {
        ...fake,
        async prepareTrustedBinaries() {
          preparations += 1
          return null
        },
      },
    )

    expect(result).toMatchObject({ status: "blocked", reason: "boundary_time_limit_exceeded" })
    expect(processes).toBe(0)
    expect(preparations).toBe(0)
  })

  test("fails closed on output, entry, and time limits", async () => {
    const root = await repository()
    await writeFile(join(root, "one"), "1")
    await writeFile(join(root, "two"), "2")

    expect(await inspectGitWorkspace(root, { maxStdoutBytes: 1 })).toMatchObject({
      status: "blocked",
      reason: "git_stdout_limit_exceeded",
    })
    expect(await inspectGitWorkspace(root, { maxEntries: 1 })).toMatchObject({
      status: "blocked",
      reason: "git_entry_limit_exceeded",
    })
    expect(await inspectGitWorkspace(root, { timeoutMs: 1 })).toMatchObject({
      status: "blocked",
      reason: "git_process_timeout",
    })

    const broken = await repository()
    await writeFile(join(broken, ".git", "config"), "[invalid\n")
    expect(await inspectGitWorkspace(broken, { maxStderrBytes: 1 })).toMatchObject({
      status: "blocked",
      reason: "git_stderr_limit_exceeded",
    })
    expect(await inspectGitWorkspace(broken)).toMatchObject({
      status: "blocked",
      reason: "git_process_failed",
    })
  })

  test("blocks changed observations and identity drift", async () => {
    const root = await repository()
    const branch = (suffix = "") =>
      new TextEncoder().encode(`# branch.oid 0123456789abcdef0123456789abcdef01234567\0# branch.head main${suffix}\0`)
    let calls = 0
    const changed = await inspectGitWorkspaceWithDependencies(
      root,
      {},
      dependencies(async (input) => {
        calls += 1
        if (input.command !== "status") return { ok: true, stdout: new Uint8Array() }
        return { ok: true, stdout: branch(calls > 3 ? "-changed" : "") }
      }),
    )
    expect(changed).toMatchObject({ status: "blocked", reason: "observation_changed" })

    const metadataRoot = await repository()
    let metadataCalls = 0
    const metadataDrift = await inspectGitWorkspaceWithDependencies(
      metadataRoot,
      {},
      dependencies(async (input) => {
        metadataCalls += 1
        if (metadataCalls === 3) {
          const head = await readFile(join(metadataRoot, ".git", "HEAD"))
          await rename(join(metadataRoot, ".git", "HEAD"), join(metadataRoot, ".git", "HEAD.previous"))
          await writeFile(join(metadataRoot, ".git", "HEAD"), head)
        }
        return { ok: true, stdout: input.command === "status" ? branch() : taggedIndex() }
      }),
    )
    expect(metadataDrift).toMatchObject({ status: "blocked", reason: "workspace_identity_changed" })

    let driftCalls = 0
    const drift = await inspectGitWorkspaceWithDependencies(
      root,
      {},
      dependencies(async (input) => {
        driftCalls += 1
        if (driftCalls === 2) {
          await rm(join(root, ".git"), { recursive: true })
          await mkdir(join(root, ".git"))
        }
        return { ok: true, stdout: input.command === "status" ? branch() : new Uint8Array() }
      }),
    )
    expect(drift).toMatchObject({ status: "blocked", reason: "workspace_identity_changed" })
  })
})

function dependencies(run: GitInspectorDependencies["runSandboxedGit"]): GitInspectorDependencies {
  return {
    platform: "darwin",
    async prepareTrustedBinaries() {
      return {
        gitPath: realGit,
        sandboxPath: "/usr/bin/sandbox-exec",
        gitIdentity: {
          device: "1",
          inode: "1",
          size: 1,
          digest: `sha256:${"0".repeat(64)}`,
          directoryDevice: "1",
          directoryInode: "1",
        },
        async cleanup() {
          return true
        },
      }
    },
    async validatePreparedGit() {
      return true
    },
    runSandboxedGit: async (input) => run(input),
  }
}

function taggedIndex() {
  return new TextEncoder().encode("H 100644 0123456789abcdef0123456789abcdef01234567 0\ttracked.txt\0")
}

async function repository() {
  const root = await temporaryDirectory("astra-git-repository-")
  await git(root, "init", "-q", "--initial-branch=main")
  await writeFile(join(root, "tracked.txt"), "initial\n")
  await git(root, "add", "tracked.txt")
  await git(root, "-c", "user.name=Astra", "-c", "user.email=astra@example.invalid", "commit", "-qm", "initial")
  return root
}

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

async function git(root: string, ...arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn([realGit, "-C", root, ...arguments_], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Git fixture command failed: ${stderr}`)
  return stdout
}

async function directoryDigest(root: string) {
  const hash = createHash("sha256")
  await appendDirectory(hash, root, "")
  return hash.digest("hex")
}

async function appendDirectory(hash: ReturnType<typeof createHash>, root: string, relative: string) {
  const entries = await readdir(join(root, relative))
  entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  for (const name of entries) {
    const childRelative = join(relative, name)
    const path = join(root, childRelative)
    const facts = await lstat(path)
    hash.update(`${childRelative}\0${facts.mode}\0${facts.size}\0${facts.mtimeMs}\0`)
    if (facts.isSymbolicLink()) {
      hash.update(`link\0${await readlink(path)}\0`)
      continue
    }
    if (facts.isDirectory()) {
      await appendDirectory(hash, root, childRelative)
      continue
    }
    if (facts.isFile()) hash.update(await readFile(path))
  }
}

function restoreEnvironment(values: Readonly<Record<string, string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}
