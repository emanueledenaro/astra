import { operationEvents, operationSemanticKey, operationStates } from "./operation"
import type { OperationSemanticKey, OperationState } from "./operation"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const subjectPattern = /^[\x20-\x7e]{1,128}$/

const operationStateSet = new Set<string>(operationStates)
const operationEventSet = new Set<string>(operationEvents)
const actorKinds = new Set(["user", "system", "agent"])
const recoveryStatuses = new Set(["pending_outbox", "claimed_no_receipt", "receipt_ingested", "claim_uncertain"])
const receiptOutcomes = new Set(["effect_observed", "effect_completed", "no_effect_proved", "effect_unknown"])
const criterionResults = new Set(["passed", "failed", "unknown"])

export const maximumOperationViewOperations = 64
export const maximumOperationViewEvents = 256
export const maximumOperationViewRecoveryCandidates = 64
export const maximumOperationViewCriteria = 16

/** Honest coverage label: the durable list is derived from dispatch records only. */
export const operationViewCoverage = "dispatched_operations_only" as const
/** Honest recovery framing: candidates are surfaced, never retried, never auto-closed. */
export const operationViewRecoveryNote = "recovery_is_not_retry_ambiguity_is_preserved" as const

export type OperationViewControlRequest =
  | Readonly<{ schemaVersion: 1; method: "operation-view.list"; requestId: string; sessionID: string; token: string }>
  | Readonly<{
      schemaVersion: 1
      method: "operation-view.detail"
      requestId: string
      sessionID: string
      token: string
      operationID: string
    }>
  | Readonly<{
      schemaVersion: 1
      method: "operation-view.recovery"
      requestId: string
      sessionID: string
      token: string
    }>

export type OperationViewSummary = Readonly<{
  operationID: string
  intentKind: string
  state: OperationState
  semanticKey: OperationSemanticKey
  sequence: number
  updatedAt: string
}>

export type OperationViewEvent = Readonly<{
  sequence: number
  name: string
  actorKind: "user" | "system" | "agent"
  actorSubject: string
  observedAt: string
  recordedAt: string
  digest: `sha256:${string}`
  previousDigest: `sha256:${string}` | null
}>

export type OperationViewReceipt = Readonly<{
  receiptID: string
  outcome: "effect_observed" | "effect_completed" | "no_effect_proved" | "effect_unknown"
  endedAt: string
}>

export type OperationViewUncertainty = Readonly<{ reason: string; observedAt: string }>

export type OperationViewDispatch = Readonly<{
  dispatchRequestID: string
  recoveryStatus: "pending_outbox" | "claimed_no_receipt" | "receipt_ingested" | "claim_uncertain"
  executor: string | null
  receipt: OperationViewReceipt | null
  uncertainty: OperationViewUncertainty | null
}>

export type OperationViewVerification = Readonly<{
  evidenceID: string
  evidenceDigest: `sha256:${string}`
  verifier: string
  observedAt: string
  criteria: ReadonlyArray<Readonly<{ criterionID: string; result: "passed" | "failed" | "unknown" }>>
}>

export type OperationViewRecoveryCandidate = Readonly<{
  dispatchRequestID: string
  operationID: string
  recoveryStatus: OperationViewDispatch["recoveryStatus"]
  executor: string
  requestedAt: string
  authorizationExpiresAt: string
}>

export type OperationViewListResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "listed"
      coverage: typeof operationViewCoverage
      operations: ReadonlyArray<OperationViewSummary>
    }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

export type OperationViewDetailResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "detailed"
      operation: OperationViewSummary
      events: ReadonlyArray<OperationViewEvent>
      dispatch: OperationViewDispatch | null
      verification: OperationViewVerification | null
    }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "not_found"; operationID: string }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

export type OperationViewRecoveryResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "listed"
      note: typeof operationViewRecoveryNote
      candidates: ReadonlyArray<OperationViewRecoveryCandidate>
    }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

export type OperationViewControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_operation_view_control" }>

