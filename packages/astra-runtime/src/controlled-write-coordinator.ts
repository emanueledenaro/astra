import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, open } from "node:fs/promises"
import { join } from "node:path"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseOperationEffectUncertainty,
  parseOperationReceipt,
  type OperationEffectUncertainty,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { OperationRecord } from "@astra/ledger"
import { captureGitRepositoryBaseline, revalidateGitRepositoryBaseline } from "@astra/git"
import { Effect } from "effect"
import { prepareControlledWrite, type ControlledWriteResult } from "./controlled-write"
import type { ControlledWritePlan } from "./controlled-write-plan"
import {
  canonicalJson,
  controlledWriteAdapterDigest,
  controlledWriteExecutor,
  digest,
  makeApprovedControlledWriteFacts,
} from "./controlled-write-operation-facts"
import {
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithCoordinatorReceiptSpool,
  runWithLedger,
  runWithReceiptSpool,
} from "./operation-storage"
import { checkWorkspaceActivation, scanWorkspace } from "./workspace-preflight"

const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 5_000

export const controlledWriteFaultPoints = [
  "after_claim_before_effect",
  "after_effect_before_spool",
  "after_spool_before_ledger",
  "after_ledger_before_ack",
] as const

export type ControlledWriteFaultPoint = (typeof controlledWriteFaultPoints)[number]

export type ExecuteApprovedControlledWriteInput = Readonly<{
  ledgerFilename: string
  spoolFilename: string
  plan: ControlledWritePlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
  approvalGrantedAt: string
  recordingStartedAt: string
}>

export type ControlledWriteCoordinatorDependencies = Readonly<{
  injectFault?: (point: ControlledWriteFaultPoint) => Promise<void>
  beforeEffectBoundary?: () => Promise<void>
  now?: () => number
}>

export type DurableControlledWriteResult = Readonly<{
  operationID: string
  state: "effect_observed" | "failed" | "reconciliation_required"
  sequence: number
  lastCursor: number
  receiptID: string | null
  status: "effect_observed" | "failed_without_effect" | "reconciliation_required"
}>

