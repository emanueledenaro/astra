import { mcpActivationBoundaryLabel, mcpActivationNetworkLabel, mcpActivationRequestBudget } from "./mcp-activation"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/

export type McpActivationControlRequest =
  | Readonly<{ schemaVersion: 1; method: "mcp-activation.prepare"; requestId: string; sessionID: string; token: string; candidateID: string }>
  | Readonly<{ schemaVersion: 1; method: "mcp-activation.decide"; requestId: string; sessionID: string; token: string; proposalID: string; decision: "approve" | "reject" }>
  | Readonly<{ schemaVersion: 1; method: "mcp-activation.stop"; requestId: string; sessionID: string; token: string; proposalID: string }>

export type McpActivationControlPreview = Readonly<{
  schemaVersion: 1
  proposalID: string
  candidateID: `sha256:${string}`
  displayName: string
  sourcePath: string
  transport: "streamable_http"
  destination: "public_https_withheld" | "literal_loopback_http_withheld"
  leaseExpiresAt: string
  capabilityDigest: `sha256:${string}`
  boundaryLabel: typeof mcpActivationBoundaryLabel
  networkLabel: typeof mcpActivationNetworkLabel
  requestBudget: typeof mcpActivationRequestBudget
  credentials: "none"
  workspaceRootShared: "none"
  redirects: "forbidden"
  retries: "none"
  reconnect: "none"
  instructions: "withheld"
  toolInvocation: "forbidden"
  verification: "not_verified"
}>

export type McpActivationControlPrepareResult =
  | Readonly<{ schemaVersion: 1; requestId: string; status: "prepared"; preview: McpActivationControlPreview }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

export type McpActivationControlProgress = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  operationID: string
  status: "active"
  catalogCount: number
  leaseExpiresAt: string
  verification: "not_verified"
}>

export type McpActivationControlDecisionResult =
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; operationID: string; status: "denied_without_effect" }>
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; operationID: string; status: "completed_observed_not_verified"; receiptID: string; catalogCount: number; verification: "not_verified" }>
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; operationID: string; status: "failed_without_effect" | "reconciliation_required"; reason: string; verification: "not_verified" }>
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; status: "blocked"; reason: string }>

export type McpActivationControlStopResult =
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; status: "stop_requested" }>
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; status: "blocked"; reason: string }>

type ParseResult<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; reason: "invalid_mcp_activation_control" }>

export function parseMcpActivationControlRequest(input: unknown): ParseResult<McpActivationControlRequest> {
  const broad = record(input)
  const method = broad?.method
  const keys = method === "mcp-activation.prepare"
    ? ["schemaVersion", "method", "requestId", "sessionID", "token", "candidateID"]
    : method === "mcp-activation.decide"
      ? ["schemaVersion", "method", "requestId", "sessionID", "token", "proposalID", "decision"]
      : method === "mcp-activation.stop"
        ? ["schemaVersion", "method", "requestId", "sessionID", "token", "proposalID"]
        : null
  const value = keys ? exact(input, keys) : null
  if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.sessionID) || !token(value.token)) return invalid()
  if (method === "mcp-activation.prepare" && digest(value.candidateID)) return valid({ schemaVersion: 1, method, requestId: value.requestId, sessionID: value.sessionID, token: value.token, candidateID: value.candidateID })
  if (method === "mcp-activation.decide" && uuid(value.proposalID) && (value.decision === "approve" || value.decision === "reject")) return valid({ schemaVersion: 1, method, requestId: value.requestId, sessionID: value.sessionID, token: value.token, proposalID: value.proposalID, decision: value.decision })
  if (method === "mcp-activation.stop" && uuid(value.proposalID)) return valid({ schemaVersion: 1, method, requestId: value.requestId, sessionID: value.sessionID, token: value.token, proposalID: value.proposalID })
  return invalid()
}

export function parseMcpActivationControlPrepareResult(input: unknown): ParseResult<McpActivationControlPrepareResult> {
  const broad = record(input)
  if (broad?.status !== "prepared") return parseBlocked(input)
  const value = exact(input, ["schemaVersion", "requestId", "status", "preview"])
  const preview = parsePreview(value?.preview)
  if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !preview.ok) return invalid()
  return valid({ schemaVersion: 1, requestId: value.requestId, status: "prepared", preview: preview.value })
}

export function parseMcpActivationControlProgress(input: unknown): ParseResult<McpActivationControlProgress> {
  const value = exact(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "catalogCount", "leaseExpiresAt", "verification"])
  if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.proposalID) || value.operationID !== value.proposalID || value.status !== "active" || !count(value.catalogCount) || !timestamp(value.leaseExpiresAt) || value.verification !== "not_verified") return invalid()
  return valid({ schemaVersion: 1, requestId: value.requestId, proposalID: value.proposalID, operationID: value.operationID, status: "active", catalogCount: value.catalogCount, leaseExpiresAt: value.leaseExpiresAt, verification: "not_verified" })
}

export function parseMcpActivationControlDecisionResult(input: unknown): ParseResult<McpActivationControlDecisionResult> {
  const broad = record(input)
  if (broad?.status === "blocked") return parseBlockedDecision(input)
  const common = exactCommon(input)
  if (!common) return invalid()
  if (broad?.status === "denied_without_effect" && exact(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status"])) return valid({ ...common, status: "denied_without_effect" })
  if (broad?.status === "completed_observed_not_verified") {
    const value = exact(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "receiptID", "catalogCount", "verification"])
    if (!value || !uuid(value.receiptID) || !count(value.catalogCount) || value.verification !== "not_verified") return invalid()
    return valid({ ...common, status: "completed_observed_not_verified", receiptID: value.receiptID, catalogCount: value.catalogCount, verification: "not_verified" })
  }
  const value = exact(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "reason", "verification"])
  if (!value || (value.status !== "failed_without_effect" && value.status !== "reconciliation_required") || !reason(value.reason) || value.verification !== "not_verified") return invalid()
  return valid({ ...common, status: value.status, reason: value.reason, verification: "not_verified" })
}

