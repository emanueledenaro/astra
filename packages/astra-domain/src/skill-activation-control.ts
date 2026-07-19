const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/

export const skillMetadataTrustLabel = "UNTRUSTED WORKSPACE METADATA" as const
export const skillInstructionTrustLabel = "UNTRUSTED INSTRUCTION DATA" as const
export const skillActivationBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const

type RequestBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  sessionID: string
  token: string
}>

export type SkillInventoryRequest = RequestBinding & Readonly<{ method: "skill.inventory" }>
export type SkillActivationPrepareRequest = RequestBinding &
  Readonly<{
    method: "skill.prepare"
    inventoryID: string
    candidateID: `sha256:${string}`
  }>
export type SkillActivationDecisionRequest = RequestBinding &
  Readonly<{
    method: "skill.decide"
    proposalID: string
    decision: "approve" | "reject"
  }>

export type SkillControlRequest = SkillInventoryRequest | SkillActivationPrepareRequest | SkillActivationDecisionRequest

export type SkillInventoryCandidateView = Readonly<{
  candidateID: `sha256:${string}`
  name: string
  description: string | null
  metadataTrust: typeof skillMetadataTrustLabel
  provenance: "workspace_opencode"
  relativePath: string
  fileDigest: `sha256:${string}`
  fileBytes: number
  instructionsDigest: `sha256:${string}`
  instructionsBytes: number
}>

export type SkillInventoryResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "complete"
      inventoryID: string
      candidates: ReadonlyArray<SkillInventoryCandidateView>
      verification: "not_verified"
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "blocked"
      reason: string
    }>

export type SkillActivationPreviewView = Readonly<{
  operationID: string
  proposalID: string
  expiresAt: string
  boundaryLabel: typeof skillActivationBoundaryLabel
  capabilityDigest: `sha256:${string}`
  skill: Readonly<{
    candidateID: `sha256:${string}`
    name: string
    relativePath: string
    fileDigest: `sha256:${string}`
    fileBytes: number
    instructionsDigest: `sha256:${string}`
    instructionsBytes: number
    provenance: "workspace_opencode"
    trust: typeof skillInstructionTrustLabel
  }>
  effects: Readonly<{
    workspaceRead: string
    workspaceWrite: "none"
    runtimeWrite: "private_session_skill_bundle"
    process: "none"
    network: "none"
    plugins: "none"
    mcp: "none"
    tools: "none"
  }>
  verification: "not_verified"
}>

export type SkillActivationPrepareResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "prepared"
      preview: SkillActivationPreviewView
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "blocked"
      reason: string
    }>

export type SkillActivationProgress = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  operationID: string
  status: "recording_authority" | "submitting_approval" | "effect_observed_not_verified"
  verification: "not_verified"
}>

export type SkillActivationDecisionResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      operationID: string
      status: "denied_without_effect" | "failed_without_effect" | "completed_observed_not_verified"
      receiptID: string | null
      verification: "not_verified"
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      operationID: string
      status: "reconciliation_required"
      reason: "effect_unknown" | "durable_state_unavailable"
      verification: "not_verified"
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "blocked"
      reason: string
    }>

export type SkillControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_shape" | "invalid_value" }>