export class ControlledWriteCoordinationError extends Error {
  readonly _tag = "ControlledWriteCoordinationError"

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
 * Executes one approved create-only attempt. It records observation, never
 * verification; only the independent verifier may advance to succeeded.
 */
export async function executeApprovedControlledWrite(
  input: ExecuteApprovedControlledWriteInput,
  dependencies: ControlledWriteCoordinatorDependencies = {},
): Promise<DurableControlledWriteResult> {
  try {
    const facts = makeApprovedControlledWriteFacts(input)
    if (await exists(input.ledgerFilename)) {
      await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
      const existingClaim = await runWithLedger(input.ledgerFilename, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          return (yield* ledger.getDispatchSnapshot(facts.dispatchRequestID))?.claim ?? null
        }),
      )
      if (existingClaim) return recoverApprovedControlledWrite(input, dependencies)
    }
    const admissionBaseline = await checkRepositoryBaseline(input, facts.repositorySnapshotDigest)
    if (!admissionBaseline.matched) {
      throw new ControlledWriteCoordinationError("invalid_input", admissionBaseline.reason)
    }
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
    const now = dependencies.now ?? Date.now
    const claimStartedAt = now()
    const claimed = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        yield* ledger.appendBatch(facts.commands)
        const existing = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        if (existing?.claim) return { kind: "existing_claim" as const }
        return yield* ledger.claimDispatch({
          dispatchRequestID: facts.dispatchRequestID,
          operationID: facts.operationID,
          attemptID: facts.attemptID,
          executor: controlledWriteExecutor,
          executorClaimID: facts.executorClaimID,
          claimExpiresAt: new Date(
            Math.min(claimStartedAt + claimLeaseMilliseconds, Date.parse(facts.authorizationExpiresAt) - 1),
          ).toISOString(),
          event: {
            eventID: facts.eventIDs.claim,
            schemaVersion: 1,
            actor: {
              kind: "system",
              subject: controlledWriteExecutor,
              componentDigest: controlledWriteAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    )
    if (claimed.kind === "existing_claim" || claimed.kind === "replayed") {
      return recoverApprovedControlledWrite(input, dependencies)
    }
    await dependencies.injectFault?.("after_claim_before_effect")

    const startedAt = new Date(now()).toISOString()
    const prepared = await prepareControlledWrite(
      input.plan,
      input.report,
      async () => {
        await dependencies.beforeEffectBoundary?.()
        const repository = await checkRepositoryBaseline(input, facts.repositorySnapshotDigest)
        if (!repository.matched) return { allowed: false as const, reason: repository.reason }
        const validation = await runWithCoordinatorLedger(
          input.ledgerFilename,
          (ledger) =>
            Effect.gen(function* () {
              yield* ledger.initialize()
              return yield* ledger.validateEffectAuthority({
                operationID: facts.operationID,
                dispatchRequestID: facts.dispatchRequestID,
                attemptID: facts.attemptID,
                capabilityGrantID: facts.capabilityGrantID,
                executorClaimID: facts.executorClaimID,
                fencingToken: claimed.claim.fencingToken,
                executor: controlledWriteExecutor,
                adapterDigest: controlledWriteAdapterDigest,
                baselineDigest: facts.baselineTrustDigest,
                minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
              })
            }),
          () => new Date(now()).toISOString(),
        )
        return validation.allowed
          ? { allowed: true as const }
          : { allowed: false as const, reason: `effect_authority_${validation.reason}` }
      },
      () => checkRepositoryBaseline(input, facts.repositorySnapshotDigest),
    )
    const effect = prepared.prepared
      ? await prepared.execute()
      : ({ status: "failed_without_effect", reason: prepared.reason } as const)
    const endedAt = new Date(now()).toISOString()
    await dependencies.injectFault?.("after_effect_before_spool")

    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(
        input,
        facts,
        claimed.claim.fencingToken,
        await observeRecoveryTarget(input.plan),
        endedAt,
        () => new Date(now()).toISOString(),
      )
    }

    const postEffectReport = await scanWorkspace(input.report.root, input.report.limits)
    const postEffectRepositoryBaseline = await capturePostEffectRepositoryBaseline(input)
    const receipt = makeReceipt(
      input.plan,
      input.report,
      postEffectReport,
      facts,
      claimed.claim.fencingToken,
      startedAt,
      endedAt,
      effect,
      facts.repositorySnapshotDigest,
      postEffectRepositoryBaseline,
    )
    await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(receipt)
      }),
    )
    await dependencies.injectFault?.("after_spool_before_ledger")

    const ingested = await runWithLedger(input.ledgerFilename, (ledger) =>
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
    )
    await dependencies.injectFault?.("after_ledger_before_ack")
    await acknowledgeReceipt(input.spoolFilename, receipt, ingested.event.eventID, ingested.event.digest)
    return durableResult(ingested.operation, receipt)
  } catch (cause) {
    if (cause instanceof ControlledWriteCoordinationError) throw cause
    throw new ControlledWriteCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The approved controlled write could not complete its durable path",
      cause,
    )
  }
}

/** Recovers durable receipt transfer or records uncertainty. It never executes the effect again. */
export async function recoverApprovedControlledWrite(
  input: ExecuteApprovedControlledWriteInput,
  dependencies: Pick<ControlledWriteCoordinatorDependencies, "now"> = {},
): Promise<DurableControlledWriteResult> {
  try {
    const facts = makeApprovedControlledWriteFacts(input)
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
    if (await exists(input.spoolFilename)) await ingestPendingReceipts(input, facts)

    const snapshot = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        const dispatch = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        const operation = yield* ledger.getOperation(facts.operationID)
        return { dispatch, operation }
      }),
    )
    if (!snapshot.operation || !snapshot.dispatch) {
      throw new ControlledWriteCoordinationError("recovery_unavailable", "No durable controlled write is available")
    }
    if (snapshot.dispatch.recoveryStatus === "claimed_no_receipt") {
      const now = dependencies.now?.() ?? Date.now()
      if (now < Date.parse(snapshot.dispatch.claim!.claimExpiresAt)) {
        throw new ControlledWriteCoordinationError(
          "operation_in_progress",
          "The exact executor claim is still active; recovery will not mutate or retry it",
        )
      }
      return recordUncertainty(
        input,
        facts,
        snapshot.dispatch.claim!.fencingToken,
        await observeRecoveryTarget(input.plan),
        new Date(now).toISOString(),
        () => new Date(now).toISOString(),
      )
    }
    if (snapshot.dispatch.recoveryStatus === "claim_uncertain") {
      return durableResult(snapshot.operation, null)
    }
    if (snapshot.dispatch.recoveryStatus === "pending_outbox") {
      throw new ControlledWriteCoordinationError(
        "recovery_unavailable",
        "The dispatch was never claimed; this increment does not retry or cancel it automatically",
      )
    }
    return durableResult(snapshot.operation, snapshot.dispatch.receipt)
  } catch (cause) {
    if (cause instanceof ControlledWriteCoordinationError) throw cause
    throw new ControlledWriteCoordinationError(
      "recovery_unavailable",
      "The controlled write could not be reconciled without retrying the effect",
      cause,
    )
  }
}

