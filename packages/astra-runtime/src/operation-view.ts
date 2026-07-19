import { access } from "node:fs/promises"
import { operationSemanticKey } from "@astra/domain/operation"
import type { OperationSemanticKey, OperationState } from "@astra/domain/operation"
import { parseOperationID } from "@astra/domain/operation-contract"
import {
  makeOperationLedger,
  type DispatchSnapshot,
  type OperationLedger,
  type OperationRecord,
  type PersistedOperationEvent,
} from "@astra/ledger"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"

const maximumReadEvents = 256
const maximumListedOperations = 64
const maximumRecoveryCandidates = 64

/** Honest coverage label: the durable list is derived from dispatch records only. */
export const operationViewSourceCoverage = "dispatched_operations_only" as const

export class OperationViewError extends Error {
  readonly _tag = "OperationViewError"

  constructor(
    readonly code: "ledger_unavailable" | "invalid_operation_id",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

export type OperationViewSummaryFacts = Readonly<{
  operationID: string
  intentKind: string
  state: OperationState
  semanticKey: OperationSemanticKey
  sequence: number
  updatedAt: string
}>

export type OperationViewEventFacts = Readonly<{
  sequence: number
  name: string
  actorKind: "user" | "system" | "agent"
  actorSubject: string
  observedAt: string
  recordedAt: string
  digest: string
  previousDigest: string | null
}>

export type OperationViewDispatchFacts = Readonly<{
  dispatchRequestID: string
  recoveryStatus: DispatchSnapshot["recoveryStatus"]
  executor: string | null
  receipt: Readonly<{ receiptID: string; outcome: string; endedAt: string }> | null
  uncertainty: Readonly<{ reason: string; observedAt: string }> | null
}>

export type OperationViewVerificationFacts = Readonly<{
  evidenceID: string
  evidenceDigest: string
  verifier: string
  observedAt: string
  criteria: ReadonlyArray<Readonly<{ criterionID: string; result: "passed" | "failed" | "unknown" }>>
}>

export type OperationViewDetailFacts = Readonly<{
  operation: OperationViewSummaryFacts
  events: ReadonlyArray<OperationViewEventFacts>
  dispatch: OperationViewDispatchFacts | null
  verification: OperationViewVerificationFacts | null
}>

export type OperationViewListFacts = Readonly<{
  coverage: typeof operationViewSourceCoverage
  operations: ReadonlyArray<OperationViewSummaryFacts>
}>

export type OperationViewRecoveryCandidateFacts = Readonly<{
  dispatchRequestID: string
  operationID: string
  recoveryStatus: DispatchSnapshot["recoveryStatus"]
  executor: string
  requestedAt: string
  authorizationExpiresAt: string
}>

/**
 * Lists dispatched Operations from the durable ledger, read-only. Operations
 * that never produced a dispatch record (for example durable denials in a
 * different ledger family) are not enumerable through this read API; the
 * coverage label states that limitation instead of hiding it.
 */
export async function listOperationViews(filename: string): Promise<OperationViewListFacts> {
  return withReadOnlyLedger(filename, (ledger) =>
    Effect.gen(function* () {
      const candidates = yield* ledger.listRecoveryCandidates({ limit: maximumRecoveryCandidates })
      const seen = new Set<string>()
      const operations: Array<OperationViewSummaryFacts> = []
      for (const candidate of candidates) {
        const operationID = candidate.request.operationID
        if (seen.has(operationID) || operations.length >= maximumListedOperations) continue
        seen.add(operationID)
        const operation = yield* ledger.getOperation(operationID)
        if (!operation) continue
        const events = yield* ledger.readEvents(operationID, { limit: maximumReadEvents })
        operations.push(summaryFacts(operation, events))
      }
      operations.sort((left, right) =>
        left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
      )
      return { coverage: operationViewSourceCoverage, operations: Object.freeze(operations) }
    }),
  )
}

/** Reads one Operation's durable truth: projection, event chain, dispatch snapshot, evidence. */
export async function readOperationViewDetail(
  filename: string,
  operationID: string,
): Promise<OperationViewDetailFacts | null> {
  const parsedID = parseOperationID(operationID)
  if (!parsedID.ok) throw new OperationViewError("invalid_operation_id", "The Operation ID is not canonical")
  return withReadOnlyLedger(filename, (ledger) =>
    Effect.gen(function* () {
      const operation = yield* ledger.getOperation(parsedID.value)
      if (!operation) return null
      const events = yield* ledger.readEvents(parsedID.value, { limit: maximumReadEvents })
      const snapshot = operation.dispatchRequestID
        ? yield* ledger.getDispatchSnapshot(operation.dispatchRequestID)
        : null
      const verification = yield* ledger.getVerification(parsedID.value)
      return {
        operation: summaryFacts(operation, events),
        events: Object.freeze(events.map(eventFacts)),
        dispatch: snapshot ? dispatchFacts(snapshot) : null,
        verification: verification
          ? {
              evidenceID: verification.evidence.evidenceID,
              evidenceDigest: verification.evidenceDigest,
              verifier: verification.evidence.verifier.identity,
              observedAt: verification.evidence.observedAt,
              criteria: Object.freeze(
                verification.evidence.criteria.map((criterion) => ({
                  criterionID: criterion.criterionID,
                  result: criterion.result,
                })),
              ),
            }
          : null,
      }
    }),
  )
}

/** Lists dispatch recovery candidates for surfacing only; nothing here retries or closes ambiguity. */
export async function listOperationRecoveryCandidates(
  filename: string,
): Promise<ReadonlyArray<OperationViewRecoveryCandidateFacts>> {
  return withReadOnlyLedger(filename, (ledger) =>
    Effect.gen(function* () {
      const candidates = yield* ledger.listRecoveryCandidates({ limit: maximumRecoveryCandidates })
      return Object.freeze(
        candidates.map((candidate) => ({
          dispatchRequestID: candidate.request.dispatchRequestID,
          operationID: candidate.request.operationID,
          recoveryStatus: candidate.recoveryStatus,
          executor: candidate.request.executor,
          requestedAt: candidate.request.requestedAt,
          authorizationExpiresAt: candidate.request.authorizationExpiresAt,
        })),
      )
    }),
  )
}

function summaryFacts(
  operation: OperationRecord,
  events: ReadonlyArray<PersistedOperationEvent>,
): OperationViewSummaryFacts {
  return {
    operationID: operation.operationID,
    intentKind: admittedIntentKind(events),
    state: operation.state,
    // Semantic keys are computed here, from the durable state, by the domain projection.
    semanticKey: operationSemanticKey(operation.state),
    sequence: operation.sequence,
    updatedAt: operation.updatedAt,
  }
}

function admittedIntentKind(events: ReadonlyArray<PersistedOperationEvent>): string {
  const admitted = events.find((event) => event.name === "operation.admitted")
  const intent = admitted?.payload["intent"]
  if (typeof intent === "object" && intent !== null && !Array.isArray(intent)) {
    const kind = (intent as Record<string, unknown>)["kind"]
    if (typeof kind === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(kind)) return kind
  }
  return "unknown"
}

function eventFacts(event: PersistedOperationEvent): OperationViewEventFacts {
  return {
    sequence: event.sequence,
    name: event.name,
    actorKind: event.actor.kind,
    actorSubject: event.actor.subject,
    observedAt: event.observedAt,
    recordedAt: event.recordedAt,
    digest: event.digest,
    previousDigest: event.previousDigest,
  }
}

function dispatchFacts(snapshot: DispatchSnapshot): OperationViewDispatchFacts {
  return {
    dispatchRequestID: snapshot.request.dispatchRequestID,
    recoveryStatus: snapshot.recoveryStatus,
    executor: snapshot.claim?.executor ?? null,
    receipt: snapshot.receipt
      ? {
          receiptID: snapshot.receipt.receiptID,
          outcome: snapshot.receipt.observation.kind,
          endedAt: snapshot.receipt.endedAt,
        }
      : null,
    uncertainty: snapshot.uncertainty
      ? { reason: snapshot.uncertainty.reason, observedAt: snapshot.uncertainty.observedAt }
      : null,
  }
}

async function withReadOnlyLedger<A, E>(
  filename: string,
  use: (ledger: OperationLedger) => Effect.Effect<A, E>,
): Promise<A> {
  await access(filename).catch((cause) => {
    throw new OperationViewError("ledger_unavailable", "The Operation ledger does not exist", cause)
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* makeOperationLedger()
      return yield* use(ledger)
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename, readonly: true, readwrite: false, create: false, disableWAL: true }),
      ),
      Effect.scoped,
    ),
  ).catch((cause) => {
    if (cause instanceof OperationViewError) throw cause
    throw new OperationViewError("ledger_unavailable", "The Operation ledger could not be read", cause)
  })
}
