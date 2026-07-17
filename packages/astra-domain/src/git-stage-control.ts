import {
  gitStageBoundaryLabel,
  gitStageLimitations,
  parseGitStagePreview,
  type GitStagePreview,
} from "./git-stage-mutation"
import { parseExactRecord } from "./operation-contract-validation"

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/

export type GitStageInventoryRequest = Readonly<{
  schemaVersion: 1
  method: "git-stage.inventory"
  requestId: string
  sessionID: string
  token: string
}>

export type GitStagePrepareRequest = Readonly<{
  schemaVersion: 1
  method: "git-stage.prepare"
  requestId: string
  sessionID: string
  token: string
  inventoryID: string
  candidateIDs: ReadonlyArray<string>
}>

export type GitStageDecisionRequest = Readonly<{
  schemaVersion: 1
  method: "git-stage.decide"
  requestId: string
  sessionID: string
  token: string
  proposalID: string
  decision: "approve" | "reject"
}>

export type GitStageControlRequest = GitStageInventoryRequest | GitStagePrepareRequest | GitStageDecisionRequest

export type GitStageControlCandidate = Readonly<{
  candidateID: string
  path: string
  change: "add" | "modify" | "delete"
}>

export type GitStageControlInventory = Readonly<{
  schemaVersion: 1
  action: "Stage selected"
  inventoryID: string
  inventoryDigest: `sha256:${string}`
  baselineSnapshotDigest: `sha256:${string}`
  expiresAt: string
  boundaryLabel: typeof gitStageBoundaryLabel
  verification: "not_verified"
  candidates: ReadonlyArray<GitStageControlCandidate>
  limitations: typeof gitStageLimitations
}>

export type GitStageInventoryResult =
  | Readonly<{ schemaVersion: 1; requestId: string; status: "inventory"; inventory: GitStageControlInventory }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

export type GitStageControlPreview = Readonly<{
  schemaVersion: 1
  action: "Stage selected"
  proposalID: string
  authority: GitStagePreview
}>

export type GitStagePrepareResult =
  | Readonly<{ schemaVersion: 1; requestId: string; status: "prepared"; preview: GitStageControlPreview }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

type GitStageDecisionBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  proposalDigest: `sha256:${string}`
}>

export type GitStageDecisionResult =
  | (GitStageDecisionBinding & Readonly<{ status: "denied_without_git_effect"; operationID: string }>)
  | (GitStageDecisionBinding & Readonly<{ status: "failed_without_effect"; operationID: string; reason: string }>)
  | (GitStageDecisionBinding &
      Readonly<{
        status: "verified"
        verification: "independent_selected_index_and_preservation"
        operationID: string
        receiptID: string
        snapshotDigest: `sha256:${string}`
      }>)
  | (GitStageDecisionBinding &
      Readonly<{ status: "reconciliation_required"; operationID: string | null; reason: string }>)
  | Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; status: "blocked"; reason: string }>

export type GitStageProgress = GitStageDecisionBinding &
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

export type GitStageControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: string }>

export function parseGitStageInventoryRequest(input: unknown): GitStageControlParseResult<GitStageInventoryRequest> {
  const record = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "git-stage.inventory" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token)
  ) {
    return rejected("invalid_inventory_request")
  }
  return accepted({
    schemaVersion: 1,
    method: "git-stage.inventory",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
  })
}

export function parseGitStagePrepareRequest(input: unknown): GitStageControlParseResult<GitStagePrepareRequest> {
  const record = exact(input, [
    "schemaVersion",
    "method",
    "requestId",
    "sessionID",
    "token",
    "inventoryID",
    "candidateIDs",
  ])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "git-stage.prepare" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !uuid(record.inventoryID) ||
    !uuidList(record.candidateIDs, 1, 512)
  ) {
    return rejected("invalid_prepare_request")
  }
  return accepted({
    schemaVersion: 1,
    method: "git-stage.prepare",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    inventoryID: record.inventoryID,
    candidateIDs: [...record.candidateIDs],
  })
}

