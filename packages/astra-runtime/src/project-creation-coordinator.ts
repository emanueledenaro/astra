import { access, lstat } from "node:fs/promises"
import {
  parseOperationEffectUncertainty,
  parseOperationEvidence,
  parseOperationReceipt,
  parseContentDigest,
  type OperationEffectUncertainty,
  type OperationEvidence,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import {
  executeProjectScaffold,
  type ProjectScaffoldExecutionResult,
} from "@astra/executor"
import type { OperationRecord } from "@astra/ledger"
import { Effect } from "effect"
import { canonicalJson, digest } from "./controlled-write-authority"
import {
  makeProjectScaffoldOperationFacts,
  projectScaffoldAdapterDigest,
  projectScaffoldExecutor,
  projectScaffoldVerifier,
  projectScaffoldVerifierDigest,
  type ProjectScaffoldOperationFactsInput,
} from "./project-creation-operation-facts"
import { expectedTreeDigest, verifyProjectScaffoldTree } from "./project-creation-verifier"
import { revalidateProjectParentAuthority } from "./project-parent-authority"
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

export const projectScaffoldFaultPoints = [
  "after_claim_before_adapter",
  "after_adapter_before_spool",
  "after_spool_before_ledger",
  "after_ledger_before_ack",
] as const

export type ProjectScaffoldFaultPoint = (typeof projectScaffoldFaultPoints)[number]

export type DurableProjectScaffoldInput = ProjectScaffoldOperationFactsInput &
  Readonly<{ ledgerFilename: string; spoolFilename: string }>

export type ProjectScaffoldCoordinatorDependencies = Readonly<{
  injectFault?: (point: ProjectScaffoldFaultPoint) => Promise<void>
  onHostAdapterEntered?: () => void
  now?: () => number
}>

export type DurableProjectScaffoldResult = Readonly<{
  operationID: string
  state: "denied" | "effect_observed" | "failed" | "reconciliation_required" | "succeeded"
  status: "denied_without_effect" | "effect_observed" | "failed_without_effect" | "reconciliation_required" | "verified"
  sequence: number
  lastCursor: number
  receiptID: string | null
  evidence: OperationEvidence | null
}>

export class ProjectScaffoldCoordinationError extends Error {
  readonly _tag = "ProjectScaffoldCoordinationError"

  constructor(
    readonly code: "invalid_input" | "state_unavailable" | "recovery_unavailable" | "operation_in_progress",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

const activeProjectScaffolds = new Map<string, Promise<DurableProjectScaffoldResult>>()

export async function executeDurableProjectScaffold(
  input: DurableProjectScaffoldInput,
  dependencies: ProjectScaffoldCoordinatorDependencies = {},
): Promise<DurableProjectScaffoldResult> {
  let operationID: string
  try {
    operationID = makeProjectScaffoldOperationFacts(input).operationID
  } catch {
    return executeDurableProjectScaffoldOnce(input, dependencies)
  }
  const active = activeProjectScaffolds.get(operationID)
  if (active) return active
  const running = executeDurableProjectScaffoldOnce(input, dependencies)
  activeProjectScaffolds.set(operationID, running)
  try {
    return await running
  } finally {
    if (activeProjectScaffolds.get(operationID) === running) activeProjectScaffolds.delete(operationID)
  }
}

async function executeDurableProjectScaffoldOnce(
  input: DurableProjectScaffoldInput,
  dependencies: ProjectScaffoldCoordinatorDependencies = {},
): Promise<DurableProjectScaffoldResult> {
  try {
    const facts = makeProjectScaffoldOperationFacts(input)
    if (facts.decision.decision === "rejected") {
      return {
        operationID: facts.operationID,
        state: "denied",
        status: "denied_without_effect",
        sequence: 0,
        lastCursor: 0,
        receiptID: null,
        evidence: null,
      }
    }
    const now = dependencies.now ?? Date.now
    const clock = () => new Date(now()).toISOString()
    if (now() + minimumEffectLeaseMilliseconds >= Date.parse(facts.preview.expiresAt)) {
      throw new ProjectScaffoldCoordinationError("invalid_input", "The approved project scaffold has expired")
    }

    if (await exists(input.ledgerFilename)) {
      await assertSafeStateFile(facts.authority.parentPath, input.ledgerFilename)
      const existing = await runWithLedger(input.ledgerFilename, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          return yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        }),
      )
      if (existing?.claim) return recoverDurableProjectScaffold(input, { now })
    }
    await requireCurrentAuthority(facts)
    await prepareOperationStateFiles(facts.authority.parentPath, input.ledgerFilename, input.spoolFilename)
    const claimStartedAt = now()
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
            executor: projectScaffoldExecutor,
            capabilityDigest: facts.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            claimExpiresAt: new Date(
              Math.min(claimStartedAt + claimLeaseMilliseconds, Date.parse(facts.preview.expiresAt) - 1),
            ).toISOString(),
            event: {
              eventID: facts.eventIDs.claim,
              schemaVersion: 1,
              actor: { kind: "system", subject: projectScaffoldExecutor, componentDigest: projectScaffoldAdapterDigest },
              correlationID: facts.correlationID,
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
        }),
      clock,
    )
    if (claimed.kind === "replayed") return recoverDurableProjectScaffold(input, { now })
    await dependencies.injectFault?.("after_claim_before_adapter")

    let bridgeAttempted = false
    let bridgeAccepted = false
    dependencies.onHostAdapterEntered?.()
    const effect = await executeProjectScaffold(
      { authority: facts.authority, draft: facts.draft, preview: facts.preview },
      async (proposal) => {
        if (bridgeAttempted) return "already_claimed"
        bridgeAttempted = true
        if (
          proposal.proposalDigest !== facts.preview.proposalDigest ||
          proposal.authorityDigest !== facts.authority.observationDigest ||
          proposal.targetPath !== facts.authority.targetPath
        ) {
          return "unavailable"
        }
        const current = await revalidateProjectParentAuthority(facts.authority)
        if (current.status !== "current") return "unavailable"
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
                executor: projectScaffoldExecutor,
                adapterDigest: projectScaffoldAdapterDigest,
                baselineDigest: facts.baselineTrustDigest,
                minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
              })
            }),
          clock,
        ).catch(() => null)
        if (!authority?.allowed) return "unavailable"
        bridgeAccepted = true
        return "claimed"
      },
    )
    await dependencies.injectFault?.("after_adapter_before_spool")
    if ((effect.status === "effect_observed" || effect.status === "effect_unknown") && !bridgeAccepted) {
      throw new ProjectScaffoldCoordinationError(
        "state_unavailable",
        "The project adapter entered an effect path without durable authority",
      )
    }
    const endedAt = clock()
    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(input, facts, claimed.claim.fencingToken, endedAt, clock)
    }
    const receipt = makeReceipt(facts, claimed.claim.fencingToken, claimed.claim.acceptedAt, endedAt, effect)
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
    return durableResult(ingested.operation, receipt, null)
  } catch (cause) {
    if (cause instanceof ProjectScaffoldCoordinationError) throw cause
    throw new ProjectScaffoldCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The project scaffold Operation could not complete its durable path",
      cause,
    )
  }
}

