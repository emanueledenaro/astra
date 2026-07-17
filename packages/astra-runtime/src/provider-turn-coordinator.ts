import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat } from "node:fs/promises"
import {
  parseContentDigest,
  parseOperationEffectUncertainty,
  parseOperationReceipt,
  type ContentDigest,
  type OperationEffectUncertainty,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { OperationRecord } from "@astra/ledger"
import { revalidateGitRepositoryBaseline } from "@astra/git"
import { Effect } from "effect"
import { canonicalJson, deterministicUUID, digest } from "./controlled-write-authority"
import {
  makeProviderTurnOperationFacts,
  providerTurnAdapterDigest,
  providerTurnExecutionBoundaryLabel,
  providerTurnExecutor,
  snapshotProviderTurnOperationFactsInput,
  type ProviderTurnOperationFactsInput,
  type ProviderTurnPreview,
  type UntrustedProviderTurnAdapterRequest,
} from "./provider-turn-operation-facts"
import {
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithCoordinatorReceiptSpool,
  runWithLedger,
  runWithReceiptSpool,
} from "./operation-storage"

const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 5_000
const maximumProviderResponseBytes = 1_048_576

export const untrustedProviderTurnAdapterDescriptor = Object.freeze({
  trust: "untrusted_test_seam",
  productionCapable: false,
  completionAuthority: "none",
  terminalState: "effect_unknown_only",
} as const)

export type UntrustedProviderTurnAdapterFinishEvent = Readonly<{
  type: "provider.finish"
  requestBinding: Readonly<{
    operationID: string
    attemptID: string
    capabilityGrantID: string
    capabilityDigest: string
    expectedOrigin: string
    logicalPayloadDigest: string
    logicalPayloadBytes: number
  }>
  finalOrigin: string
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "other"
  response: Uint8Array
}>

/**
 * Non-production integration seam. The descriptor is an accidental-use guard,
 * not a security boundary; its events never authorize completed state.
 */
export interface UntrustedProviderTurnAdapter {
  readonly descriptor: typeof untrustedProviderTurnAdapterDescriptor
  execute(request: UntrustedProviderTurnAdapterRequest): Promise<UntrustedProviderTurnAdapterFinishEvent>
}

export type ExecuteProviderTurnInput = ProviderTurnOperationFactsInput &
  Readonly<{
    ledgerFilename: string
    spoolFilename: string
  }>

export type ProviderTurnCoordinatorDependencies = Readonly<{
  requestApproval: (preview: ProviderTurnPreview) => Promise<"approve" | "reject">
  untrustedAdapter: UntrustedProviderTurnAdapter
  now?: () => number
}>

export type DurableProviderTurnResult = Readonly<{
  operationID: string
  state: "denied" | "reconciliation_required"
  status: "denied_without_effect" | "effect_unknown"
  sequence: number
  lastCursor: number
  receiptID: string | null
  boundaryLabel: typeof providerTurnExecutionBoundaryLabel
}>

export class ProviderTurnCoordinationError extends Error {
  readonly _tag = "ProviderTurnCoordinationError"

  constructor(
    readonly code: "invalid_input" | "state_unavailable" | "recovery_unavailable" | "operation_in_progress",
    message: string,
  ) {
    super(message)
    this.name = this._tag
  }
}

/**
 * Governs one provider call. Consent happens after durable admission and the
 * callback receives its opaque authority only after the one-shot claim exists.
 */
export async function executeProviderTurn(
  source: ExecuteProviderTurnInput,
  dependencies: ProviderTurnCoordinatorDependencies,
): Promise<DurableProviderTurnResult> {
  try {
    const input = snapshotExecuteInput(source)
    const facts = makeProviderTurnOperationFacts(input)
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)

    if (await exists(input.ledgerFilename)) {
      const existing = await readDurableSnapshot(input, facts)
      if (existing.operation) {
        assertDurableBinding(existing, facts)
        return recoverProviderTurn(input, dependencies.now ? { now: dependencies.now } : {})
      }
    }

    const admissionBaseline = await revalidateBaseline(input, facts.repositorySnapshotDigest)
    if (!admissionBaseline.matched) {
      throw new ProviderTurnCoordinationError("invalid_input", "The provider turn baseline is stale")
    }

    const admission = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.appendBatch(facts.admissionCommands)
      }),
    )
    const ownsApproval = admission.every((result) => result.kind === "appended")
    if (!ownsApproval) {
      assertDurableBinding(await readDurableSnapshot(input, facts), facts)
      throw new ProviderTurnCoordinationError(
        "operation_in_progress",
        "The provider turn already has a durable consent request",
      )
    }

    const decision = await dependencies.requestApproval(facts.preview)
    if (decision !== "approve" && decision !== "reject") {
      throw new ProviderTurnCoordinationError("state_unavailable", "The provider turn consent result is invalid")
    }
    const now = dependencies.now ?? Date.now
    const decidedAt = new Date(now()).toISOString()
    if (decision === "reject") {
      const denied = await runWithLedger(input.ledgerFilename, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          return yield* ledger.append(facts.rejectionCommand(decidedAt))
        }),
      )
      return durableResult(denied.operation, null)
    }

    const claimStartedAt = now()
    const claimed = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          yield* ledger.appendBatch(facts.approvalCommands(decidedAt))
          return yield* ledger.claimDispatch({
            dispatchRequestID: facts.dispatchRequestID,
            operationID: facts.operationID,
            attemptID: facts.attemptID,
            executor: providerTurnExecutor,
            capabilityDigest: facts.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            claimExpiresAt: new Date(
              Math.min(claimStartedAt + claimLeaseMilliseconds, Date.parse(facts.authorizationExpiresAt) - 1),
            ).toISOString(),
            event: {
              eventID: facts.eventIDs.claim,
              schemaVersion: 1,
              actor: { kind: "system", subject: providerTurnExecutor, componentDigest: providerTurnAdapterDigest },
              correlationID: facts.correlationID,
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
        }),
      () => new Date(claimStartedAt).toISOString(),
    )
    if (claimed.kind !== "claimed") {
      assertDurableBinding(await readDurableSnapshot(input, facts), facts)
      return recoverProviderTurn(input, dependencies.now ? { now: dependencies.now } : {})
    }

    const startedAt = new Date(now()).toISOString()
    let observation: AdapterObservation = unknownAdapterObservation("adapter_not_observed")
    try {
      const baseline = await revalidateBaseline(input, facts.repositorySnapshotDigest)
      if (!baseline.matched) throw new Error("provider turn boundary rejected")
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
              executor: providerTurnExecutor,
              adapterDigest: providerTurnAdapterDigest,
              baselineDigest: facts.baselineTrustDigest,
              minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
            })
          }),
        () => new Date(now()).toISOString(),
      )
      if (!authority.allowed) throw new Error("provider turn authority rejected")
      if (dependencies.untrustedAdapter.descriptor !== untrustedProviderTurnAdapterDescriptor) {
        throw new Error("untrusted adapter descriptor mismatch")
      }
      const event: unknown = await dependencies.untrustedAdapter.execute(facts.adapterRequest)
      observation = normalizeAdapterEvent(event, facts.adapterRequest)
    } catch {
      observation = unknownAdapterObservation("adapter_failed_or_malformed")
    }
    const endedAt = new Date(now()).toISOString()

    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(input, facts, claimed.claim.fencingToken, endedAt)
    }

    const receipt = makeReceipt(input, facts, claimed.claim.fencingToken, startedAt, endedAt, observation)
    await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(receipt)
      }),
    )
    const ingested = await ingestReceipt(input, facts, receipt, endedAt)
    await acknowledgeReceipt(input.spoolFilename, receipt, ingested.event.eventID, ingested.event.digest)
    return durableResult(ingested.operation, receipt)
  } catch (cause) {
    if (cause instanceof ProviderTurnCoordinationError) throw cause
    throw new ProviderTurnCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The provider turn could not complete its durable path",
    )
  }
}

