import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitCommitDecision } from "@astra/domain/git-commit-mutation"
import {
  captureGitRepositoryBaseline,
  executeGitCommitLocal,
  prepareGitCommitLocal,
  verifyGitCommitLocal,
} from "@astra/git"
import {
  executeDurableGitCommit,
  recoverDurableGitCommit,
  verifyDurableGitCommit,
  type DurableGitCommitInput,
  type GitCommitAdapter,
  type GitCommitFaultPoint,
} from "../src/git-commit-coordinator"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable local Git commit coordinator", () => {
  test("records rejection without invoking the Git adapter", async () => {
    const input = await operationInput("rejected")
    let calls = 0
    const adapter: GitCommitAdapter = {
      async execute() {
        calls += 1
        throw new Error("denied commit reached adapter")
      },
      verify: verifyGitCommitLocal,
    }
    expect(await executeDurableGitCommit(input, { adapter })).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
      receiptID: null,
    })
    expect(calls).toBe(0)
  })

  test("claims durably before the adapter and records only observed effect until independent verification", async () => {
    const input = await operationInput("approved")
    let executions = 0
    let verifications = 0
    const adapter: GitCommitAdapter = {
      async execute(effectInput, claimProposal) {
        executions += 1
        return executeGitCommitLocal(effectInput, { claimProposal })
      },
      async verify(verificationInput) {
        verifications += 1
        return verifyGitCommitLocal(verificationInput)
      },
    }
    expect(await executeDurableGitCommit(input, { adapter, now: clock(input, 2_000) })).toMatchObject({
      state: "effect_observed",
      status: "effect_observed",
    })
    expect(await executeDurableGitCommit(input, { adapter, now: clock(input, 2_100) })).toMatchObject({
      state: "effect_observed",
    })
    expect(executions).toBe(1)
    const verified = await verifyDurableGitCommit(input, adapter)
    expect(verified).toMatchObject({
      state: "succeeded",
      status: "verified",
      snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(await verifyDurableGitCommit(input, adapter)).toMatchObject({
      state: "succeeded",
      status: "verified",
      snapshotDigest: verified.snapshotDigest,
    })
    expect(verifications).toBe(1)
  })

  test("crash after adapter never retries the commit and recovers as reconciliation required", async () => {
    const input = await operationInput("approved")
    let executions = 0
    const adapter: GitCommitAdapter = {
      async execute(effectInput, claimProposal) {
        executions += 1
        return executeGitCommitLocal(effectInput, { claimProposal })
      },
      verify: verifyGitCommitLocal,
    }
    expect(
      await executeDurableGitCommit(input, {
        adapter,
        now: clock(input, 2_000),
        injectFault: faultAt("after_adapter_before_spool"),
      }).catch((cause) => cause),
    ).toMatchObject({ code: "state_unavailable" })
    expect(await recoverDurableGitCommit(input, { now: clock(input, 2_100) }).catch((cause) => cause)).toMatchObject({
      code: "operation_in_progress",
    })
    expect(await recoverDurableGitCommit(input, { now: clock(input, 63_000) })).toMatchObject({
      state: "reconciliation_required",
      receiptID: null,
    })
    expect(executions).toBe(1)
  })

  test("persists adapter uncertainty as reconciliation required, never as failed without effect", async () => {
    const input = await operationInput("approved")
    const adapter: GitCommitAdapter = {
      async execute(_, claimProposal) {
        expect(
          await claimProposal({
            proposalDigest: input.preview.proposalDigest,
            nonce: input.preview.nonce,
            expiresAt: input.preview.expiresAt,
            decision: "approved",
          }),
        ).toMatchObject({ status: "claimed", effectExpiresAt: expect.any(String) })
        return {
          status: "reconciliation_required",
          verification: "not_verified",
          reason: "orphan_objects_installed",
        }
      },
      verify: verifyGitCommitLocal,
    }
    expect(await executeDurableGitCommit(input, { adapter, now: clock(input, 2_000) })).toMatchObject({
      state: "reconciliation_required",
      status: "reconciliation_required",
    })
  })

  test("rejects an observed receipt whose object list is not the exact admitted inventory", async () => {
    const input = await operationInput("approved")
    const adapter: GitCommitAdapter = {
      async execute(_, claimProposal) {
        await claimProposal({
          proposalDigest: input.preview.proposalDigest,
          nonce: input.preview.nonce,
          expiresAt: input.preview.expiresAt,
          decision: "approved",
        })
        return {
          status: "effect_observed",
          verification: "not_verified",
          observation: {
            schemaVersion: 1,
            operation: "git_commit_local",
            status: "effect_observed",
            verification: "not_verified",
            proposalDigest: input.preview.proposalDigest,
            ref: input.preview.ref,
            beforeOID: input.preview.expectedOldOID,
            afterOID: input.preview.commitOID,
            objectOIDs: [],
            limitations: input.preview.limitations,
          },
        }
      },
      verify: verifyGitCommitLocal,
    }
    expect(
      await executeDurableGitCommit(input, { adapter, now: clock(input, 2_000) }).catch((cause) => cause),
    ).toMatchObject({ code: "state_unavailable" })
  })
})

async function operationInput(decision: "approved" | "rejected"): Promise<DurableGitCommitInput> {
  const workspace = await temporaryDirectory("astra-git-commit-runtime-workspace-")
  const state = await temporaryDirectory("astra-git-commit-runtime-state-")
  await git(workspace, ["init", "-q", "-b", "main"])
  await writeFile(join(workspace, "tracked.txt"), "initial\n")
  await git(workspace, ["add", "tracked.txt"])
  await git(workspace, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-q",
    "-m",
    "initial",
  ])
  await writeFile(join(workspace, "tracked.txt"), "staged\n")
  await git(workspace, ["add", "tracked.txt"])
  const baseline = await captureGitRepositoryBaseline(workspace)
  if (baseline.status !== "complete") throw new Error(`Baseline failed: ${baseline.reason}`)
  const createdAt = Date.now() - 5_000
  const prepared = await prepareGitCommitLocal(
    workspace,
    baseline.snapshot,
    "feat: durable governed commit",
    { ASTRA_GIT_AUTHOR_NAME: "Astra User", ASTRA_GIT_AUTHOR_EMAIL: "astra@example.test" },
    createdAt,
  )
  if (prepared.status !== "ready") throw new Error(`Commit preparation failed: ${prepared.reason}`)
  const approval: GitCommitDecision = {
    schemaVersion: 1,
    operation: "git_commit_local",
    proposalDigest: prepared.preview.proposalDigest,
    nonce: prepared.preview.nonce,
    decision,
    decidedAt: new Date(createdAt + 1_000).toISOString(),
  }
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    preview: prepared.preview,
    inventory: prepared.inventory,
    expectedBaseline: prepared.baseline,
    decision: approval,
    recordingStartedAt: new Date(createdAt + 1_500).toISOString(),
  }
}

function clock(input: DurableGitCommitInput, offset: number) {
  const value = Date.parse(input.preview.createdAt) + offset
  return () => value
}

function faultAt(expected: GitCommitFaultPoint) {
  return async (point: GitCommitFaultPoint) => {
    if (point === expected) throw new Error(`Injected commit coordinator fault at ${point}`)
  }
}

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

async function git(root: string, arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn(["/usr/bin/git", ...arguments_], {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "empty-home"), GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`git ${arguments_.join(" ")} failed: ${stderr}`)
}