export async function recoverDurableProjectScaffold(
  input: DurableProjectScaffoldInput,
  dependencies: Readonly<{ now?: () => number }> = {},
): Promise<DurableProjectScaffoldResult> {
  try {
    const facts = makeProjectScaffoldOperationFacts(input)
    if (facts.decision.decision !== "approved") {
      throw new ProjectScaffoldCoordinationError("invalid_input", "Only an approved scaffold can be recovered")
    }
    await prepareOperationStateFiles(facts.authority.parentPath, input.ledgerFilename, input.spoolFilename)
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
      throw new ProjectScaffoldCoordinationError("recovery_unavailable", "No durable project scaffold is available")
    }
    if (durable.dispatch.recoveryStatus === "claimed_no_receipt") {
      if (now() < Date.parse(durable.dispatch.claim!.claimExpiresAt)) {
        throw new ProjectScaffoldCoordinationError("operation_in_progress", "The project scaffold claim is still active")
      }
      return recordUncertainty(input, facts, durable.dispatch.claim!.fencingToken, clock(), clock)
    }
    if (durable.dispatch.recoveryStatus === "pending_outbox") {
      throw new ProjectScaffoldCoordinationError(
        "recovery_unavailable",
        "The unclaimed project scaffold is never dispatched automatically",
      )
    }
    return durableResult(durable.operation, durable.dispatch.receipt, null)
  } catch (cause) {
    if (cause instanceof ProjectScaffoldCoordinationError) throw cause
    throw new ProjectScaffoldCoordinationError(
      "recovery_unavailable",
      "The project scaffold could not be reconciled without repeating its effect",
      cause,
    )
  }
}

