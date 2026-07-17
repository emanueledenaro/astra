import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeGitStageInventoryDigest,
  gitStageLimitations,
  type GitStageDecision,
  type GitStageInventory,
  type GitStageInventoryAuthority,
  type GitStageObservation,
} from "../../astra-domain/src/git-stage-mutation"
import {
  computeGitRepositoryBaselineSnapshotDigest,
  type GitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshotAuthority,
} from "@astra/domain/git-repository-baseline"
import { parseOperationID } from "@astra/domain/operation-contract"
import { prepareGitStageSelected } from "@astra/git"
import { Effect } from "effect"
import {
  executeDurableGitStage,
  recoverDurableGitStage,
  verifyDurableGitStage,
  type DurableGitStageInput,
  type GitStageAdapter,
  type GitStageFaultPoint,
} from "../src/git-stage-coordinator"
import { makeGitStageOperationFacts } from "../src/git-stage-operation-facts"
import { runWithLedger, runWithReceiptSpool } from "../src/operation-storage"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable Git stage selected Operation coordinator", () => {
  test("records rejection without invoking the Git adapter", async () => {
    const input = await operationInput("rejected")
    let calls = 0
    const adapter = adapterThat(async () => {
      calls += 1
      throw new Error("A denied operation reached the adapter")
    })

    expect(await executeDurableGitStage(input, { adapter })).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
      receiptID: null,
    })
    expect(calls).toBe(0)
    expect(await eventNames(input)).toEqual(["operation.admitted", "policy.ask", "approval.rejected"])
  })

  test("claims durable exact authority before execution and verifies independently", async () => {
    const input = await operationInput("approved")
    const facts = makeGitStageOperationFacts(input)
    expect([...facts.resources]).toEqual([...input.preview.repositoryWrites])
    let claimCalls = 0
    let verifyCalls = 0
    const observation = operationObservation(input)
    const adapter = adapterThat(
      async (effectInput, claimProposal) => {
        expect(effectInput.inventory).toEqual(input.inventory)
        expect(await eventNames(input)).toEqual([
          "operation.admitted",
          "policy.ask",
          "approval.granted",
          "dispatch.requested",
          "executor.accepted",
        ])
        claimCalls += 1
        expect(await claimProposal(claim(input))).toBe("claimed")
        claimCalls += 1
        expect(await claimProposal(claim(input))).toBe("already_claimed")
        return { status: "effect_observed", verification: "not_verified", observation }
      },
      async (verifyInput) => {
        verifyCalls += 1
        expect(verifyInput.inventory).toEqual(input.inventory)
        expect(verifyInput.expectedBaseline).toEqual(input.expectedBaseline)
        expect(verifyInput.observation).toEqual(observation)
        return {
          status: "verified",
          verification: "independent_selected_index_and_preservation",
          proposalDigest: input.preview.proposalDigest,
          snapshotDigest: observation.afterSnapshotDigest,
          limitations: gitStageLimitations,
        }
      },
    )

    expect(await executeDurableGitStage(input, { adapter })).toMatchObject({
      state: "effect_observed",
      status: "effect_observed",
    })
    expect(claimCalls).toBe(2)
    expect(await verifyDurableGitStage(input, adapter)).toMatchObject({ state: "succeeded", status: "verified" })
    expect(await verifyDurableGitStage(input, adapter)).toMatchObject({ state: "succeeded", status: "verified" })
    expect(verifyCalls).toBe(1)
  })

  test("never invokes the adapter again for an exact approved replay", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async (_, claimProposal) => {
      calls += 1
      expect(await claimProposal(claim(input))).toBe("claimed")
      return { status: "effect_observed", verification: "not_verified", observation: operationObservation(input) }
    })

    expect(await executeDurableGitStage(input, { adapter })).toMatchObject({ status: "effect_observed" })
    expect(await executeDurableGitStage(input, { adapter })).toMatchObject({ status: "effect_observed" })
    expect(calls).toBe(1)
  })

  for (const point of ["after_claim_before_adapter", "after_adapter_before_spool"] as const) {
    test(`${point} recovers as uncertainty without retrying the effect`, async () => {
      const input = await operationInput("approved")
      let calls = 0
      const adapter = adapterThat(async (_, claimProposal) => {
        calls += 1
        expect(await claimProposal(claim(input))).toBe("claimed")
        return { status: "effect_observed", verification: "not_verified", observation: operationObservation(input) }
      })

      expect(
        await executeDurableGitStage(input, { adapter, injectFault: faultAt(point) }).catch((cause) => cause),
      ).toMatchObject({ code: "state_unavailable" })
      expect(await recoverDurableGitStage(input).catch((cause) => cause)).toMatchObject({
        code: "operation_in_progress",
      })
      expect(
        await recoverDurableGitStage(input, { now: () => Date.parse(input.recordingStartedAt) + 61_000 }),
      ).toMatchObject({ state: "reconciliation_required", receiptID: null })
      expect(calls).toBe(point === "after_claim_before_adapter" ? 0 : 1)
    })
  }

  test("recovers a spooled receipt without rerunning Git", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async (_, claimProposal) => {
      calls += 1
      expect(await claimProposal(claim(input))).toBe("claimed")
      return { status: "effect_observed", verification: "not_verified", observation: operationObservation(input) }
    })

    expect(
      await executeDurableGitStage(input, {
        adapter,
        injectFault: faultAt("after_spool_before_ledger"),
      }).catch((cause) => cause),
    ).toMatchObject({ code: "state_unavailable" })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(1)
    expect(await recoverDurableGitStage(input)).toMatchObject({ state: "effect_observed" })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
    expect(calls).toBe(1)
  })

  test("acknowledges an already-ledgered receipt after an acknowledgement fault", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async (_, claimProposal) => {
      calls += 1
      expect(await claimProposal(claim(input))).toBe("claimed")
      return { status: "effect_observed", verification: "not_verified", observation: operationObservation(input) }
    })

    expect(
      await executeDurableGitStage(input, {
        adapter,
        injectFault: faultAt("after_ledger_before_ack"),
      }).catch((cause) => cause),
    ).toMatchObject({ code: "state_unavailable" })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(1)
    expect(await recoverDurableGitStage(input)).toMatchObject({ state: "effect_observed" })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
    expect(calls).toBe(1)
  })
})

