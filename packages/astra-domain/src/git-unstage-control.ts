import { parseGitUnstageAllPreview, type GitUnstageAllPreview } from "./git-control-mutation"
import { parseExactRecord } from "./operation-contract-validation"

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/

export type GitUnstagePrepareRequest = Readonly<{
  schemaVersion: 1
  method: "git-unstage.prepare"
  requestId: string
  sessionID: string
  token: string
}>

export type GitUnstageDecisionRequest = Readonly<{
  schemaVersion: 1
  method: "git-unstage.decide"
  requestId: string
  sessionID: string
  token: string
  proposalID: string
  decision: "approve" | "reject"
}>

export type GitUnstageControlRequest = GitUnstagePrepareRequest | GitUnstageDecisionRequest

export type GitUnstageControlPreview = Readonly<{
  schemaVersion: 1
  action: "Unstage all"
  proposalID: string
  authority: GitUnstageAllPreview
}>

export type GitUnstagePrepareResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "prepared"
      preview: GitUnstageControlPreview
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "blocked"
      reason: string
    }>

type GitUnstageDecisionBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  proposalDigest: `sha256:${string}`
}>

export type GitUnstageDecisionResult =
  | (GitUnstageDecisionBinding &
      Readonly<{
        status: "denied_without_git_effect"
        operationID: string
      }>)
  | (GitUnstageDecisionBinding &
      Readonly<{
        status: "failed_without_effect"
        operationID: string
        reason: string
      }>)
  | (GitUnstageDecisionBinding &
      Readonly<{
        status: "verified"
        verification: "independent_post_state"
        operationID: string
        receiptID: string
        snapshotDigest: `sha256:${string}`
      }>)
  | (GitUnstageDecisionBinding &
      Readonly<{
        status: "reconciliation_required"
        operationID: string | null
        reason: string
      }>)
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "blocked"
      reason: string
    }>

export type GitUnstageProgress = GitUnstageDecisionBinding &
  (
    | Readonly<{
        status: "recording_authority" | "host_adapter_validating" | "verifying"
        verification: "not_verified"
      }>
    | Readonly<{
        status: "effect_observed_not_verified"
        verification: "not_verified"
        operationID: string
        receiptID: string
        snapshotDigest: `sha256:${string}`
      }>
  )

export type GitUnstageControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: string }>

/** Accepts only the path-free prepare request for the parent-owned action. */
export function parseGitUnstagePrepareRequest(input: unknown): GitUnstageControlParseResult<GitUnstagePrepareRequest> {
  const record = exactRecord(input, ["schemaVersion", "method", "requestId", "sessionID", "token"])
  if (!record) return rejected("invalid_prepare_request_shape")
  if (
    record.schemaVersion !== 1 ||
    record.method !== "git-unstage.prepare" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token)
  ) {
    return rejected("invalid_prepare_request_value")
  }
  return accepted({
    schemaVersion: 1,
    method: "git-unstage.prepare",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
  })
}

/** Accepts only approve or reject for one server-created proposal. */
export function parseGitUnstageDecisionRequest(
  input: unknown,
): GitUnstageControlParseResult<GitUnstageDecisionRequest> {
  const record = exactRecord(input, [
    "schemaVersion",
    "method",
    "requestId",
    "sessionID",
    "token",
    "proposalID",
    "decision",
  ])
  if (!record) return rejected("invalid_decision_request_shape")
  if (
    record.schemaVersion !== 1 ||
    record.method !== "git-unstage.decide" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !uuid(record.proposalID) ||
    (record.decision !== "approve" && record.decision !== "reject")
  ) {
    return rejected("invalid_decision_request_value")
  }
  return accepted({
    schemaVersion: 1,
    method: "git-unstage.decide",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    proposalID: record.proposalID,
    decision: record.decision,
  })
}

export function parseGitUnstageControlRequest(input: unknown): GitUnstageControlParseResult<GitUnstageControlRequest> {
  const method = plainRecord(input)?.method
  if (method === "git-unstage.prepare") return parseGitUnstagePrepareRequest(input)
  if (method === "git-unstage.decide") return parseGitUnstageDecisionRequest(input)
  return rejected("invalid_request_method")
}

export function parseGitUnstageControlPreview(input: unknown): GitUnstageControlParseResult<GitUnstageControlPreview> {
  const record = exactRecord(input, ["schemaVersion", "action", "proposalID", "authority"])
  if (!record) return rejected("invalid_preview_shape")
  const authority = parseGitUnstageAllPreview(record.authority)
  if (record.schemaVersion !== 1 || record.action !== "Unstage all" || !uuid(record.proposalID) || !authority.ok) {
    return rejected("invalid_preview_value")
  }
  return accepted({
    schemaVersion: 1,
    action: "Unstage all",
    proposalID: record.proposalID,
    authority: authority.value,
  })
}

export function parseGitUnstagePrepareResult(input: unknown): GitUnstageControlParseResult<GitUnstagePrepareResult> {
  const broad = plainRecord(input)
  if (!broad) return rejected("invalid_prepare_result_shape")
  if (broad.status === "prepared") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "status", "preview"])
    const preview = parseGitUnstageControlPreview(record?.preview)
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !preview.ok) {
      return rejected("invalid_prepare_result_value")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "prepared", preview: preview.value })
  }
  if (broad.status === "blocked") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "status", "reason"])
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !reason(record.reason)) {
      return rejected("invalid_prepare_result_value")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "blocked", reason: record.reason })
  }
  return rejected("invalid_prepare_result_value")
}

