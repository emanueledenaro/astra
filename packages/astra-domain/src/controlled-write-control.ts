import { createHash } from "node:crypto"
import { parseExactRecord } from "./operation-contract-validation"

const digestPattern = /^sha256:[0-9a-f]{64}$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/
const maximumContentBytes = 1_048_576

export const controlledWriteBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const
export const controlledWriteNetworkWarning = "HOST NETWORK UNRESTRICTED — NOT ISOLATED" as const
export const controlledWriteDemoTarget = ".astra-demo-marker" as const

export type ControlledWritePrepareRequest = Readonly<{
  schemaVersion: 1
  method: "controlled-write.prepare"
  requestId: string
  sessionID: string
  token: string
}>

export type ControlledWriteDecisionRequest = Readonly<{
  schemaVersion: 1
  method: "controlled-write.decide"
  requestId: string
  sessionID: string
  token: string
  proposalID: string
  decision: "approve" | "reject"
}>

export type ControlledWritePreview = Readonly<{
  schemaVersion: 1
  operation: "controlled_write_create_only"
  operationID: string
  proposalID: string
  expiresAt: string
  boundary: Readonly<{
    mode: "host_no_sandbox"
    label: typeof controlledWriteBoundaryLabel
  }>
  resource: Readonly<{
    kind: "workspace_relative_file"
    mode: "create_only"
    relativeTarget: string
    bytes: number
    contentDigest: `sha256:${string}`
  }>
  capabilityDigest: `sha256:${string}`
  network: Readonly<{
    mode: "host_unrestricted"
    warning: typeof controlledWriteNetworkWarning
  }>
  verification: "not_verified"
}>

export type ControlledWritePrepareResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "prepared"
      preview: ControlledWritePreview
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "blocked"
      reason: string
    }>

type ControlledWriteDecisionBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  operationID: string
}>

export type ControlledWriteDecisionResult =
  | (ControlledWriteDecisionBinding &
      Readonly<{
        status: "denied_without_workspace_effect"
      }>)
  | (ControlledWriteDecisionBinding &
      Readonly<{
        status: "failed_without_effect"
        reason: string
      }>)
  | (ControlledWriteDecisionBinding &
      Readonly<{
        status: "verified"
        verification: "exact_readback"
        receiptID: string
        evidenceID: string
        readback: Readonly<{
          relativeTarget: string
          bytes: number
          contentDigest: `sha256:${string}`
        }>
      }>)
  | (ControlledWriteDecisionBinding &
      Readonly<{
        status: "reconciliation_required"
        reason: string
      }>)
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "blocked"
      reason: string
    }>

export type ControlledWriteProgress = ControlledWriteDecisionBinding &
  (
    | Readonly<{
        status: "recording_authority" | "host_adapter_validating" | "verifying"
        verification: "not_verified"
      }>
    | Readonly<{
        status: "effect_observed_not_verified"
        verification: "not_verified"
        receiptID: string
        observation: Readonly<{
          relativeTarget: string
          bytes: number
          contentDigest: `sha256:${string}`
        }>
      }>
  )

export type ControlledWriteControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{
      ok: false
      reason:
        | "invalid_prepare_request_shape"
        | "invalid_prepare_request_value"
        | "invalid_decision_request_shape"
        | "invalid_decision_request_value"
        | "invalid_preview_shape"
        | "invalid_preview_value"
        | "invalid_prepare_result_shape"
        | "invalid_prepare_result_value"
        | "invalid_decision_result_shape"
        | "invalid_decision_result_value"
        | "invalid_progress_shape"
        | "invalid_progress_value"
    }>

/** Parses the path-free, content-free request used to prepare server-owned authority. */
export function parseControlledWritePrepareRequest(
  input: unknown,
): ControlledWriteControlParseResult<ControlledWritePrepareRequest> {
  const record = exactRecord(input, ["schemaVersion", "method", "requestId", "sessionID", "token"])
  if (!record) return rejected("invalid_prepare_request_shape")
  if (
    record.schemaVersion !== 1 ||
    record.method !== "controlled-write.prepare" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token)
  ) {
    return rejected("invalid_prepare_request_value")
  }
  return accepted(
    Object.freeze({
      schemaVersion: 1,
      method: "controlled-write.prepare",
      requestId: record.requestId,
      sessionID: record.sessionID,
      token: record.token,
    }),
  )
}