function adapterThat(
  execute: GitStageAdapter["execute"],
  verify: GitStageAdapter["verify"] = async () => ({
    status: "blocked",
    verification: "not_verified",
    reason: "post_state_unavailable",
  }),
): GitStageAdapter {
  return { execute, verify }
}

function claim(input: DurableGitStageInput) {
  return {
    proposalDigest: input.preview.proposalDigest,
    nonce: input.preview.nonce,
    expiresAt: input.preview.expiresAt,
    decision: "approved",
  } as const
}

function operationObservation(input: DurableGitStageInput): GitStageObservation {
  return {
    schemaVersion: 1,
    operation: "git_stage_paths",
    status: "effect_observed",
    verification: "not_verified",
    proposalDigest: input.preview.proposalDigest,
    beforeSnapshotDigest: input.expectedBaseline.snapshotDigest,
    afterSnapshotDigest: sha("after-snapshot"),
    afterIndexDigest: sha("after-index"),
    afterIndexMetadataDigest: sha("after-index-metadata"),
    objectOIDs: input.preview.candidates.flatMap((candidate) =>
      candidate.after.state === "object" ? [candidate.after.oid] : [],
    ),
    limitations: gitStageLimitations,
  }
}

function faultAt(expected: GitStageFaultPoint) {
  return async (point: GitStageFaultPoint) => {
    if (point === expected) throw new Error(`Injected Git stage coordinator fault at ${point}`)
  }
}