export function parseSkillControlRequest(input: unknown): SkillControlParseResult<SkillControlRequest> {
  if (!record(input) || typeof input.method !== "string") return rejected("invalid_shape")
  if (input.method === "skill.inventory") {
    const value = exactRecord(input, ["schemaVersion", "method", "requestId", "sessionID", "token"])
    if (!value) return rejected("invalid_shape")
    if (!requestBinding(value) || value.method !== "skill.inventory") return rejected("invalid_value")
    return accepted(Object.freeze({
      schemaVersion: 1,
      method: "skill.inventory",
      requestId: value.requestId,
      sessionID: value.sessionID,
      token: value.token,
    }))
  }
  if (input.method === "skill.prepare") {
    const value = exactRecord(input, [
      "schemaVersion",
      "method",
      "requestId",
      "sessionID",
      "token",
      "inventoryID",
      "candidateID",
    ])
    if (!value) return rejected("invalid_shape")
    if (
      !requestBinding(value) ||
      value.method !== "skill.prepare" ||
      !uuid(value.inventoryID) ||
      !digest(value.candidateID)
    ) return rejected("invalid_value")
    return accepted(Object.freeze({
      schemaVersion: 1,
      method: "skill.prepare",
      requestId: value.requestId,
      sessionID: value.sessionID,
      token: value.token,
      inventoryID: value.inventoryID,
      candidateID: value.candidateID,
    }))
  }
  if (input.method === "skill.decide") {
    const value = exactRecord(input, [
      "schemaVersion",
      "method",
      "requestId",
      "sessionID",
      "token",
      "proposalID",
      "decision",
    ])
    if (!value) return rejected("invalid_shape")
    if (
      !requestBinding(value) ||
      value.method !== "skill.decide" ||
      !uuid(value.proposalID) ||
      (value.decision !== "approve" && value.decision !== "reject")
    ) return rejected("invalid_value")
    return accepted(Object.freeze({
      schemaVersion: 1,
      method: "skill.decide",
      requestId: value.requestId,
      sessionID: value.sessionID,
      token: value.token,
      proposalID: value.proposalID,
      decision: value.decision,
    }))
  }
  return rejected("invalid_value")
}

export function parseSkillInventoryResult(input: unknown): SkillControlParseResult<SkillInventoryResult> {
  if (!record(input) || input.status === "blocked") {
    const value = exactRecord(input, ["schemaVersion", "requestId", "status", "reason"])
    if (!value) return rejected("invalid_shape")
    if (value.schemaVersion !== 1 || !uuid(value.requestId) || value.status !== "blocked" || !reason(value.reason)) {
      return rejected("invalid_value")
    }
    return accepted(Object.freeze({ schemaVersion: 1, requestId: value.requestId, status: "blocked", reason: value.reason }))
  }
  const value = exactRecord(input, ["schemaVersion", "requestId", "status", "inventoryID", "candidates", "verification"])
  if (!value) return rejected("invalid_shape")
  if (
    value.schemaVersion !== 1 ||
    !uuid(value.requestId) ||
    value.status !== "complete" ||
    !uuid(value.inventoryID) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 32 ||
    value.verification !== "not_verified"
  ) return rejected("invalid_value")
  const candidates: SkillInventoryCandidateView[] = []
  for (const input of value.candidates) {
    const candidate = candidateView(input)
    if (!candidate) return rejected("invalid_value")
    candidates.push(candidate)
  }
  return accepted(Object.freeze({
    schemaVersion: 1,
    requestId: value.requestId,
    status: "complete",
    inventoryID: value.inventoryID,
    candidates: Object.freeze(candidates),
    verification: "not_verified",
  }))
}

export function parseSkillActivationPrepareResult(input: unknown): SkillControlParseResult<SkillActivationPrepareResult> {
  if (!record(input) || input.status === "blocked") {
    const value = exactRecord(input, ["schemaVersion", "requestId", "status", "reason"])
    if (!value) return rejected("invalid_shape")
    if (value.schemaVersion !== 1 || !uuid(value.requestId) || value.status !== "blocked" || !reason(value.reason)) {
      return rejected("invalid_value")
    }
    return accepted(Object.freeze({ schemaVersion: 1, requestId: value.requestId, status: "blocked", reason: value.reason }))
  }
  const value = exactRecord(input, ["schemaVersion", "requestId", "status", "preview"])
  if (!value) return rejected("invalid_shape")
  const preview = previewView(value.preview)
  if (value.schemaVersion !== 1 || !uuid(value.requestId) || value.status !== "prepared" || !preview) {
    return rejected("invalid_value")
  }
  return accepted(Object.freeze({ schemaVersion: 1, requestId: value.requestId, status: "prepared", preview }))
}

export function parseSkillActivationProgress(input: unknown): SkillControlParseResult<SkillActivationProgress> {
  const value = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "verification"])
  if (!value) return rejected("invalid_shape")
  if (
    value.schemaVersion !== 1 ||
    !uuid(value.requestId) ||
    !uuid(value.proposalID) ||
    !uuid(value.operationID) ||
    !["recording_authority", "submitting_approval", "effect_observed_not_verified"].includes(String(value.status)) ||
    value.verification !== "not_verified"
  ) return rejected("invalid_value")
  return accepted(Object.freeze({
    schemaVersion: 1,
    requestId: value.requestId,
    proposalID: value.proposalID,
    operationID: value.operationID,
    status: requireProgressStatus(value.status),
    verification: "not_verified",
  }))
}

