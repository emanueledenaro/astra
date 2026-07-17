import { access } from "node:fs/promises"
import {
  parseGitStageObservation,
  type GitStageInventory,
  type GitStageObservation,
  type GitStagePreview,
} from "../../astra-domain/src/git-stage-mutation"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseOperationEffectUncertainty,
  parseOperationEvidence,
  parseOperationReceipt,
  parseContentDigest,
  type OperationEffectUncertainty,
  type OperationEvidence,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type {
  GitStageDurableClaim,
  GitStageDurableClaimResult,
  GitStageExecutionResult,
  GitStageVerificationResult,
} from "@astra/git"
import type { OperationRecord } from "@astra/ledger"
import { Effect } from "effect"
import { canonicalJson, digest } from "./controlled-write-authority"
import {
  gitStageAdapterDigest,
  gitStageExecutor,
  gitStageVerifier,
  gitStageVerifierDigest,
  makeGitStageOperationFacts,
  type GitStageOperationFactsInput,
} from "./git-stage-operation-facts"
import {
  assertSafeStateFile,
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithCoordinatorReceiptSpool,
  runWithLedger,
  runWithReceiptSpool,
  runWithVerificationLedger,
} from "./operation-storage"

const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 1_000

export const gitStageFaultPoints = [
  "after_claim_before_adapter",
  "after_adapter_before_spool",
  "after_spool_before_ledger",
  "after_ledger_before_ack",
] as const

export type GitStageFaultPoint = (typeof gitStageFaultPoints)[number]

export type DurableGitStageInput = GitStageOperationFactsInput &
  Readonly<{
    ledgerFilename: string
    spoolFilename: string
  }>

export type GitStageAdapter = Readonly<{
  execute: (
    input: Readonly<{
      preview: GitStagePreview
      inventory: GitStageInventory
      expectedBaseline: GitRepositoryBaselineSnapshot
      decision: DurableGitStageInput["decision"]
    }>,
    claimProposal: (claim: GitStageDurableClaim) => Promise<GitStageDurableClaimResult>,
  ) => Promise<GitStageExecutionResult>
  verify: (
    input: Readonly<{
      preview: GitStagePreview
      inventory: GitStageInventory
      expectedBaseline: GitRepositoryBaselineSnapshot
      observation: GitStageObservation
    }>,
  ) => Promise<GitStageVerificationResult>
}>

export type GitStageCoordinatorDependencies = Readonly<{
  adapter: GitStageAdapter
  injectFault?: (point: GitStageFaultPoint) => Promise<void>
  now?: () => number
}>

export type DurableGitStageResult = Readonly<{
  operationID: string
  state: "denied" | "effect_observed" | "failed" | "reconciliation_required" | "succeeded"
  status: "denied_without_effect" | "effect_observed" | "failed_without_effect" | "reconciliation_required" | "verified"
  sequence: number
  lastCursor: number
  receiptID: string | null
  observation: GitStageObservation | null
}>

export class GitStageCoordinationError extends Error {
  readonly _tag = "GitStageCoordinationError"

