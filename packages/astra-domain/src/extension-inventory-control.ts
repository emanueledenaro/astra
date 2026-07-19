import { parseExtensionInventoryReport, type ExtensionInventoryCandidate } from "./extension-inventory-operation"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const extensionInventoryControlBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const

export type ExtensionInventoryControlRequest =
  | Readonly<{ schemaVersion: 1; method: "extension-inventory.prepare"; requestId: string; sessionID: string; token: string }>
  | Readonly<{
      schemaVersion: 1
      method: "extension-inventory.decide"
      requestId: string
      sessionID: string
      token: string
      proposalID: string
      decision: "approve" | "reject"
    }>

export type ExtensionInventoryControlPreview = Readonly<{
  schemaVersion: 1
  proposalID: string
  expiresAt: string
  capabilityDigest: `sha256:${string}`
  boundaryLabel: typeof extensionInventoryControlBoundaryLabel
  helper: Readonly<{ kind: "astra_native_static_inventory"; execution: "private_verified_snapshot_after_claim" }>
  resourceClasses: ReadonlyArray<string>
  allowlist: ReadonlyArray<string>
  verification: "not_verified"
}>

export type ExtensionInventoryControlPrepareResult =
  | Readonly<{ schemaVersion: 1; requestId: string; status: "prepared"; preview: ExtensionInventoryControlPreview }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

export type ExtensionInventoryControlDecisionResult =
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; status: "denied_without_effect" }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "completed_observed_not_verified"
      receiptID: string
      candidates: ReadonlyArray<ExtensionInventoryCandidate>
      verification: "not_verified"
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "failed_without_effect" | "reconciliation_required" | "blocked"
      reason: string
    }>

export type ExtensionInventoryControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_extension_inventory_control" }>

/** Accepts only inventory intent or a decision; paths, helper identities and argv are impossible on this boundary. */
export function parseExtensionInventoryControlRequest(
  input: unknown,
): ExtensionInventoryControlParseResult<ExtensionInventoryControlRequest> {
  const broad = record(input)
  if (broad?.method === "extension-inventory.prepare") {
    const value = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token"])
    if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.sessionID) || !token(value.token)) {
      return invalid()
    }
    return valid({
      schemaVersion: 1,
      method: "extension-inventory.prepare",
      requestId: value.requestId,
      sessionID: value.sessionID,
      token: value.token,
    })
  }
  if (broad?.method !== "extension-inventory.decide") return invalid()
  const value = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "proposalID", "decision"])
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !uuid(value.requestId) ||
    !uuid(value.sessionID) ||
    !token(value.token) ||
    !uuid(value.proposalID) ||
    (value.decision !== "approve" && value.decision !== "reject")
  ) {
    return invalid()
  }
  return valid({
    schemaVersion: 1,
    method: "extension-inventory.decide",
    requestId: value.requestId,
    sessionID: value.sessionID,
    token: value.token,
    proposalID: value.proposalID,
    decision: value.decision,
  })
}

export function parseExtensionInventoryControlPrepareResult(
  input: unknown,
): ExtensionInventoryControlParseResult<ExtensionInventoryControlPrepareResult> {
  const broad = record(input)
  if (broad?.status === "prepared") {
    const value = exact(input, ["schemaVersion", "requestId", "status", "preview"])
    const preview = parsePreview(value?.preview)
    if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !preview.ok) return invalid()
    return valid({ schemaVersion: 1, requestId: value.requestId, status: "prepared", preview: preview.value })
  }
  const value = exact(input, ["schemaVersion", "requestId", "status", "reason"])
  if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || value.status !== "blocked" || !reason(value.reason)) {
    return invalid()
  }
  return valid({ schemaVersion: 1, requestId: value.requestId, status: "blocked", reason: value.reason })
}

