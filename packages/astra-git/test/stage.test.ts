import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureGitRepositoryBaseline,
  captureGitStageInventory,
  executeGitStageSelected,
  inspectGitWorkspace,
  prepareGitStageSelected,
  verifyGitStageSelected,
  type GitStageDependencies,
  type GitStageHostInvocation,
} from "../src"
import {
  captureGitRepositoryBaselineWithDependencies,
  revalidateGitRepositoryBaselineWithDependencies,
} from "../src/baseline"
import {
  defaultGitInspectionLimits,
  inspectGitWorkspaceWithDependencies,
  prepareTrustedBinaries,
  runSandboxedGit,
  validatePreparedGit,
  type GitInspectorDependencies,
} from "../src/inspect"
import { computeGitStageProposalDigest } from "../../astra-domain/src/git-stage-mutation"

const roots: Array<string> = []
const realGit = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"
const timeoutMs = 10_000

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("bounded Git stage selected adapter", () => {
  test("prepares an exact selected proposal without effects", async () => {
    const fixture = await changedRepository()
    const inventory = await captureGitStageInventory(fixture.root, fixture.baseline, fixture.inspection)
    expect(inventory.status).toBe("ready")
    if (inventory.status !== "ready") throw new Error(inventory.reason)
    const selected = inventory.inventory.candidates.find((candidate) => candidate.path === "tracked.txt")!
    const before = await repositoryDigest(fixture.root)

    const prepared = prepareGitStageSelected(inventory.inventory, [selected.candidateID], Date.now())

    expect(prepared.status).toBe("ready")
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    expect(prepared.preview.selection.candidateIDs).toEqual([selected.candidateID])
    expect(prepared.preview.candidates.map((candidate) => candidate.path)).toEqual(["tracked.txt"])
    expect(prepared.preview.repositoryWrites).toEqual([".git/index", ".git/index.lock", selected.objectPath!].sort())
    expect(prepared.preview.boundaryLabel).toBe("HOST EXECUTION — NO SANDBOX")
    expect(await exists(prepared.preview.runtimeScratch)).toBeFalse()
    expect(await repositoryDigest(fixture.root)).toBe(before)
  }, 30_000)

  test("rejects without crossing an effect boundary", async () => {
    const fixture = await preparedFixture("tracked.txt")
    let calls = 0
    const crossed = (): never => {
      calls++
      throw new Error("Rejected stage crossed an effect boundary")
    }
    const dependencies: GitStageDependencies = {
      platform: "darwin",
      async revalidateBaseline() {
        return crossed()
      },
      async captureBaseline() {
        return crossed()
      },
      async inspect() {
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
      async claimProposal() {
        return crossed()
      },
      async cleanupRuntimeScratch() {
        return crossed()
      },
    }
    const before = await repositoryDigest(fixture.root)
    const result = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "rejected"),
      },
      dependencies,
    )
    expect(result).toEqual({ status: "denied_without_effect", verification: "not_verified" })
    expect(calls).toBe(0)
    expect(await repositoryDigest(fixture.root)).toBe(before)
  }, 30_000)

  test("rejects a recomputed preview that substitutes an opaque inventory candidate", async () => {
    const fixture = await preparedFixture("tracked.txt")
    const substitutedCandidates = fixture.preview.candidates.map((candidate) => ({
      ...candidate,
      path: "substituted.txt",
    }))
    const { proposalDigest: _proposalDigest, ...authority } = {
      ...fixture.preview,
      candidates: substitutedCandidates,
    }
    const preview = { ...authority, proposalDigest: computeGitStageProposalDigest(authority) }
    let calls = 0
    const dependencies = productionDependencies({
      async claimProposal() {
        calls++
        throw new Error("Substituted candidate crossed the claim boundary")
      },
    })
    expect(
      await executeGitStageSelected(
        {
          preview,
          inventory: fixture.inventory,
          expectedBaseline: fixture.baseline,
          decision: decision(preview, "approved"),
        },
        dependencies,
      ),
    ).toEqual({ status: "blocked_without_effect", verification: "not_verified", reason: "invalid_input" })
    expect(calls).toBe(0)
  }, 30_000)

  test("stages only the selected path and independently verifies exact state", async () => {
    const fixture = await preparedFixture("tracked.txt")
    const beforeWorktree = await worktreeDigest(fixture.root)
    const beforeHead = await gitText(fixture.root, "rev-parse", "HEAD")
    const dependencies = productionDependencies()

    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      dependencies,
    )

    if (execution.status !== "effect_observed") throw new Error(JSON.stringify(execution))
    expect(execution.status).toBe("effect_observed")
    expect(
      await verifyGitStageSelected(
        {
          preview: fixture.preview,
          inventory: fixture.inventory,
          expectedBaseline: fixture.baseline,
          observation: execution.observation,
        },
        dependencies,
      ),
    ).toMatchObject({ status: "verified", verification: "independent_selected_index_and_preservation" })
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("tracked.txt\n")
    expect(await gitText(fixture.root, "status", "--short")).toContain("?? untracked.txt")
    expect(await worktreeDigest(fixture.root)).toBe(beforeWorktree)
    expect(await gitText(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead)
    expect(await exists(join(fixture.root, ".git", "index.lock"))).toBeFalse()
    expect(await exists(fixture.preview.runtimeScratch)).toBeFalse()
  }, 45_000)

  test("stages one untracked file without staging the tracked change", async () => {
    const fixture = await preparedFixture("untracked.txt")
    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      productionDependencies(),
    )
    expect(execution.status).toBe("effect_observed")
    if (execution.status !== "effect_observed") throw new Error(JSON.stringify(execution))
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("untracked.txt\n")
    expect(await gitText(fixture.root, "diff", "--name-only")).toBe("tracked.txt\n")
  }, 45_000)

  test("stages a file whose blob already exists in the repository object store", async () => {
    const fixture = await preparedFixture("untracked.txt", { existingObjectReuse: true })
    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      productionDependencies(),
    )
    expect(execution.status).toBe("effect_observed")
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("untracked.txt\n")
  }, 45_000)

  test("never observes success for a corrupt existing destination object", async () => {
    const fixture = await preparedFixture("untracked.txt", { existingObjectReuse: true })
    const selected = fixture.preview.candidates[0]
    if (!selected?.objectPath) throw new Error("Missing selected object path")
    const objectPath = join(fixture.root, selected.objectPath)
    await chmod(objectPath, 0o600)
    await writeFile(objectPath, "corrupt loose object")

    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      productionDependencies(),
    )

    expect(execution.status).not.toBe("effect_observed")
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("")
    expect(await exists(join(fixture.root, ".git", "index.lock"))).toBeFalse()
  }, 45_000)

  test("stages a file whose existing blob is available only from a packfile", async () => {
    const fixture = await preparedFixture("untracked.txt", { existingObjectReuse: true, packExistingObject: true })
    const selected = fixture.preview.candidates[0]
    if (!selected?.objectPath) throw new Error("Missing selected object path")
    expect(await exists(join(fixture.root, selected.objectPath))).toBeFalse()

    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      productionDependencies(),
    )

    expect(execution.status).toBe("effect_observed")
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("untracked.txt\n")
  }, 45_000)

  test("stages one tracked deletion", async () => {
    const fixture = await preparedFixture("tracked.txt", { deleteTracked: true })
    const dependencies = productionDependencies()
    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      dependencies,
    )
    if (execution.status !== "effect_observed") throw new Error(JSON.stringify(execution))
    expect(execution.status).toBe("effect_observed")
    expect(
      await verifyGitStageSelected(
        {
          preview: fixture.preview,
          inventory: fixture.inventory,
          expectedBaseline: fixture.baseline,
          observation: execution.observation,
        },
        dependencies,
      ),
    ).toMatchObject({ status: "verified" })
    expect(await gitText(fixture.root, "diff", "--cached", "--name-status")).toBe("D\ttracked.txt\n")
    expect(await exists(join(fixture.root, "tracked.txt"))).toBeFalse()
  }, 45_000)

  test("blocks selected content drift after the durable claim without a Git process", async () => {
    const fixture = await preparedFixture("tracked.txt")
    await writeFile(join(fixture.root, "tracked.txt"), "drifted after consent\n")
    let processes = 0
    const dependencies = productionDependencies({
      async runHostGit() {
        processes++
        throw new Error("Drift must block before Git")
      },
    })
    const result = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      dependencies,
    )
    expect(result.status).toBe("blocked_without_effect")
    expect(processes).toBe(0)
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("")
  }, 30_000)

  test("does not observe success after a same-size selected-content race", async () => {
    const fixture = await preparedFixture("untracked.txt")
    const base = productionDependencies()
    let raced = false
    const dependencies: GitStageDependencies = {
      ...base,
      async captureBaseline(root) {
        if (!raced) {
          raced = true
          await writeFile(join(root, "untracked.txt"), "raced content!\n")
        }
        return base.captureBaseline(root)
      },
    }
    const result = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      dependencies,
    )
    expect(result).toEqual({ status: "effect_unknown", verification: "not_verified", reason: "post_state_mismatch" })
    expect(raced).toBeTrue()
  }, 45_000)

  test("does not verify a mutation that races independent Git verification", async () => {
    const fixture = await preparedFixture("tracked.txt")
    const base = productionDependencies()
    const execution = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      base,
    )
    if (execution.status !== "effect_observed") throw new Error(JSON.stringify(execution))
    let raced = false
    const verificationDependencies: GitStageDependencies = {
      ...base,
      async runHostGit(invocation) {
        const result = await base.runHostGit(invocation)
        if (!raced && invocation.arguments.includes("cat-file")) {
          raced = true
          await writeFile(join(fixture.root, "tracked.txt"), "tampered change\n")
        }
        return result
      },
    }
    expect(
      await verifyGitStageSelected(
        {
          preview: fixture.preview,
          inventory: fixture.inventory,
          expectedBaseline: fixture.baseline,
          observation: execution.observation,
        },
        verificationDependencies,
      ),
    ).toEqual({ status: "stale", verification: "not_verified", reason: "post_state_changed" })
    expect(raced).toBeTrue()
  }, 60_000)

  test("cleanup failure overrides an early process result", async () => {
    const fixture = await preparedFixture("tracked.txt")
    const dependencies = productionDependencies({
      async runHostGit() {
        return { started: false }
      },
      async cleanupRuntimeScratch() {
        return false
      },
    })
    const result = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      dependencies,
    )
    expect(result).toEqual({
      status: "effect_unknown",
      verification: "not_verified",
      reason: "trusted_git_cleanup_failed",
    })
    expect(await exists(fixture.preview.runtimeScratch)).toBeTrue()
    await rm(fixture.preview.runtimeScratch, { recursive: true, force: true })
  }, 30_000)

  test("blocks an existing index lock without changing the index", async () => {
    const fixture = await preparedFixture("tracked.txt")
    const before = await readFile(join(fixture.root, ".git", "index"))
    await writeFile(join(fixture.root, ".git", "index.lock"), "foreign lock")
    const result = await executeGitStageSelected(
      {
        preview: fixture.preview,
        inventory: fixture.inventory,
        expectedBaseline: fixture.baseline,
        decision: decision(fixture.preview, "approved"),
      },
      productionDependencies(),
    )
    expect(result).toEqual({
      status: "blocked_without_effect",
      verification: "not_verified",
      reason: "index_lock_present",
    })
    expect(await readFile(join(fixture.root, ".git", "index"))).toEqual(before)
  }, 30_000)

  test("blocks split index after claim before any Git process", async () => {
    const fixture = await preparedFixture("tracked.txt")
    await git(fixture.root, "config", "core.splitIndex", "true")
    let processes = 0
    const dependencies = productionDependencies({
      async revalidateBaseline(_root, baseline) {
        return {
          status: "current",
          expectedSnapshotDigest: baseline.snapshotDigest,
          currentSnapshotDigest: baseline.snapshotDigest,
        }
      },
      async runHostGit() {
        processes++
        throw new Error("Split index must block before Git")
      },
    })
    expect(
      await executeGitStageSelected(
        {
          preview: fixture.preview,
          inventory: fixture.inventory,
          expectedBaseline: fixture.baseline,
          decision: decision(fixture.preview, "approved"),
        },
        dependencies,
      ),
    ).toEqual({ status: "blocked_without_effect", verification: "not_verified", reason: "split_index_unsupported" })
    expect(processes).toBe(0)
  }, 30_000)

  test("blocks transforming attributes before proposal creation", async () => {
    const fixture = await changedRepository({ attributes: "*.txt filter=hostile\n", hostileFilter: true })
    const inventory = await captureGitStageInventory(fixture.root, fixture.baseline, fixture.inspection)
    expect(inventory).toEqual({ status: "blocked", reason: "transforming_attributes_unsupported" })
    expect(await gitText(fixture.root, "diff", "--cached", "--name-only")).toBe("")
    expect(await exists(fixture.sentinel)).toBeFalse()
  }, 30_000)

  test("fails closed on a symlinked attributes file", async () => {
    const fixture = await changedRepository({ attributeSymlink: true })
    const inventory = await captureGitStageInventory(fixture.root, fixture.baseline, fixture.inspection)
    expect(inventory).toEqual({ status: "blocked", reason: "transforming_attributes_unsupported" })
  }, 30_000)

  test("blocks rename-like and special-file candidates", async () => {
    const renamed = await changedRepository({ renameTracked: true })
    expect(await captureGitStageInventory(renamed.root, renamed.baseline, renamed.inspection)).toEqual({
      status: "blocked",
      reason: "rename_unsupported",
    })

    const special = await changedRepository({ specialTracked: true })
    expect(await captureGitStageInventory(special.root, special.baseline, special.inspection)).toEqual({
      status: "blocked",
      reason: "special_file_unsupported",
    })
  }, 45_000)
})

