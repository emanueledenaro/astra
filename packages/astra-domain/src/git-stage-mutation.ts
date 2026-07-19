import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { parseExactRecord } from "./operation-contract-validation"

export const gitStageBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const
export const gitStageLimitations = Object.freeze([
  "host_network_not_isolated",
  "full_object_store_not_observed",
  "quarantine_and_repository_must_share_filesystem",
  "same_uid_concurrent_path_replacement_not_isolated",
] as const)

export type GitStageIndexEndpoint =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "object"; mode: "100644" | "100755"; oid: string }>

export type GitStageWorktreeEndpoint =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "object"
      mode: "100644" | "100755"
      oid: string
      byteLength: number
      contentDigest: `sha256:${string}`
    }>

export type GitStageCandidate = Readonly<{
  candidateID: string
  path: string
  action: "upsert" | "delete"
  before: GitStageIndexEndpoint
  after: GitStageWorktreeEndpoint
  objectPath: string | null
}>

export type GitStageInventoryAuthority = Readonly<{
  schemaVersion: 1
  workspaceRoot: string
  baselineSnapshotDigest: `sha256:${string}`
  inspectionObservationDigest: `sha256:${string}`
  inspectionReportDigest: `sha256:${string}`
  objectFormat: "sha1" | "sha256"
  indexEntries: ReadonlyArray<Readonly<{ path: string; mode: string; oid: string }>>
  candidates: ReadonlyArray<GitStageCandidate>
}>

export type GitStageInventory = GitStageInventoryAuthority & Readonly<{ inventoryDigest: `sha256:${string}` }>

export type GitStagePreviewAuthority = Readonly<{
  schemaVersion: 1
  operation: "git_stage_paths"
  boundary: "host_no_sandbox"
  boundaryLabel: typeof gitStageBoundaryLabel
  verification: "not_verified"
  workspaceRoot: string
  nonce: string
  createdAt: string
  expiresAt: string
  runtimeScratch: string
  inventoryDigest: `sha256:${string}`
  baselineSnapshotDigest: `sha256:${string}`
  selection: Readonly<{ kind: "selected"; candidateIDs: ReadonlyArray<string> }>
  candidates: ReadonlyArray<GitStageCandidate>
  repositoryWrites: ReadonlyArray<string>
  scratchWrites: readonly [string]
  authorizationConsumption: "durable_operation_kernel_claim_required"
  hooks: "disabled"
  filters: "raw_no_filters_transforming_attributes_blocked"
  network: "not_requested_host_unrestricted"
  preserves: Readonly<{
    worktree: "required"
    head: "required"
    refs: "required"
    nonSelectedIndexEntries: "required"
  }>
  limitations: typeof gitStageLimitations
}>

export type GitStagePreview = GitStagePreviewAuthority & Readonly<{ proposalDigest: `sha256:${string}` }>

export type GitStageDecision = Readonly<{
  schemaVersion: 1
  operation: "git_stage_paths"
  proposalDigest: `sha256:${string}`
  nonce: string
  decision: "approved" | "rejected"
  decidedAt: string
}>

export type GitStageObservation = Readonly<{
  schemaVersion: 1
  operation: "git_stage_paths"
  status: "effect_observed"
  verification: "not_verified"
  proposalDigest: `sha256:${string}`
  beforeSnapshotDigest: `sha256:${string}`
  afterSnapshotDigest: `sha256:${string}`
  afterIndexDigest: `sha256:${string}`
  afterIndexMetadataDigest: `sha256:${string}`
  objectOIDs: ReadonlyArray<string>
  limitations: typeof gitStageLimitations
}>

export type GitStageParseResult<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; reason: string }>

export function computeGitStageInventoryDigest(authority: GitStageInventoryAuthority): `sha256:${string}` {
  return digest(`astra.git-stage-inventory.v1\0${canonicalJson(authority)}`)
}

export function computeGitStageProposalDigest(authority: GitStagePreviewAuthority): `sha256:${string}` {
  return digest(`astra.git-stage-preview.v1\0${canonicalJson(authority)}`)
}

export function parseGitStageInventory(input: unknown): GitStageParseResult<GitStageInventory> {
  const record = exact(input, [
    "schemaVersion",
    "workspaceRoot",
    "baselineSnapshotDigest",
    "inspectionObservationDigest",
    "inspectionReportDigest",
    "objectFormat",
    "indexEntries",
    "candidates",
    "inventoryDigest",
  ])
  if (!record) return rejected("invalid_inventory_shape")
  const authority = inventoryAuthority(record)
  if (!authority || !digestValue(record.inventoryDigest)) return rejected("invalid_inventory_value")
  if (record.inventoryDigest !== computeGitStageInventoryDigest(authority)) return rejected("invalid_inventory_digest")
  return accepted({ ...authority, inventoryDigest: record.inventoryDigest })
}