export function parseGitStageDecisionRequest(input: unknown): GitStageControlParseResult<GitStageDecisionRequest> {
  const record = exact(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "proposalID", "decision"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "git-stage.decide" ||
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
    method: "git-stage.decide",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    proposalID: record.proposalID,
    decision: record.decision,
  })
}

export function parseGitStageControlRequest(input: unknown): GitStageControlParseResult<GitStageControlRequest> {
  const method = plain(input)?.method
  if (method === "git-stage.inventory") return parseGitStageInventoryRequest(input)
  if (method === "git-stage.prepare") return parseGitStagePrepareRequest(input)
  if (method === "git-stage.decide") return parseGitStageDecisionRequest(input)
  return rejected("invalid_request_method")
}

export function parseGitStageControlInventory(input: unknown): GitStageControlParseResult<GitStageControlInventory> {
  const record = exact(input, [
    "schemaVersion",
    "action",
    "inventoryID",
    "inventoryDigest",
    "baselineSnapshotDigest",
    "expiresAt",
    "boundaryLabel",
    "verification",
    "candidates",
    "limitations",
  ])
  const candidates = candidateList(record?.candidates)
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.action !== "Stage selected" ||
    !uuid(record.inventoryID) ||
    !digest(record.inventoryDigest) ||
    !digest(record.baselineSnapshotDigest) ||
    !timestamp(record.expiresAt) ||
    record.boundaryLabel !== gitStageBoundaryLabel ||
    record.verification !== "not_verified" ||
    !candidates ||
    !sameStrings(record.limitations, gitStageLimitations)
  ) {
    return rejected("invalid_inventory")
  }
  return accepted({
    schemaVersion: 1,
    action: "Stage selected",
    inventoryID: record.inventoryID,
    inventoryDigest: record.inventoryDigest,
    baselineSnapshotDigest: record.baselineSnapshotDigest,
    expiresAt: record.expiresAt,
    boundaryLabel: gitStageBoundaryLabel,
    verification: "not_verified",
    candidates,
    limitations: gitStageLimitations,
  })
}

export function parseGitStageInventoryResult(input: unknown): GitStageControlParseResult<GitStageInventoryResult> {
  const broad = plain(input)
  if (broad?.status === "inventory") {
    const record = exact(input, ["schemaVersion", "requestId", "status", "inventory"])
    const inventory = parseGitStageControlInventory(record?.inventory)
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !inventory.ok) {
      return rejected("invalid_inventory_result")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "inventory", inventory: inventory.value })
  }
  return parseBlockedResult(input)
}

export function parseGitStageControlPreview(input: unknown): GitStageControlParseResult<GitStageControlPreview> {
  const record = exact(input, ["schemaVersion", "action", "proposalID", "authority"])
  const authority = parseGitStagePreview(record?.authority)
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.action !== "Stage selected" ||
    !uuid(record.proposalID) ||
    !authority.ok
  ) {
    return rejected("invalid_preview")
  }
  return accepted({
    schemaVersion: 1,
    action: "Stage selected",
    proposalID: record.proposalID,
    authority: authority.value,
  })
}

export function parseGitStagePrepareResult(input: unknown): GitStageControlParseResult<GitStagePrepareResult> {
  const broad = plain(input)
  if (broad?.status === "prepared") {
    const record = exact(input, ["schemaVersion", "requestId", "status", "preview"])
    const preview = parseGitStageControlPreview(record?.preview)
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !preview.ok) {
      return rejected("invalid_prepare_result")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "prepared", preview: preview.value })
  }
  return parseBlockedResult(input)
}

export function parseGitStageDecisionResult(input: unknown): GitStageControlParseResult<GitStageDecisionResult> {
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
    !exact(input, [...decisionKeys, "status", "verification", "operationID", "receiptID", "snapshotDigest"]) ||
    broad.verification !== "independent_selected_index_and_preservation" ||
    !uuid(broad.operationID) ||
    !uuid(broad.receiptID) ||
    !digest(broad.snapshotDigest)
  )
    return rejected("invalid_decision_result")
  return accepted({
    ...binding,
    status: "verified",
    verification: "independent_selected_index_and_preservation",
    operationID: broad.operationID,
    receiptID: broad.receiptID,
    snapshotDigest: broad.snapshotDigest,
  })
}