/** Recovers durable state without asking again and without invoking the provider callback. */
export async function recoverProviderTurn(
  source: ExecuteProviderTurnInput,
  dependencies: Readonly<{ now?: () => number }> = {},
): Promise<DurableProviderTurnResult> {
  try {
    const input = snapshotExecuteInput(source)
    const facts = makeProviderTurnOperationFacts(input)
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
    const now = dependencies.now?.() ?? Date.now()
    let snapshot = await readDurableSnapshot(input, facts)
    if (!snapshot.operation) {
      throw new ProviderTurnCoordinationError("recovery_unavailable", "No durable provider turn is available")
    }
    assertDurableBinding(snapshot, facts)
    if (await exists(input.spoolFilename)) {
      await ingestPendingReceipt(input, facts, new Date(now).toISOString())
    }
    snapshot = await readDurableSnapshot(input, facts)
    assertDurableBinding(snapshot, facts)
    const operation = snapshot.operation
    if (!operation) {
      throw new ProviderTurnCoordinationError("recovery_unavailable", "The durable provider turn disappeared")
    }
    if (operation.state === "denied" || operation.state === "reconciliation_required") {
      return durableResult(operation, snapshot.dispatch?.receipt ?? null)
    }
    if (!snapshot.dispatch) {
      throw new ProviderTurnCoordinationError(
        "operation_in_progress",
        "The durable provider turn is waiting for its original consent flow",
      )
    }
    if (snapshot.dispatch.recoveryStatus === "claimed_no_receipt") {
      if (now < Date.parse(snapshot.dispatch.claim!.claimExpiresAt)) {
        throw new ProviderTurnCoordinationError(
          "operation_in_progress",
          "The one-shot provider claim is active; recovery will not retry it",
        )
      }
      return recordUncertainty(input, facts, snapshot.dispatch.claim!.fencingToken, new Date(now).toISOString())
    }
    if (snapshot.dispatch.recoveryStatus === "pending_outbox") {
      throw new ProviderTurnCoordinationError(
        "recovery_unavailable",
        "The provider dispatch was not claimed and is not retried automatically",
      )
    }
    return durableResult(operation, snapshot.dispatch.receipt)
  } catch (cause) {
    if (cause instanceof ProviderTurnCoordinationError) throw cause
    throw new ProviderTurnCoordinationError(
      "recovery_unavailable",
      "The provider turn could not be recovered without retrying the provider",
    )
  }
}

