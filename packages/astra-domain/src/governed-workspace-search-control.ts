import { parseExactRecord } from "./operation-contract-validation"

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const maximumQueryBytes = 512
const maximumDisplayLines = 100
const maximumDisplayLineBytes = 512
const maximumDisplayBytes = 16_384

export const workspaceSearchBoundaryLabel = "HOST EXECUTION — NO SANDBOX"

export type WorkspaceSearchPrepareRequest = Readonly<{
  schemaVersion: 1
  method: "search.prepare"
  requestId: string
  sessionID: string
  token: string
  query: string
}>

export type WorkspaceSearchDecisionRequest = Readonly<{
  schemaVersion: 1
  method: "search.decide"
  requestId: string
  sessionID: string
  token: string
  proposalID: string
  decision: "approve" | "reject"
}>

export type WorkspaceSearchControlRequest = WorkspaceSearchPrepareRequest | WorkspaceSearchDecisionRequest

export type WorkspaceSearchControlPreview = Readonly<{
  schemaVersion: 1
  proposalID: string
  operationID: string
  query: string
  queryBytes: number
  capabilityDigest: `sha256:${string}`
  expiresAt: string
  boundaryLabel: typeof workspaceSearchBoundaryLabel
  workspaceRoot: string
  executable: "/usr/bin/grep"
  mode: "recursive_fixed_string"
  resources: ReadonlyArray<string>
  network: "host_unrestricted_not_requested"
  writes: ReadonlyArray<never>
  verification: "not_verified"
}>

export type WorkspaceSearchOutputSummary = Readonly<{
  outputDigest: `sha256:${string}`
  digestScope: "stdout_only"
  outputLineCount: number | null
  outcome: "matches" | "no_matches" | "unknown"
  exitCode: number | null
  displayLines: ReadonlyArray<string>
  truncated: boolean
}>

export type WorkspaceSearchPrepareResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "prepared"
      preview: WorkspaceSearchControlPreview
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "blocked"
      reason: string
    }>

type WorkspaceSearchDecisionBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  operationID: string
  capabilityDigest: `sha256:${string}`
  verification: "not_verified"
}>

export type WorkspaceSearchDecisionResult =
  | (WorkspaceSearchDecisionBinding & Readonly<{ status: "denied_without_effect" }>)
  | (WorkspaceSearchDecisionBinding &
      Readonly<{
        status: "completed_observed_not_verified"
        receiptID: string
        output: WorkspaceSearchOutputSummary
      }>)
  | (WorkspaceSearchDecisionBinding & Readonly<{ status: "failed_without_effect"; reason: string }>)
  | (WorkspaceSearchDecisionBinding &
      Readonly<{
        status: "reconciliation_required"
        reason: string
        receiptID: string | null
        output: WorkspaceSearchOutputSummary | null
      }>)
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "blocked"
      reason: string
    }>

export type WorkspaceSearchProgress = WorkspaceSearchDecisionBinding &
  (
    | Readonly<{ status: "recording_authority" | "executing_host" }>
    | Readonly<{
        status: "effect_observed_not_verified"
        receiptID: string
        outputDigest: `sha256:${string}`
        digestScope: "stdout_only"
        outputLineCount: number | null
        outcome: "matches" | "no_matches"
      }>
  )

export type WorkspaceSearchControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: string }>

/** The child may choose only a bounded literal query; paths and argv are not part of this request. */
export function parseWorkspaceSearchPrepareRequest(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchPrepareRequest> {
  const record = exactRecord(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "query"])
  if (!record) return rejected("invalid_prepare_request_shape")
  if (
    record.schemaVersion !== 1 ||
    record.method !== "search.prepare" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !query(record.query)
  ) {
    return rejected("invalid_prepare_request_value")
  }
  return accepted({
    schemaVersion: 1,
    method: "search.prepare",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    query: record.query,
  })
}

/** Approval and rejection bind to one parent-created proposal and carry no command data. */
export function parseWorkspaceSearchDecisionRequest(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchDecisionRequest> {
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
    record.method !== "search.decide" ||
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
    method: "search.decide",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    proposalID: record.proposalID,
    decision: record.decision,
  })
}