export function parseSkillActivationDecisionResult(input: unknown): SkillControlParseResult<SkillActivationDecisionResult> {
  if (!record(input)) return rejected("invalid_shape")
  if (input.status === "blocked") {
    const value = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
    if (!value || value.schemaVersion !== 1 || !uuid(value.requestId) || !uuid(value.proposalID) || !reason(value.reason)) {
      return rejected(value ? "invalid_value" : "invalid_shape")
    }
    return accepted(Object.freeze({
      schemaVersion: 1,
      requestId: value.requestId,
      proposalID: value.proposalID,
      status: "blocked",
      reason: value.reason,
    }))
  }
  if (input.status === "reconciliation_required") {
    const value = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "reason", "verification"])
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !uuid(value.requestId) ||
      !uuid(value.proposalID) ||
      !uuid(value.operationID) ||
      (value.reason !== "effect_unknown" && value.reason !== "durable_state_unavailable") ||
      value.verification !== "not_verified"
    ) return rejected(value ? "invalid_value" : "invalid_shape")
    return accepted(Object.freeze({
      schemaVersion: 1,
      requestId: value.requestId,
      proposalID: value.proposalID,
      operationID: value.operationID,
      status: "reconciliation_required",
      reason: value.reason,
      verification: "not_verified",
    }))
  }
  const value = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "receiptID", "verification"])
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !uuid(value.requestId) ||
    !uuid(value.proposalID) ||
    !uuid(value.operationID) ||
    !["denied_without_effect", "failed_without_effect", "completed_observed_not_verified"].includes(String(value.status)) ||
    (value.receiptID !== null && !uuid(value.receiptID)) ||
    value.verification !== "not_verified"
  ) return rejected(value ? "invalid_value" : "invalid_shape")
  if (value.status === "completed_observed_not_verified" && value.receiptID === null) return rejected("invalid_value")
  if (value.status === "denied_without_effect" && value.receiptID !== null) return rejected("invalid_value")
  return accepted(Object.freeze({
    schemaVersion: 1,
    requestId: value.requestId,
    proposalID: value.proposalID,
    operationID: value.operationID,
    status: requireTerminalStatus(value.status),
    receiptID: value.receiptID,
    verification: "not_verified",
  }))
}

function candidateView(input: unknown): SkillInventoryCandidateView | null {
  const value = exactRecord(input, [
    "candidateID", "name", "description", "metadataTrust", "provenance", "relativePath",
    "fileDigest", "fileBytes", "instructionsDigest", "instructionsBytes",
  ])
  if (
    !value || !digest(value.candidateID) || !skillName(value.name) ||
    (value.description !== null && (typeof value.description !== "string" || value.description.length > 240)) ||
    value.metadataTrust !== skillMetadataTrustLabel || value.provenance !== "workspace_opencode" ||
    !skillPath(value.relativePath) || !digest(value.fileDigest) || !boundedInteger(value.fileBytes, 65_536) ||
    !digest(value.instructionsDigest) || !boundedInteger(value.instructionsBytes, 65_536) ||
    value.instructionsBytes > value.fileBytes
  ) return null
  return Object.freeze({
    candidateID: value.candidateID,
    name: value.name,
    description: value.description,
    metadataTrust: skillMetadataTrustLabel,
    provenance: "workspace_opencode",
    relativePath: value.relativePath,
    fileDigest: value.fileDigest,
    fileBytes: value.fileBytes,
    instructionsDigest: value.instructionsDigest,
    instructionsBytes: value.instructionsBytes,
  })
}