/** Accepts only read intents; the boundary carries no path, filter, or mutation field. */
export function parseOperationViewControlRequest(
  input: unknown,
): OperationViewControlParseResult<OperationViewControlRequest> {
  const broad = record(input)
  if (broad?.method === "operation-view.detail") {
    const value = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "operationID"])
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !uuid(value.requestId) ||
      !uuid(value.sessionID) ||
      !token(value.token) ||
      !uuid(value.operationID)
    ) {
      return invalid()
    }
    return valid({
      schemaVersion: 1,
      method: "operation-view.detail",
      requestId: value.requestId,
      sessionID: value.sessionID,
      token: value.token,
      operationID: value.operationID,
    })
  }
  if (broad?.method !== "operation-view.list" && broad?.method !== "operation-view.recovery") return invalid()
  const method = broad.method
  const value = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token"])
  if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.sessionID) || !token(value.token)) {
    return invalid()
  }
  return valid({
    schemaVersion: 1,
    method,
    requestId: value.requestId,
    sessionID: value.sessionID,
    token: value.token,
  })
}

export function parseOperationViewListResult(input: unknown): OperationViewControlParseResult<OperationViewListResult> {
  const broad = record(input)
  if (broad?.status === "listed") {
    const value = exact(input, ["schemaVersion", "requestId", "status", "coverage", "operations"])
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !uuid(value.requestId) ||
      value.coverage !== operationViewCoverage ||
      !Array.isArray(value.operations) ||
      value.operations.length > maximumOperationViewOperations
    ) {
      return invalid()
    }
    const operations: OperationViewSummary[] = []
    for (const candidate of value.operations) {
      const summary = parseSummary(candidate)
      if (!summary.ok) return invalid()
      operations.push(summary.value)
    }
    return valid({
      schemaVersion: 1,
      requestId: value.requestId,
      status: "listed",
      coverage: operationViewCoverage,
      operations: Object.freeze(operations),
    })
  }
  return parseBlocked(input)
}

export function parseOperationViewDetailResult(
  input: unknown,
): OperationViewControlParseResult<OperationViewDetailResult> {
  const broad = record(input)
  if (broad?.status === "detailed") {
    const value = exact(input, [
      "schemaVersion",
      "requestId",
      "status",
      "operation",
      "events",
      "dispatch",
      "verification",
    ])
    const operation = value ? parseSummary(value.operation) : invalid()
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !uuid(value.requestId) ||
      !operation.ok ||
      !Array.isArray(value.events) ||
      value.events.length > maximumOperationViewEvents
    ) {
      return invalid()
    }
    const events: OperationViewEvent[] = []
    let previousSequence = -1
    for (const candidate of value.events) {
      const event = parseEvent(candidate)
      if (!event.ok || event.value.sequence <= previousSequence) return invalid()
      previousSequence = event.value.sequence
      events.push(event.value)
    }
    const dispatch = value.dispatch === null ? valid(null) : parseDispatch(value.dispatch)
    const verification = value.verification === null ? valid(null) : parseVerification(value.verification)
    if (!dispatch.ok || !verification.ok) return invalid()
    if (operation.value.state === "succeeded" && verification.value === null) return invalid()
    return valid({
      schemaVersion: 1,
      requestId: value.requestId,
      status: "detailed",
      operation: operation.value,
      events: Object.freeze(events),
      dispatch: dispatch.value,
      verification: verification.value,
    })
  }
  if (broad?.status === "not_found") {
    const value = exact(input, ["schemaVersion", "requestId", "status", "operationID"])
    if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.operationID)) return invalid()
    return valid({ schemaVersion: 1, requestId: value.requestId, status: "not_found", operationID: value.operationID })
  }
  return parseBlocked(input)
}

