import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"

export const gitCommitBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const
export const gitCommitLimitations = Object.freeze([
  "host_network_not_isolated",
  "orphan_objects_require_reconciliation",
] as const)

export type GitCommitIdentity = Readonly<{ name: string; email: string }>
export type GitCommitIndexEntry = Readonly<{ mode: "100644" | "100755"; oid: string; path: string }>
export type GitCommitObject = Readonly<{
  oid: string
  byteLength: number
  contentDigest: `sha256:${string}`
  contentBase64: string
}>
export type GitCommitHelperIdentity = Readonly<{
  canonicalPath: string
  device: string
  inode: string
  byteLength: number
  contentDigest: `sha256:${string}`
}>

export type GitCommitInventoryAuthority = Readonly<{
  schemaVersion: 1
  workspaceRoot: string
  baselineSnapshotDigest: `sha256:${string}`
  helper: GitCommitHelperIdentity
  objectFormat: "sha1" | "sha256"
  ref: `refs/heads/${string}`
  expectedOldOID: string
  indexDigest: `sha256:${string}`
  worktreeDigest: `sha256:${string}`
  refsDigest: `sha256:${string}`
  otherRefsDigest: `sha256:${string}`
  indexEntries: ReadonlyArray<GitCommitIndexEntry>
  identity: GitCommitIdentity
  timestamp: number
  timezone: "+0000"
  message: string
  treeOID: string
  commitOID: string
  treeObjects: ReadonlyArray<GitCommitObject>
  commitObject: GitCommitObject
  reflog: "absent_no_create" | "existing_update"
  reflogBefore:
    | Readonly<{ state: "absent" }>
    | Readonly<{ state: "existing"; byteLength: number; contentDigest: `sha256:${string}` }>
}>

export type GitCommitInventory = GitCommitInventoryAuthority & Readonly<{ inventoryDigest: `sha256:${string}` }>

export type GitCommitPreviewAuthority = Readonly<{
  schemaVersion: 1
  operation: "git_commit_local"
  boundary: "host_no_sandbox"
  boundaryLabel: typeof gitCommitBoundaryLabel
  verification: "not_verified"
  workspaceRoot: string
  nonce: string
  createdAt: string
  expiresAt: string
  runtimeScratch: string
  baselineSnapshotDigest: `sha256:${string}`
  inventoryDigest: `sha256:${string}`
  helper: GitCommitHelperIdentity
  objectFormat: "sha1" | "sha256"
  branch: string
  ref: `refs/heads/${string}`
  expectedOldOID: string
  treeOID: string
  commitOID: string
  identity: GitCommitIdentity
  timestamp: number
  timezone: "+0000"
  message: string
  treeObjects: ReadonlyArray<Readonly<{ oid: string; byteLength: number; contentDigest: `sha256:${string}` }>>
  commitObject: Readonly<{ byteLength: number; contentDigest: `sha256:${string}` }>
  repositoryWrites: ReadonlyArray<string>
  scratchWrites: readonly [string]
  reflog: "absent_no_create" | "existing_update"
  hooks: "disabled"
  editor: "disabled"
  signing: "disabled"
  credentials: "disabled"
  network: "not_requested_host_unrestricted"
  authorizationConsumption: "durable_operation_kernel_claim_required"
  preserves: Readonly<{ index: "required"; worktree: "required"; otherRefs: "required" }>
  limitations: typeof gitCommitLimitations
}>

export type GitCommitPreview = GitCommitPreviewAuthority & Readonly<{ proposalDigest: `sha256:${string}` }>

export type GitCommitDecision = Readonly<{
  schemaVersion: 1
  operation: "git_commit_local"
  proposalDigest: `sha256:${string}`
  nonce: string
  decision: "approved" | "rejected"
  decidedAt: string
}>

