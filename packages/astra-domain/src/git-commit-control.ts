import { parseGitCommitMessage, parseGitCommitPreview, type GitCommitPreview } from "./git-commit-mutation"
import { parseExactRecord } from "./operation-contract-validation"

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/
const objectIDPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type GitCommitPrepareRequest = Readonly<{
  schemaVersion: 1
  method: "git-commit.prepare"
  requestId: string
  sessionID: string
  token: string
  message: string
}>

export type GitCommitDecisionRequest = Readonly<{
  schemaVersion: 1
  method: "git-commit.decide"
  requestId: string
  sessionID: string
  token: string
  proposalID: string
  decision: "approve" | "reject"
}>

export type GitCommitControlRequest = GitCommitPrepareRequest | GitCommitDecisionRequest

export type GitCommitControlPreview = Readonly<{
  schemaVersion: 1
  action: "Commit staged"
  proposalID: string
  authority: GitCommitPreview
}>

export type GitCommitPrepareResult =
  | Readonly<{ schemaVersion: 1; requestId: string; status: "prepared"; preview: GitCommitControlPreview }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

type GitCommitDecisionBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  proposalDigest: `sha256:${string}`
}>

export type GitCommitDecisionResult =
  | (GitCommitDecisionBinding & Readonly<{ status: "denied_without_git_effect"; operationID: string }>)
  | (GitCommitDecisionBinding & Readonly<{ status: "failed_without_effect"; operationID: string; reason: string }>)
  | (GitCommitDecisionBinding &
      Readonly<{
        status: "verified"
        verification: "independent_commit_bytes_and_repository_state"
        operationID: string
        receiptID: string
        commitOID: string
        snapshotDigest: `sha256:${string}`
      }>)
  | (GitCommitDecisionBinding &
      Readonly<{ status: "reconciliation_required"; operationID: string | null; reason: string }>)
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; status: "blocked"; reason: string }>

export type GitCommitProgress = GitCommitDecisionBinding &
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
        commitOID: string
      }>
  )

export type GitCommitControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: string }>

export function parseGitCommitPrepareRequest(input: unknown): GitCommitControlParseResult<GitCommitPrepareRequest> {
  const record = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "message"])
  const message = record ? parseGitCommitMessage(record.message) : null
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "git-commit.prepare" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !message?.ok ||
    message.value !== record.message
  ) {
    return rejected("invalid_prepare_request")
  }
  return accepted({
    schemaVersion: 1,
    method: "git-commit.prepare",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    message: message.value,
  })
}

export function parseGitCommitDecisionRequest(input: unknown): GitCommitControlParseResult<GitCommitDecisionRequest> {
  const record = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "proposalID", "decision"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "git-commit.decide" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !uuid(record.proposalID) ||
    (record.decision !== "approve" && record.decision !== "reject")
  ) {
    return rejected("invalid_decision_request")
  }
  return accepted({
    schemaVersion: 1,
    method: "git-commit.decide",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    proposalID: record.proposalID,
    decision: record.decision,
  })
}

export function parseGitCommitControlRequest(input: unknown): GitCommitControlParseResult<GitCommitControlRequest> {
  const method = plain(input)?.method
  if (method === "git-commit.prepare") return parseGitCommitPrepareRequest(input)
  if (method === "git-commit.decide") return parseGitCommitDecisionRequest(input)
  return rejected("invalid_request_method")
}

export function parseGitCommitControlPreview(input: unknown): GitCommitControlParseResult<GitCommitControlPreview> {
  const record = exact(input, ["schemaVersion", "action", "proposalID", "authority"])
  const authority = record ? parseGitCommitPreview(record.authority) : null
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.action !== "Commit staged" ||
    !uuid(record.proposalID) ||
    !authority?.ok
  ) {
    return rejected("invalid_preview")
  }
  return accepted({
    schemaVersion: 1,
    action: "Commit staged",
    proposalID: record.proposalID,
    authority: authority.value,
  })
}

export function parseGitCommitPrepareResult(input: unknown): GitCommitControlParseResult<GitCommitPrepareResult> {
  const broad = plain(input)
  if (broad?.status === "prepared") {
    const record = exact(input, ["schemaVersion", "requestId", "status", "preview"])
    const preview = record ? parseGitCommitControlPreview(record.preview) : null
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !preview?.ok) {
      return rejected("invalid_prepare_result")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "prepared", preview: preview.value })
  }
  return parseBlockedResult(input)
}