async function operationInput(decision: "approved" | "rejected"): Promise<DurableGitStageInput> {
  const workspace = await temporaryDirectory("astra-git-stage-workspace-")
  const state = await temporaryDirectory("astra-git-stage-state-")
  await mkdir(join(workspace, ".git"))
  await writeFile(join(workspace, ".git", "index"), "synthetic-index\n")
  const [rootFacts, gitFacts] = await Promise.all([
    stat(workspace, { bigint: true }),
    stat(join(workspace, ".git"), { bigint: true }),
  ])
  const baselineAuthority = {
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
    root: { canonicalPath: workspace, device: String(rootFacts.dev), inode: String(rootFacts.ino) },
    gitDirectory: { canonicalPath: join(workspace, ".git"), device: String(gitFacts.dev), inode: String(gitFacts.ino) },
    commonDirectory: {
      canonicalPath: join(workspace, ".git"),
      device: String(gitFacts.dev),
      inode: String(gitFacts.ino),
    },
    head: { kind: "symbolic", symbolicRef: "refs/heads/main", oid: "a".repeat(40) },
    refs: { digest: sha("refs"), count: 1 },
    index: { digest: sha("index"), metadataDigest: sha("index-metadata"), entryCount: 1 },
    worktree: {
      digest: sha("worktree"),
      ignored: "excluded",
      trackedPaths: 1,
      untrackedPaths: 1,
      contentEntries: 2,
      totalBytes: 8,
    },
    metadata: { digest: sha("metadata"), fileCount: 1, totalBytes: 1, externalConfig: "unsupported" },
    observer: {
      adapter: "astra.git-baseline.v1",
      adapterDigest: sha("baseline-adapter"),
      gitBinaryDigest: sha("git-binary"),
      observationDigest: sha("baseline-observation"),
    },
    limits: {
      timeoutMs: 5_000,
      maxStdoutBytes: 16_384,
      maxStderrBytes: 16_384,
      maxEntries: 1_000,
      maxBoundaryEntries: 1_000,
      maxBoundaryDurationMs: 5_000,
      maxGitBinaryBytes: 64 * 1024 * 1024,
      maxContentEntries: 1_000,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxDurationMs: 5_000,
    },
  } as const satisfies GitRepositoryBaselineSnapshotAuthority
  const expectedBaseline: GitRepositoryBaselineSnapshot = {
    ...baselineAuthority,
    snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(baselineAuthority),
  }
  const objectOID = "b".repeat(40)
  const candidateID = randomUUID()
  const inventoryAuthority = {
    schemaVersion: 1,
    workspaceRoot: workspace,
    baselineSnapshotDigest: expectedBaseline.snapshotDigest,
    inspectionObservationDigest: sha("inspection-observation"),
    inspectionReportDigest: sha("inspection-report"),
    objectFormat: "sha1",
    indexEntries: [],
    candidates: [
      {
        candidateID,
        path: "selected.txt",
        action: "upsert",
        before: { state: "absent" },
        after: {
          state: "object",
          mode: "100644",
          oid: objectOID,
          byteLength: 8,
          contentDigest: sha("selected-content"),
        },
        objectPath: `.git/objects/${objectOID.slice(0, 2)}/${objectOID.slice(2)}`,
      },
    ],
  } as const satisfies GitStageInventoryAuthority
  const inventory: GitStageInventory = {
    ...inventoryAuthority,
    inventoryDigest: computeGitStageInventoryDigest(inventoryAuthority),
  }
  const createdAtMilliseconds = Date.now() - 2_000
  const prepared = prepareGitStageSelected(inventory, [candidateID], createdAtMilliseconds)
  if (prepared.status !== "ready") throw new Error(`Stage fixture preparation failed: ${prepared.reason}`)
  const approval: GitStageDecision = {
    schemaVersion: 1,
    operation: "git_stage_paths",
    proposalDigest: prepared.preview.proposalDigest,
    nonce: prepared.preview.nonce,
    decision,
    decidedAt: new Date(createdAtMilliseconds + 1_000).toISOString(),
  }
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    preview: prepared.preview,
    inventory,
    expectedBaseline,
    decision: approval,
    recordingStartedAt: new Date(createdAtMilliseconds + 1_500).toISOString(),
  }
}

async function eventNames(input: DurableGitStageInput) {
  const operationID = parseOperationID(makeGitStageOperationFacts(input).operationID)
  if (!operationID.ok) throw new Error("Invalid test Operation ID")
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return (yield* ledger.readEvents(operationID.value, { limit: 20 })).map((event) => event.name)
    }),
  )
}

async function pendingReceiptCount(filename: string) {
  return runWithReceiptSpool(filename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return (yield* spool.listPending({ limit: 10 })).length
    }),
  )
}

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

function sha(seed: string): `sha256:${string}` {
  return `sha256:${new Bun.CryptoHasher("sha256").update(seed).digest("hex")}`
}