export type GitCommitObservation = Readonly<{
  schemaVersion: 1
  operation: "git_commit_local"
  status: "effect_observed"
  verification: "not_verified"
  proposalDigest: `sha256:${string}`
  ref: `refs/heads/${string}`
  beforeOID: string
  afterOID: string
  objectOIDs: ReadonlyArray<string>
  limitations: typeof gitCommitLimitations
}>

export type GitCommitParseResult<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; reason: string }>

export function parseGitCommitMessage(input: unknown): GitCommitParseResult<string> {
  if (typeof input !== "string") return rejected("invalid_commit_message")
  if (Buffer.byteLength(input, "utf8") > 4096 || input.trim().length === 0 || input.includes("\r")) {
    return rejected("invalid_commit_message")
  }
  if (Buffer.from(input, "utf8").toString("utf8") !== input) return rejected("invalid_commit_message")
  for (const character of input) {
    if (character !== "\n" && /[\p{C}\p{Zl}\p{Zp}]/u.test(character)) {
      return rejected("invalid_commit_message")
    }
  }
  return accepted(input)
}

export function computeGitCommitInventoryDigest(authority: GitCommitInventoryAuthority): `sha256:${string}` {
  return digest(`astra.git-commit-inventory.v1\0${canonicalJson(authority)}`)
}

export function computeGitCommitProposalDigest(authority: GitCommitPreviewAuthority): `sha256:${string}` {
  return digest(`astra.git-commit-preview.v1\0${canonicalJson(authority)}`)
}

export function parseGitCommitInventory(input: unknown): GitCommitParseResult<GitCommitInventory> {
  const record = exact(input, [...inventoryKeys, "inventoryDigest"])
  if (!record) return rejected("invalid_inventory_shape")
  const authority = inventoryAuthority(record)
  if (!authority || !digestValue(record.inventoryDigest)) return rejected("invalid_inventory_value")
  if (record.inventoryDigest !== computeGitCommitInventoryDigest(authority)) {
    return rejected("invalid_inventory_digest")
  }
  return accepted({ ...authority, inventoryDigest: record.inventoryDigest })
}

export function parseGitCommitPreview(input: unknown): GitCommitParseResult<GitCommitPreview> {
  const record = exact(input, [...previewKeys, "proposalDigest"])
  if (!record) return rejected("invalid_preview_shape")
  const authority = previewAuthority(record)
  if (!authority || !digestValue(record.proposalDigest)) return rejected("invalid_preview_value")
  if (record.proposalDigest !== computeGitCommitProposalDigest(authority)) {
    return rejected("invalid_proposal_digest")
  }
  return accepted({ ...authority, proposalDigest: record.proposalDigest })
}

export function parseGitCommitDecision(input: unknown): GitCommitParseResult<GitCommitDecision> {
  const record = exact(input, ["schemaVersion", "operation", "proposalDigest", "nonce", "decision", "decidedAt"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.operation !== "git_commit_local" ||
    !digestValue(record.proposalDigest) ||
    !uuid(record.nonce) ||
    (record.decision !== "approved" && record.decision !== "rejected") ||
    !timestamp(record.decidedAt)
  ) {
    return rejected("invalid_decision")
  }
  return accepted({
    schemaVersion: 1,
    operation: "git_commit_local",
    proposalDigest: record.proposalDigest,
    nonce: record.nonce,
    decision: record.decision,
    decidedAt: record.decidedAt,
  })
}

export function parseGitCommitObservation(input: unknown): GitCommitParseResult<GitCommitObservation> {
  const record = exact(input, [
    "schemaVersion",
    "operation",
    "status",
    "verification",
    "proposalDigest",
    "ref",
    "beforeOID",
    "afterOID",
    "objectOIDs",
    "limitations",
  ])
  const objectOIDs = record ? stringList(record.objectOIDs, objectID) : null
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.operation !== "git_commit_local" ||
    record.status !== "effect_observed" ||
    record.verification !== "not_verified" ||
    !digestValue(record.proposalDigest) ||
    !refName(record.ref) ||
    !objectID(record.beforeOID) ||
    !objectID(record.afterOID) ||
    !objectOIDs ||
    !sameStrings(record.limitations, gitCommitLimitations)
  ) {
    return rejected("invalid_observation")
  }
  return accepted({
    schemaVersion: 1,
    operation: "git_commit_local",
    status: "effect_observed",
    verification: "not_verified",
    proposalDigest: record.proposalDigest,
    ref: record.ref,
    beforeOID: record.beforeOID,
    afterOID: record.afterOID,
    objectOIDs,
    limitations: gitCommitLimitations,
  })
}

