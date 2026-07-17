import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeGitUnstageAllProposalDigest,
  gitUnstageAllBoundaryLabel,
  gitUnstageAllLimitations,
  type GitUnstageAllDecision,
  type GitUnstageAllObservation,
  type GitUnstageAllPreview,
  type GitUnstageAllPreviewAuthority,
} from "@astra/domain/git-control-mutation"
import {
  computeGitRepositoryBaselineSnapshotDigest,
  type GitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshotAuthority,
} from "@astra/domain/git-repository-baseline"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import {
  executeDurableGitUnstage,
  recoverDurableGitUnstage,
  verifyDurableGitUnstage,
  type DurableGitUnstageInput,
  type GitUnstageAdapter,
  type GitUnstageFaultPoint,
} from "../src/git-unstage-coordinator"
import { makeGitUnstageOperationFacts } from "../src/git-unstage-operation-facts"
import { runWithLedger, runWithReceiptSpool } from "../src/operation-storage"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable Git unstage Operation coordinator", () => {
  test("records rejection durably without invoking any Git adapter boundary", async () => {
    const input = await operationInput("rejected")
    let calls = 0
    const adapter = adapterThat(async () => {
      calls += 1
      throw new Error("A denied operation reached the adapter")
    })

    expect(await executeDurableGitUnstage(input, { adapter })).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
      receiptID: null,
    })
    expect(calls).toBe(0)
    expect(await eventNames(input)).toEqual(["operation.admitted", "policy.ask", "approval.rejected"])
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
  })

  test("consumes ledger authority before the adapter claim and verifies only through independent evidence", async () => {
    const input = await operationInput("approved")
    let claimCalls = 0
    let verifyCalls = 0
    const observation = operationObservation(input)
    const adapter = adapterThat(async (_, claimProposal) => {
      expect(await eventNames(input)).toEqual([
        "operation.admitted",
        "policy.ask",
        "approval.granted",
        "dispatch.requested",
        "executor.accepted",
      ])
      claimCalls += 1
      expect(
        await claimProposal({
          proposalDigest: input.preview.proposalDigest,
          nonce: input.preview.nonce,
          expiresAt: input.preview.expiresAt,
          decision: "approved",
        }),
      ).toBe("claimed")
      claimCalls += 1
      expect(
        await claimProposal({
          proposalDigest: input.preview.proposalDigest,
          nonce: input.preview.nonce,
          expiresAt: input.preview.expiresAt,
          decision: "approved",
        }),
      ).toBe("already_claimed")
      return { status: "effect_observed", verification: "not_verified", observation }
    }, async ({ observation: candidate }) => {
      verifyCalls += 1
      expect(candidate).toEqual(observation)
      return {
        status: "verified",
        verification: "independent_post_state",
        proposalDigest: input.preview.proposalDigest,
        snapshotDigest: observation.afterSnapshotDigest,
        limitations: gitUnstageAllLimitations,
      }
    })

    const executed = await executeDurableGitUnstage(input, { adapter })
    expect(executed).toMatchObject({ state: "effect_observed", status: "effect_observed" })
    expect(executed.status).not.toBe("verified")
    expect(executed.observation).toEqual(observation)
    expect(claimCalls).toBe(2)
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.observed",
    ])

    expect(await verifyDurableGitUnstage(input, adapter)).toMatchObject({ state: "succeeded", status: "verified" })
    expect(verifyCalls).toBe(1)
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.observed",
      "verification.started",
      "verification.passed",
    ])
    expect(await verifyDurableGitUnstage(input, adapter)).toMatchObject({ state: "succeeded", status: "verified" })
    expect(verifyCalls).toBe(1)
  })

  test("never invokes the adapter again for an exact approved replay", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const observation = operationObservation(input)
    const adapter = adapterThat(async (_, claimProposal) => {
      calls += 1
      expect(await claimProposal(claim(input))).toBe("claimed")
      return { status: "effect_observed", verification: "not_verified", observation }
    })

    expect(await executeDurableGitUnstage(input, { adapter })).toMatchObject({ status: "effect_observed" })
    expect(await executeDurableGitUnstage(input, { adapter })).toMatchObject({ status: "effect_observed" })
    expect(calls).toBe(1)
  })

  for (const point of ["after_claim_before_adapter", "after_adapter_before_spool"] as const) {
    test(`${point} becomes reconciliation required after lease expiry without a blind retry`, async () => {
      const input = await operationInput("approved")
      let calls = 0
      const adapter = adapterThat(async (_, claimProposal) => {
        calls += 1
        expect(await claimProposal(claim(input))).toBe("claimed")
        return {
          status: "effect_observed",
          verification: "not_verified",
          observation: operationObservation(input),
        }
      })

      expect(
        await executeDurableGitUnstage(input, { adapter, injectFault: faultAt(point) }).catch((cause) => cause),
      ).toMatchObject({ code: "state_unavailable" })
      expect(await recoverDurableGitUnstage(input).catch((cause) => cause)).toMatchObject({
        code: "operation_in_progress",
      })
      const recovered = await recoverDurableGitUnstage(input, {
        now: () => Date.parse(input.recordingStartedAt) + 61_000,
      })
      expect(recovered).toMatchObject({
        state: "reconciliation_required",
        status: "reconciliation_required",
        receiptID: null,
      })
      expect(calls).toBe(point === "after_claim_before_adapter" ? 0 : 1)
      expect(await eventNames(input)).toEqual([
        "operation.admitted",
        "policy.ask",
        "approval.granted",
        "dispatch.requested",
        "executor.accepted",
        "effect.unknown",
      ])
      expect(
        await executeDurableGitUnstage(input, { adapter, now: () => Date.parse(input.recordingStartedAt) + 62_000 }),
      ).toMatchObject({ state: "reconciliation_required" })
      expect(calls).toBe(point === "after_claim_before_adapter" ? 0 : 1)
    })
  }

  test("recovers a spooled observed receipt without rerunning Git", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async (_, claimProposal) => {
      calls += 1
      expect(await claimProposal(claim(input))).toBe("claimed")
      return {
        status: "effect_observed",
        verification: "not_verified",
        observation: operationObservation(input),
      }
    })

    expect(
      await executeDurableGitUnstage(input, {
        adapter,
        injectFault: faultAt("after_spool_before_ledger"),
      }).catch((cause) => cause),
    ).toMatchObject({ code: "state_unavailable" })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(1)

    expect(await recoverDurableGitUnstage(input)).toMatchObject({ state: "effect_observed" })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
    expect(calls).toBe(1)
  })

  test("persists unknown verification instead of promoting stale post-state", async () => {
    const input = await operationInput("approved")
    const adapter = adapterThat(
      async (_, claimProposal) => {
        expect(await claimProposal(claim(input))).toBe("claimed")
        return {
          status: "effect_observed",
          verification: "not_verified",
          observation: operationObservation(input),
        }
      },
      async () => ({ status: "stale", verification: "not_verified", reason: "post_state_changed" }),
    )
    expect(await executeDurableGitUnstage(input, { adapter })).toMatchObject({ state: "effect_observed" })

    expect(await verifyDurableGitUnstage(input, adapter)).toMatchObject({
      state: "reconciliation_required",
      status: "reconciliation_required",
    })
    expect(await eventNames(input)).toContain("verification.unknown")
  })

  test("refuses a verifier success that is not bound to the exact observed post-state", async () => {
    const input = await operationInput("approved")
    const adapter = adapterThat(
      async (_, claimProposal) => {
        expect(await claimProposal(claim(input))).toBe("claimed")
        return {
          status: "effect_observed",
          verification: "not_verified",
          observation: operationObservation(input),
        }
      },
      async () => ({
        status: "verified",
        verification: "independent_post_state",
        proposalDigest: input.preview.proposalDigest,
        snapshotDigest: sha("different-post-state"),
        limitations: gitUnstageAllLimitations,
      }),
    )
    expect(await executeDurableGitUnstage(input, { adapter })).toMatchObject({ state: "effect_observed" })

    expect(await verifyDurableGitUnstage(input, adapter)).toMatchObject({
      state: "reconciliation_required",
      status: "reconciliation_required",
    })
    expect(await eventNames(input)).toContain("verification.unknown")
  })

  test("rejects an effect observation bound to another proposal before spooling a receipt", async () => {
    const input = await operationInput("approved")
    const adapter = adapterThat(async (_, claimProposal) => {
      expect(await claimProposal(claim(input))).toBe("claimed")
      return {
        status: "effect_observed",
        verification: "not_verified",
        observation: { ...operationObservation(input), proposalDigest: sha("another-proposal") },
      }
    })

    expect(await executeDurableGitUnstage(input, { adapter }).catch((cause) => cause)).toMatchObject({
      code: "state_unavailable",
    })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
    expect(
      await recoverDurableGitUnstage(input, {
        now: () => Date.parse(input.recordingStartedAt) + 61_000,
      }),
    ).toMatchObject({ state: "reconciliation_required", receiptID: null })
  })

  test("does not accept an unknown effect path before the adapter consumes durable authority", async () => {
    const input = await operationInput("approved")
    const adapter = adapterThat(async () => ({
      status: "effect_unknown",
      verification: "not_verified",
      reason: "process_failed",
    }))

    expect(await executeDurableGitUnstage(input, { adapter }).catch((cause) => cause)).toMatchObject({
      code: "state_unavailable",
    })
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
    expect(
      await recoverDurableGitUnstage(input, {
        now: () => Date.parse(input.recordingStartedAt) + 61_000,
      }),
    ).toMatchObject({ state: "reconciliation_required", receiptID: null })
  })

  test("rejects stale or mismatched approval before creating durable state or calling the adapter", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async () => {
      calls += 1
      throw new Error("Invalid authority reached the adapter")
    })
    const stale = {
      ...input,
      decision: { ...input.decision, nonce: randomUUID() },
    }

    expect(await executeDurableGitUnstage(stale, { adapter }).catch((cause) => cause)).toMatchObject({
      code: "invalid_input",
    })
    expect(calls).toBe(0)
    expect(await exists(input.ledgerFilename)).toBeFalse()
  })

  test("rejects an expired approval before admission and never reaches the adapter", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async () => {
      calls += 1
      throw new Error("Expired authority reached the adapter")
    })

    expect(
      await executeDurableGitUnstage(input, {
        adapter,
        now: () => Date.parse(input.preview.expiresAt) + 1,
      }).catch((cause) => cause),
    ).toMatchObject({ code: "invalid_input" })
    expect(calls).toBe(0)
    expect(await exists(input.ledgerFilename)).toBeFalse()
  })

  test("a concurrent exact race crosses the adapter boundary at most once", async () => {
    const input = await operationInput("approved")
    let calls = 0
    const adapter = adapterThat(async (_, claimProposal) => {
      calls += 1
      expect(await claimProposal(claim(input))).toBe("claimed")
      await Bun.sleep(20)
      return {
        status: "effect_observed",
        verification: "not_verified",
        observation: operationObservation(input),
      }
    })

    const results = await Promise.allSettled([
      executeDurableGitUnstage(input, { adapter }),
      executeDurableGitUnstage(input, { adapter }),
    ])
    expect(calls).toBe(1)
    expect(results.some((result) => result.status === "fulfilled")).toBeTrue()
    expect(await recoverDurableGitUnstage(input)).toMatchObject({ state: "effect_observed" })
  }, 15_000)
})

