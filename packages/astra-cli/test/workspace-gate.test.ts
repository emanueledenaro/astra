import { afterAll, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeGitRepositoryBaselineSnapshotDigest,
  type GitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshotAuthority,
} from "@astra/domain/git-repository-baseline"
import { parseOperationEvidence } from "@astra/domain/operation-contract"
import { demoMarkerName } from "@astra/runtime/controlled-write-plan"
import { createMaliciousWorkspace, directoryDigest, sentinelNames } from "../../astra-runtime/test/support"
import {
  runWorkspaceGate,
  type EffectApproval,
  type GitInspection,
  type WorkspaceDecision,
  type WorkspaceGateIO,
} from "../src/workspace-gate"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "astra-cli-workspace-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "touch must-not-run" } }))
  return root
}

function scriptedIO(
  decision: WorkspaceDecision | ReadonlyArray<WorkspaceDecision>,
  approval: EffectApproval = "deny",
  onDecision?: () => Promise<void>,
) {
  const lines: Array<string> = []
  const decisions = typeof decision === "string" ? [decision] : [...decision]
  let decisionCalls = 0
  const io: WorkspaceGateIO = {
    write: (line) => lines.push(line),
    continueAfterGitInspection: decisions.length > 1,
    async chooseWorkspaceDecision() {
      decisionCalls += 1
      await onDecision?.()
      return decisions.shift() ?? "exit"
    },
    async approveControlledWrite() {
      return approval
    },
  }
  return { io, lines, decisionCalls: () => decisionCalls }
}

function approvedDependencies() {
  const receipts = new Map<string, string>()
  return {
    async executeApprovedOperation({
      plan,
    }: Parameters<
      NonNullable<import("../src/workspace-gate").WorkspaceGateDependencies["executeApprovedOperation"]>
    >[0]) {
      await writeFile(join(plan.workspaceRoot, plan.relativePath), plan.content, { flag: "wx" })
      const receiptID = crypto.randomUUID()
      receipts.set(plan.operationId, receiptID)
      return {
        operationID: plan.operationId,
        state: "effect_observed" as const,
        sequence: 6,
        lastCursor: 6,
        receiptID,
        status: "effect_observed" as const,
      }
    },
    async verifyApprovedOperation({
      plan,
    }: Parameters<
      NonNullable<import("../src/workspace-gate").WorkspaceGateDependencies["verifyApprovedOperation"]>
    >[0]) {
      const evidence = parseOperationEvidence({
        evidenceID: crypto.randomUUID(),
        operationID: plan.operationId,
        receiptID: receipts.get(plan.operationId)!,
        verificationPlanID: crypto.randomUUID(),
        verifier: { identity: "astra-test-verifier", version: "1", digest: plan.contentDigest },
        snapshotDigest: plan.contentDigest,
        observedAt: new Date().toISOString(),
        criteria: [
          {
            criterionID: "marker_exact_bytes",
            result: "passed",
            observationDigest: plan.contentDigest,
          },
        ],
        limitations: [],
      })
      if (!evidence.ok) throw new Error("test evidence must be valid")
      return {
        operationID: plan.operationId,
        state: "succeeded" as const,
        sequence: 8,
        lastCursor: 8,
        status: "verified" as const,
        evidence: evidence.value,
      }
    },
  }
}