const inventoryKeys = [
  "schemaVersion",
  "workspaceRoot",
  "baselineSnapshotDigest",
  "helper",
  "objectFormat",
  "ref",
  "expectedOldOID",
  "indexDigest",
  "worktreeDigest",
  "refsDigest",
  "otherRefsDigest",
  "indexEntries",
  "identity",
  "timestamp",
  "timezone",
  "message",
  "treeOID",
  "commitOID",
  "treeObjects",
  "commitObject",
  "reflog",
  "reflogBefore",
] as const

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
  "baselineSnapshotDigest",
  "inventoryDigest",
  "helper",
  "objectFormat",
  "branch",
  "ref",
  "expectedOldOID",
  "treeOID",
  "commitOID",
  "identity",
  "timestamp",
  "timezone",
  "message",
  "treeObjects",
  "commitObject",
  "repositoryWrites",
  "scratchWrites",
  "reflog",
  "hooks",
  "editor",
  "signing",
  "credentials",
  "network",
  "authorizationConsumption",
  "preserves",
  "limitations",
] as const

function inventoryAuthority(input: Readonly<Record<string, unknown>>): GitCommitInventoryAuthority | null {
  const message = parseGitCommitMessage(input.message)
  const identity = parseIdentity(input.identity)
  const entries = parseIndexEntries(input.indexEntries, input.objectFormat)
  const trees = parseObjects(input.treeObjects, input.objectFormat, true)
  const commit = parseObject(input.commitObject, input.objectFormat, true)
  const reflogBefore = parseReflogBefore(input.reflogBefore)
  const helper = parseHelperIdentity(input.helper)
  if (
    input.schemaVersion !== 1 ||
    typeof input.workspaceRoot !== "string" ||
    !isAbsolute(input.workspaceRoot) ||
    !digestValue(input.baselineSnapshotDigest) ||
    !helper ||
    (input.objectFormat !== "sha1" && input.objectFormat !== "sha256") ||
    !refName(input.ref) ||
    !objectIDFor(input.expectedOldOID, input.objectFormat) ||
    !digestValue(input.indexDigest) ||
    !digestValue(input.worktreeDigest) ||
    !digestValue(input.refsDigest) ||
    !digestValue(input.otherRefsDigest) ||
    !entries ||
    !identity ||
    !positiveInteger(input.timestamp) ||
    input.timezone !== "+0000" ||
    !message.ok ||
    !objectIDFor(input.treeOID, input.objectFormat) ||
    !objectIDFor(input.commitOID, input.objectFormat) ||
    !trees ||
    !commit ||
    !reflogBefore ||
    commit.oid !== input.commitOID ||
    !trees.some((tree) => tree.oid === input.treeOID) ||
    (input.reflog !== "absent_no_create" && input.reflog !== "existing_update") ||
    (input.reflog === "absent_no_create" && reflogBefore.state !== "absent") ||
    (input.reflog === "existing_update" && reflogBefore.state !== "existing")
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    workspaceRoot: input.workspaceRoot,
    baselineSnapshotDigest: input.baselineSnapshotDigest,
    helper,
    objectFormat: input.objectFormat,
    ref: input.ref,
    expectedOldOID: input.expectedOldOID,
    indexDigest: input.indexDigest,
    worktreeDigest: input.worktreeDigest,
    refsDigest: input.refsDigest,
    otherRefsDigest: input.otherRefsDigest,
    indexEntries: entries,
    identity,
    timestamp: input.timestamp,
    timezone: "+0000",
    message: message.value,
    treeOID: input.treeOID,
    commitOID: input.commitOID,
    treeObjects: trees,
    commitObject: commit,
    reflog: input.reflog,
    reflogBefore,
  }
}