function makeReceipt(
  input: ExecuteProviderTurnInput,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  observation: AdapterObservation,
) {
  const observationDigest = digest(
    canonicalJson({
      capabilityDigest: facts.capabilityDigest,
      classification: "provider_turn_execution_ambiguous",
      executionBoundary: "network_egress_host_no_sandbox",
      observation,
    }),
  )
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: providerTurnExecutor, version: "1", digest: providerTurnAdapterDigest },
    effectClass: "provider_turn",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation: { kind: "effect_unknown", observationDigest },
    verificationContext: legacyUncertaintyContext(input, facts),
    output: {
      digest: observation.kind === "finish_observed_unenforced" ? observation.responseDigest : observationDigest,
      bytes: observation.kind === "finish_observed_unenforced" ? observation.responseBytes : 0,
      preview:
        observation.kind === "finish_observed_unenforced"
          ? "EFFECT UNKNOWN — FINISH OBSERVED AT UNENFORCED ADAPTER SEAM"
          : "EFFECT UNKNOWN — PROVIDER TURN REQUIRES RECONCILIATION",
    },
  })
}

function legacyUncertaintyContext(
  input: ExecuteProviderTurnInput,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
): OperationReceipt["verificationContext"] {
  if (facts.repositorySnapshotDigest) {
    return {
      schemaVersion: 2,
      admittedBaselineDigest: facts.baselineTrustDigest,
      admittedRepositorySnapshotDigest: facts.repositorySnapshotDigest,
      postEffectWorkspaceDigest: null,
      postEffectRepositorySnapshotDigest: null,
      workspaceIdentity: input.report.identity!,
      targetIdentity: null,
      preflightLimits: input.report.limits,
      activationGuard: "blocked",
    }
  }
  return {
    admittedBaselineDigest: facts.baselineTrustDigest,
    postEffectWorkspaceDigest: null,
    workspaceIdentity: input.report.identity!,
    targetIdentity: null,
    preflightLimits: input.report.limits,
    activationGuard: "blocked",
  }
}