export function parseExtensionInventoryControlDecisionResult(
  input: unknown,
): ExtensionInventoryControlParseResult<ExtensionInventoryControlDecisionResult> {
  const broad = record(input)
  const common = exactCommon(input)
  if (!broad || !common) return invalid()
  if (broad.status === "denied_without_effect") {
    if (!exact(input, ["schemaVersion", "requestId", "proposalID", "status"])) return invalid()
    return valid({ ...common, status: "denied_without_effect" })
  }
  if (broad.status === "completed_observed_not_verified") {
    const value = exact(input, [
      "schemaVersion",
      "requestId",
      "proposalID",
      "status",
      "receiptID",
      "candidates",
      "verification",
    ])
    const report = parseExtensionInventoryReport({
      schemaVersion: 1,
      status: "complete",
      candidates: value?.candidates,
      sourceFileCount: 0,
      sourceByteCount: 0,
      candidateCounts: {
        plugins: Array.isArray(value?.candidates) ? value.candidates.filter((candidate) => record(candidate)?.kind === "plugin").length : -1,
        mcp: Array.isArray(value?.candidates) ? value.candidates.filter((candidate) => record(candidate)?.kind === "mcp").length : -1,
      },
      state: "inactive",
      verification: "not_verified",
      redaction: "secrets_removed",
    })
    if (!value || !uuid(value.receiptID) || value.verification !== "not_verified" || !report.ok) return invalid()
    return valid({
      ...common,
      status: "completed_observed_not_verified",
      receiptID: value.receiptID,
      candidates: report.value.candidates,
      verification: "not_verified",
    })
  }
  const value = exact(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
  if (
    !value ||
    (value.status !== "failed_without_effect" && value.status !== "reconciliation_required" && value.status !== "blocked") ||
    !reason(value.reason)
  ) {
    return invalid()
  }
  return valid({ ...common, status: value.status, reason: value.reason })
}

function parsePreview(input: unknown): ExtensionInventoryControlParseResult<ExtensionInventoryControlPreview> {
  const value = exact(input, [
    "schemaVersion",
    "proposalID",
    "expiresAt",
    "capabilityDigest",
    "boundaryLabel",
    "helper",
    "resourceClasses",
    "allowlist",
    "verification",
  ])
  const helper = exact(value?.helper, ["kind", "execution"])
  const resources = strings(value?.resourceClasses, 16)
  const allowlist = strings(value?.allowlist, 32)
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !uuid(value.proposalID) ||
    !timestamp(value.expiresAt) ||
    !digest(value.capabilityDigest) ||
    value.boundaryLabel !== extensionInventoryControlBoundaryLabel ||
    !helper ||
    helper.kind !== "astra_native_static_inventory" ||
    helper.execution !== "private_verified_snapshot_after_claim" ||
    !resources ||
    !allowlist ||
    value.verification !== "not_verified"
  ) {
    return invalid()
  }
  return valid({
    schemaVersion: 1,
    proposalID: value.proposalID,
    expiresAt: value.expiresAt,
    capabilityDigest: value.capabilityDigest,
    boundaryLabel: extensionInventoryControlBoundaryLabel,
    helper: { kind: "astra_native_static_inventory", execution: "private_verified_snapshot_after_claim" },
    resourceClasses: resources,
    allowlist,
    verification: "not_verified",
  })
}

function exactCommon(input: unknown) {
  const value = record(input)
  if (value?.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.proposalID)) return null
  return { schemaVersion: 1 as const, requestId: value.requestId, proposalID: value.proposalID }
}

function exact(input: unknown, keys: ReadonlyArray<string>) {
  const value = record(input)
  if (!value) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return null
  const output: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) return null
    output[key] = descriptor.value
  }
  return output
}

function record(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const output: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    output[key] = descriptor.value
  }
  return output
}

function strings(input: unknown, maximum: number) {
  if (!Array.isArray(input) || input.length > maximum) return null
  const output: string[] = []
  for (const value of input) {
    if (typeof value !== "string" || value.length > 256) return null
    output.push(value)
  }
  return Object.freeze(output)
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
  return typeof input === "string" && timestampPattern.test(input) && new Date(Date.parse(input)).toISOString() === input
}

function reason(input: unknown): input is string {
  return typeof input === "string" && reasonPattern.test(input)
}

function valid<Value>(value: Value): ExtensionInventoryControlParseResult<Value> {
  return { ok: true, value }
}

function invalid(): ExtensionInventoryControlParseResult<never> {
  return { ok: false, reason: "invalid_extension_inventory_control" }
}