  constructor(
    readonly code: "invalid_input" | "state_unavailable" | "recovery_unavailable" | "operation_in_progress",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

/**
 * Records a rejection or executes one approved Git index mutation. The durable
 * ledger claim is consumed before the adapter can accept its proposal claim.
 */
export async function executeDurableGitStage(
  input: DurableGitStageInput,
  dependencies: GitStageCoordinatorDependencies,
): Promise<DurableGitStageResult> {
  try {
    const facts = makeGitStageOperationFacts(input)
    const now = dependencies.now ?? Date.now
    const clock = () => new Date(now()).toISOString()

    if (facts.decision.decision === "rejected") {
      await prepareOperationStateFiles(facts.preview.workspaceRoot, input.ledgerFilename, input.spoolFilename)
      const operation = await runWithCoordinatorLedger(
        input.ledgerFilename,
        (ledger) =>
          Effect.gen(function* () {
            yield* ledger.initialize()
            const appended = yield* ledger.appendBatch(facts.commands)
            const result = appended.at(-1)?.operation
            if (!result || result.state !== "denied") return yield* Effect.die("Git denial was not durable")
            return result
          }),
        clock,
      )
      return durableResult(operation, null)
    }

    const claimStartedAt = now()
    const authorizationEnd = Date.parse(facts.preview.expiresAt)
    if (claimStartedAt + minimumEffectLeaseMilliseconds >= authorizationEnd) {
      throw new GitStageCoordinationError("invalid_input", "The approved Git proposal has expired")
    }
    await prepareOperationStateFiles(facts.preview.workspaceRoot, input.ledgerFilename, input.spoolFilename)
    const existing = (await exists(input.ledgerFilename))
      ? await runWithLedger(input.ledgerFilename, (ledger) =>
          Effect.gen(function* () {
            yield* ledger.initialize()
            return yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
          }),
        )
      : null
    if (existing?.claim) return recoverDurableGitStage(input, { now })

    const claimed = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          yield* ledger.appendBatch(facts.commands)
          return yield* ledger.claimDispatch({
            dispatchRequestID: facts.dispatchRequestID,
            operationID: facts.operationID,
            attemptID: facts.attemptID,
            executor: gitStageExecutor,
            capabilityDigest: facts.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            claimExpiresAt: new Date(
              Math.min(claimStartedAt + claimLeaseMilliseconds, authorizationEnd - 1),
            ).toISOString(),
            event: {
              eventID: facts.eventIDs.claim,
              schemaVersion: 1,
              actor: { kind: "system", subject: gitStageExecutor, componentDigest: gitStageAdapterDigest },
              correlationID: facts.correlationID,
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
        }),
      clock,
    )
    if (claimed.kind === "replayed") return recoverDurableGitStage(input, { now })
    await dependencies.injectFault?.("after_claim_before_adapter")

    let bridgeAttempted = false
    let bridgeAccepted = false
    const claimProposal = async (proposal: GitStageDurableClaim) => {
      if (bridgeAttempted) return "already_claimed" as const
      bridgeAttempted = true
      if (
        proposal.proposalDigest !== facts.preview.proposalDigest ||
        proposal.nonce !== facts.preview.nonce ||
        proposal.expiresAt !== facts.preview.expiresAt ||
        proposal.decision !== "approved"
      ) {
        return "unavailable" as const
      }
      const authority = await runWithCoordinatorLedger(
        input.ledgerFilename,
        (ledger) =>
          Effect.gen(function* () {
            yield* ledger.initialize()
            return yield* ledger.validateEffectAuthority({
              operationID: facts.operationID,
              dispatchRequestID: facts.dispatchRequestID,
              attemptID: facts.attemptID,
              capabilityGrantID: facts.capabilityGrantID,
              capabilityDigest: facts.capabilityDigest,
              executorClaimID: facts.executorClaimID,
              fencingToken: claimed.claim.fencingToken,
              executor: gitStageExecutor,
              adapterDigest: gitStageAdapterDigest,
              baselineDigest: facts.baselineTrustDigest,
              minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
            })
          }),
        clock,
      ).catch(() => null)
      if (!authority?.allowed) return "unavailable" as const
      bridgeAccepted = true
      return "claimed" as const
    }
    const effect = await dependencies.adapter.execute(
      {
        preview: facts.preview,
        inventory: facts.inventory,
        expectedBaseline: facts.baseline,
        decision: facts.decision,
      },
      claimProposal,
    )
    await dependencies.injectFault?.("after_adapter_before_spool")

    if ((effect.status === "effect_observed" || effect.status === "effect_unknown") && !bridgeAccepted) {
      throw new GitStageCoordinationError(
        "state_unavailable",
        "The Git adapter entered an effect path without accepting durable authority",
      )
    }
    const execution = normalizeExecutionObservation(effect, facts)
    const endedAt = clock()
    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(input, facts, claimed.claim.fencingToken, endedAt, clock)
    }
    const receipt = makeReceipt(facts, claimed.claim.fencingToken, claimed.claim.acceptedAt, endedAt, execution)
    await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(receipt)
      }),
    )
    await dependencies.injectFault?.("after_spool_before_ledger")

    const ingested = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          return yield* ledger.ingestReceipt({
            receipt,
            event: {
              eventID: facts.eventIDs.receipt,
              schemaVersion: 1,
              correlationID: facts.correlationID,
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
        }),
      clock,
    )
    await dependencies.injectFault?.("after_ledger_before_ack")
    await acknowledgeReceipt(input.spoolFilename, receipt, ingested.event.eventID, ingested.event.digest)
    return durableResult(ingested.operation, receipt)
  } catch (cause) {
    if (cause instanceof GitStageCoordinationError) throw cause
    throw new GitStageCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The Git stage Operation could not complete its durable path",
      cause,
    )
  }
}