async function ingestPendingReceipt(
  input: ExecuteProviderTurnInput,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
  trustedAt: string,
) {
  const entry = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.get(facts.receiptID)
    }),
  )
  if (!entry || entry.acknowledgement) return
  if (
    entry.receipt.operationID !== facts.operationID ||
    entry.receipt.receiptID !== facts.receiptID ||
    entry.receipt.capabilityDigest !== facts.capabilityDigest
  ) {
    throw new ProviderTurnCoordinationError(
      "recovery_unavailable",
      "The pending receipt is not bound to this provider turn",
    )
  }
  const ingested = await ingestReceipt(input, facts, entry.receipt, trustedAt)
  await acknowledgeReceipt(input.spoolFilename, entry.receipt, ingested.event.eventID, ingested.event.digest)
}

async function ingestReceipt(
  input: ExecuteProviderTurnInput,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
  receipt: OperationReceipt,
  trustedAt: string,
) {
  return runWithCoordinatorLedger(
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
    () => trustedAt,
  )
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
  input: ExecuteProviderTurnInput,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
  fencingToken: number,
  observedAt: string,
) {
  const uncertainty = requireUncertainty({
    uncertaintyID: deterministicUUID(facts.operationID, "uncertainty:1"),
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
          capabilityDigest: facts.capabilityDigest,
          executionBoundary: "network_egress_host_no_sandbox",
          observation: "provider_receipt_missing",
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
              subject: "astra-coordinator:provider-turn-recovery",
              componentDigest: providerTurnAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    () => observedAt,
  )
  return durableResult(recorded.operation, null)
}

async function revalidateBaseline(
  input: Pick<ExecuteProviderTurnInput, "report" | "repositoryBaseline">,
  repositorySnapshotDigest: string | null,
) {
  const root = await lstat(input.report.root).catch(() => null)
  if (
    !root?.isDirectory() ||
    root.isSymbolicLink() ||
    String(root.dev) !== input.report.identity?.device ||
    String(root.ino) !== input.report.identity.inode
  ) {
    return { matched: false as const }
  }
  if (!isGitWorkspace(input.report)) return { matched: true as const }
  if (!input.repositoryBaseline || input.repositoryBaseline.snapshotDigest !== repositorySnapshotDigest) {
    return { matched: false as const }
  }
  const result = await revalidateGitRepositoryBaseline(input.report.root, input.repositoryBaseline)
  return {
    matched:
      result.status === "current" &&
      result.expectedSnapshotDigest === input.repositoryBaseline.snapshotDigest &&
      result.currentSnapshotDigest === input.repositoryBaseline.snapshotDigest,
  } as const
}

type AdapterObservation =
  | Readonly<{
      kind: "finish_observed_unenforced"
      finishReason: UntrustedProviderTurnAdapterFinishEvent["finishReason"]
      finalOrigin: string
      responseDigest: ContentDigest
      responseBytes: number
    }>
  | Readonly<{ kind: "unknown"; reasonDigest: ContentDigest }>

/**
 * This adapter seam has no trusted network implementation yet. Even a valid
 * terminal event remains effect_unknown until Astra owns transport, redirect,
 * and origin enforcement inside the provider integration.
 */
function normalizeAdapterEvent(input: unknown, request: UntrustedProviderTurnAdapterRequest): AdapterObservation {
  try {
    const event = exactRecord(input, ["type", "requestBinding", "finalOrigin", "finishReason", "response"])
    if (event.type !== "provider.finish") return unknownAdapterObservation("unsupported_adapter_event")
    const binding = exactRecord(event.requestBinding, [
      "operationID",
      "attemptID",
      "capabilityGrantID",
      "capabilityDigest",
      "expectedOrigin",
      "logicalPayloadDigest",
      "logicalPayloadBytes",
    ])
    if (
      binding.operationID !== request.operationID ||
      binding.attemptID !== request.capability.attemptID ||
      binding.capabilityGrantID !== request.capability.capabilityGrantID ||
      binding.capabilityDigest !== request.capability.capabilityDigest ||
      binding.expectedOrigin !== request.expectedOrigin ||
      binding.logicalPayloadDigest !== request.logicalPayload.digest ||
      binding.logicalPayloadBytes !== request.logicalPayload.bytes ||
      event.finalOrigin !== request.expectedOrigin
    ) {
      return unknownAdapterObservation("adapter_binding_or_origin_mismatch")
    }
    if (
      event.finishReason !== "stop" &&
      event.finishReason !== "length" &&
      event.finishReason !== "tool_calls" &&
      event.finishReason !== "content_filter" &&
      event.finishReason !== "other"
    ) {
      return unknownAdapterObservation("invalid_finish_reason")
    }
    if (!(event.response instanceof Uint8Array)) return unknownAdapterObservation("invalid_response_bytes")
    const responseBytes = event.response.byteLength
    if (!Number.isSafeInteger(responseBytes) || responseBytes > maximumProviderResponseBytes) {
      return unknownAdapterObservation("response_limit_exceeded")
    }
    const response = Uint8Array.from(event.response)
    if (response.byteLength !== responseBytes) return unknownAdapterObservation("response_copy_mismatch")
    return {
      kind: "finish_observed_unenforced",
      finishReason: event.finishReason,
      finalOrigin: event.finalOrigin,
      responseDigest: requireContentDigest(`sha256:${createHash("sha256").update(response).digest("hex")}`),
      responseBytes: response.byteLength,
    }
  } catch {
    return unknownAdapterObservation("adapter_failed_or_malformed")
  }
}

function unknownAdapterObservation(reason: string): AdapterObservation {
  return { kind: "unknown", reasonDigest: digest(`astra-provider-turn:${reason}:v1`) }
}

function exactRecord(input: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Expected record")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Expected plain record")
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string") ||
    fields.some((field) => !Object.hasOwn(input, field))
  ) {
    throw new TypeError("Unexpected adapter event fields")
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(input, field)]))
}