async function ingestPendingReceipts(
  input: ExecuteApprovedControlledWriteInput,
  facts: ReturnType<typeof makeApprovedControlledWriteFacts>,
) {
  const pending = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.listPending({ limit: 2 })
    }),
  )
  if (pending.length > 1) {
    throw new ControlledWriteCoordinationError(
      "recovery_unavailable",
      "Multiple receipts require manual reconciliation",
    )
  }
  const entry = pending[0]
  if (!entry) return
  if (entry.receipt.operationID !== facts.operationID || entry.receipt.receiptID !== facts.receiptID) {
    throw new ControlledWriteCoordinationError(
      "recovery_unavailable",
      "The pending receipt belongs to another Operation",
    )
  }
  const ingested = await runWithLedger(input.ledgerFilename, (ledger) =>
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
      yield* spool.acknowledgeIngestedReceipt({
        receiptID: receipt.receiptID,
        ledgerEventID,
        ledgerEventDigest,
      })
    }),
  )
}

async function recordUncertainty(
  input: ExecuteApprovedControlledWriteInput,
  facts: ReturnType<typeof makeApprovedControlledWriteFacts>,
  fencingToken: number,
  targetObservation: OperationEffectUncertainty["targetObservation"],
  observedAt: string,
  clock: () => string = () => new Date().toISOString(),
) {
  const uncertainty = requireUncertainty({
    uncertaintyID: facts.uncertaintyID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    fencingToken,
    reason: "claimed_without_receipt",
    observedAt,
    targetObservation,
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
              subject: "astra-coordinator:recovery",
              componentDigest: controlledWriteAdapterDigest,
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
  plan: ControlledWritePlan,
  admittedReport: WorkspaceTrustReport,
  postEffectReport: WorkspaceTrustReport,
  facts: ReturnType<typeof makeApprovedControlledWriteFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  effect: ControlledWriteResult,
  admittedRepositorySnapshotDigest: string | null,
  postEffectRepositoryBaseline: GitRepositoryBaselineSnapshot | null,
) {
  if (!admittedReport.identity || !admittedReport.securityDigest) {
    throw new TypeError("The admitted workspace baseline is incomplete")
  }
  const gitWorkspace = isGitWorkspace(admittedReport)
  const activation = gitWorkspace
    ? { allowed: postEffectRepositoryBaseline !== null }
    : checkWorkspaceActivation(postEffectReport)
  const targetIdentity = "receipt" in effect ? effect.receipt.targetIdentity : null
  const contextReady =
    postEffectReport.completeness === "complete" &&
    postEffectReport.securityDigest !== null &&
    postEffectReport.identity !== null &&
    sameIdentity(admittedReport.identity, postEffectReport.identity) &&
    activation.allowed &&
    (!gitWorkspace || admittedRepositorySnapshotDigest !== null) &&
    (effect.status !== "effect_observed" || targetIdentity !== null)
  const observation: OperationReceipt["observation"] =
    effect.status === "effect_observed" && contextReady
      ? { kind: "effect_observed", beforeDigest: null, afterDigest: digest(plan.content) }
      : effect.status === "failed_without_effect"
        ? {
            kind: "no_effect_proved",
            proofDigest: digest(canonicalJson({ reason: effect.reason, target: plan.relativePath })),
          }
        : {
            kind: "effect_unknown",
            observationDigest: digest(canonicalJson({ effect, postEffectReport, activation })),
          }
  const bytes = "receipt" in effect ? effect.receipt.bytes : 0
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    fencingToken,
    adapter: { identity: controlledWriteExecutor, version: "1", digest: controlledWriteAdapterDigest },
    effectClass: "workspace_write",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation,
    verificationContext:
      gitWorkspace && admittedRepositorySnapshotDigest
        ? {
            schemaVersion: 2,
            admittedBaselineDigest: facts.baselineTrustDigest,
            admittedRepositorySnapshotDigest,
            postEffectWorkspaceDigest: postEffectReport.securityDigest,
            postEffectRepositorySnapshotDigest: postEffectRepositoryBaseline?.snapshotDigest ?? null,
            workspaceIdentity: admittedReport.identity,
            targetIdentity,
            preflightLimits: admittedReport.limits,
            activationGuard: activation.allowed ? "allowed" : "blocked",
          }
        : {
            admittedBaselineDigest: facts.baselineTrustDigest,
            postEffectWorkspaceDigest: postEffectReport.securityDigest,
            workspaceIdentity: admittedReport.identity,
            targetIdentity,
            preflightLimits: admittedReport.limits,
            activationGuard: activation.allowed ? "allowed" : "blocked",
          },
    output: {
      digest: digest(canonicalJson(effect)),
      bytes,
      preview:
        effect.status === "effect_observed"
          ? `Observed create-only write to ${plan.relativePath}`
          : `Controlled write ${effect.status}`,
    },
  })
}