function adapterThat(
  execute: GitUnstageAdapter["execute"],
  verify: GitUnstageAdapter["verify"] = async () => ({
    status: "blocked",
    verification: "not_verified",
    reason: "post_state_unavailable",
  }),
): GitUnstageAdapter {
  return { execute, verify }
}

function claim(input: DurableGitUnstageInput) {
  return {
    proposalDigest: input.preview.proposalDigest,
    nonce: input.preview.nonce,
    expiresAt: input.preview.expiresAt,
    decision: "approved",
  } as const
}

function operationObservation(input: DurableGitUnstageInput): GitUnstageAllObservation {
  return {
    schemaVersion: 1,
    operation: "git_unstage_all",
    status: "effect_observed",
    verification: "not_verified",
    proposalDigest: input.preview.proposalDigest,
    beforeSnapshotDigest: input.expectedBaseline.snapshotDigest,
    afterSnapshotDigest: sha("after-snapshot"),
    afterIndexDigest: sha("after-index"),
    afterIndexMetadataDigest: sha("after-index-metadata"),
    processObservationDigest: sha("process-observation"),
    scratchCleanup: "observed_absent_before_return",
    limitations: gitUnstageAllLimitations,
  }
}

function faultAt(expected: GitUnstageFaultPoint) {
  return async (point: GitUnstageFaultPoint) => {
    if (point === expected) throw new Error(`Injected Git coordinator fault at ${point}`)
  }
}