function completeGitInspection(workspaceRoot: string): GitInspection {
  const outputDigest = `sha256:${"1".repeat(64)}` as const
  return {
    status: "complete",
    mode: "bounded_read_only",
    baseline: "not_captured",
    activationAllowed: false,
    verification: "not_verified",
    submodules: "not_inspected",
    workspaceRoot,
    branch: {
      oid: "0123456789abcdef0123456789abcdef01234567",
      head: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      stashCount: 0,
      aheadBehindScope: "local_ref_only",
    },
    staged: [{ path: "same.txt", index: "M", worktree: "M" }],
    unstaged: [{ path: "same.txt", index: "M", worktree: "M" }],
    untracked: ["new.txt"],
    conflicts: [],
    entryCount: 2,
    outputDigest,
    diff: {
      source: "status_porcelain_v2",
      format: "metadata_only",
      renames: "disabled",
      durability: "ephemeral",
      verification: "not_verified",
      untrackedContent: "not_inspected",
      conflictContent: "not_inspected",
      observationDigest: outputDigest,
      staged: [
        {
          path: "same.txt",
          change: "modified",
          before: {
            location: "head",
            state: "object",
            mode: "100644",
            oid: "0123456789abcdef0123456789abcdef01234567",
          },
          after: {
            location: "index",
            state: "object",
            mode: "100644",
            oid: "0123456789abcdef0123456789abcdef01234567",
          },
        },
      ],
      unstaged: [
        {
          path: "same.txt",
          change: "modified",
          before: {
            location: "index",
            state: "object",
            mode: "100644",
            oid: "0123456789abcdef0123456789abcdef01234567",
          },
          after: { location: "worktree", state: "unhashed", mode: "100644" },
        },
      ],
    },
    reportDigest: `sha256:${"2".repeat(64)}`,
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

function gitBaselineDependencies() {
  return {
    async captureGitRepositoryBaseline(workspaceRoot: string) {
      return { status: "complete" as const, snapshot: await gitRepositoryBaseline(workspaceRoot) }
    },
    async revalidateGitRepositoryBaseline(_workspaceRoot: string, snapshot: GitRepositoryBaselineSnapshot) {
      return {
        status: "current" as const,
        expectedSnapshotDigest: snapshot.snapshotDigest,
        currentSnapshotDigest: snapshot.snapshotDigest,
      }
    },
  }
}

async function gitRepositoryBaseline(root: string): Promise<GitRepositoryBaselineSnapshot> {
  const [rootFacts, gitFacts] = await Promise.all([lstat(root), lstat(join(root, ".git"))])
  const gitIdentity = {
    canonicalPath: join(root, ".git"),
    device: String(gitFacts.dev),
    inode: String(gitFacts.ino),
  }
  const authority = {
    schemaVersion: 1,
    mode: "bounded_read_only",
    durability: "ephemeral",
    verification: "not_verified",
    contentPolicy: {
      tracked: "raw_content_type_and_executable",
      untracked: "raw_content_type_and_executable",
      symlinks: "raw_link_text_no_follow",
      ignored: "excluded",
      specialFiles: "blocked",
    },
    root: { canonicalPath: root, device: String(rootFacts.dev), inode: String(rootFacts.ino) },
    gitDirectory: gitIdentity,
    commonDirectory: gitIdentity,
    head: { kind: "unborn", symbolicRef: "refs/heads/main" },
    refs: { digest: `sha256:${"1".repeat(64)}`, count: 0 },
    index: {
      digest: `sha256:${"2".repeat(64)}`,
      metadataDigest: `sha256:${"3".repeat(64)}`,
      entryCount: 0,
    },
    worktree: {
      digest: `sha256:${"4".repeat(64)}`,
      ignored: "excluded",
      trackedPaths: 0,
      untrackedPaths: 0,
      contentEntries: 0,
      totalBytes: 0,
    },
    metadata: { digest: `sha256:${"5".repeat(64)}`, fileCount: 0, totalBytes: 0, externalConfig: "unsupported" },
    observer: {
      adapter: "astra.git-baseline.v1",
      adapterDigest: `sha256:${"6".repeat(64)}`,
      gitBinaryDigest: `sha256:${"7".repeat(64)}`,
      observationDigest: `sha256:${"8".repeat(64)}`,
    },
    limits: {
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      maxEntries: 128,
      maxBoundaryEntries: 128,
      maxBoundaryDurationMs: 1_000,
      maxGitBinaryBytes: 16_000_000,
      maxContentEntries: 128,
      maxFileBytes: 65_536,
      maxTotalBytes: 262_144,
      maxDurationMs: 2_000,
    },
  } as const satisfies GitRepositoryBaselineSnapshotAuthority
  return { ...authority, snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(authority) }
}

describe("workspace gate", () => {
  test("opens read-only without trust persistence or workspace effects", async () => {
    const root = await workspace()
    const before = await readdir(root)
    const terminal = scriptedIO("read-only")
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: null })
    expect(await readdir(root)).toEqual(before)
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("READ ONLY")
    expect(terminal.lines.join("\n")).not.toContain("HOST EXECUTION")
    expect(terminal.lines.join("\n")).toContain("STATIC PREFLIGHT DIGEST")
    expect(terminal.lines.join("\n")).not.toContain("SNAPSHOT")
  })

  test("runs Git inspection only after the explicit G decision and remains untrusted", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("inspect-git")
    let inspections = 0

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace(workspaceRoot) {
        inspections += 1
        expect(workspaceRoot).toBe(root)
        return completeGitInspection(workspaceRoot)
      },
    })
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: null })
    expect(inspections).toBe(1)
    expect(output).toContain("[G] inspect Git")
    expect(output).toContain("bounded read-only • baseline not captured • submodules not inspected")
    expect(output).toContain("+1 -2 (LOCAL REF ONLY)")
    expect(output).toContain("STAGED     same.txt")
    expect(output).toContain("UNSTAGED   same.txt")
    expect(output).toContain("GIT DIFF   metadata only • ephemeral • not verified")
    expect(output).toContain(`DIFF BIND  sha256:${"1".repeat(64)}`)
    expect(output).toContain("GIT BASELINE  CAPTURING • BOUNDED READ ONLY • NOT VERIFIED")
    expect(output).toContain("GIT BASELINE  CURRENT")
    expect(output).toContain("NOT VERIFIED")
    expect(output).toContain("WORKSPACE STATE  UNTRUSTED")
    expect(output).not.toContain("HOST EXECUTION")
    expect(output).not.toContain("VERIFIED   independent verifier matched")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.decisionCalls()).toBe(1)
  })

  test("continues from a current Git baseline to Activate once and persists denial with the same authority", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO(["inspect-git", "activate-once"], "deny")
    let capturedBaseline: GitRepositoryBaselineSnapshot | undefined

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace(workspaceRoot) {
        return completeGitInspection(workspaceRoot)
      },
      async recordDeniedOperation({ plan, repositoryBaseline }) {
        capturedBaseline = repositoryBaseline
        return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 3 }
      },
    })

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: "denied" })
    expect(capturedBaseline?.root.canonicalPath).toBe(root)
    expect(terminal.decisionCalls()).toBe(2)
    expect(terminal.lines.join("\n")).toContain("AWAITING_DECISION • Git baseline current")
    expect(terminal.lines.join("\n")).toContain("DENIED     no dispatch • no host effect")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("carries one Git authority through approved execution and independent verification", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO(["inspect-git", "activate-once"], "approve")
    const approved = approvedDependencies()
    const baselines: Array<GitRepositoryBaselineSnapshot | undefined> = []

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace(workspaceRoot) {
        return completeGitInspection(workspaceRoot)
      },
      async executeApprovedOperation(input) {
        baselines.push(input.repositoryBaseline)
        return approved.executeApprovedOperation(input)
      },
      async verifyApprovedOperation(input) {
        baselines.push(input.repositoryBaseline)
        return approved.verifyApprovedOperation(input)
      },
    })

    expect(result).toMatchObject({ exitCode: 0, operationState: "succeeded" })
    expect(baselines).toHaveLength(2)
    expect(baselines[0]?.snapshotDigest).toBe(baselines[1]?.snapshotDigest)
    expect(baselines[0]?.root.canonicalPath).toBe(root)
    expect(await readFile(join(root, demoMarkerName), "utf8")).toContain("Astra controlled host write")
  })

  test("blocks activation when the Git baseline changes after inspection", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO(["inspect-git", "activate-once"], "approve")
    let revalidations = 0
    let executions = 0
    const baselineDependencies = gitBaselineDependencies()

    const result = await runWorkspaceGate(root, terminal.io, {
      ...baselineDependencies,
      async inspectGitWorkspace(workspaceRoot) {
        return completeGitInspection(workspaceRoot)
      },
      async revalidateGitRepositoryBaseline(workspaceRoot, snapshot) {
        revalidations += 1
        if (revalidations === 1) return baselineDependencies.revalidateGitRepositoryBaseline(workspaceRoot, snapshot)
        return {
          status: "stale",
          expectedSnapshotDigest: snapshot.snapshotDigest,
          currentSnapshotDigest: `sha256:${"9".repeat(64)}`,
        }
      },
      async executeApprovedOperation() {
        executions += 1
        throw new Error("must not execute")
      },
    })

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "STALE", operationState: null })
    expect(revalidations).toBe(2)
    expect(executions).toBe(0)
    expect(terminal.lines.join("\n")).toContain("Git baseline changed")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("fails closed when Git changes while the displayed inspection is being produced", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO(["inspect-git", "activate-once"], "approve")
    const baselineDependencies = gitBaselineDependencies()
    let inspectionCompleted = false
    let executions = 0

    const result = await runWorkspaceGate(root, terminal.io, {
      ...baselineDependencies,
      async inspectGitWorkspace(workspaceRoot) {
        inspectionCompleted = true
        return completeGitInspection(workspaceRoot)
      },
      async revalidateGitRepositoryBaseline(workspaceRoot, snapshot) {
        if (!inspectionCompleted) return baselineDependencies.revalidateGitRepositoryBaseline(workspaceRoot, snapshot)
        return {
          status: "stale",
          expectedSnapshotDigest: snapshot.snapshotDigest,
          currentSnapshotDigest: `sha256:${"9".repeat(64)}`,
        }
      },
      async executeApprovedOperation() {
        executions += 1
        throw new Error("must not execute")
      },
    })

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: null })
    expect(terminal.decisionCalls()).toBe(1)
    expect(executions).toBe(0)
    expect(terminal.lines.join("\n")).toContain("GIT BASELINE  STALE")
    expect(terminal.lines.join("\n")).not.toContain("AWAITING_DECISION • Git baseline current")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("shows a blocked baseline without treating Git inspection as activation", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("inspect-git")
    let revalidations = 0

    const result = await runWorkspaceGate(root, terminal.io, {
      async inspectGitWorkspace(workspaceRoot) {
        return completeGitInspection(workspaceRoot)
      },
      async captureGitRepositoryBaseline(workspaceRoot) {
        return {
          status: "blocked",
          mode: "bounded_read_only",
          durability: "ephemeral",
          verification: "not_verified",
          workspaceRoot,
          reason: "git_config_include_unsupported",
        }
      },
      async revalidateGitRepositoryBaseline() {
        revalidations += 1
        throw new Error("must not revalidate a blocked capture")
      },
    })

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: null })
    expect(revalidations).toBe(0)
    expect(terminal.lines.join("\n")).toContain("GIT BASELINE  BLOCKED • git_config_include_unsupported • NOT VERIFIED")
    expect(terminal.lines.join("\n")).toContain("WORKSPACE STATE  UNTRUSTED")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("captures the authority before a blocked Git inspection and does not revalidate it", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("inspect-git")
    let captures = 0

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace(workspaceRoot) {
        return {
          status: "blocked",
          mode: "bounded_read_only",
          baseline: "not_captured",
          activationAllowed: false,
          verification: "not_verified",
          submodules: "not_inspected",
          workspaceRoot,
          reason: "git_process_failed",
        }
      },
      async captureGitRepositoryBaseline() {
        captures += 1
        return { status: "complete", snapshot: await gitRepositoryBaseline(root) }
      },
      async revalidateGitRepositoryBaseline() {
        throw new Error("must not revalidate a blocked inspection")
      },
    })

    expect(result.exitCode).toBe(2)
    expect(captures).toBe(1)
    expect(terminal.lines.join("\n")).toContain("GIT INSPECTION BLOCKED  git_process_failed")
    expect(terminal.lines.join("\n")).toContain("GIT BASELINE  CAPTURING")
  })

  test("fails closed for a malformed Git inspection result", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("inspect-git")

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace() {
        return null
      },
    })

    expect(result.exitCode).toBe(2)
    expect(terminal.lines.join("\n")).toContain("GIT INSPECTION BLOCKED  invalid adapter result")
    expect(terminal.lines.join("\n")).toContain("WORKSPACE STATE  UNTRUSTED")
  })

  test("rejects a current tuple that is not bound to the captured snapshot", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("inspect-git")
    const unrelatedDigest = `sha256:${"9".repeat(64)}` as const

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace(workspaceRoot) {
        return completeGitInspection(workspaceRoot)
      },
      async revalidateGitRepositoryBaseline() {
        return {
          status: "current",
          expectedSnapshotDigest: unrelatedDigest,
          currentSnapshotDigest: unrelatedDigest,
        }
      },
    })

    expect(result.exitCode).toBe(2)
    expect(terminal.lines.join("\n")).toContain("GIT BASELINE  BLOCKED • revalidation snapshot mismatch • NOT VERIFIED")
    expect(terminal.lines.join("\n")).not.toContain("GIT BASELINE  CURRENT")
  })

  test("blocks a Git diff whose binding does not match the bounded observation", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("inspect-git")

    const result = await runWorkspaceGate(root, terminal.io, {
      ...gitBaselineDependencies(),
      async inspectGitWorkspace(workspaceRoot) {
        const inspection = completeGitInspection(workspaceRoot)
        if (inspection.status !== "complete") return inspection
        return {
          ...inspection,
          diff: { ...inspection.diff, observationDigest: `sha256:${"3".repeat(64)}` },
        }
      },
    })

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: null })
    expect(terminal.lines.join("\n")).toContain("diff binding does not match the bounded observation")
  })

  test("does not call the Git adapter during ordinary read-only open", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const terminal = scriptedIO("read-only")
    let inspections = 0

    await runWorkspaceGate(root, terminal.io, {
      async inspectGitWorkspace() {
        inspections += 1
        throw new Error("must not run")
      },
    })

    expect(inspections).toBe(0)
    expect(terminal.lines.join("\n")).not.toContain("GIT MODE")
  })

  test("keeps a hostile Git workspace read-only when an override requests activation", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        return new Response("unexpected")
      },
    })
    const fixture = await createMaliciousWorkspace(server.port)

    try {
      const before = await directoryDigest(fixture.root)
      const terminal = scriptedIO("activate-once", "approve")
      let denialRecordings = 0
      const result = await runWorkspaceGate(fixture.root, terminal.io, {
        async recordDeniedOperation({ plan }) {
          denialRecordings += 1
          return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 3 }
        },
      })
      const output = terminal.lines.join("\n")

      expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: null })
      expect(output).toContain("GIT META   directory • .git")
      expect(output).toContain("GIT BASELINE NOT INSPECTED")
      expect(output).toContain("activate once unavailable")
      expect(output).toContain("READ ONLY  bounded static report remains available")
      expect(output).not.toContain("HOST EXECUTION")
      expect(output).not.toContain("OPERATION ")
      expect(denialRecordings).toBe(0)
      expect(await directoryDigest(fixture.root)).toBe(before)
      expect(await sentinelNames(fixture.sentinel)).toEqual([])
      expect(requests).toBe(0)
    } finally {
      await server.stop(true)
      await fixture.cleanup()
    }
  })

  test("keeps a nested Git workspace read-only when an override requests activation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "astra-cli-parent-repository-"))
    const root = join(repository, "packages", "app")
    roots.push(repository)
    await mkdir(join(repository, ".git"))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "package.json"), "{}\n")
    const terminal = scriptedIO("activate-once", "approve")

    const result = await runWorkspaceGate(root, terminal.io)
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: null })
    expect(output).toContain("GIT META   directory • ../../.git")
    expect(output).toContain("GIT BASELINE NOT INSPECTED")
    expect(output).not.toContain("HOST EXECUTION")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("keeps a symlinked path into a Git repository read-only", async () => {
    const repository = await mkdtemp(join(tmpdir(), "astra-cli-physical-repository-"))
    const aliases = await mkdtemp(join(tmpdir(), "astra-cli-repository-alias-"))
    const physicalParent = join(repository, "packages")
    const root = join(aliases, "linked-packages", "app")
    roots.push(repository, aliases)
    await mkdir(join(repository, ".git"))
    await mkdir(join(physicalParent, "app"), { recursive: true })
    await writeFile(join(physicalParent, "app", "package.json"), "{}\n")
    await symlink(physicalParent, join(aliases, "linked-packages"))
    const terminal = scriptedIO("activate-once", "approve")

    const result = await runWorkspaceGate(root, terminal.io)
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: null })
    expect(output).toContain("GIT META   directory • ../../.git")
    expect(output).toContain("GIT BASELINE NOT INSPECTED")
    expect(output).not.toContain("HOST EXECUTION")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("exits without creating trust or proposing an effect", async () => {
    const root = await workspace()
    const terminal = scriptedIO("exit")
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: null })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("no trust stored • no effect dispatched")
  })

  test("denies the controlled effect before dispatch and produces no marker", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "deny")
    const recorded: Array<string> = []
    const result = await runWorkspaceGate(root, terminal.io, {
      async recordDeniedOperation({ plan }) {
        recorded.push(plan.operationId)
        return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 9 }
      },
    })
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: "denied" })
    expect(recorded).toHaveLength(1)
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(output).toContain("HOST EXECUTION — NO SANDBOX")
    expect(output).toContain("PLANNING")
    expect(output).toContain("AWAITING_APPROVAL")
    expect(output).toContain("DENIED     no dispatch • no host effect")
    expect(output).toContain("LEDGER     durable • sequence 3 • cursor 9")
    expect(output).not.toContain("DISPATCHING")
    expect(output).not.toContain("EFFECT OBSERVED")
    expect(output).not.toContain("VERIFIED   demo marker")
  })

  test("treats every malformed approval value as a denial without effects", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "unexpected" as EffectApproval)
    let executions = 0

    const result = await runWorkspaceGate(root, terminal.io, {
      async executeApprovedOperation() {
        executions += 1
        throw new Error("must not execute")
      },
      async recordDeniedOperation({ plan }) {
        return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 3 }
      },
    })

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: "denied" })
    expect(executions).toBe(0)
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("DENIED     no dispatch • no host effect")
  })

  test("fails closed when a denial cannot be recorded durably", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "deny")
    const result = await runWorkspaceGate(root, terminal.io, {
      async recordDeniedOperation() {
        throw new Error("Git baseline unavailable")
      },
    })

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: "denied" })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain(
      "LEDGER     DENIAL NOT CONFIRMED DURABLE • durable Operation state is unavailable",
    )
    expect(terminal.lines.join("\n")).not.toContain("DISPATCHING")
  })

  test("rejects a durable projection for another Operation", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "deny")
    const result = await runWorkspaceGate(root, terminal.io, {
      async recordDeniedOperation() {
        return {
          operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670499",
          state: "denied",
          sequence: 3,
          lastCursor: 3,
        }
      },
    })

    expect(result).toMatchObject({ exitCode: 2, operationState: "denied" })
    expect(terminal.lines.join("\n")).toContain("LEDGER     DENIAL NOT CONFIRMED DURABLE")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("does not request denial recording for read-only, exit, or approval", async () => {
    for (const [decision, approval] of [
      ["read-only", "deny"],
      ["exit", "deny"],
      ["activate-once", "approve"],
    ] as const) {
      const root = await workspace()
      const terminal = scriptedIO(decision, approval)
      let calls = 0
      await runWorkspaceGate(root, terminal.io, {
        async recordDeniedOperation({ plan }) {
          calls += 1
          return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 3 }
        },
      })
      expect(calls).toBe(0)
    }
  })

  test("runs one approved create-only effect through observed and verified states", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "approve")
    const result = await runWorkspaceGate(root, terminal.io, approvedDependencies())
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: "succeeded" })
    expect(await readFile(join(root, demoMarkerName), "utf8")).toContain("Astra controlled host write")
    for (const state of ["PLANNING", "AWAITING_APPROVAL", "EFFECT_OBSERVED", "VERIFIED"]) {
      expect(output).toContain(state)
    }
    expect(output.indexOf("EFFECT OBSERVED — NOT VERIFIED")).toBeLessThan(
      output.indexOf("VERIFIED   independent verifier matched"),
    )
    expect(output).toContain("HOST EXECUTION — NO SANDBOX")
    expect(output).toContain("independent verifier matched the exact expected bytes and SHA-256")
  })

  test("refuses to print VERIFIED when the evidence criterion failed", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "approve")
    const approved = approvedDependencies()

    const result = await runWorkspaceGate(root, terminal.io, {
      ...approved,
      async verifyApprovedOperation(input) {
        const verified = await approved.verifyApprovedOperation(input)
        const criterion = verified.evidence.criteria[0]
        if (!criterion) throw new Error("test evidence criterion must exist")
        return {
          ...verified,
          evidence: {
            ...verified.evidence,
            criteria: [
              {
                criterionID: criterion.criterionID,
                observationDigest: criterion.observationDigest,
                result: "failed" as const,
              },
            ],
          },
        }
      },
    })

    expect(result).toMatchObject({
      exitCode: 2,
      workspaceState: "UNTRUSTED",
      operationState: "reconciliation_required",
    })
    expect(await exists(join(root, demoMarkerName))).toBeTrue()
    expect(terminal.lines.join("\n")).toContain(
      "RECONCILIATION REQUIRED  independent verification evidence is unavailable",
    )
    expect(terminal.lines.join("\n")).not.toContain("VERIFIED   independent verifier matched")
  })

  test("invalidates activate-once when bounded static facts change after preview", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "approve", () =>
      writeFile(join(root, "AGENTS.md"), "changed after report\n"),
    )
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "STALE", operationState: null })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("run a new bounded static preflight")
  })

  test("fails closed without overwriting an existing marker", async () => {
    const root = await workspace()
    const marker = join(root, demoMarkerName)
    await writeFile(marker, "user-owned\n")
    const terminal = scriptedIO("activate-once", "approve")
    const dependencies = approvedDependencies()
    const result = await runWorkspaceGate(root, terminal.io, {
      ...dependencies,
      async executeApprovedOperation({ plan }) {
        return {
          operationID: plan.operationId,
          state: "failed",
          sequence: 6,
          lastCursor: 6,
          receiptID: crypto.randomUUID(),
          status: "failed_without_effect",
        }
      },
    })

    expect(result).toMatchObject({ exitCode: 1, workspaceState: "UNTRUSTED", operationState: "failed" })
    expect(await readFile(marker, "utf8")).toBe("user-owned\n")
    expect(terminal.lines.join("\n")).toContain("durable proof reports no host effect")
  })

  test("does not import or invoke the host effect adapter directly", async () => {
    const source = await Bun.file(new URL("../src/workspace-gate.ts", import.meta.url)).text()

    expect(source).not.toContain('from "@astra/runtime/controlled-write"')
    expect(source).not.toContain('import("@astra/runtime/controlled-write")')
    expect(source.indexOf('if (approval !== "approve")')).toBeLessThan(
      source.indexOf("dependencies.executeApprovedOperation"),
    )
  })
})