export function parseGitStageProgress(input: unknown): GitStageControlParseResult<GitStageProgress> {
  const broad = plain(input)
  const binding = broad && decisionBinding(broad)
  if (!broad || !binding || broad.verification !== "not_verified") return rejected("invalid_progress")
  if (
    broad.status === "recording_authority" ||
    broad.status === "host_adapter_validating" ||
    broad.status === "verifying"
  ) {
    if (!exact(input, [...decisionKeys, "status", "verification"])) return rejected("invalid_progress")
    return accepted({ ...binding, status: broad.status, verification: "not_verified" })
  }
  if (
    broad.status !== "effect_observed_not_verified" ||
    !exact(input, [...decisionKeys, "status", "verification", "operationID", "receiptID", "snapshotDigest"]) ||
    !uuid(broad.operationID) ||
    !uuid(broad.receiptID) ||
    !digest(broad.snapshotDigest)
  )
    return rejected("invalid_progress")
  return accepted({
    ...binding,
    status: "effect_observed_not_verified",
    verification: "not_verified",
    operationID: broad.operationID,
    receiptID: broad.receiptID,
    snapshotDigest: broad.snapshotDigest,
  })
}

const decisionKeys = ["schemaVersion", "requestId", "proposalID", "proposalDigest"] as const

function decisionBinding(input: Readonly<Record<string, unknown>>): GitStageDecisionBinding | null {
  if (input.schemaVersion !== 1 || !uuid(input.requestId) || !uuid(input.proposalID) || !digest(input.proposalDigest))
    return null
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    proposalID: input.proposalID,
    proposalDigest: input.proposalDigest,
  }
}

function candidateList(input: unknown): ReadonlyArray<GitStageControlCandidate> | null {
  if (!Array.isArray(input) || input.length > 512) return null
  const values = input.map((value) => {
    const record = exact(value, ["candidateID", "path", "change"])
    if (
      !record ||
      !uuid(record.candidateID) ||
      !safePath(record.path) ||
      (record.change !== "add" && record.change !== "modify" && record.change !== "delete")
    )
      return null
    return { candidateID: record.candidateID, path: record.path, change: record.change }
  })
  const candidates = values.filter((value): value is GitStageControlCandidate => value !== null)
  if (
    candidates.length !== values.length ||
    new Set(candidates.map((value) => value.candidateID)).size !== candidates.length ||
    new Set(candidates.map((value) => value.path)).size !== candidates.length
  )
    return null
  return candidates
}

function parseBlockedResult(
  input: unknown,
): GitStageControlParseResult<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }> {
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

function safePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    Buffer.byteLength(input) > 0 &&
    Buffer.byteLength(input) <= 4_096 &&
    !input.startsWith("/") &&
    !input.includes("\0") &&
    !/\p{C}/u.test(input) &&
    !input.split("/").some((part) => part === "" || part === "." || part === "..")
  )
}

function uuidList(input: unknown, minimum: number, maximum: number): input is Array<string> {
  return (
    Array.isArray(input) &&
    input.length >= minimum &&
    input.length <= maximum &&
    input.every(uuid) &&
    new Set(input).size === input.length
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
function reason(input: unknown): input is string {
  return typeof input === "string" && reasonPattern.test(input)
}
function timestamp(input: unknown): input is string {
  if (typeof input !== "string") return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}
function sameStrings(input: unknown, expected: ReadonlyArray<string>) {
  return (
    Array.isArray(input) && input.length === expected.length && input.every((value, index) => value === expected[index])
  )
}
function accepted<Value>(value: Value): GitStageControlParseResult<Value> {
  return { ok: true, value: deepFreeze(value) }
}
function rejected(reason: string): GitStageControlParseResult<never> {
  return { ok: false, reason }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