function previewAuthority(input: Readonly<Record<string, unknown>>): GitCommitPreviewAuthority | null {
  const message = parseGitCommitMessage(input.message)
  const identity = parseIdentity(input.identity)
  const trees = parseObjects(input.treeObjects, input.objectFormat, false)
  const commit = parseObjectSummary(input.commitObject)
  const preserves = exact(input.preserves, ["index", "worktree", "otherRefs"])
  const writes = stringList(input.repositoryWrites, safeRelativeResource)
  const scratch = stringList(
    input.scratchWrites,
    (value): value is string => typeof value === "string" && isAbsolute(value),
  )
  const helper = parseHelperIdentity(input.helper)
  if (
    input.schemaVersion !== 1 ||
    input.operation !== "git_commit_local" ||
    input.boundary !== "host_no_sandbox" ||
    input.boundaryLabel !== gitCommitBoundaryLabel ||
    input.verification !== "not_verified" ||
    typeof input.workspaceRoot !== "string" ||
    !isAbsolute(input.workspaceRoot) ||
    !uuid(input.nonce) ||
    !timestamp(input.createdAt) ||
    !timestamp(input.expiresAt) ||
    Date.parse(input.expiresAt) <= Date.parse(input.createdAt) ||
    input.runtimeScratch !== join("/private/tmp", `astra-git-commit-${input.nonce}`) ||
    !digestValue(input.baselineSnapshotDigest) ||
    !digestValue(input.inventoryDigest) ||
    !helper ||
    (input.objectFormat !== "sha1" && input.objectFormat !== "sha256") ||
    typeof input.branch !== "string" ||
    input.branch.length === 0 ||
    input.ref !== `refs/heads/${input.branch}` ||
    !refName(input.ref) ||
    !objectIDFor(input.expectedOldOID, input.objectFormat) ||
    !objectIDFor(input.treeOID, input.objectFormat) ||
    !objectIDFor(input.commitOID, input.objectFormat) ||
    !identity ||
    !positiveInteger(input.timestamp) ||
    input.timezone !== "+0000" ||
    !message.ok ||
    !trees ||
    !commit ||
    !writes ||
    !scratch ||
    scratch.length !== 1 ||
    scratch[0] !== input.runtimeScratch ||
    (input.reflog !== "absent_no_create" && input.reflog !== "existing_update") ||
    input.hooks !== "disabled" ||
    input.editor !== "disabled" ||
    input.signing !== "disabled" ||
    input.credentials !== "disabled" ||
    input.network !== "not_requested_host_unrestricted" ||
    input.authorizationConsumption !== "durable_operation_kernel_claim_required" ||
    !preserves ||
    preserves.index !== "required" ||
    preserves.worktree !== "required" ||
    preserves.otherRefs !== "required" ||
    !sameStrings(input.limitations, gitCommitLimitations)
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    operation: "git_commit_local",
    boundary: "host_no_sandbox",
    boundaryLabel: gitCommitBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: input.workspaceRoot,
    nonce: input.nonce,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    runtimeScratch: input.runtimeScratch,
    baselineSnapshotDigest: input.baselineSnapshotDigest,
    inventoryDigest: input.inventoryDigest,
    helper,
    objectFormat: input.objectFormat,
    branch: input.branch,
    ref: input.ref,
    expectedOldOID: input.expectedOldOID,
    treeOID: input.treeOID,
    commitOID: input.commitOID,
    identity,
    timestamp: input.timestamp,
    timezone: "+0000",
    message: message.value,
    treeObjects: trees.map(({ oid, byteLength, contentDigest }) => ({ oid, byteLength, contentDigest })),
    commitObject: commit,
    repositoryWrites: writes,
    scratchWrites: [scratch[0]],
    reflog: input.reflog,
    hooks: "disabled",
    editor: "disabled",
    signing: "disabled",
    credentials: "disabled",
    network: "not_requested_host_unrestricted",
    authorizationConsumption: "durable_operation_kernel_claim_required",
    preserves: { index: "required", worktree: "required", otherRefs: "required" },
    limitations: gitCommitLimitations,
  }
}