/** Parses a one-proposal decision without accepting effect scope from the client. */
export function parseControlledWriteDecisionRequest(
  input: unknown,
): ControlledWriteControlParseResult<ControlledWriteDecisionRequest> {
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
    record.method !== "controlled-write.decide" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !uuid(record.proposalID) ||
    (record.decision !== "approve" && record.decision !== "reject")
  ) {
    return rejected("invalid_decision_request_value")
  }
  return accepted(
    Object.freeze({
      schemaVersion: 1,
      method: "controlled-write.decide",
      requestId: record.requestId,
      sessionID: record.sessionID,
      token: record.token,
      proposalID: record.proposalID,
      decision: record.decision,
    }),
  )
}

/** Parses the exact create-only authority rendered before approval. */
export function parseControlledWritePreview(input: unknown): ControlledWriteControlParseResult<ControlledWritePreview> {
  const record = exactRecord(input, [
    "schemaVersion",
    "operation",
    "operationID",
    "proposalID",
    "expiresAt",
    "boundary",
    "resource",
    "capabilityDigest",
    "network",
    "verification",
  ])
  if (!record) return rejected("invalid_preview_shape")
  const boundary = parseBoundary(record.boundary)
  const resource = parseResource(record.resource)
  const network = parseNetwork(record.network)
  if (
    !boundary ||
    !resource ||
    !network ||
    record.schemaVersion !== 1 ||
    record.operation !== "controlled_write_create_only" ||
    !uuid(record.operationID) ||
    !uuid(record.proposalID) ||
    !canonicalTimestamp(record.expiresAt) ||
    !digest(record.capabilityDigest) ||
    record.verification !== "not_verified"
  ) {
    return rejected("invalid_preview_value")
  }
  if (!exactDemoResource(record.operationID, resource)) return rejected("invalid_preview_value")
  return accepted(
    Object.freeze({
      schemaVersion: 1,
      operation: "controlled_write_create_only",
      operationID: record.operationID,
      proposalID: record.proposalID,
      expiresAt: record.expiresAt,
      boundary,
      resource,
      capabilityDigest: record.capabilityDigest,
      network,
      verification: "not_verified",
    }),
  )
}

export function parseControlledWritePrepareResult(
  input: unknown,
): ControlledWriteControlParseResult<ControlledWritePrepareResult> {
  const broad = exactRecordWithAllowedFields(input, ["schemaVersion", "requestId", "status", "preview", "reason"])
  if (!broad) return rejected("invalid_prepare_result_shape")
  if (broad.status === "prepared") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "status", "preview"])
    if (!record) return rejected("invalid_prepare_result_shape")
    const preview = parseControlledWritePreview(record.preview)
    if (record.schemaVersion !== 1 || !uuid(record.requestId) || !preview.ok) {
      return rejected("invalid_prepare_result_value")
    }
    return accepted(
      Object.freeze({ schemaVersion: 1, requestId: record.requestId, status: "prepared", preview: preview.value }),
    )
  }
  if (broad.status === "blocked") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "status", "reason"])
    if (!record) return rejected("invalid_prepare_result_shape")
    if (record.schemaVersion !== 1 || !uuid(record.requestId) || !reason(record.reason)) {
      return rejected("invalid_prepare_result_value")
    }
    return accepted(
      Object.freeze({ schemaVersion: 1, requestId: record.requestId, status: "blocked", reason: record.reason }),
    )
  }
  return rejected("invalid_prepare_result_value")
}