export function parseGitStagePreview(input: unknown): GitStageParseResult<GitStagePreview> {
  const record = exact(input, [...previewKeys, "proposalDigest"])
  if (!record) return rejected("invalid_preview_shape")
  const authority = previewAuthority(record)
  if (!authority || !digestValue(record.proposalDigest)) return rejected("invalid_preview_value")
  if (record.proposalDigest !== computeGitStageProposalDigest(authority)) return rejected("invalid_proposal_digest")
  return accepted({ ...authority, proposalDigest: record.proposalDigest })
}

export function parseGitStageDecision(input: unknown): GitStageParseResult<GitStageDecision> {
  const record = exact(input, ["schemaVersion", "operation", "proposalDigest", "nonce", "decision", "decidedAt"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.operation !== "git_stage_paths" ||
    !digestValue(record.proposalDigest) ||
    !uuid(record.nonce) ||
    (record.decision !== "approved" && record.decision !== "rejected") ||
    !timestamp(record.decidedAt)
  ) {
    return rejected("invalid_decision")
  }
  return accepted({
    schemaVersion: 1,
    operation: "git_stage_paths",
    proposalDigest: record.proposalDigest,
    nonce: record.nonce,
    decision: record.decision,
    decidedAt: record.decidedAt,
  })
}

export function parseGitStageObservation(input: unknown): GitStageParseResult<GitStageObservation> {
  const record = exact(input, [
    "schemaVersion",
    "operation",
    "status",
    "verification",
    "proposalDigest",
    "beforeSnapshotDigest",
    "afterSnapshotDigest",
    "afterIndexDigest",
    "afterIndexMetadataDigest",
    "objectOIDs",
    "limitations",
  ])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.operation !== "git_stage_paths" ||
    record.status !== "effect_observed" ||
    record.verification !== "not_verified" ||
    !digestValue(record.proposalDigest) ||
    !digestValue(record.beforeSnapshotDigest) ||
    !digestValue(record.afterSnapshotDigest) ||
    !digestValue(record.afterIndexDigest) ||
    !digestValue(record.afterIndexMetadataDigest) ||
    !stringList(record.objectOIDs, objectID) ||
    !sameStrings(record.limitations, gitStageLimitations)
  ) {
    return rejected("invalid_observation")
  }
  return accepted({
    schemaVersion: 1,
    operation: "git_stage_paths",
    status: "effect_observed",
    verification: "not_verified",
    proposalDigest: record.proposalDigest,
    beforeSnapshotDigest: record.beforeSnapshotDigest,
    afterSnapshotDigest: record.afterSnapshotDigest,
    afterIndexDigest: record.afterIndexDigest,
    afterIndexMetadataDigest: record.afterIndexMetadataDigest,
    objectOIDs: [...record.objectOIDs],
    limitations: gitStageLimitations,
  })
}

const previewKeys = [
  "schemaVersion",
  "operation",
  "boundary",
  "boundaryLabel",
  "verification",
  "workspaceRoot",
  "nonce",
  "createdAt",
  "expiresAt",
  "runtimeScratch",
  "inventoryDigest",
  "baselineSnapshotDigest",
  "selection",
  "candidates",
  "repositoryWrites",
  "scratchWrites",
  "authorizationConsumption",
  "hooks",
  "filters",
  "network",
  "preserves",
  "limitations",
] as const

function inventoryAuthority(input: Readonly<Record<string, unknown>>): GitStageInventoryAuthority | null {
  const candidates = candidateList(input.candidates, input.objectFormat)
  const indexEntries = indexEntryList(input.indexEntries, input.objectFormat)
  if (
    input.schemaVersion !== 1 ||
    typeof input.workspaceRoot !== "string" ||
    !isAbsolute(input.workspaceRoot) ||
    !digestValue(input.baselineSnapshotDigest) ||
    !digestValue(input.inspectionObservationDigest) ||
    !digestValue(input.inspectionReportDigest) ||
    (input.objectFormat !== "sha1" && input.objectFormat !== "sha256") ||
    !indexEntries ||
    !candidates
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    workspaceRoot: input.workspaceRoot,
    baselineSnapshotDigest: input.baselineSnapshotDigest,
    inspectionObservationDigest: input.inspectionObservationDigest,
    inspectionReportDigest: input.inspectionReportDigest,
    objectFormat: input.objectFormat,
    indexEntries,
    candidates,
  }
}