async function checkRepositoryBaseline(
  input: ExecuteApprovedControlledWriteInput,
  admittedRepositorySnapshotDigest: string | null,
) {
  if (!isGitWorkspace(input.report)) return { matched: true as const }
  if (!input.repositoryBaseline) return { matched: false as const, reason: "git_baseline_not_inspected" }
  if (input.repositoryBaseline.snapshotDigest !== admittedRepositorySnapshotDigest) {
    return { matched: false as const, reason: "git_baseline_binding_mismatch" }
  }
  const result = await revalidateGitRepositoryBaseline(input.report.root, input.repositoryBaseline)
  if (
    result.status === "current" &&
    result.expectedSnapshotDigest === input.repositoryBaseline.snapshotDigest &&
    result.currentSnapshotDigest === input.repositoryBaseline.snapshotDigest
  ) {
    return { matched: true as const }
  }
  if (result.status === "stale") return { matched: false as const, reason: "git_baseline_stale" }
  if (result.status === "blocked") {
    return { matched: false as const, reason: `git_baseline_blocked:${result.reason}` }
  }
  return { matched: false as const, reason: "git_baseline_binding_mismatch" }
}

async function capturePostEffectRepositoryBaseline(input: ExecuteApprovedControlledWriteInput) {
  if (!isGitWorkspace(input.report)) return null
  const result = await captureGitRepositoryBaseline(input.report.root, input.repositoryBaseline?.limits)
  return result.status === "complete" ? result.snapshot : null
}

function isGitWorkspace(report: WorkspaceTrustReport) {
  return report.surfaces.some((surface) => surface.kind === "git_metadata")
}

async function observeRecoveryTarget(
  plan: ControlledWritePlan,
): Promise<OperationEffectUncertainty["targetObservation"]> {
  const target = join(plan.workspaceRoot, plan.relativePath)
  try {
    const facts = await lstat(target)
    if (!facts.isFile() || facts.isSymbolicLink()) {
      return { state: "present", digest: digest(canonicalJson({ kind: "non_regular", mode: facts.mode })) }
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.dev !== facts.dev || before.ino !== facts.ino) {
        return { state: "unavailable", digest: digest(canonicalJson({ state: "identity_changed" })) }
      }
      const content = await handle.readFile()
      const after = await handle.stat()
      const pathFacts = await lstat(target)
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        pathFacts.dev !== after.dev ||
        pathFacts.ino !== after.ino ||
        pathFacts.isSymbolicLink()
      ) {
        return { state: "unavailable", digest: digest(canonicalJson({ state: "identity_changed" })) }
      }
      return {
        state: "present",
        digest: digest(canonicalJson({ bytes: content.byteLength, digest: sha256(content) })),
      }
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) {
      return { state: "absent", digest: digest(canonicalJson({ state: "absent", target: plan.relativePath })) }
    }
    return { state: "unavailable", digest: digest(canonicalJson({ state: "unavailable", target: plan.relativePath })) }
  }
}

function durableResult(operation: OperationRecord, receipt: OperationReceipt | null): DurableControlledWriteResult {
  if (
    operation.state !== "effect_observed" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required"
  ) {
    throw new ControlledWriteCoordinationError(
      "recovery_unavailable",
      `Operation state ${operation.state} is outside the executor recovery boundary`,
    )
  }
  const status =
    operation.state === "effect_observed"
      ? "effect_observed"
      : operation.state === "failed"
        ? "failed_without_effect"
        : "reconciliation_required"
  return {
    operationID: operation.operationID,
    state: operation.state,
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    status,
  }
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`Controlled write receipt is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireUncertainty(input: unknown) {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError(`Claim uncertainty is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function sha256(input: Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}

function sameIdentity(
  left: Readonly<{ device: string; inode: string }>,
  right: Readonly<{ device: string; inode: string }>,
) {
  return left.device === right.device && left.inode === right.inode
}