/** Recovers durable transfer or uncertainty and never invokes the Git adapter. */
export async function recoverDurableGitStage(
  input: DurableGitStageInput,
  dependencies: Readonly<{ now?: () => number }> = {},
): Promise<DurableGitStageResult> {
  try {
    const facts = makeGitStageOperationFacts(input)
    if (facts.decision.decision !== "approved") {
      throw new GitStageCoordinationError("invalid_input", "Only an approved Git Operation can be recovered")
    }
    await prepareOperationStateFiles(facts.preview.workspaceRoot, input.ledgerFilename, input.spoolFilename)
    const now = dependencies.now ?? Date.now
    const clock = () => new Date(now()).toISOString()
    if (await exists(input.spoolFilename)) await ingestPendingReceipt(input, facts, clock)

    const durable = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        const operation = yield* ledger.getOperation(facts.operationID)
        const dispatch = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        return { operation, dispatch }
      }),
    )
    if (!durable.operation || !durable.dispatch) {
      throw new GitStageCoordinationError("recovery_unavailable", "No durable Git Operation is available")
    }
    if (durable.dispatch.recoveryStatus === "claimed_no_receipt") {
      if (now() < Date.parse(durable.dispatch.claim!.claimExpiresAt)) {
        throw new GitStageCoordinationError(
          "operation_in_progress",
          "The exact Git claim is still active and will not be retried",
        )
      }
      return recordUncertainty(input, facts, durable.dispatch.claim!.fencingToken, clock(), clock)
    }
    if (durable.dispatch.recoveryStatus === "pending_outbox") {
      throw new GitStageCoordinationError(
        "recovery_unavailable",
        "The Git dispatch was not claimed and is never retried automatically",
      )
    }
    return durableResult(durable.operation, durable.dispatch.receipt)
  } catch (cause) {
    if (cause instanceof GitStageCoordinationError) throw cause
    throw new GitStageCoordinationError(
      "recovery_unavailable",
      "The Git stage Operation could not be reconciled without retrying its effect",
      cause,
    )
  }
}

/** Runs the separately injected Git verifier and persists its evidence. */
export async function verifyDurableGitStage(
  input: DurableGitStageInput,
  adapter: Pick<GitStageAdapter, "verify">,
): Promise<DurableGitStageResult> {
  try {
    const facts = makeGitStageOperationFacts(input)
    if (facts.decision.decision !== "approved") {
      throw new GitStageCoordinationError("invalid_input", "A rejected Git Operation cannot be verified")
    }
    await assertSafeStateFile(facts.preview.workspaceRoot, input.ledgerFilename)
    const durable = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        const operation = yield* ledger.getOperation(facts.operationID)
        const verification = yield* ledger.getVerification(facts.operationID)
        const dispatch = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        return { operation, verification, dispatch }
      }),
    )
    if (!durable.operation || !durable.dispatch?.receipt) {
      throw new GitStageCoordinationError("recovery_unavailable", "No observed Git receipt is available")
    }
    if (durable.verification) return durableResult(durable.operation, durable.dispatch.receipt)
    if (
      durable.operation.state !== "effect_observed" ||
      durable.dispatch.receipt.observation.kind !== "effect_observed" ||
      durable.dispatch.receipt.capabilityDigest !== facts.capabilityDigest
    ) {
      throw new GitStageCoordinationError("recovery_unavailable", "The Git effect is not independently verifiable")
    }
    const observation = receiptObservation(durable.dispatch.receipt, facts)
    const verification = await adapter.verify({
      preview: facts.preview,
      inventory: facts.inventory,
      expectedBaseline: facts.baseline,
      observation,
    })
    const verified =
      verification.status === "verified" &&
      verification.verification === "independent_selected_index_and_preservation" &&
      verification.proposalDigest === facts.preview.proposalDigest &&
      verification.snapshotDigest === observation.afterSnapshotDigest &&
      canonicalJson(verification.limitations) === canonicalJson(facts.preview.limitations)
    const evidence = requireEvidence({
      evidenceID: facts.evidenceID,
      operationID: facts.operationID,
      receiptID: facts.receiptID,
      verificationPlanID: facts.verificationPlanID,
      verifier: { identity: gitStageVerifier, version: "1", digest: gitStageVerifierDigest },
      snapshotDigest: verified ? verification.snapshotDigest : digest(canonicalJson(verification)),
      observedAt: new Date().toISOString(),
      criteria: [
        {
          criterionID: "independent_git_index_post_state",
          result: verified ? "passed" : "unknown",
          observationDigest: verified ? facts.expectedVerificationDigest : digest(canonicalJson(verification)),
        },
      ],
      limitations: verified
        ? [...verification.limitations]
        : [`git_verification_${verification.status}_${"reason" in verification ? verification.reason : "unknown"}`],
    })
    const ingested = await runWithVerificationLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.ingestEvidence({
          evidence,
          startedEvent: {
            eventID: facts.eventIDs.verificationStarted,
            schemaVersion: 1,
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
          terminalEvent: {
            eventID: facts.eventIDs.verificationTerminal,
            schemaVersion: 1,
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    )
    return durableResult(ingested.operation, durable.dispatch.receipt)
  } catch (cause) {
    if (cause instanceof GitStageCoordinationError) throw cause
    throw new GitStageCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "Independent Git stage verification could not complete",
      cause,
    )
  }
}