export async function verifyDurableProjectScaffold(
  input: DurableProjectScaffoldInput,
): Promise<DurableProjectScaffoldResult> {
  try {
    const facts = makeProjectScaffoldOperationFacts(input)
    if (facts.decision.decision !== "approved") {
      throw new ProjectScaffoldCoordinationError("invalid_input", "A rejected scaffold cannot be verified")
    }
    await assertSafeStateFile(facts.authority.parentPath, input.ledgerFilename)
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
      throw new ProjectScaffoldCoordinationError("recovery_unavailable", "No observed scaffold receipt is available")
    }
    if (durable.verification) return durableResult(durable.operation, durable.dispatch.receipt, durable.verification.evidence)
    if (
      durable.operation.state !== "effect_observed" ||
      durable.dispatch.receipt.observation.kind !== "effect_observed" ||
      durable.dispatch.receipt.capabilityDigest !== facts.capabilityDigest
    ) {
      throw new ProjectScaffoldCoordinationError("recovery_unavailable", "The scaffold effect is not verifiable")
    }
    const targetIdentity = receiptTargetIdentity(durable.dispatch.receipt)
    const verification = await verifyProjectScaffoldTree(facts.authority, facts.preview, targetIdentity)
    const passed = verification.status === "verified" && verification.snapshotDigest === facts.expectedTreeDigest
    const evidence = requireEvidence({
      evidenceID: facts.evidenceID,
      operationID: facts.operationID,
      receiptID: facts.receiptID,
      verificationPlanID: facts.verificationPlanID,
      verifier: { identity: projectScaffoldVerifier, version: "1", digest: projectScaffoldVerifierDigest },
      snapshotDigest: verification.snapshotDigest,
      observedAt: new Date().toISOString(),
      criteria: [
        {
          criterionID: "exact_project_tree",
          result: passed ? "passed" : verification.status === "failed" ? "failed" : "unknown",
          observationDigest: passed ? expectedTreeDigest(facts.preview) : verification.snapshotDigest,
        },
      ],
      limitations: passed ? [] : [verification.reason ?? "project_tree_not_verified"],
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
    return durableResult(ingested.operation, durable.dispatch.receipt, ingested.evidence)
  } catch (cause) {
    if (cause instanceof ProjectScaffoldCoordinationError) throw cause
    throw new ProjectScaffoldCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "Independent project scaffold verification could not complete",
      cause,
    )
  }
}

async function requireCurrentAuthority(facts: ReturnType<typeof makeProjectScaffoldOperationFacts>) {
  const current = await revalidateProjectParentAuthority(facts.authority)
  if (current.status !== "current" || canonicalJson(current.authority) !== canonicalJson(facts.authority)) {
    throw new ProjectScaffoldCoordinationError("invalid_input", "The approved project parent is stale")
  }
}

async function ingestPendingReceipt(
  input: DurableProjectScaffoldInput,
  facts: ReturnType<typeof makeProjectScaffoldOperationFacts>,
  clock: () => string,
) {
  const pending = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.listPending({ limit: 2 })
    }),
  )
  if (pending.length > 1) {
    throw new ProjectScaffoldCoordinationError("recovery_unavailable", "Multiple scaffold receipts require review")
  }
  const entry = pending[0]
  if (!entry) return
  if (
    entry.receipt.operationID !== facts.operationID ||
    entry.receipt.receiptID !== facts.receiptID ||
    entry.receipt.capabilityDigest !== facts.capabilityDigest
  ) {
    throw new ProjectScaffoldCoordinationError("recovery_unavailable", "The pending scaffold receipt is not bound here")
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
  input: DurableProjectScaffoldInput,
  facts: ReturnType<typeof makeProjectScaffoldOperationFacts>,
  fencingToken: number,
  observedAt: string,
  clock: () => string,
) {
  const target = await observeTarget(facts.authority.targetPath)
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
      state: target,
      digest: digest(canonicalJson({ proposalDigest: facts.preview.proposalDigest, target })),
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
              subject: "astra-coordinator:project-scaffold-recovery",
              componentDigest: projectScaffoldAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    clock,
  )
  return durableResult(recorded.operation, null, null)
}