export function parseMcpActivationControlStopResult(input: unknown): ParseResult<McpActivationControlStopResult> {
  const broad = record(input)
  const value = broad?.status === "stop_requested"
    ? exact(input, ["schemaVersion", "requestId", "proposalID", "status"])
    : exact(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
  if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.proposalID)) return invalid()
  if (value.status === "stop_requested") return valid({ schemaVersion: 1, requestId: value.requestId, proposalID: value.proposalID, status: "stop_requested" })
  if (value.status === "blocked" && reason(value.reason)) return valid({ schemaVersion: 1, requestId: value.requestId, proposalID: value.proposalID, status: "blocked", reason: value.reason })
  return invalid()
}

function parsePreview(input: unknown): ParseResult<McpActivationControlPreview> {
  const value = exact(input, ["schemaVersion", "proposalID", "candidateID", "displayName", "sourcePath", "transport", "destination", "leaseExpiresAt", "capabilityDigest", "boundaryLabel", "networkLabel", "requestBudget", "credentials", "workspaceRootShared", "redirects", "retries", "reconnect", "instructions", "toolInvocation", "verification"])
  if (!value || value.schemaVersion !== 1 || !uuid(value.proposalID) || !digest(value.candidateID) || !safe(value.displayName, 128) || !safe(value.sourcePath, 512) || value.transport !== "streamable_http" || (value.destination !== "public_https_withheld" && value.destination !== "literal_loopback_http_withheld") || !timestamp(value.leaseExpiresAt) || !digest(value.capabilityDigest) || value.boundaryLabel !== mcpActivationBoundaryLabel || value.networkLabel !== mcpActivationNetworkLabel || !exactArray(value.requestBudget, mcpActivationRequestBudget) || value.credentials !== "none" || value.workspaceRootShared !== "none" || value.redirects !== "forbidden" || value.retries !== "none" || value.reconnect !== "none" || value.instructions !== "withheld" || value.toolInvocation !== "forbidden" || value.verification !== "not_verified") return invalid()
  return valid({ ...value, schemaVersion: 1, proposalID: value.proposalID, candidateID: value.candidateID, displayName: value.displayName, sourcePath: value.sourcePath, transport: "streamable_http", destination: value.destination, leaseExpiresAt: value.leaseExpiresAt, capabilityDigest: value.capabilityDigest, boundaryLabel: mcpActivationBoundaryLabel, networkLabel: mcpActivationNetworkLabel, requestBudget: mcpActivationRequestBudget, credentials: "none", workspaceRootShared: "none", redirects: "forbidden", retries: "none", reconnect: "none", instructions: "withheld", toolInvocation: "forbidden", verification: "not_verified" })
}

function parseBlocked(input: unknown): ParseResult<McpActivationControlPrepareResult> {
  const value = exact(input, ["schemaVersion", "requestId", "status", "reason"])
  return value && value.schemaVersion === 1 && uuid(value.requestId) && value.status === "blocked" && reason(value.reason)
    ? valid({ schemaVersion: 1, requestId: value.requestId, status: "blocked", reason: value.reason })
    : invalid()
}

function parseBlockedDecision(input: unknown): ParseResult<McpActivationControlDecisionResult> {
  const value = exact(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
  return value && value.schemaVersion === 1 && uuid(value.requestId) && uuid(value.proposalID) && value.status === "blocked" && reason(value.reason)
    ? valid({ schemaVersion: 1, requestId: value.requestId, proposalID: value.proposalID, status: "blocked", reason: value.reason })
    : invalid()
}

function exactCommon(input: unknown) {
  const value = record(input)
  if (value?.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.proposalID) || value.operationID !== value.proposalID) return null
  return { schemaVersion: 1 as const, requestId: value.requestId, proposalID: value.proposalID, operationID: value.operationID }
}

function exact(input: unknown, keys: ReadonlyArray<string>) {
  const value = record(input)
  if (!value || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) return null
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

function exactArray(input: unknown, expected: ReadonlyArray<string>) {
  return Array.isArray(input) && input.length === expected.length && input.every((value, index) => value === expected[index])
}

function valid<Value>(value: Value): ParseResult<Value> { return { ok: true, value } }
function invalid(): ParseResult<never> { return { ok: false, reason: "invalid_mcp_activation_control" } }
function uuid(input: unknown): input is string { return typeof input === "string" && uuidPattern.test(input) }
function token(input: unknown): input is string { return typeof input === "string" && tokenPattern.test(input) }
function digest(input: unknown): input is `sha256:${string}` { return typeof input === "string" && digestPattern.test(input) }
function timestamp(input: unknown): input is string { return typeof input === "string" && timestampPattern.test(input) && new Date(Date.parse(input)).toISOString() === input }
function reason(input: unknown): input is string { return typeof input === "string" && reasonPattern.test(input) }
function safe(input: unknown, maximum: number): input is string { return typeof input === "string" && input.length > 0 && input.length <= maximum && !/\p{C}/u.test(input) }
function count(input: unknown): input is number { return Number.isSafeInteger(input) && Number(input) >= 0 && Number(input) <= 64 }