function previewAuthority(input: Readonly<Record<string, unknown>>): GitStagePreviewAuthority | null {
  const candidates = candidateList(input.candidates)
  const selection = exact(input.selection, ["kind", "candidateIDs"])
  const candidateIDs = selection && stringList(selection.candidateIDs, uuid) ? selection.candidateIDs : null
  const preserves = exact(input.preserves, ["worktree", "head", "refs", "nonSelectedIndexEntries"])
  if (
    input.schemaVersion !== 1 ||
    input.operation !== "git_stage_paths" ||
    input.boundary !== "host_no_sandbox" ||
    input.boundaryLabel !== gitStageBoundaryLabel ||
    input.verification !== "not_verified" ||
    typeof input.workspaceRoot !== "string" ||
    !isAbsolute(input.workspaceRoot) ||
    !uuid(input.nonce) ||
    !timestamp(input.createdAt) ||
    !timestamp(input.expiresAt) ||
    Date.parse(input.expiresAt) <= Date.parse(input.createdAt) ||
    input.runtimeScratch !== join("/private/tmp", `astra-git-stage-${input.nonce}`) ||
    !digestValue(input.inventoryDigest) ||
    !digestValue(input.baselineSnapshotDigest) ||
    !selection ||
    selection.kind !== "selected" ||
    !candidateIDs ||
    candidateIDs.length < 1 ||
    new Set(candidateIDs).size !== candidateIDs.length ||
    !candidates ||
    candidates.length !== candidateIDs.length ||
    candidates.some((candidate, index) => candidate.candidateID !== candidateIDs[index]) ||
    !stringList(input.repositoryWrites, safeResource) ||
    !exactRepositoryWrites(input.repositoryWrites, candidates) ||
    !Array.isArray(input.scratchWrites) ||
    input.scratchWrites.length !== 1 ||
    input.scratchWrites[0] !== input.runtimeScratch ||
    input.authorizationConsumption !== "durable_operation_kernel_claim_required" ||
    input.hooks !== "disabled" ||
    input.filters !== "raw_no_filters_transforming_attributes_blocked" ||
    input.network !== "not_requested_host_unrestricted" ||
    !preserves ||
    preserves.worktree !== "required" ||
    preserves.head !== "required" ||
    preserves.refs !== "required" ||
    preserves.nonSelectedIndexEntries !== "required" ||
    !sameStrings(input.limitations, gitStageLimitations)
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    operation: "git_stage_paths",
    boundary: "host_no_sandbox",
    boundaryLabel: gitStageBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: input.workspaceRoot,
    nonce: input.nonce,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    runtimeScratch: input.runtimeScratch,
    inventoryDigest: input.inventoryDigest,
    baselineSnapshotDigest: input.baselineSnapshotDigest,
    selection: { kind: "selected", candidateIDs: [...candidateIDs] },
    candidates,
    repositoryWrites: [...input.repositoryWrites],
    scratchWrites: [input.runtimeScratch],
    authorizationConsumption: "durable_operation_kernel_claim_required",
    hooks: "disabled",
    filters: "raw_no_filters_transforming_attributes_blocked",
    network: "not_requested_host_unrestricted",
    preserves: { worktree: "required", head: "required", refs: "required", nonSelectedIndexEntries: "required" },
    limitations: gitStageLimitations,
  }
}

function candidateList(input: unknown, format?: unknown): ReadonlyArray<GitStageCandidate> | null {
  if (!Array.isArray(input) || input.length > 512) return null
  const candidates = input.map((value) => candidate(value, format))
  const values = candidates.filter((value): value is GitStageCandidate => value !== null)
  if (values.length !== candidates.length) return null
  if (new Set(values.map((value) => value.candidateID)).size !== values.length) return null
  if (new Set(values.map((value) => value.path)).size !== values.length) return null
  if (!values.every((value, index) => index === 0 || values[index - 1]!.path < value.path)) return null
  return values
}

function candidate(input: unknown, format?: unknown): GitStageCandidate | null {
  const record = exact(input, ["candidateID", "path", "action", "before", "after", "objectPath"])
  if (!record || !uuid(record.candidateID) || !safePath(record.path)) return null
  const before = indexEndpoint(record.before, format)
  const after = worktreeEndpoint(record.after, format)
  if (!before || !after) return null
  if (record.action === "delete" && after.state === "absent" && record.objectPath === null) {
    return { candidateID: record.candidateID, path: record.path, action: "delete", before, after, objectPath: null }
  }
  if (
    record.action !== "upsert" ||
    after.state !== "object" ||
    typeof record.objectPath !== "string" ||
    record.objectPath !== `.git/objects/${after.oid.slice(0, 2)}/${after.oid.slice(2)}`
  ) {
    return null
  }
  return {
    candidateID: record.candidateID,
    path: record.path,
    action: "upsert",
    before,
    after,
    objectPath: record.objectPath,
  }
}