function makeReceipt(
  facts: ReturnType<typeof makeProjectScaffoldOperationFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  effect: ProjectScaffoldExecutionResult,
) {
  const output = canonicalJson(effect)
  const observation: OperationReceipt["observation"] =
    effect.status === "effect_observed"
      ? { kind: "effect_observed", beforeDigest: null, afterDigest: requireContentDigest(effect.observationDigest) }
      : effect.status === "failed_without_effect"
        ? { kind: "no_effect_proved", proofDigest: requireContentDigest(effect.proofDigest) }
        : { kind: "effect_unknown", observationDigest: requireContentDigest(effect.observationDigest) }
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: projectScaffoldExecutor, version: "1", digest: projectScaffoldAdapterDigest },
    effectClass: "project_scaffold_create",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation,
    verificationContext: {
      admittedBaselineDigest: facts.baselineTrustDigest,
      postEffectWorkspaceDigest: effect.status === "effect_observed" ? effect.observationDigest : null,
      workspaceIdentity: facts.authority.parentIdentity,
      targetIdentity: effect.status === "effect_observed" ? effect.targetIdentity : null,
      preflightLimits: {
        maxEntries: facts.preview.limits.maxFiles * facts.preview.limits.maxPathSegments + 1,
        maxFileBytes: facts.preview.limits.maxFileBytes,
        maxTotalBytes: facts.preview.limits.maxTotalBytes,
        maxDurationMs: 5_000,
      },
      activationGuard: effect.status === "effect_observed" ? "allowed" : "blocked",
    },
    output: { digest: digest(output), bytes: Buffer.byteLength(output), preview: output },
  })
}

function receiptTargetIdentity(receipt: OperationReceipt) {
  if (
    receipt.output.bytes !== Buffer.byteLength(receipt.output.preview) ||
    receipt.output.digest !== digest(receipt.output.preview)
  ) {
    throw new TypeError("The durable scaffold output is corrupt")
  }
  const decoded: unknown = JSON.parse(receipt.output.preview)
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("status" in decoded) ||
    decoded.status !== "effect_observed" ||
    !("targetIdentity" in decoded) ||
    typeof decoded.targetIdentity !== "object" ||
    decoded.targetIdentity === null ||
    !("device" in decoded.targetIdentity) ||
    !("inode" in decoded.targetIdentity) ||
    typeof decoded.targetIdentity.device !== "string" ||
    typeof decoded.targetIdentity.inode !== "string"
  ) {
    throw new TypeError("The durable scaffold target identity is invalid")
  }
  return { device: decoded.targetIdentity.device, inode: decoded.targetIdentity.inode }
}

function durableResult(
  operation: OperationRecord,
  receipt: OperationReceipt | null,
  evidence: OperationEvidence | null,
): DurableProjectScaffoldResult {
  if (
    operation.state !== "effect_observed" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required" &&
    operation.state !== "succeeded" &&
    operation.state !== "denied"
  ) {
    throw new ProjectScaffoldCoordinationError(
      "recovery_unavailable",
      `Project scaffold state ${operation.state} is outside the durable boundary`,
    )
  }
  const status =
    operation.state === "effect_observed"
      ? "effect_observed"
      : operation.state === "failed"
        ? "failed_without_effect"
        : operation.state === "succeeded"
          ? "verified"
          : operation.state === "denied"
            ? "denied_without_effect"
            : "reconciliation_required"
  return {
    operationID: operation.operationID,
    state: operation.state,
    status,
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    evidence,
  }
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`The project receipt is invalid at ${parsed.issue.path}: ${parsed.issue.reason}`)
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError(`The project uncertainty is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireEvidence(input: unknown): OperationEvidence {
  const parsed = parseOperationEvidence(input)
  if (!parsed.ok) throw new TypeError(`The project evidence is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireContentDigest(input: unknown) {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The project receipt digest is invalid")
  return parsed.value
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function observeTarget(path: string): Promise<"absent" | "present" | "unavailable"> {
  try {
    await lstat(path)
    return "present"
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? "absent" : "unavailable"
  }
}