export function parseWorkspaceSearchControlRequest(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchControlRequest> {
  const method = plainRecord(input)?.method
  if (method === "search.prepare") return parseWorkspaceSearchPrepareRequest(input)
  if (method === "search.decide") return parseWorkspaceSearchDecisionRequest(input)
  return rejected("invalid_request_method")
}

export function parseWorkspaceSearchControlPreview(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchControlPreview> {
  const record = exactRecord(input, [
    "schemaVersion",
    "proposalID",
    "operationID",
    "query",
    "queryBytes",
    "capabilityDigest",
    "expiresAt",
    "boundaryLabel",
    "workspaceRoot",
    "executable",
    "mode",
    "resources",
    "network",
    "writes",
    "verification",
  ])
  const resources = parseStrings(record?.resources, 8, 1_024)
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !uuid(record.proposalID) ||
    !uuid(record.operationID) ||
    !query(record.query) ||
    record.queryBytes !== Buffer.byteLength(record.query) ||
    !digest(record.capabilityDigest) ||
    !timestamp(record.expiresAt) ||
    record.boundaryLabel !== workspaceSearchBoundaryLabel ||
    !boundedText(record.workspaceRoot, 1_024) ||
    record.executable !== "/usr/bin/grep" ||
    record.mode !== "recursive_fixed_string" ||
    !resources ||
    record.network !== "host_unrestricted_not_requested" ||
    !emptyArray(record.writes) ||
    record.verification !== "not_verified"
  ) {
    return rejected("invalid_preview_value")
  }
  return accepted({
    schemaVersion: 1,
    proposalID: record.proposalID,
    operationID: record.operationID,
    query: record.query,
    queryBytes: record.queryBytes,
    capabilityDigest: record.capabilityDigest,
    expiresAt: record.expiresAt,
    boundaryLabel: workspaceSearchBoundaryLabel,
    workspaceRoot: record.workspaceRoot,
    executable: "/usr/bin/grep",
    mode: "recursive_fixed_string",
    resources,
    network: "host_unrestricted_not_requested",
    writes: [],
    verification: "not_verified",
  })
}

export function parseWorkspaceSearchPrepareResult(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchPrepareResult> {
  const broad = plainRecord(input)
  if (!broad) return rejected("invalid_prepare_result_shape")
  if (broad.status === "prepared") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "status", "preview"])
    const preview = parseWorkspaceSearchControlPreview(record?.preview)
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !preview.ok) {
      return rejected("invalid_prepare_result_value")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "prepared", preview: preview.value })
  }
  const record = exactRecord(input, ["schemaVersion", "requestId", "status", "reason"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !uuid(record.requestId) ||
    record.status !== "blocked" ||
    !reason(record.reason)
  ) {
    return rejected("invalid_prepare_result_value")
  }
  return accepted({ schemaVersion: 1, requestId: record.requestId, status: "blocked", reason: record.reason })
}