function parseHelperIdentity(input: unknown): GitCommitHelperIdentity | null {
  const record = exact(input, ["canonicalPath", "device", "inode", "byteLength", "contentDigest"])
  if (
    !record ||
    typeof record.canonicalPath !== "string" ||
    !isAbsolute(record.canonicalPath) ||
    typeof record.device !== "string" ||
    !/^[0-9]+$/u.test(record.device) ||
    typeof record.inode !== "string" ||
    !/^[0-9]+$/u.test(record.inode) ||
    !positiveInteger(record.byteLength) ||
    !digestValue(record.contentDigest)
  ) {
    return null
  }
  return {
    canonicalPath: record.canonicalPath,
    device: record.device,
    inode: record.inode,
    byteLength: record.byteLength,
    contentDigest: record.contentDigest,
  }
}

function parseIdentity(input: unknown): GitCommitIdentity | null {
  const record = exact(input, ["name", "email"])
  if (!record || !printableIdentity(record.name) || !printableIdentity(record.email)) return null
  if (!record.email.includes("@")) return null
  return { name: record.name, email: record.email }
}

function printableIdentity(input: unknown): input is string {
  return (
    typeof input === "string" &&
    Buffer.byteLength(input) <= 256 &&
    input.trim() === input &&
    input.length > 0 &&
    !/[\x00-\x1f\x7f<>\n\r]/u.test(input)
  )
}

function parseIndexEntries(input: unknown, format: unknown): ReadonlyArray<GitCommitIndexEntry> | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 25_000) return null
  const result: Array<GitCommitIndexEntry> = []
  for (const item of input) {
    const record = exact(item, ["mode", "oid", "path"])
    if (
      !record ||
      (record.mode !== "100644" && record.mode !== "100755") ||
      !objectIDFor(record.oid, format) ||
      !safeGitPath(record.path)
    ) {
      return null
    }
    result.push({ mode: record.mode, oid: record.oid, path: record.path })
  }
  if (new Set(result.map((entry) => entry.path)).size !== result.length) return null
  if ([...result].sort(comparePath).some((entry, index) => entry.path !== result[index]?.path)) return null
  return result
}

function parseObjects(input: unknown, format: unknown, requireBytes: boolean) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 25_001) return null
  const values = input.map((item) => parseObject(item, format, requireBytes))
  if (values.some((item) => item === null)) return null
  const objects = values.filter((item): item is GitCommitObject => item !== null)
  if (new Set(objects.map((item) => item.oid)).size !== objects.length) return null
  return objects
}

function parseObject(input: unknown, format: unknown, requireBytes: boolean): GitCommitObject | null {
  const keys = requireBytes
    ? ["oid", "byteLength", "contentDigest", "contentBase64"]
    : ["oid", "byteLength", "contentDigest"]
  const record = exact(input, keys)
  if (
    !record ||
    !objectIDFor(record.oid, format) ||
    !boundedByteLength(record.byteLength) ||
    !digestValue(record.contentDigest) ||
    (requireBytes && typeof record.contentBase64 !== "string")
  ) {
    return null
  }
  const contentBase64 = requireBytes && typeof record.contentBase64 === "string" ? record.contentBase64 : ""
  if (requireBytes) {
    if (contentBase64.length > 24 * 1024 * 1024) return null
    const bytes = Buffer.from(contentBase64, "base64")
    if (bytes.byteLength !== record.byteLength || bytes.toString("base64") !== contentBase64) return null
    if (digestBytes(bytes) !== record.contentDigest) return null
  }
  return {
    oid: record.oid,
    byteLength: record.byteLength,
    contentDigest: record.contentDigest,
    contentBase64,
  }
}