export function parseControlledWriteDecisionResult(
  input: unknown,
): ControlledWriteControlParseResult<ControlledWriteDecisionResult> {
  const broad = exactRecordWithAllowedFields(input, [
    "schemaVersion",
    "requestId",
    "proposalID",
    "operationID",
    "status",
    "reason",
    "verification",
    "receiptID",
    "evidenceID",
    "readback",
  ])
  if (!broad) return rejected("invalid_decision_result_shape")
  if (broad.status === "blocked") return parseBlockedDecisionResult(input)
  const binding = parseDecisionBinding(broad)
  if (!binding) return rejected("invalid_decision_result_value")

  if (broad.status === "denied_without_workspace_effect") {
    if (!exactRecord(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status"])) {
      return rejected("invalid_decision_result_shape")
    }
    return accepted(Object.freeze({ ...binding, status: "denied_without_workspace_effect" }))
  }
  if (broad.status === "failed_without_effect" || broad.status === "reconciliation_required") {
    if (!exactRecord(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "reason"])) {
      return rejected("invalid_decision_result_shape")
    }
    if (!reason(broad.reason)) return rejected("invalid_decision_result_value")
    return accepted(Object.freeze({ ...binding, status: broad.status, reason: broad.reason }))
  }
  if (broad.status === "verified") return parseVerifiedDecisionResult(input, binding)
  return rejected("invalid_decision_result_value")
}

export function parseControlledWriteProgress(
  input: unknown,
): ControlledWriteControlParseResult<ControlledWriteProgress> {
  const phase = exactRecord(input, [
    "schemaVersion",
    "requestId",
    "proposalID",
    "operationID",
    "status",
    "verification",
  ])
  if (phase) {
    const binding = parseDecisionBinding(phase)
    if (
      !binding ||
      (phase.status !== "recording_authority" &&
        phase.status !== "host_adapter_validating" &&
        phase.status !== "verifying") ||
      phase.verification !== "not_verified"
    ) {
      return rejected("invalid_progress_value")
    }
    return accepted(Object.freeze({ ...binding, status: phase.status, verification: "not_verified" }))
  }
  const record = exactRecord(input, [
    "schemaVersion",
    "requestId",
    "proposalID",
    "operationID",
    "status",
    "verification",
    "receiptID",
    "observation",
  ])
  if (!record) return rejected("invalid_progress_shape")
  const binding = parseDecisionBinding(record)
  const observation = parseReadback(record.observation)
  if (
    !binding ||
    !observation ||
    record.status !== "effect_observed_not_verified" ||
    record.verification !== "not_verified" ||
    !uuid(record.receiptID)
  ) {
    return rejected("invalid_progress_value")
  }
  if (!exactDemoResource(binding.operationID, observation)) return rejected("invalid_progress_value")
  return accepted(
    Object.freeze({
      ...binding,
      status: "effect_observed_not_verified",
      verification: "not_verified",
      receiptID: record.receiptID,
      observation,
    }),
  )
}

function parseBlockedDecisionResult(input: unknown): ControlledWriteControlParseResult<ControlledWriteDecisionResult> {
  const record = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
  if (!record) return rejected("invalid_decision_result_shape")
  if (
    record.schemaVersion !== 1 ||
    !uuid(record.requestId) ||
    !uuid(record.proposalID) ||
    record.status !== "blocked" ||
    !reason(record.reason)
  ) {
    return rejected("invalid_decision_result_value")
  }
  return accepted(
    Object.freeze({
      schemaVersion: 1,
      requestId: record.requestId,
      proposalID: record.proposalID,
      status: "blocked",
      reason: record.reason,
    }),
  )
}

function parseVerifiedDecisionResult(
  input: unknown,
  binding: ControlledWriteDecisionBinding,
): ControlledWriteControlParseResult<ControlledWriteDecisionResult> {
  const record = exactRecord(input, [
    "schemaVersion",
    "requestId",
    "proposalID",
    "operationID",
    "status",
    "verification",
    "receiptID",
    "evidenceID",
    "readback",
  ])
  if (!record) return rejected("invalid_decision_result_shape")
  const readback = parseReadback(record.readback)
  if (
    !readback ||
    record.status !== "verified" ||
    record.verification !== "exact_readback" ||
    !uuid(record.receiptID) ||
    !uuid(record.evidenceID)
  ) {
    return rejected("invalid_decision_result_value")
  }
  if (!exactDemoResource(binding.operationID, readback)) return rejected("invalid_decision_result_value")
  return accepted(
    Object.freeze({
      ...binding,
      status: "verified",
      verification: "exact_readback",
      receiptID: record.receiptID,
      evidenceID: record.evidenceID,
      readback,
    }),
  )
}

