import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildGitUnstageAllInvocation,
  captureGitRepositoryBaseline,
  executeGitUnstageAll,
  inspectGitWorkspace,
  prepareGitUnstageAll,
  revalidateGitRepositoryBaseline,
  verifyGitUnstageAll,
  type GitUnstageAllDependencies,
  type GitUnstageAllDurableClaim,
  type GitUnstageHostInvocation,
} from "../src"
import { defaultGitInspectionLimits, prepareTrustedBinaries, validatePreparedGit } from "../src/inspect"

const roots: Array<string> = []
const realGit = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("bounded Git unstage adapter", () => {
  test("builds one exact direct invocation with inert extension points", () => {
    const invocation = buildGitUnstageAllInvocation("/sealed/git", "/workspace", "a".repeat(40))

    expect(invocation).toMatchObject({
      executablePath: "/sealed/git",
      workingDirectory: "/",
      stdin: "ignore",
      limits: { timeoutMs: 5_000, maxStdoutBytes: 16_384, maxStderrBytes: 16_384 },
    })
    expect(invocation.arguments.slice(-5)).toEqual([
      "restore",
      "--staged",
      `--source=${"a".repeat(40)}`,
      "--",
      ":(top)",
    ])
    expect(invocation.arguments).toContain("core.hooksPath=/dev/null")
    expect(invocation.arguments).toContain("credential.helper=")
    expect(invocation.arguments).toContain("core.editor=true")
    expect(invocation.arguments).toContain("commit.gpgSign=false")
    expect(invocation.arguments).toContain("tag.gpgSign=false")
    expect(invocation.arguments).toContain("--no-lazy-fetch")
    expect(invocation.arguments).not.toContain("--eval")
    expect(invocation.environment).toEqual({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_INDEX_FILE: "/private/tmp/astra-git-unstage-authorized/index",
      GIT_ADVICE: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      PATH: "/usr/bin:/bin",
    })
    expect(Object.keys(invocation.environment).some((name) => name.startsWith("DYLD_"))).toBeFalse()
    expect(Object.keys(invocation.environment).some((name) => name.toLowerCase().includes("proxy"))).toBeFalse()
  })

  test("records rejection at the adapter boundary without reads or a process", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    expect(Object.isFrozen(prepared.preview)).toBeTrue()
    expect(Object.isFrozen(prepared.preview.baseline)).toBeTrue()
    expect(Object.isFrozen(prepared.preview.repositoryWrites)).toBeTrue()
    expect(Object.isFrozen(prepared.preview.scratchWrites)).toBeTrue()
    expect(prepared.preview.repositoryWrites).toEqual([".git/index", ".git/index.lock"])
    expect(prepared.preview.scratchWrites).toEqual([
      prepared.preview.runtimeScratch,
      join(prepared.preview.runtimeScratch, "index"),
      join(prepared.preview.runtimeScratch, "index.lock"),
    ])
    let calls = 0
    const crossed = () => {
      calls += 1
      throw new Error("A rejected operation crossed an effect boundary")
    }
    const unavailable: GitUnstageAllDependencies = {
      platform: "darwin",
      async inspect() {
        return crossed()
      },
      async captureBaseline() {
        return crossed()
      },
      async revalidateBaseline() {
        return crossed()
      },
      async prepareTrustedGit() {
        return crossed()
      },
      async validateTrustedGit() {
        return crossed()
      },
      async runHostGit() {
        return crossed()
      },
      async indexLockAbsent() {
        return crossed()
      },
      async claimProposal() {
        return crossed()
      },
    }
    const before = await repositoryEffectDigest(fixture.root)

    expect(
      await executeGitUnstageAll(
        {
          preview: {
            ...prepared.preview,
            scratchWrites: [
              prepared.preview.runtimeScratch,
              join(prepared.preview.runtimeScratch, "index"),
              "/tmp/unbound-index.lock",
            ] as const,
          },
          expectedBaseline: fixture.baseline,
          consent: decision(prepared.preview, "rejected"),
        },
        unavailable,
      ),
    ).toEqual({ status: "blocked_without_effect", verification: "not_verified", reason: "invalid_input" })

    expect(
      await executeGitUnstageAll(
        {
          preview: prepared.preview,
          expectedBaseline: fixture.baseline,
          consent: decision(prepared.preview, "rejected"),
        },
        unavailable,
      ),
    ).toEqual({ status: "denied_without_effect", verification: "not_verified" })
    expect(calls).toBe(0)
    expect(await repositoryEffectDigest(fixture.root)).toBe(before)
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
  }, 20_000)

  test("uses a durable claim to block an approved replay after adapter restart", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const claimProposal = durableClaimStore()
    const first = await executeGitUnstageAll(
      {
        preview: prepared.preview,
        expectedBaseline: fixture.baseline,
        consent: decision(prepared.preview, "approved"),
      },
      productionLikeDependencies({ claimProposal, runHostGit: runInvocation }),
    )
    expect(first.status).toBe("effect_observed")
    const beforeReplay = await repositoryEffectDigest(fixture.root)

    let calls = 0
    const restartedAdapter = productionLikeDependencies({
      claimProposal,
      async revalidateBaseline() {
        calls += 1
        throw new Error("A replay crossed the Git effect boundary")
      },
      async runHostGit() {
        calls += 1
        throw new Error("A replay started Git")
      },
    })
    const input = {
      preview: prepared.preview,
      expectedBaseline: fixture.baseline,
      consent: decision(prepared.preview, "approved"),
    } as const

    expect(await executeGitUnstageAll(input, restartedAdapter)).toEqual({
      status: "blocked_without_effect",
      verification: "not_verified",
      reason: "proposal_consumed",
    })
    expect(calls).toBe(0)
    expect(await repositoryEffectDigest(fixture.root)).toBe(beforeReplay)
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
  }, 20_000)

  test("fails closed without an Operation Kernel durable claim", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const before = await repositoryEffectDigest(fixture.root)

    expect(
      await executeGitUnstageAll({
        preview: prepared.preview,
        expectedBaseline: fixture.baseline,
        consent: decision(prepared.preview, "approved"),
      }),
    ).toEqual({
      status: "blocked_without_effect",
      verification: "not_verified",
      reason: "durable_claim_unavailable",
    })
    expect(await repositoryEffectDigest(fixture.root)).toBe(before)
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
  }, 20_000)

  test("rejects configured or materialized split indexes before authorization", async () => {
    const configured = await stagedRepository()
    await git(configured.root, "config", "core.splitIndex", "false")
    const configuredBaseline = await captureGitRepositoryBaseline(configured.root)
    if (configuredBaseline.status !== "complete") throw new Error(configuredBaseline.reason)
    expect(await prepareGitUnstageAll(configured.root, configuredBaseline.snapshot)).toEqual({
      status: "blocked",
      reason: "split_index_unsupported",
    })

    const materialized = await stagedRepository()
    await writeFile(join(materialized.root, ".git", `sharedindex.${"a".repeat(40)}`), "hostile\n")
    const materializedBaseline = await captureGitRepositoryBaseline(materialized.root)
    if (materializedBaseline.status !== "complete") throw new Error(materializedBaseline.reason)
    expect(await prepareGitUnstageAll(materialized.root, materializedBaseline.snapshot)).toEqual({
      status: "blocked",
      reason: "split_index_unsupported",
    })
  }, 30_000)

  test("does not infer an effect from exit zero when post-state observation fails", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    let processes = 0
    const dependencies = productionLikeDependencies({
      async runHostGit() {
        processes += 1
        return {
          started: true,
          termination: "exited",
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }
      },
      async captureBaseline(root) {
        return {
          status: "blocked",
          mode: "bounded_read_only",
          durability: "ephemeral",
          verification: "not_verified",
          workspaceRoot: root,
          reason: "observation_changed",
        }
      },
    })

    expect(
      await executeGitUnstageAll(
        {
          preview: prepared.preview,
          expectedBaseline: fixture.baseline,
          consent: decision(prepared.preview, "approved"),
        },
        dependencies,
      ),
    ).toEqual({ status: "effect_unknown", verification: "not_verified", reason: "post_state_unavailable" })
    expect(processes).toBe(1)
    expect(await gitExit(fixture.root, "diff", "--cached", "--quiet")).not.toBe(0)
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
  }, 20_000)

  test("preserves a newly staged change when the approved index changes before installation", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const dependencies = productionLikeDependencies({
      async runHostGit(invocation) {
        const observation = await runInvocation(invocation)
        await writeFile(join(fixture.root, "late.txt"), "late staged change\n")
        await git(fixture.root, "add", "late.txt")
        return observation
      },
    })

    expect(
      await executeGitUnstageAll(
        {
          preview: prepared.preview,
          expectedBaseline: fixture.baseline,
          consent: decision(prepared.preview, "approved"),
        },
        dependencies,
      ),
    ).toEqual({ status: "effect_unknown", verification: "not_verified", reason: "post_state_changed" })
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toContain("late.txt")
    expect(await exists(join(fixture.root, ".git", "index.lock"))).toBeFalse()
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
  }, 30_000)

  test("does not issue a coherent observation when the repository changes inside the observation sandwich", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    let raced = false
    const dependencies = productionLikeDependencies({
      runHostGit: runInvocation,
      async inspect(root) {
        const inspection = await inspectGitWorkspace(root)
        if (!raced) {
          raced = true
          await writeFile(join(root, "tracked.txt"), "changed during observation\n")
        }
        return inspection
      },
    })

    expect(
      await executeGitUnstageAll(
        {
          preview: prepared.preview,
          expectedBaseline: fixture.baseline,
          consent: decision(prepared.preview, "approved"),
        },
        dependencies,
      ),
    ).toEqual({ status: "effect_unknown", verification: "not_verified", reason: "post_state_changed" })
  }, 40_000)

  test("unstages a real fixture without invoking repository helpers and verifies independently", async () => {
    const fixture = await stagedRepository(true)
    const listener = createServer()
    let connections = 0
    listener.on("connection", (socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((complete) => listener.listen(0, "127.0.0.1", complete))
    const address = listener.address()
    if (!address || typeof address === "string") throw new Error("The network sentinel did not bind")
    await git(fixture.root, "config", "remote.origin.url", `http://127.0.0.1:${address.port}/repository`)
    const currentBaseline = await captureGitRepositoryBaseline(fixture.root)
    if (currentBaseline.status !== "complete") throw new Error(currentBaseline.reason)
    const prepared = await prepareGitUnstageAll(fixture.root, currentBaseline.snapshot)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const beforeWorktree = await worktreeDigest(fixture.root)
    const beforeHead = await gitText(fixture.root, "rev-parse", "HEAD")
    const beforeRefs = await gitText(fixture.root, "show-ref")
    const beforeReflog = await optionalFile(join(fixture.root, ".git", "logs", "HEAD"))
    const beforeObjects = await directoryDigest(join(fixture.root, ".git", "objects"))

    const execution = await executeGitUnstageAll(
      {
        preview: prepared.preview,
        expectedBaseline: currentBaseline.snapshot,
        consent: decision(prepared.preview, "approved"),
      },
      productionLikeDependencies({ runHostGit: runInvocation }),
    )
    expect(execution.status).toBe("effect_observed")
    if (execution.status !== "effect_observed") throw new Error(JSON.stringify(execution))
    expect(execution.verification).toBe("not_verified")
    expect(execution.observation.scratchCleanup).toBe("observed_absent_before_return")
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
    expect(await verifyGitUnstageAll({ preview: prepared.preview, observation: execution.observation })).toMatchObject({
      status: "verified",
      verification: "independent_post_state",
      limitations: ["host_network_not_isolated", "object_store_not_observed"],
    })
    expect(
      await verifyGitUnstageAll({
        preview: prepared.preview,
        observation: { ...execution.observation, beforeSnapshotDigest: execution.observation.afterSnapshotDigest },
      }),
    ).toEqual({ status: "blocked", verification: "not_verified", reason: "invalid_input" })
    expect(
      await verifyGitUnstageAll({
        preview: prepared.preview,
        observation: {
          ...execution.observation,
          processObservationDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).toEqual({ status: "blocked", verification: "not_verified", reason: "invalid_input" })

    expect(await gitExit(fixture.root, "diff", "--cached", "--quiet")).toBe(0)
    expect(await gitExit(fixture.root, "diff", "--quiet")).not.toBe(0)
    expect(await readFile(join(fixture.root, "untracked.txt"), "utf8")).toBe("new file\n")
    expect(await worktreeDigest(fixture.root)).toBe(beforeWorktree)
    expect(await gitText(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead)
    expect(await gitText(fixture.root, "show-ref")).toBe(beforeRefs)
    expect(await optionalFile(join(fixture.root, ".git", "logs", "HEAD"))).toBe(beforeReflog)
    expect(await directoryDigest(join(fixture.root, ".git", "objects"))).toBe(beforeObjects)
    expect(await exists(join(fixture.root, ".git", "index.lock"))).toBeFalse()
    expect(await exists(fixture.sentinel)).toBeFalse()
    await Bun.sleep(20)
    expect(connections).toBe(0)
    await new Promise<void>((complete) => listener.close(() => complete()))
  }, 20_000)

  test("marks verification stale when the repository changes inside its observation sandwich", async () => {
    const fixture = await stagedRepository()
    const prepared = await prepareGitUnstageAll(fixture.root, fixture.baseline)
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const execution = await executeGitUnstageAll(
      {
        preview: prepared.preview,
        expectedBaseline: fixture.baseline,
        consent: decision(prepared.preview, "approved"),
      },
      productionLikeDependencies({ runHostGit: runInvocation }),
    )
    if (execution.status !== "effect_observed") throw new Error(JSON.stringify(execution))
    let raced = false
    const dependencies = productionLikeDependencies({
      async inspect(root) {
        const inspection = await inspectGitWorkspace(root)
        if (!raced) {
          raced = true
          await writeFile(join(root, "tracked.txt"), "changed during verification\n")
        }
        return inspection
      },
    })

    expect(
      await verifyGitUnstageAll({ preview: prepared.preview, observation: execution.observation }, dependencies),
    ).toEqual({ status: "stale", verification: "not_verified", reason: "post_state_changed" })
  }, 40_000)
})

function productionLikeDependencies(
  overrides: Partial<GitUnstageAllDependencies>,
): GitUnstageAllDependencies {
  return {
    platform: "darwin",
    inspect: inspectGitWorkspace,
    captureBaseline: captureGitRepositoryBaseline,
    revalidateBaseline: revalidateGitRepositoryBaseline,
    prepareTrustedGit: (root) => prepareTrustedBinaries(root, defaultGitInspectionLimits),
    validateTrustedGit: (binaries) => validatePreparedGit(binaries, defaultGitInspectionLimits),
    async runHostGit() {
      throw new Error("A process dependency must be supplied by this test")
    },
    async indexLockAbsent(root) {
      return !(await exists(join(root, ".git", "index.lock")))
    },
    async claimProposal() {
      return "claimed"
    },
    ...overrides,
  }
}

function decision(
  preview: Readonly<{ proposalDigest: `sha256:${string}`; nonce: string; createdAt: string }>,
  value: "approved" | "rejected",
) {
  return {
    schemaVersion: 1 as const,
    operation: "git_unstage_all" as const,
    proposalDigest: preview.proposalDigest,
    nonce: preview.nonce,
    decision: value,
    decidedAt: preview.createdAt,
  }
}

function durableClaimStore() {
  const claimed = new Set<string>()
  return async (claim: GitUnstageAllDurableClaim) => {
    if (claimed.has(claim.proposalDigest)) return "already_claimed" as const
    claimed.add(claim.proposalDigest)
    return "claimed" as const
  }
}

async function runInvocation(invocation: GitUnstageHostInvocation) {
  const process = Bun.spawn([invocation.executablePath, ...invocation.arguments], {
    cwd: invocation.workingDirectory,
    env: { ...invocation.environment },
    stdin: invocation.stdin,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).bytes(),
    new Response(process.stderr).bytes(),
  ])
  return {
    started: true,
    termination: "exited" as const,
    exitCode,
    stdout,
    stderr,
  }
}

async function stagedRepository(withSentinels = false) {
  const root = await temporaryDirectory("astra-git-unstage-")
  await git(root, "init", "-b", "main")
  await writeFile(join(root, "tracked.txt"), "initial\n")
  await git(root, "add", "tracked.txt")
  await git(root, "-c", "user.name=Astra Test", "-c", "user.email=astra@example.invalid", "commit", "-m", "initial")
  const sentinel = join(root, "helper-ran")
  if (withSentinels) await installMaliciousConfig(root, sentinel)
  await writeFile(join(root, "tracked.txt"), "changed in worktree\n")
  await writeFile(join(root, "untracked.txt"), "new file\n")
  await git(root, "add", "tracked.txt", "untracked.txt")
  await rm(sentinel, { force: true })
  const captured = await captureGitRepositoryBaseline(root)
  if (captured.status !== "complete") throw new Error(captured.reason)
  return { root, baseline: captured.snapshot, sentinel }
}

async function installMaliciousConfig(root: string, sentinel: string) {
  const script = join(root, ".git", "hooks", "astra-sentinel")
  await writeFile(script, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\ncat\n`)
  await chmod(script, 0o700)
  for (const [name, value] of [
    ["core.hooksPath", join(root, ".git", "hooks")],
    ["alias.restore", `!${script}`],
    ["credential.helper", `!${script}`],
    ["core.askPass", script],
    ["core.editor", script],
    ["core.pager", script],
    ["core.sshCommand", script],
    ["sequence.editor", script],
    ["diff.external", script],
    ["gpg.program", script],
    ["commit.gpgSign", "true"],
    ["tag.gpgSign", "true"],
    ["filter.astra.clean", script],
    ["filter.astra.smudge", script],
  ] as const) {
    await git(root, "config", name, value)
  }
}

async function git(root: string, ...args: ReadonlyArray<string>) {
  const process = Bun.spawn([realGit, ...args], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: tmpdir() },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
  if (exitCode !== 0) throw new Error(`Git failed (${exitCode}): ${stderr}`)
}

async function gitExit(root: string, ...args: ReadonlyArray<string>) {
  return Bun.spawn([realGit, ...args], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: tmpdir() },
    stdout: "ignore",
    stderr: "ignore",
  }).exited
}

async function gitText(root: string, ...args: ReadonlyArray<string>) {
  const process = Bun.spawn([realGit, ...args], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: tmpdir() },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Git failed (${exitCode}): ${stderr}`)
  return stdout
}

async function worktreeDigest(root: string) {
  const hash = createHash("sha256")
  for (const path of ["tracked.txt", "untracked.txt"]) hash.update(await readFile(join(root, path)))
  return hash.digest("hex")
}

async function repositoryEffectDigest(root: string) {
  return createHash("sha256")
    .update(await readFile(join(root, ".git", "index")))
    .update(await worktreeDigest(root))
    .update(await gitText(root, "rev-parse", "HEAD"))
    .digest("hex")
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash("sha256")
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name)
    hash.update(entry.name)
    if (entry.isDirectory()) hash.update(await directoryDigest(path))
    else {
      const facts = await stat(path)
      hash.update(String(facts.mode & 0o777))
      hash.update(await readFile(path))
    }
  }
  return hash.digest("hex")
}

async function optionalFile(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
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

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}