function previewView(input: unknown): SkillActivationPreviewView | null {
  const value = exactRecord(input, ["operationID", "proposalID", "expiresAt", "boundaryLabel", "capabilityDigest", "skill", "effects", "verification"])
  if (!value) return null
  const skill = exactRecord(value.skill, ["candidateID", "name", "relativePath", "fileDigest", "fileBytes", "instructionsDigest", "instructionsBytes", "provenance", "trust"])
  const effects = exactRecord(value.effects, ["workspaceRead", "workspaceWrite", "runtimeWrite", "process", "network", "plugins", "mcp", "tools"])
  if (
    !uuid(value.operationID) || !uuid(value.proposalID) || !timestamp(value.expiresAt) ||
    value.boundaryLabel !== skillActivationBoundaryLabel || !digest(value.capabilityDigest) || value.verification !== "not_verified" ||
    !skill || !digest(skill.candidateID) || !skillName(skill.name) || !skillPath(skill.relativePath) ||
    !digest(skill.fileDigest) || !boundedInteger(skill.fileBytes, 65_536) || !digest(skill.instructionsDigest) ||
    !boundedInteger(skill.instructionsBytes, 65_536) || skill.instructionsBytes > skill.fileBytes ||
    skill.provenance !== "workspace_opencode" || skill.trust !== skillInstructionTrustLabel ||
    !effects || effects.workspaceRead !== skill.relativePath || effects.workspaceWrite !== "none" ||
    effects.runtimeWrite !== "private_session_skill_bundle" || effects.process !== "none" || effects.network !== "none" ||
    effects.plugins !== "none" || effects.mcp !== "none" || effects.tools !== "none"
  ) return null
  return Object.freeze({
    operationID: value.operationID,
    proposalID: value.proposalID,
    expiresAt: value.expiresAt,
    boundaryLabel: skillActivationBoundaryLabel,
    capabilityDigest: value.capabilityDigest,
    skill: Object.freeze({
      candidateID: skill.candidateID,
      name: skill.name,
      relativePath: skill.relativePath,
      fileDigest: skill.fileDigest,
      fileBytes: skill.fileBytes,
      instructionsDigest: skill.instructionsDigest,
      instructionsBytes: skill.instructionsBytes,
      provenance: "workspace_opencode",
      trust: skillInstructionTrustLabel,
    }),
    effects: Object.freeze({
      workspaceRead: effects.workspaceRead,
      workspaceWrite: "none",
      runtimeWrite: "private_session_skill_bundle",
      process: "none",
      network: "none",
      plugins: "none",
      mcp: "none",
      tools: "none",
    }),
    verification: "not_verified",
  })
}

function requireProgressStatus(input: unknown): SkillActivationProgress["status"] {
  if (input === "recording_authority" || input === "submitting_approval" || input === "effect_observed_not_verified") return input
  throw new TypeError("Invalid skill activation progress")
}

function requireTerminalStatus(input: unknown): "denied_without_effect" | "failed_without_effect" | "completed_observed_not_verified" {
  if (input === "denied_without_effect" || input === "failed_without_effect" || input === "completed_observed_not_verified") return input
  throw new TypeError("Invalid skill activation terminal")
}

function requestBinding(value: Record<string, unknown>): value is Record<string, unknown> & RequestBinding {
  return value.schemaVersion === 1 && uuid(value.requestId) && uuid(value.sessionID) && token(value.token)
}

function skillPath(input: unknown): input is string {
  return typeof input === "string" &&
    !/[\p{Cc}\p{Cf}]/u.test(input) &&
    /^\.opencode\/(?:skill|skills)\/(?:[^/]+\/)+SKILL\.md$/.test(input) &&
    !input.includes("..")
}

function skillName(input: unknown): input is string {
  return typeof input === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input)
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!record(input) || Object.getOwnPropertySymbols(input).length > 0) return null
  const own = Object.keys(input)
  if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) return null
  return input
}

function record(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function uuid(input: unknown): input is string { return typeof input === "string" && uuidPattern.test(input) }
function token(input: unknown): input is string { return typeof input === "string" && tokenPattern.test(input) }
function digest(input: unknown): input is `sha256:${string}` { return typeof input === "string" && digestPattern.test(input) }
function reason(input: unknown): input is string { return typeof input === "string" && reasonPattern.test(input) }
function timestamp(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) && new Date(Date.parse(input)).toISOString() === input
}
function boundedInteger(input: unknown, maximum: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 && input <= maximum
}
function accepted<Value>(value: Value): SkillControlParseResult<Value> { return { ok: true, value } }
function rejected(reason: "invalid_shape" | "invalid_value") { return { ok: false, reason } as const }