async function preparedFixture(
  path: string,
  options: Readonly<{ deleteTracked?: boolean; existingObjectReuse?: boolean; packExistingObject?: boolean }> = {},
) {
  const fixture = await changedRepository(options)
  const captured = await captureGitStageInventory(fixture.root, fixture.baseline, fixture.inspection)
  if (captured.status !== "ready") throw new Error(captured.reason)
  const selected = captured.inventory.candidates.find((candidate) => candidate.path === path)
  if (!selected) throw new Error(`Missing candidate ${path}`)
  const prepared = prepareGitStageSelected(captured.inventory, [selected.candidateID], Date.now())
  if (prepared.status !== "ready") throw new Error(prepared.reason)
  return { ...fixture, inventory: captured.inventory, preview: prepared.preview }
}

async function changedRepository(
  options: Readonly<{
    attributes?: string
    attributeSymlink?: boolean
    deleteTracked?: boolean
    hostileFilter?: boolean
    existingObjectReuse?: boolean
    packExistingObject?: boolean
    renameTracked?: boolean
    specialTracked?: boolean
  }> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "astra-git-stage-")))
  roots.push(root)
  await git(root, "init", "-b", "main")
  await writeFile(join(root, "tracked.txt"), options.existingObjectReuse ? "" : "initial\n")
  if (options.attributes) await writeFile(join(root, ".gitattributes"), options.attributes)
  await git(root, "add", ".")
  await git(root, "-c", "user.name=Astra Test", "-c", "user.email=astra@example.invalid", "commit", "-m", "initial")
  if (options.packExistingObject) {
    await git(root, "repack", "-ad")
    await git(root, "prune-packed")
  }
  const sentinel = join(root, "filter-ran")
  if (options.hostileFilter) {
    const script = join(root, ".git", "hostile-filter")
    await writeFile(script, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\ncat\n`)
    await chmod(script, 0o700)
    await git(root, "config", "filter.hostile.clean", script)
  }
  if (options.attributeSymlink) {
    const target = join(root, ".git", "attribute-target")
    await writeFile(target, "*.txt filter=hostile\n")
    await symlink(target, join(root, ".gitattributes"))
  }
  if (options.renameTracked) {
    await rm(join(root, "tracked.txt"))
    await writeFile(join(root, "renamed.txt"), "initial\n")
  } else if (options.specialTracked) {
    await rm(join(root, "tracked.txt"))
    await symlink(join(root, ".git", "attribute-target"), join(root, "tracked.txt"))
  } else if (options.deleteTracked) await rm(join(root, "tracked.txt"))
  else if (!options.existingObjectReuse) await writeFile(join(root, "tracked.txt"), "selected change\n")
  await writeFile(join(root, "untracked.txt"), options.existingObjectReuse ? "" : "leave unstaged\n")
  const captured = await captureGitRepositoryBaseline(root, { timeoutMs })
  const inspection = await inspectGitWorkspace(root, { timeoutMs })
  if (captured.status !== "complete") throw new Error(captured.reason)
  if (inspection.status !== "complete") throw new Error(inspection.reason)
  return { root, baseline: captured.snapshot, inspection, sentinel }
}

function productionDependencies(overrides: Partial<GitStageDependencies> = {}): GitStageDependencies {
  const observer: GitInspectorDependencies = {
    platform: "darwin",
    prepareTrustedBinaries: (root, limits, deadline) => prepareTrustedBinaries(root, limits, deadline, "/private/tmp"),
    validatePreparedGit,
    runSandboxedGit,
  }
  return {
    platform: "darwin",
    inspect: (root) => inspectGitWorkspaceWithDependencies(root, { timeoutMs }, observer),
    captureBaseline: (root) => captureGitRepositoryBaselineWithDependencies(root, { timeoutMs }, observer),
    revalidateBaseline: (root, baseline) => revalidateGitRepositoryBaselineWithDependencies(root, baseline, observer),
    prepareTrustedGit: (root) => prepareTrustedBinaries(root, defaultGitInspectionLimits, undefined, "/private/tmp"),
    validateTrustedGit: (binaries) => validatePreparedGit(binaries, defaultGitInspectionLimits),
    runHostGit: runInvocation,
    async claimProposal() {
      return "claimed"
    },
    async cleanupRuntimeScratch(path) {
      await rm(path, { recursive: true, force: true })
      return !(await exists(path))
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
    operation: "git_stage_paths" as const,
    proposalDigest: preview.proposalDigest,
    nonce: preview.nonce,
    decision: value,
    decidedAt: preview.createdAt,
  }
}

async function runInvocation(invocation: GitStageHostInvocation) {
  const process = Bun.spawn([invocation.executablePath, ...invocation.arguments], {
    cwd: "/",
    env: { ...invocation.environment },
    stdin: invocation.stdin === "ignore" ? "ignore" : new Blob([Buffer.from(invocation.stdin)]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).bytes(),
    new Response(process.stderr).bytes(),
  ])
  const outputLimited =
    stdout.byteLength > invocation.limits.maxStdoutBytes || stderr.byteLength > invocation.limits.maxStderrBytes
  return {
    started: true,
    termination: outputLimited ? ("output_limit_exceeded" as const) : ("exited" as const),
    exitCode,
    stdout: stdout.slice(0, invocation.limits.maxStdoutBytes),
    stderr: stderr.slice(0, invocation.limits.maxStderrBytes),
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

async function repositoryDigest(root: string) {
  return createHash("sha256")
    .update(await readFile(join(root, ".git", "index")))
    .update(await worktreeDigest(root))
    .update(await gitText(root, "rev-parse", "HEAD"))
    .digest("hex")
}

async function worktreeDigest(root: string) {
  return createHash("sha256")
    .update(await readFile(join(root, "tracked.txt")))
    .update(await readFile(join(root, "untracked.txt")))
    .digest("hex")
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}