async function operationInput(decision: "approved" | "rejected"): Promise<DurableGitUnstageInput> {
  const workspace = await temporaryDirectory("astra-git-operation-workspace-")
  const state = await temporaryDirectory("astra-git-operation-state-")
  await mkdir(join(workspace, ".git"))
  await writeFile(join(workspace, ".git", "index"), "synthetic-index\n")
  const [rootFacts, gitFacts, indexFacts] = await Promise.all([
    stat(workspace, { bigint: true }),
    stat(join(workspace, ".git"), { bigint: true }),
    stat(join(workspace, ".git", "index"), { bigint: true }),
  ])
  const rootIdentity = { device: String(rootFacts.dev), inode: String(rootFacts.ino) }
  const gitIdentity = { canonicalPath: join(workspace, ".git"), device: String(gitFacts.dev), inode: String(gitFacts.ino) }
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
    root: { canonicalPath: workspace, ...rootIdentity },
    gitDirectory: gitIdentity,
    commonDirectory: gitIdentity,
    head: { kind: "symbolic", symbolicRef: "refs/heads/main", oid: "a".repeat(40) },
    refs: { digest: sha("refs"), count: 1 },
    index: { digest: sha("index"), metadataDigest: sha("index-metadata"), entryCount: 1 },
    worktree: {
      digest: sha("worktree"),
      ignored: "excluded",
      trackedPaths: 1,
      untrackedPaths: 0,
      contentEntries: 1,
      totalBytes: 1,
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
  const nonce = randomUUID()
  const createdAtMilliseconds = Date.now() - 2_000
  const createdAt = new Date(createdAtMilliseconds).toISOString()
  const expiresAt = new Date(createdAtMilliseconds + 5 * 60_000).toISOString()
  const runtimeScratch = join(tmpdir(), `astra-git-unstage-${nonce}`)
  const previewAuthority = {
    schemaVersion: 1,
    operation: "git_unstage_all",
    boundary: "host_no_sandbox",
    boundaryLabel: gitUnstageAllBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: workspace,
    nonce,
    createdAt,
    expiresAt,
    runtimeScratch,
    stagedCount: 1,
    baseline: {
      snapshotDigest: expectedBaseline.snapshotDigest,
      rootIdentity,
      gitIdentity: { device: gitIdentity.device, inode: gitIdentity.inode },
      indexDigest: expectedBaseline.index.digest,
      indexMetadataDigest: expectedBaseline.index.metadataDigest,
      indexIdentity: {
        device: String(indexFacts.dev),
        inode: String(indexFacts.ino),
        size: Number(indexFacts.size),
      },
      head: baselineAuthority.head,
      refsDigest: expectedBaseline.refs.digest,
      worktreeDigest: expectedBaseline.worktree.digest,
    },
    inspection: { observationDigest: sha("inspection-observation"), reportDigest: sha("inspection-report") },
    executableDigest: sha("sealed-git"),
    invocation: {
      argumentsDigest: sha("arguments"),
      environmentDigest: sha("environment"),
      timeoutMs: 5_000,
      maxStdoutBytes: 16_384,
      maxStderrBytes: 16_384,
    },
    repositoryWrites: [".git/index", ".git/index.lock"],
    scratchWrites: [runtimeScratch, join(runtimeScratch, "index"), join(runtimeScratch, "index.lock")],
    scratchCleanup: "required_before_return",
    authorizationConsumption: "durable_operation_kernel_claim_required",
    preserves: { worktree: "required", head: "required", refs: "required", objectStore: "not_observed" },
    network: "not_requested_host_unrestricted",
    splitIndex: {
      config: "absent",
      sharedIndexFiles: "absent",
      indexExtension: "rejected_by_baseline",
      invocation: "forced_disabled",
    },
    limitations: gitUnstageAllLimitations,
  } as const satisfies GitUnstageAllPreviewAuthority
  const preview: GitUnstageAllPreview = {
    ...previewAuthority,
    proposalDigest: computeGitUnstageAllProposalDigest(previewAuthority),
  }
  const decidedAt = new Date(createdAtMilliseconds + 1_000).toISOString()
  const approval: GitUnstageAllDecision = {
    schemaVersion: 1,
    operation: "git_unstage_all",
    proposalDigest: preview.proposalDigest,
    nonce,
    decision,
    decidedAt,
  }
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    preview,
    expectedBaseline,
    decision: approval,
    recordingStartedAt: new Date(createdAtMilliseconds + 1_500).toISOString(),
  }
}

async function eventNames(input: DurableGitUnstageInput) {
  const operationID = parseOperationID(makeGitUnstageOperationFacts(input).operationID)
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

async function exists(path: string) {
  return Bun.file(path).exists()
}