function parseDecisionBinding(input: Readonly<Record<string, unknown>>): ControlledWriteDecisionBinding | null {
  if (input.schemaVersion !== 1 || !uuid(input.requestId) || !uuid(input.proposalID) || !uuid(input.operationID)) {
    return null
  }
  return Object.freeze({
    schemaVersion: 1,
    requestId: input.requestId,
    proposalID: input.proposalID,
    operationID: input.operationID,
  })
}

function parseBoundary(input: unknown): ControlledWritePreview["boundary"] | null {
  const record = exactRecord(input, ["mode", "label"])
  if (!record || record.mode !== "host_no_sandbox" || record.label !== controlledWriteBoundaryLabel) return null
  return Object.freeze({ mode: "host_no_sandbox", label: controlledWriteBoundaryLabel })
}

function parseResource(input: unknown): ControlledWritePreview["resource"] | null {
  const record = exactRecord(input, ["kind", "mode", "relativeTarget", "bytes", "contentDigest"])
  if (
    !record ||
    record.kind !== "workspace_relative_file" ||
    record.mode !== "create_only" ||
    record.relativeTarget !== controlledWriteDemoTarget ||
    !contentBytes(record.bytes) ||
    !digest(record.contentDigest)
  ) {
    return null
  }
  return Object.freeze({
    kind: "workspace_relative_file",
    mode: "create_only",
    relativeTarget: record.relativeTarget,
    bytes: record.bytes,
    contentDigest: record.contentDigest,
  })
}

function parseNetwork(input: unknown): ControlledWritePreview["network"] | null {
  const record = exactRecord(input, ["mode", "warning"])
  if (!record || record.mode !== "host_unrestricted" || record.warning !== controlledWriteNetworkWarning) return null
  return Object.freeze({ mode: "host_unrestricted", warning: controlledWriteNetworkWarning })
}

function parseReadback(
  input: unknown,
): Readonly<{ relativeTarget: string; bytes: number; contentDigest: `sha256:${string}` }> | null {
  const record = exactRecord(input, ["relativeTarget", "bytes", "contentDigest"])
  if (
    !record ||
    record.relativeTarget !== controlledWriteDemoTarget ||
    !contentBytes(record.bytes) ||
    !digest(record.contentDigest)
  ) {
    return null
  }
  return Object.freeze({
    relativeTarget: record.relativeTarget,
    bytes: record.bytes,
    contentDigest: record.contentDigest,
  })
}

function exactRecord(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  if (!parsed.ok || fields.some((field) => !Object.hasOwn(parsed.value, field))) return null
  return parsed.value
}

function exactRecordWithAllowedFields(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  return parsed.ok ? parsed.value : null
}

function uuid(input: unknown): input is string {
  return typeof input === "string" && input.length === 36 && uuidPattern.test(input)
}

function token(input: unknown): input is string {
  return typeof input === "string" && input.length === 43 && tokenPattern.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && input.length === 71 && digestPattern.test(input)
}

function canonicalTimestamp(input: unknown): input is string {
  if (typeof input !== "string" || input.length !== 24) return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function reason(input: unknown): input is string {
  return typeof input === "string" && input.length <= 64 && reasonPattern.test(input)
}

function contentBytes(input: unknown): input is number {
  return Number.isSafeInteger(input) && typeof input === "number" && input > 0 && input <= maximumContentBytes
}

function exactDemoResource(
  operationID: string,
  resource: Readonly<{ relativeTarget: string; bytes: number; contentDigest: `sha256:${string}` }>,
) {
  const content = `Astra controlled host write\noperation_id=${operationID}\n`
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`
  return (
    resource.relativeTarget === controlledWriteDemoTarget &&
    resource.bytes === Buffer.byteLength(content) &&
    resource.contentDigest === digest
  )
}

function accepted<Value>(value: Value): ControlledWriteControlParseResult<Value> {
  return Object.freeze({ ok: true, value })
}

function rejected(
  reason: Exclude<ControlledWriteControlParseResult<never>, { ok: true }>["reason"],
): ControlledWriteControlParseResult<never> {
  return Object.freeze({ ok: false, reason })
}