function indexEntryList(input: unknown, format: unknown) {
  if (!Array.isArray(input) || input.length > 25_000) return null
  const values: Array<{ path: string; mode: string; oid: string }> = []
  for (const entry of input) {
    const record = exact(entry, ["path", "mode", "oid"])
    if (!record || !safePath(record.path) || !mode(record.mode) || !oidForFormat(record.oid, format)) return null
    const entryMode = record.mode
    const entryOID = record.oid
    if (!mode(entryMode) || !objectID(entryOID)) return null
    values.push({ path: record.path, mode: entryMode, oid: entryOID })
  }
  if (!values.every((value, index) => index === 0 || values[index - 1]!.path < value.path)) return null
  return values
}

function indexEndpoint(input: unknown, format?: unknown): GitStageIndexEndpoint | null {
  const broad = plain(input)
  if (!broad) return null
  if (broad.state === "absent" && exact(input, ["state"])) return { state: "absent" }
  const record = exact(input, ["state", "mode", "oid"])
  if (!record || record.state !== "object" || !mode(record.mode) || !objectID(record.oid)) return null
  if (format !== undefined && !oidForFormat(record.oid, format)) return null
  return { state: "object", mode: record.mode, oid: record.oid }
}

function worktreeEndpoint(input: unknown, format?: unknown): GitStageWorktreeEndpoint | null {
  const broad = plain(input)
  if (!broad) return null
  if (broad.state === "absent" && exact(input, ["state"])) return { state: "absent" }
  const record = exact(input, ["state", "mode", "oid", "byteLength", "contentDigest"])
  if (
    !record ||
    record.state !== "object" ||
    !mode(record.mode) ||
    !objectID(record.oid) ||
    (format !== undefined && !oidForFormat(record.oid, format)) ||
    typeof record.byteLength !== "number" ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 0 ||
    !digestValue(record.contentDigest)
  ) {
    return null
  }
  return {
    state: "object",
    mode: record.mode,
    oid: record.oid,
    byteLength: record.byteLength,
    contentDigest: record.contentDigest,
  }
}

function exactRepositoryWrites(input: unknown, candidates: ReadonlyArray<GitStageCandidate>) {
  if (!Array.isArray(input)) return false
  const expected = [
    ...candidates.flatMap((value) => (value.objectPath ? [value.objectPath] : [])),
    ".git/index",
    ".git/index.lock",
  ].sort()
  return sameStrings(input, expected)
}

function exact(input: unknown, keys: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, keys)
  return parsed.ok ? parsed.value : null
}

function plain(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null ? Object.fromEntries(Object.entries(input)) : null
}

function safePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    Buffer.byteLength(input) > 0 &&
    Buffer.byteLength(input) <= 4_096 &&
    !input.startsWith("/") &&
    !input.includes("\0") &&
    !input.split("/").some((part) => part === "" || part === "." || part === "..")
  )
}

function safeResource(input: unknown): input is string {
  return typeof input === "string" && input.length <= 4_200 && !input.includes("\0")
}

function mode(input: unknown): input is "100644" | "100755" {
  return input === "100644" || input === "100755"
}

function objectID(input: unknown): input is string {
  return typeof input === "string" && (/^[0-9a-f]{40}$/.test(input) || /^[0-9a-f]{64}$/.test(input))
}

function oidForFormat(input: unknown, format: unknown) {
  return objectID(input) && input.length === (format === "sha1" ? 40 : format === "sha256" ? 64 : -1)
}

function digestValue(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/.test(input)
}

function uuid(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  )
}

function timestamp(input: unknown): input is string {
  if (typeof input !== "string") return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function stringList(input: unknown, predicate: (value: unknown) => boolean): input is Array<string> {
  return Array.isArray(input) && input.every(predicate)
}

function sameStrings(input: unknown, expected: ReadonlyArray<string>) {
  return (
    Array.isArray(input) && input.length === expected.length && input.every((value, index) => value === expected[index])
  )
}

function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  if (input && typeof input === "object") {
    return `{${Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
      .join(",")}}`
  }
  return JSON.stringify(input)
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function accepted<Value>(value: Value): GitStageParseResult<Value> {
  return { ok: true, value }
}

function rejected(reason: string): GitStageParseResult<never> {
  return { ok: false, reason }
}