function durableResult(operation: OperationRecord, receipt: OperationReceipt | null): DurableProviderTurnResult {
  if (operation.state !== "denied" && operation.state !== "reconciliation_required") {
    throw new ProviderTurnCoordinationError(
      "recovery_unavailable",
      "The provider turn has not reached a recoverable terminal state",
    )
  }
  return {
    operationID: operation.operationID,
    state: operation.state,
    status: operation.state === "denied" ? "denied_without_effect" : "effect_unknown",
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    boundaryLabel: providerTurnExecutionBoundaryLabel,
  }
}

async function readDurableSnapshot(
  input: ExecuteProviderTurnInput,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const operation = yield* ledger.getOperation(facts.operationID)
      return {
        operation,
        dispatch: yield* ledger.getDispatchSnapshot(facts.dispatchRequestID),
        events: operation ? yield* ledger.readEvents(facts.operationID, { limit: 20 }) : [],
      }
    }),
  )
}

function assertDurableBinding(
  snapshot: Awaited<ReturnType<typeof readDurableSnapshot>>,
  facts: ReturnType<typeof makeProviderTurnOperationFacts>,
) {
  const operation = snapshot.operation
  const admitted = snapshot.events.find((event) => event.name === "operation.admitted")
  const policy = snapshot.events.find((event) => event.name === "policy.ask")
  if (!operation || !admitted || !policy) throw divergentOperationError()
  const admittedPayload = optionalRecord(admitted?.payload)
  const admittedBaseline = optionalRecord(admittedPayload?.baseline)
  const policyPayload = optionalRecord(policy?.payload)
  const mismatch =
    operation.operationID !== facts.operationID ||
    operation.admissionKey !== facts.admissionKey ||
    operation.baselineTrustDigest !== facts.baselineTrustDigest ||
    operation.baselineAdapterDigest !== providerTurnAdapterDigest ||
    admitted?.eventID !== facts.eventIDs.admitted ||
    admitted.recordedAt !== facts.admissionCommands[0].event.recordedAt ||
    admitted.observedAt !== facts.admissionCommands[0].event.observedAt ||
    canonicalJson(admitted.payload) !== canonicalJson(facts.admissionCommands[0].event.payload) ||
    admittedPayload?.admissionKey !== facts.admissionKey ||
    admittedBaseline?.trustDigest !== facts.baselineTrustDigest ||
    policy?.eventID !== facts.eventIDs.policy ||
    policy.recordedAt !== facts.admissionCommands[1].event.recordedAt ||
    policy.observedAt !== facts.admissionCommands[1].event.observedAt ||
    canonicalJson(policy.payload) !== canonicalJson(facts.admissionCommands[1].event.payload) ||
    policyPayload?.capabilityDigest !== facts.capabilityDigest ||
    policyPayload?.previewDigest !== facts.previewDigest ||
    policyPayload?.expiresAt !== facts.authorizationExpiresAt ||
    (operation.attemptID !== null && operation.attemptID !== facts.attemptID) ||
    (operation.capabilityGrantID !== null && operation.capabilityGrantID !== facts.capabilityGrantID) ||
    (operation.capabilityDigest !== null && operation.capabilityDigest !== facts.capabilityDigest) ||
    (operation.dispatchRequestID !== null && operation.dispatchRequestID !== facts.dispatchRequestID) ||
    (operation.dispatchExecutor !== null && operation.dispatchExecutor !== providerTurnExecutor) ||
    (operation.dispatchAdapterDigest !== null && operation.dispatchAdapterDigest !== providerTurnAdapterDigest)
  if (mismatch) throw divergentOperationError()

  const dispatch = snapshot.dispatch
  if (!dispatch) {
    if (
      operation.dispatchRequestID !== null ||
      operation.dispatchExecutor !== null ||
      operation.dispatchAdapterDigest !== null
    ) {
      throw divergentOperationError()
    }
    return
  }
  const request = dispatch.request
  if (
    request.dispatchRequestID !== facts.dispatchRequestID ||
    request.operationID !== facts.operationID ||
    request.attemptID !== facts.attemptID ||
    request.capabilityGrantID !== facts.capabilityGrantID ||
    request.capabilityDigest !== facts.capabilityDigest ||
    request.baselineDigest !== facts.baselineTrustDigest ||
    request.executor !== providerTurnExecutor ||
    request.adapterDigest !== providerTurnAdapterDigest ||
    request.idempotencyKey !== facts.dispatchIdempotencyKey ||
    request.authorizationExpiresAt !== facts.authorizationExpiresAt
  ) {
    throw divergentOperationError()
  }
  if (
    dispatch.claim &&
    (dispatch.claim.operationID !== facts.operationID ||
      dispatch.claim.attemptID !== facts.attemptID ||
      dispatch.claim.capabilityDigest !== facts.capabilityDigest ||
      dispatch.claim.executor !== providerTurnExecutor)
  ) {
    throw divergentOperationError()
  }
  if (
    dispatch.receipt &&
    (dispatch.receipt.operationID !== facts.operationID ||
      dispatch.receipt.attemptID !== facts.attemptID ||
      dispatch.receipt.capabilityDigest !== facts.capabilityDigest ||
      dispatch.receipt.effectClass !== "provider_turn")
  ) {
    throw divergentOperationError()
  }
}

function divergentOperationError() {
  return new ProviderTurnCoordinationError(
    "invalid_input",
    "The Operation ID is already bound to different provider turn facts",
  )
}

function optionalRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : null
}

function snapshotExecuteInput(source: ExecuteProviderTurnInput): ExecuteProviderTurnInput {
  const facts = snapshotProviderTurnOperationFactsInput(source)
  if (typeof source.ledgerFilename !== "string" || typeof source.spoolFilename !== "string") {
    throw new TypeError("Provider turn state filenames must be strings")
  }
  return Object.freeze({ ...facts, ledgerFilename: source.ledgerFilename, spoolFilename: source.spoolFilename })
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`The provider turn receipt is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError(`The provider turn uncertainty is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The provider turn response digest is invalid")
  return parsed.value
}

function isGitWorkspace(report: WorkspaceTrustReport) {
  return report.surfaces.some((surface) => surface.kind === "git_metadata")
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