export function parseWorkspaceSearchOutputSummary(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchOutputSummary> {
  const record = exactRecord(input, [
    "outputDigest",
    "digestScope",
    "outputLineCount",
    "outcome",
    "exitCode",
    "displayLines",
    "truncated",
  ])
  const displayLines = parseStrings(record?.displayLines, maximumDisplayLines, maximumDisplayLineBytes)
  if (
    !record ||
    !digest(record.outputDigest) ||
    record.digestScope !== "stdout_only" ||
    (record.outputLineCount !== null && !nonNegativeInteger(record.outputLineCount)) ||
    (record.outcome !== "matches" && record.outcome !== "no_matches" && record.outcome !== "unknown") ||
    (record.exitCode !== null && !nonNegativeInteger(record.exitCode)) ||
    !displayLines ||
    Buffer.byteLength(displayLines.join("\n")) > maximumDisplayBytes ||
    typeof record.truncated !== "boolean"
  ) {
    return rejected("invalid_output_summary")
  }
  return accepted({
    outputDigest: record.outputDigest,
    digestScope: "stdout_only",
    outputLineCount: record.outputLineCount,
    outcome: record.outcome,
    exitCode: record.exitCode,
    displayLines,
    truncated: record.truncated,
  })
}

export function parseWorkspaceSearchDecisionResult(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchDecisionResult> {
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
  if (broad.status === "denied_without_effect") {
    if (!exactRecord(input, [...decisionBindingKeys, "status"])) return rejected("invalid_decision_result_shape")
    return accepted({ ...binding, status: "denied_without_effect" })
  }
  if (broad.status === "completed_observed_not_verified") {
    const output = parseWorkspaceSearchOutputSummary(broad.output)
    if (
      !exactRecord(input, [...decisionBindingKeys, "status", "receiptID", "output"]) ||
      !uuid(broad.receiptID) ||
      !output.ok
    ) {
      return rejected("invalid_decision_result_value")
    }
    return accepted({
      ...binding,
      status: "completed_observed_not_verified",
      receiptID: broad.receiptID,
      output: output.value,
    })
  }
  if (broad.status === "failed_without_effect") {
    if (!exactRecord(input, [...decisionBindingKeys, "status", "reason"]) || !reason(broad.reason)) {
      return rejected("invalid_decision_result_value")
    }
    return accepted({ ...binding, status: "failed_without_effect", reason: broad.reason })
  }
  if (broad.status !== "reconciliation_required") return rejected("invalid_decision_result_value")
  const output = broad.output === null ? null : parseWorkspaceSearchOutputSummary(broad.output)
  if (
    !exactRecord(input, [...decisionBindingKeys, "status", "reason", "receiptID", "output"]) ||
    !reason(broad.reason) ||
    (broad.receiptID !== null && !uuid(broad.receiptID)) ||
    (output !== null && !output.ok)
  ) {
    return rejected("invalid_decision_result_value")
  }
  return accepted({
    ...binding,
    status: "reconciliation_required",
    reason: broad.reason,
    receiptID: broad.receiptID,
    output: output?.value ?? null,
  })
}

export function parseWorkspaceSearchProgress(
  input: unknown,
): WorkspaceSearchControlParseResult<WorkspaceSearchProgress> {
  const broad = plainRecord(input)
  const binding = broad ? decisionBinding(broad) : null
  if (!binding) return rejected("invalid_progress_value")
  if (broad?.status === "recording_authority" || broad?.status === "executing_host") {
    if (!exactRecord(input, [...decisionBindingKeys, "status"])) return rejected("invalid_progress_shape")
    return accepted({ ...binding, status: broad.status })
  }
  if (broad?.status !== "effect_observed_not_verified") return rejected("invalid_progress_value")
  const record = exactRecord(input, [
    ...decisionBindingKeys,
    "status",
    "receiptID",
    "outputDigest",
    "digestScope",
    "outputLineCount",
    "outcome",
  ])
  if (
    !record ||
    !uuid(record.receiptID) ||
    !digest(record.outputDigest) ||
    record.digestScope !== "stdout_only" ||
    (record.outputLineCount !== null && !nonNegativeInteger(record.outputLineCount)) ||
    (record.outcome !== "matches" && record.outcome !== "no_matches")
  )
    return rejected("invalid_progress_value")
  return accepted({
    ...binding,
    status: "effect_observed_not_verified",
    receiptID: record.receiptID,
    outputDigest: record.outputDigest,
    digestScope: "stdout_only",
    outputLineCount: record.outputLineCount,
    outcome: record.outcome,
  })
}

const decisionBindingKeys = [
  "schemaVersion",
  "requestId",
  "proposalID",
  "operationID",
  "capabilityDigest",
  "verification",
] as const

function decisionBinding(input: Readonly<Record<string, unknown>>): WorkspaceSearchDecisionBinding | null {
  if (
    input.schemaVersion !== 1 ||
    !uuid(input.requestId) ||
    !uuid(input.proposalID) ||
    !uuid(input.operationID) ||
    !digest(input.capabilityDigest) ||
    input.verification !== "not_verified"
  )
    return null
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    proposalID: input.proposalID,
    operationID: input.operationID,
    capabilityDigest: input.capabilityDigest,
    verification: "not_verified",
  }
}

function exactRecord(input: unknown, keys: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, keys)
  return parsed.ok && Object.keys(parsed.value).length === keys.length ? parsed.value : null
}

function plainRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const parsed = parseExactRecord(
    input,
    Reflect.ownKeys(input).filter((key): key is string => typeof key === "string"),
  )
  return parsed.ok ? parsed.value : null
}

function parseStrings(input: unknown, maximumItems: number, maximumBytes: number) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length > maximumItems) return null
  if (
    Reflect.ownKeys(input).some(
      (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length),
    )
  )
    return null
  const values: string[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !("value" in descriptor)) return null
    const value = descriptor.value
    if (!boundedText(value, maximumBytes)) return null
    values.push(value)
  }
  return Object.freeze(values)
}

function emptyArray(input: unknown) {
  return parseStrings(input, 0, 1) !== null
}

function query(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    Buffer.byteLength(input) <= maximumQueryBytes &&
    !/\p{C}/u.test(input)
  )
}

function boundedText(input: unknown, maximumBytes: number): input is string {
  return (
    typeof input === "string" && input.length > 0 && Buffer.byteLength(input) <= maximumBytes && !/\p{C}/u.test(input)
  )
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

function timestamp(input: unknown): input is string {
  if (typeof input !== "string" || !timestampPattern.test(input)) return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function reason(input: unknown): input is string {
  return typeof input === "string" && reasonPattern.test(input)
}

function nonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
}

function accepted<Value>(value: Value): WorkspaceSearchControlParseResult<Value> {
  return { ok: true, value: Object.freeze(value) }
}

function rejected(reason: string): WorkspaceSearchControlParseResult<never> {
  return { ok: false, reason }
}