export function parseOperationViewRecoveryResult(
  input: unknown,
): OperationViewControlParseResult<OperationViewRecoveryResult> {
  const broad = record(input)
  if (broad?.status === "listed") {
    const value = exact(input, ["schemaVersion", "requestId", "status", "note", "candidates"])
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !uuid(value.requestId) ||
      value.note !== operationViewRecoveryNote ||
      !Array.isArray(value.candidates) ||
      value.candidates.length > maximumOperationViewRecoveryCandidates
    ) {
      return invalid()
    }
    const candidates: OperationViewRecoveryCandidate[] = []
    for (const item of value.candidates) {
      const candidate = exact(item, [
        "dispatchRequestID",
        "operationID",
        "recoveryStatus",
        "executor",
        "requestedAt",
        "authorizationExpiresAt",
      ])
      if (
        !candidate ||
        !uuid(candidate.dispatchRequestID) ||
        !uuid(candidate.operationID) ||
        !recoveryStatus(candidate.recoveryStatus) ||
        !subject(candidate.executor) ||
        !timestamp(candidate.requestedAt) ||
        !timestamp(candidate.authorizationExpiresAt)
      ) {
        return invalid()
      }
      candidates.push({
        dispatchRequestID: candidate.dispatchRequestID,
        operationID: candidate.operationID,
        recoveryStatus: candidate.recoveryStatus,
        executor: candidate.executor,
        requestedAt: candidate.requestedAt,
        authorizationExpiresAt: candidate.authorizationExpiresAt,
      })
    }
    return valid({
      schemaVersion: 1,
      requestId: value.requestId,
      status: "listed",
      note: operationViewRecoveryNote,
      candidates: Object.freeze(candidates),
    })
  }
  return parseBlocked(input)
}

function parseSummary(input: unknown): OperationViewControlParseResult<OperationViewSummary> {
  const value = exact(input, ["operationID", "intentKind", "state", "semanticKey", "sequence", "updatedAt"])
  if (
    !value ||
    !uuid(value.operationID) ||
    !reason(value.intentKind) ||
    !operationState(value.state) ||
    // The semantic key is recomputed from the durable state; a stronger key cannot cross this boundary.
    value.semanticKey !== operationSemanticKey(value.state) ||
    !boundedSequence(value.sequence) ||
    !timestamp(value.updatedAt)
  ) {
    return invalid()
  }
  return valid({
    operationID: value.operationID,
    intentKind: value.intentKind,
    state: value.state,
    semanticKey: operationSemanticKey(value.state),
    sequence: value.sequence,
    updatedAt: value.updatedAt,
  })
}

function parseEvent(input: unknown): OperationViewControlParseResult<OperationViewEvent> {
  const value = exact(input, [
    "sequence",
    "name",
    "actorKind",
    "actorSubject",
    "observedAt",
    "recordedAt",
    "digest",
    "previousDigest",
  ])
  if (
    !value ||
    !boundedSequence(value.sequence) ||
    typeof value.name !== "string" ||
    !operationEventSet.has(value.name) ||
    !actorKind(value.actorKind) ||
    !subject(value.actorSubject) ||
    !timestamp(value.observedAt) ||
    !timestamp(value.recordedAt) ||
    !digest(value.digest) ||
    (value.previousDigest !== null && !digest(value.previousDigest))
  ) {
    return invalid()
  }
  return valid({
    sequence: value.sequence,
    name: value.name,
    actorKind: value.actorKind,
    actorSubject: value.actorSubject,
    observedAt: value.observedAt,
    recordedAt: value.recordedAt,
    digest: value.digest,
    previousDigest: value.previousDigest === null ? null : value.previousDigest,
  })
}

function parseDispatch(input: unknown): OperationViewControlParseResult<OperationViewDispatch> {
  const value = exact(input, ["dispatchRequestID", "recoveryStatus", "executor", "receipt", "uncertainty"])
  if (
    !value ||
    !uuid(value.dispatchRequestID) ||
    !recoveryStatus(value.recoveryStatus) ||
    (value.executor !== null && !subject(value.executor))
  ) {
    return invalid()
  }
  let receipt: OperationViewReceipt | null = null
  if (value.receipt !== null) {
    const candidate = exact(value.receipt, ["receiptID", "outcome", "endedAt"])
    if (
      !candidate ||
      !uuid(candidate.receiptID) ||
      !receiptOutcome(candidate.outcome) ||
      !timestamp(candidate.endedAt)
    ) {
      return invalid()
    }
    receipt = { receiptID: candidate.receiptID, outcome: candidate.outcome, endedAt: candidate.endedAt }
  }
  let uncertainty: OperationViewUncertainty | null = null
  if (value.uncertainty !== null) {
    const candidate = exact(value.uncertainty, ["reason", "observedAt"])
    if (!candidate || !reason(candidate.reason) || !timestamp(candidate.observedAt)) return invalid()
    uncertainty = { reason: candidate.reason, observedAt: candidate.observedAt }
  }
  // A receipt-bearing snapshot must say so; a stronger recovery classification cannot be invented.
  if (receipt !== null && value.recoveryStatus !== "receipt_ingested") return invalid()
  if (value.recoveryStatus === "receipt_ingested" && receipt === null) return invalid()
  if (value.recoveryStatus === "claim_uncertain" && uncertainty === null) return invalid()
  return valid({
    dispatchRequestID: value.dispatchRequestID,
    recoveryStatus: value.recoveryStatus,
    executor: value.executor === null ? null : value.executor,
    receipt,
    uncertainty,
  })
}