async function ingestPendingReceipt(
  input: DurableGitStageInput,
  facts: ReturnType<typeof makeGitStageOperationFacts>,
  clock: () => string,
) {
  const pending = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.listPending({ limit: 2 })
    }),
  )
  if (pending.length > 1) {
    throw new GitStageCoordinationError("recovery_unavailable", "Multiple Git receipts require reconciliation")
  }
  const entry = pending[0]
  if (!entry) return
  if (
    entry.receipt.operationID !== facts.operationID ||
    entry.receipt.receiptID !== facts.receiptID ||
    entry.receipt.capabilityDigest !== facts.capabilityDigest
  ) {
    throw new GitStageCoordinationError("recovery_unavailable", "The pending Git receipt is not bound here")
  }
  const ingested = await runWithCoordinatorLedger(
    input.ledgerFilename,
    (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.ingestReceipt({
          receipt: entry.receipt,
          event: {
            eventID: facts.eventIDs.receipt,
            schemaVersion: 1,
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    clock,
  )
  await acknowledgeReceipt(input.spoolFilename, entry.receipt, ingested.event.eventID, ingested.event.digest)
}

async function acknowledgeReceipt(
  spoolFilename: string,
  receipt: OperationReceipt,
  ledgerEventID: string,
  ledgerEventDigest: string,
) {
  await runWithCoordinatorReceiptSpool(spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      yield* spool.acknowledgeIngestedReceipt({ receiptID: receipt.receiptID, ledgerEventID, ledgerEventDigest })
    }),
  )
}

async function recordUncertainty(
  input: DurableGitStageInput,
  facts: ReturnType<typeof makeGitStageOperationFacts>,
  fencingToken: number,
  observedAt: string,
  clock: () => string,
) {
  const uncertainty = requireUncertainty({
    uncertaintyID: facts.uncertaintyID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    reason: "claimed_without_receipt",
    observedAt,
    targetObservation: {
      state: "unavailable",
      digest: digest(
        canonicalJson({
          baselineSnapshotDigest: facts.baseline.snapshotDigest,
          proposalDigest: facts.preview.proposalDigest,
          state: "claimed_without_durable_receipt",
        }),
      ),
    },
  })
  const recorded = await runWithCoordinatorLedger(
    input.ledgerFilename,
    (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.recordClaimUncertainty({
          uncertainty,
          event: {
            eventID: facts.eventIDs.uncertainty,
            schemaVersion: 1,
            actor: {
              kind: "system",
              subject: "astra-coordinator:git-stage-recovery",
              componentDigest: gitStageAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    clock,
  )
  return durableResult(recorded.operation, null)
}

function makeReceipt(
  facts: ReturnType<typeof makeGitStageOperationFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  effect: GitStageExecutionResult,
) {
  const observed = effect.status === "effect_observed" ? effect.observation : null
  const output = canonicalJson(observed ?? effect)
  const observation: OperationReceipt["observation"] = observed
    ? {
        kind: "effect_observed",
        beforeDigest: requireContentDigest(facts.baseline.snapshotDigest),
        afterDigest: requireContentDigest(observed.afterSnapshotDigest),
      }
    : effect.status === "blocked_without_effect" || effect.status === "denied_without_effect"
      ? { kind: "no_effect_proved", proofDigest: digest(output) }
      : { kind: "effect_unknown", observationDigest: digest(output) }
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: gitStageExecutor, version: "1", digest: gitStageAdapterDigest },
    effectClass: "git_index_mutation",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation,
    verificationContext: {
      schemaVersion: 2,
      admittedBaselineDigest: facts.baselineTrustDigest,
      admittedRepositorySnapshotDigest: facts.baseline.snapshotDigest,
      postEffectWorkspaceDigest: observed?.afterSnapshotDigest ?? null,
      postEffectRepositorySnapshotDigest: observed?.afterSnapshotDigest ?? null,
      workspaceIdentity: { device: facts.baseline.root.device, inode: facts.baseline.root.inode },
      targetIdentity: null,
      preflightLimits: {
        maxEntries: facts.baseline.limits.maxEntries,
        maxFileBytes: facts.baseline.limits.maxFileBytes,
        maxTotalBytes: facts.baseline.limits.maxTotalBytes,
        maxDurationMs: facts.baseline.limits.maxDurationMs,
      },
      activationGuard: observed ? "allowed" : "blocked",
    },
    output: { digest: digest(output), bytes: Buffer.byteLength(output), preview: output },
  })
}

function normalizeExecutionObservation(
  effect: GitStageExecutionResult,
  facts: ReturnType<typeof makeGitStageOperationFacts>,
): GitStageExecutionResult {
  if (effect.status !== "effect_observed") return effect
  const parsed = parseGitStageObservation(effect.observation)
  if (
    !parsed.ok ||
    parsed.value.proposalDigest !== facts.preview.proposalDigest ||
    parsed.value.beforeSnapshotDigest !== facts.baseline.snapshotDigest ||
    canonicalJson(parsed.value.limitations) !== canonicalJson(facts.preview.limitations)
  ) {
    throw new GitStageCoordinationError(
      "state_unavailable",
      "The Git adapter observation is not bound to the admitted proposal and baseline",
    )
  }
  return { status: "effect_observed", verification: "not_verified", observation: parsed.value }
}

function receiptObservation(receipt: OperationReceipt, facts?: ReturnType<typeof makeGitStageOperationFacts>) {
  if (
    receipt.output.bytes !== Buffer.byteLength(receipt.output.preview) ||
    receipt.output.digest !== digest(receipt.output.preview)
  ) {
    throw new TypeError("The durable Git observation payload is corrupt")
  }
  const decoded = parseJson(receipt.output.preview)
  const parsed = parseGitStageObservation(decoded)
  if (!parsed.ok) throw new TypeError(`The durable Git observation is invalid: ${parsed.reason}`)
  if (
    receipt.observation.kind !== "effect_observed" ||
    parsed.value.beforeSnapshotDigest !== receipt.observation.beforeDigest ||
    parsed.value.afterSnapshotDigest !== receipt.observation.afterDigest ||
    (facts !== undefined &&
      (parsed.value.proposalDigest !== facts.preview.proposalDigest ||
        parsed.value.beforeSnapshotDigest !== facts.baseline.snapshotDigest ||
        canonicalJson(parsed.value.limitations) !== canonicalJson(facts.preview.limitations)))
  ) {
    throw new TypeError(
      `The durable Git observation does not match its receipt: ${canonicalJson({
        parsedBefore: parsed.value.beforeSnapshotDigest,
        parsedAfter: parsed.value.afterSnapshotDigest,
        receiptBefore: receipt.observation.kind === "effect_observed" ? receipt.observation.beforeDigest : null,
        receiptAfter: receipt.observation.kind === "effect_observed" ? receipt.observation.afterDigest : null,
      })}`,
    )
  }
  return parsed.value
}

function durableResult(operation: OperationRecord, receipt: OperationReceipt | null): DurableGitStageResult {
  if (
    operation.state !== "denied" &&
    operation.state !== "effect_observed" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required" &&
    operation.state !== "succeeded"
  ) {
    throw new GitStageCoordinationError(
      "recovery_unavailable",
      `Git Operation state ${operation.state} is outside the durable boundary`,
    )
  }
  const status =
    operation.state === "denied"
      ? "denied_without_effect"
      : operation.state === "effect_observed"
        ? "effect_observed"
        : operation.state === "failed"
          ? "failed_without_effect"
          : operation.state === "succeeded"
            ? "verified"
            : "reconciliation_required"
  return {
    operationID: operation.operationID,
    state: operation.state,
    status,
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    observation: receipt?.observation.kind === "effect_observed" ? receiptObservation(receipt) : null,
  }
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`The Git receipt is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError(`The Git uncertainty is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireEvidence(input: unknown): OperationEvidence {
  const parsed = parseOperationEvidence(input)
  if (!parsed.ok) throw new TypeError(`The Git evidence is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireContentDigest(input: unknown) {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The Git content digest is invalid")
  return parsed.value
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    throw new TypeError("The durable Git observation is not valid JSON")
  }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