export function parseGitUnstageDecisionResult(input: unknown): GitUnstageControlParseResult<GitUnstageDecisionResult> {
  const broad = plainRecord(input)
  if (!broad) return rejected("invalid_decision_result_shape")
  if (broad.status === "blocked") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !uuid(record.requestId) ||
      !uuid(record.proposalID) ||
      !reason(record.reason)
    ) {
      return rejected("invalid_decision_result_value")
    }
    return accepted({
      schemaVersion: 1,
      requestId: record.requestId,
      proposalID: record.proposalID,
      status: "blocked",
      reason: record.reason,
    })
  }
  const binding = decisionBinding(broad)
  if (!binding) return rejected("invalid_decision_result_value")
  if (broad.status === "denied_without_git_effect") {
    if (!exactRecord(input, [...decisionBindingKeys, "status", "operationID"]) || !uuid(broad.operationID)) {
      return rejected("invalid_decision_result_value")
    }
    return accepted({ ...binding, status: "denied_without_git_effect", operationID: broad.operationID })
  }
  if (broad.status === "failed_without_effect") {
    if (
      !exactRecord(input, [...decisionBindingKeys, "status", "operationID", "reason"]) ||
      !uuid(broad.operationID) ||
      !reason(broad.reason)
    ) {
      return rejected("invalid_decision_result_value")
    }
    return accepted({
      ...binding,
      status: "failed_without_effect",
      operationID: broad.operationID,
      reason: broad.reason,
    })
  }
  if (broad.status === "reconciliation_required") {
    if (
      !exactRecord(input, [...decisionBindingKeys, "status", "operationID", "reason"]) ||
      (broad.operationID !== null && !uuid(broad.operationID)) ||
      !reason(broad.reason)
    ) {
      return rejected("invalid_decision_result_value")
    }
    return accepted({
      ...binding,
      status: "reconciliation_required",
      operationID: broad.operationID,
      reason: broad.reason,
    })
  }
  if (broad.status !== "verified") return rejected("invalid_decision_result_value")
  if (
    !exactRecord(input, [
      ...decisionBindingKeys,
      "status",
      "verification",
      "operationID",
      "receiptID",
      "snapshotDigest",
    ]) ||
    broad.verification !== "independent_post_state" ||
    !uuid(broad.operationID) ||
    !uuid(broad.receiptID) ||
    !digest(broad.snapshotDigest)
  ) {
    return rejected("invalid_decision_result_value")
  }
  return accepted({
    ...binding,
    status: "verified",
    verification: "independent_post_state",
    operationID: broad.operationID,
    receiptID: broad.receiptID,
    snapshotDigest: broad.snapshotDigest,
  })
}

export function parseGitUnstageProgress(input: unknown): GitUnstageControlParseResult<GitUnstageProgress> {
  const broad = plainRecord(input)
  if (!broad) return rejected("invalid_progress_shape")
  const binding = decisionBinding(broad)
  if (!binding || broad.verification !== "not_verified") return rejected("invalid_progress_value")
  if (
    broad.status === "recording_authority" ||
    broad.status === "host_adapter_validating" ||
    broad.status === "verifying"
  ) {
    if (!exactRecord(input, [...decisionBindingKeys, "status", "verification"])) {
      return rejected("invalid_progress_shape")
    }
    return accepted({ ...binding, status: broad.status, verification: "not_verified" })
  }
  if (
    broad.status !== "effect_observed_not_verified" ||
    !exactRecord(input, [
      ...decisionBindingKeys,
      "status",
      "verification",
      "operationID",
      "receiptID",
      "snapshotDigest",
    ]) ||
    !uuid(broad.operationID) ||
    !uuid(broad.receiptID) ||
    !digest(broad.snapshotDigest)
  ) {
    return rejected("invalid_progress_value")
  }
  return accepted({
    ...binding,
    status: "effect_observed_not_verified",
    verification: "not_verified",
    operationID: broad.operationID,
    receiptID: broad.receiptID,
    snapshotDigest: broad.snapshotDigest,
  })
}

const decisionBindingKeys = ["schemaVersion", "requestId", "proposalID", "proposalDigest"] as const

function decisionBinding(input: Readonly<Record<string, unknown>>): GitUnstageDecisionBinding | null {
  if (input.schemaVersion !== 1 || !uuid(input.requestId) || !uuid(input.proposalID) || !digest(input.proposalDigest)) {
    return null
  }
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    proposalID: input.proposalID,
    proposalDigest: input.proposalDigest,
  }
}

function exactRecord(input: unknown, keys: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, keys)
  return parsed.ok ? parsed.value : null
}

function plainRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    record[key] = descriptor.value
  }
  return record
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

function accepted<Value>(value: Value): GitUnstageControlParseResult<Value> {
  return { ok: true, value: Object.freeze(value) }
}

function rejected(reason: string): GitUnstageControlParseResult<never> {
  return { ok: false, reason }
}