function parseObjectSummary(
  input: unknown,
): Readonly<{ byteLength: number; contentDigest: `sha256:${string}` }> | null {
  const record = exact(input, ["byteLength", "contentDigest"])
  if (!record || !boundedByteLength(record.byteLength) || !digestValue(record.contentDigest)) {
    return null
  }
  return { byteLength: record.byteLength, contentDigest: record.contentDigest }
}

function parseReflogBefore(input: unknown): GitCommitInventoryAuthority["reflogBefore"] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(input))
  if (record.state === "absent" && Object.keys(record).length === 1) return { state: "absent" }
  if (
    record.state !== "existing" ||
    Object.keys(record).sort().join("\0") !== "byteLength\0contentDigest\0state" ||
    !boundedByteLength(record.byteLength) ||
    !digestValue(record.contentDigest)
  ) {
    return null
  }
  return { state: "existing", byteLength: record.byteLength, contentDigest: record.contentDigest }
}

function safeGitPath(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0 || Buffer.byteLength(input) > 4096) return false
  if (input.startsWith("/") || input.endsWith("/") || input.includes("\0")) return false
  const segments = input.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment !== ".git")
}

function safeRelativeResource(input: unknown): input is string {
  return typeof input === "string" && input.startsWith(".git/") && !input.includes("..") && !input.includes("\0")
}

function objectID(input: unknown): input is string {
  return typeof input === "string" && (/^[0-9a-f]{40}$/u.test(input) || /^[0-9a-f]{64}$/u.test(input))
}

function objectIDFor(input: unknown, format: unknown): input is string {
  return typeof input === "string" && new RegExp(`^[0-9a-f]{${format === "sha256" ? 64 : 40}}$`, "u").test(input)
}

function refName(input: unknown): input is `refs/heads/${string}` {
  return (
    typeof input === "string" &&
    input.startsWith("refs/heads/") &&
    input.length <= 1024 &&
    !input.includes("..") &&
    !input.includes("@{") &&
    !hasForbiddenRefCharacter(input) &&
    !input.endsWith("/") &&
    !input.endsWith(".") &&
    !input.endsWith(".lock")
  )
}

function digestValue(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input)
}

function uuid(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)
  )
}

function timestamp(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input
}

function exact(input: unknown, keys: ReadonlyArray<string>): Readonly<Record<string, unknown>> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(input))
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]) ? record : null
}

function positiveInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && typeof input === "number" && input > 0
}

function boundedByteLength(input: unknown): input is number {
  return Number.isSafeInteger(input) && typeof input === "number" && input >= 0 && input <= 16 * 1024 * 1024
}

function hasForbiddenRefCharacter(input: string) {
  for (const character of input) {
    const code = character.codePointAt(0)!
    if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character)) return true
  }
  return false
}

function stringList(input: unknown, validator: (value: unknown) => value is string): ReadonlyArray<string> | null {
  if (!Array.isArray(input) || !input.every(validator)) return null
  return [...input]
}

function sameStrings(input: unknown, expected: ReadonlyArray<string>) {
  return (
    Array.isArray(input) && input.length === expected.length && input.every((value, index) => value === expected[index])
  )
}

function comparePath(left: GitCommitIndexEntry, right: GitCommitIndexEntry) {
  return Buffer.from(left.path).compare(Buffer.from(right.path))
}

function accepted<Value>(value: Value): GitCommitParseResult<Value> {
  return { ok: true, value }
}

function rejected(reason: string): GitCommitParseResult<never> {
  return { ok: false, reason }
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function digestBytes(input: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
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