export function parseGitCommitDecisionResult(input: unknown): GitCommitControlParseResult<GitCommitDecisionResult> {
  const broad = plain(input)
  if (!broad) return rejected("invalid_decision_result")
  if (broad.status === "blocked") {
    const record = exact(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !uuid(record.requestId) ||
      !uuid(record.proposalID) ||
      !reason(record.reason)
    ) {
      return rejected("invalid_decision_result")
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
  if (!binding) return rejected("invalid_decision_result")
  if (broad.status === "denied_without_git_effect") {
    if (!exact(input, [...decisionKeys, "status", "operationID"]) || !uuid(broad.operationID))
      return rejected("invalid_decision_result")
    return accepted({ ...binding, status: "denied_without_git_effect", operationID: broad.operationID })
  }
  if (broad.status === "failed_without_effect") {
    if (
      !exact(input, [...decisionKeys, "status", "operationID", "reason"]) ||
      !uuid(broad.operationID) ||
      !reason(broad.reason)
    )
      return rejected("invalid_decision_result")
    return accepted({
      ...binding,
      status: "failed_without_effect",
      operationID: broad.operationID,
      reason: broad.reason,
    })
  }
  if (broad.status === "reconciliation_required") {
    if (
      !exact(input, [...decisionKeys, "status", "operationID", "reason"]) ||
      (broad.operationID !== null && !uuid(broad.operationID)) ||
      !reason(broad.reason)
    )
      return rejected("invalid_decision_result")
    return accepted({
      ...binding,
      status: "reconciliation_required",
      operationID: broad.operationID,
      reason: broad.reason,
    })
  }
  if (
    broad.status !== "verified" ||
    !exact(input, [
      ...decisionKeys,
      "status",
      "verification",
      "operationID",
      "receiptID",
      "commitOID",
      "snapshotDigest",
    ]) ||
    broad.verification !== "independent_commit_bytes_and_repository_state" ||
    !uuid(broad.operationID) ||
    !uuid(broad.receiptID) ||
    !objectID(broad.commitOID) ||
    !digest(broad.snapshotDigest)
  )
    return rejected("invalid_decision_result")
  return accepted({
    ...binding,
    status: "verified",
    verification: "independent_commit_bytes_and_repository_state",
    operationID: broad.operationID,
    receiptID: broad.receiptID,
    commitOID: broad.commitOID,
    snapshotDigest: broad.snapshotDigest,
  })
}

export function parseGitCommitProgress(input: unknown): GitCommitControlParseResult<GitCommitProgress> {
  const broad = plain(input)
  const binding = broad && decisionBinding(broad)
  if (!broad || !binding) return rejected("invalid_progress")
  if (
    broad.status === "recording_authority" ||
    broad.status === "host_adapter_validating" ||
    broad.status === "verifying"
  ) {
    if (!exact(input, [...decisionKeys, "status", "verification"]) || broad.verification !== "not_verified") {
      return rejected("invalid_progress")
    }
    return accepted({ ...binding, status: broad.status, verification: "not_verified" })
  }
  if (
    broad.status !== "effect_observed_not_verified" ||
    !exact(input, [...decisionKeys, "status", "verification", "operationID", "receiptID", "commitOID"]) ||
    broad.verification !== "not_verified" ||
    !uuid(broad.operationID) ||
    !uuid(broad.receiptID) ||
    !objectID(broad.commitOID)
  )
    return rejected("invalid_progress")
  return accepted({
    ...binding,
    status: "effect_observed_not_verified",
    verification: "not_verified",
    operationID: broad.operationID,
    receiptID: broad.receiptID,
    commitOID: broad.commitOID,
  })
}

const decisionKeys = ["schemaVersion", "requestId", "proposalID", "proposalDigest"] as const

function decisionBinding(input: Readonly<Record<string, unknown>>): GitCommitDecisionBinding | null {
  if (input.schemaVersion !== 1 || !uuid(input.requestId) || !uuid(input.proposalID) || !digest(input.proposalDigest))
    return null
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    proposalID: input.proposalID,
    proposalDigest: input.proposalDigest,
  }
}

function parseBlockedResult(
  input: unknown,
): GitCommitControlParseResult<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }> {
  const record = exact(input, ["schemaVersion", "requestId", "status", "reason"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !uuid(record.requestId) ||
    record.status !== "blocked" ||
    !reason(record.reason)
  )
    return rejected("invalid_blocked_result")
  return accepted({ schemaVersion: 1, requestId: record.requestId, status: "blocked", reason: record.reason })
}

function exact(input: unknown, keys: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, keys)
  return parsed.ok ? parsed.value : null
}

function plain(input: unknown): Readonly<Record<string, unknown>> | null {
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
function objectID(input: unknown): input is string {
  return typeof input === "string" && objectIDPattern.test(input)
}
function accepted<Value>(value: Value): GitCommitControlParseResult<Value> {
  return { ok: true, value: deepFreeze(value) }
}
function rejected(reason: string): GitCommitControlParseResult<never> {
  return { ok: false, reason }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