function parseVerification(input: unknown): OperationViewControlParseResult<OperationViewVerification> {
  const value = exact(input, ["evidenceID", "evidenceDigest", "verifier", "observedAt", "criteria"])
  if (
    !value ||
    !uuid(value.evidenceID) ||
    !digest(value.evidenceDigest) ||
    !subject(value.verifier) ||
    !timestamp(value.observedAt) ||
    !Array.isArray(value.criteria) ||
    value.criteria.length < 1 ||
    value.criteria.length > maximumOperationViewCriteria
  ) {
    return invalid()
  }
  const criteria: Array<Readonly<{ criterionID: string; result: "passed" | "failed" | "unknown" }>> = []
  for (const item of value.criteria) {
    const candidate = exact(item, ["criterionID", "result"])
    if (!candidate || !reason(candidate.criterionID) || !criterionResult(candidate.result)) return invalid()
    criteria.push({ criterionID: candidate.criterionID, result: candidate.result })
  }
  return valid({
    evidenceID: value.evidenceID,
    evidenceDigest: value.evidenceDigest,
    verifier: value.verifier,
    observedAt: value.observedAt,
    criteria: Object.freeze(criteria),
  })
}

function parseBlocked(
  input: unknown,
): OperationViewControlParseResult<
  Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>
> {
  const value = exact(input, ["schemaVersion", "requestId", "status", "reason"])
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !uuid(value.requestId) ||
    value.status !== "blocked" ||
    !reason(value.reason)
  ) {
    return invalid()
  }
  return valid({ schemaVersion: 1, requestId: value.requestId, status: "blocked", reason: value.reason })
}

function exact(input: unknown, keys: ReadonlyArray<string>) {
  const value = record(input)
  if (!value) return null
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return null
  return value
}

function record(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const output: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    output[key] = descriptor.value
  }
  return output
}

function uuid(input: unknown): input is string {
  return typeof input === "string" && uuidPattern.test(input)
}

function token(input: unknown): input is string {
  return typeof input === "string" && tokenPattern.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}

function reason(input: unknown): input is string {
  return typeof input === "string" && reasonPattern.test(input)
}

function subject(input: unknown): input is string {
  return typeof input === "string" && subjectPattern.test(input)
}

function timestamp(input: unknown): input is string {
  return (
    typeof input === "string" && timestampPattern.test(input) && new Date(Date.parse(input)).toISOString() === input
  )
}

function boundedSequence(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
}

function operationState(input: unknown): input is OperationState {
  return typeof input === "string" && operationStateSet.has(input)
}

function actorKind(input: unknown): input is "user" | "system" | "agent" {
  return typeof input === "string" && actorKinds.has(input)
}

function recoveryStatus(input: unknown): input is OperationViewDispatch["recoveryStatus"] {
  return typeof input === "string" && recoveryStatuses.has(input)
}

function receiptOutcome(input: unknown): input is OperationViewReceipt["outcome"] {
  return typeof input === "string" && receiptOutcomes.has(input)
}

function criterionResult(input: unknown): input is "passed" | "failed" | "unknown" {
  return typeof input === "string" && criterionResults.has(input)
}

function valid<Value>(value: Value): OperationViewControlParseResult<Value> {
  return { ok: true, value }
}

function invalid(): OperationViewControlParseResult<never> {
  return { ok: false, reason: "invalid_operation_view_control" }
}
