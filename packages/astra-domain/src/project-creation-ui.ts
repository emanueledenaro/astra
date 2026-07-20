import {
  parseBoundedString,
  parseExactRecord,
  parseNonNegativeInteger,
  parseNormalizedJsonArray,
} from "./operation-contract-validation"

export const astraProjectCreationBoundary = "HOST EXECUTION — NO SANDBOX" as const
export const astraProjectCreationStack = "typescript-bun" as const

export type AstraProjectCreationRequest = Readonly<{
  name: string
  parentPath: string
  objective: string
  stack: typeof astraProjectCreationStack
}>

export type AstraProjectCreationDetailsDecision =
  | Readonly<{ kind: "submit"; request: AstraProjectCreationRequest }>
  | Readonly<{ kind: "cancel" }>

export type AstraProjectCreationProposalFile = Readonly<{
  path: string
  bytes: number
  contentDigest: `sha256:${string}`
}>

export type AstraProjectCreationProposal = Readonly<{
  schemaVersion: 1
  boundary: typeof astraProjectCreationBoundary
  targetPath: string
  targetName: string
  objective: string
  stack: typeof astraProjectCreationStack
  files: ReadonlyArray<AstraProjectCreationProposalFile>
  totalBytes: number
  initializeGit: false
  installsDependencies: false
  usesNetwork: false
  proposalDigest: `sha256:${string}`
}>

export type AstraProjectCreationReviewDecision =
  | Readonly<{ kind: "approve" | "reject"; proposalDigest: `sha256:${string}` }>
  | Readonly<{ kind: "cancel" }>

export type AstraProjectCreationResultStatus =
  | "denied_without_effect"
  | "effect_observed"
  | "failed_without_effect"
  | "reconciliation_required"
  | "verified"

export type AstraProjectCreationResult = Readonly<{
  schemaVersion: 1
  status: AstraProjectCreationResultStatus
  targetPath: string
  operationID: string | null
  receiptID: string | null
  evidenceID: string | null
  detail: string
}>

export type AstraProjectCreationResultDecision =
  | Readonly<{ kind: "open-project"; targetPath: string }>
  | Readonly<{ kind: "launchpad" }>
  | Readonly<{ kind: "exit" }>

export type AstraProjectCreationUiParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_project_creation_ui" }>

export function parseAstraProjectCreationDetailsDecision(
  input: unknown,
): AstraProjectCreationUiParseResult<AstraProjectCreationDetailsDecision> {
  const record = broad(input, ["kind", "request"])
  if (!record) return invalid()
  if (record.kind === "cancel") {
    if (!exact(input, ["kind"])) return invalid()
    return valid({ kind: "cancel" })
  }
  const submitted = exact(input, ["kind", "request"])
  if (record.kind !== "submit" || !submitted) return invalid()
  const request = parseRequest(submitted.request)
  if (!request) return invalid()
  return valid({ kind: "submit", request })
}

export function parseAstraProjectCreationProposal(
  input: unknown,
): AstraProjectCreationUiParseResult<AstraProjectCreationProposal> {
  const record = exact(input, [
    "schemaVersion",
    "boundary",
    "targetPath",
    "targetName",
    "objective",
    "stack",
    "files",
    "totalBytes",
    "initializeGit",
    "installsDependencies",
    "usesNetwork",
    "proposalDigest",
  ])
  if (!record || record.schemaVersion !== 1 || record.boundary !== astraProjectCreationBoundary) return invalid()
  const targetName = projectName(record.targetName)
  const targetPath = absolutePath(record.targetPath)
  const objective = boundedSafeText(record.objective, 4_096)
  if (
    !targetName ||
    !targetPath ||
    !targetPath.endsWith(`/${targetName}`) ||
    !objective ||
    record.stack !== astraProjectCreationStack ||
    record.initializeGit !== false ||
    record.installsDependencies !== false ||
    record.usesNetwork !== false ||
    !digest(record.proposalDigest)
  ) {
    return invalid()
  }
  const array = parseNormalizedJsonArray(record.files, "$.files")
  if (!array.ok || array.value.length === 0 || array.value.length > 32) return invalid()
  const files: Array<AstraProjectCreationProposalFile> = []
  const paths = new Set<string>()
  for (const item of array.value) {
    const file = exact(item, ["path", "bytes", "contentDigest"])
    if (!file) return invalid()
    const path = relativeFilePath(file.path)
    const bytes = parseNonNegativeInteger(file.bytes, "$.files.bytes")
    if (!path || paths.has(path) || !bytes.ok || bytes.value > 65_536 || !digest(file.contentDigest)) {
      return invalid()
    }
    paths.add(path)
    files.push({ path, bytes: bytes.value, contentDigest: file.contentDigest })
  }
  const totalBytes = parseNonNegativeInteger(record.totalBytes, "$.totalBytes")
  if (!totalBytes.ok || totalBytes.value !== files.reduce((total, file) => total + file.bytes, 0)) return invalid()
  return valid({
    schemaVersion: 1,
    boundary: astraProjectCreationBoundary,
    targetPath,
    targetName,
    objective,
    stack: astraProjectCreationStack,
    files,
    totalBytes: totalBytes.value,
    initializeGit: false,
    installsDependencies: false,
    usesNetwork: false,
    proposalDigest: record.proposalDigest,
  })
}

export function parseAstraProjectCreationReviewDecision(
  input: unknown,
): AstraProjectCreationUiParseResult<AstraProjectCreationReviewDecision> {
  const record = broad(input, ["kind", "proposalDigest"])
  if (!record) return invalid()
  if (record.kind === "cancel") {
    if (!exact(input, ["kind"])) return invalid()
    return valid({ kind: "cancel" })
  }
  const decided = exact(input, ["kind", "proposalDigest"])
  if (!decided || (record.kind !== "approve" && record.kind !== "reject") || !digest(decided.proposalDigest)) {
    return invalid()
  }
  return valid({ kind: record.kind, proposalDigest: decided.proposalDigest })
}

export function parseAstraProjectCreationResult(
  input: unknown,
): AstraProjectCreationUiParseResult<AstraProjectCreationResult> {
  const record = exact(input, [
    "schemaVersion",
    "status",
    "targetPath",
    "operationID",
    "receiptID",
    "evidenceID",
    "detail",
  ])
  if (!record || record.schemaVersion !== 1 || !resultStatus(record.status)) return invalid()
  const targetPath = absolutePath(record.targetPath)
  const detail = boundedSafeText(record.detail, 2_048)
  const operationID = nullableID(record.operationID)
  const receiptID = nullableID(record.receiptID)
  const evidenceID = nullableID(record.evidenceID)
  if (!targetPath || !detail || operationID === undefined || receiptID === undefined || evidenceID === undefined) {
    return invalid()
  }
  if (record.status === "verified" && (!operationID || !receiptID || !evidenceID)) return invalid()
  return valid({
    schemaVersion: 1,
    status: record.status,
    targetPath,
    operationID,
    receiptID,
    evidenceID,
    detail,
  })
}

export function parseAstraProjectCreationResultDecision(
  input: unknown,
  resultInput: unknown,
): AstraProjectCreationUiParseResult<AstraProjectCreationResultDecision> {
  const result = parseAstraProjectCreationResult(resultInput)
  if (!result.ok) return invalid()
  const record = broad(input, ["kind", "targetPath"])
  if (!record) return invalid()
  if (record.kind === "launchpad" || record.kind === "exit") {
    if (!exact(input, ["kind"])) return invalid()
    return valid({ kind: record.kind })
  }
  const open = exact(input, ["kind", "targetPath"])
  if (
    !open ||
    record.kind !== "open-project" ||
    result.value.status !== "verified" ||
    open.targetPath !== result.value.targetPath
  ) {
    return invalid()
  }
  return valid({ kind: "open-project", targetPath: result.value.targetPath })
}

function parseRequest(input: unknown): AstraProjectCreationRequest | null {
  const record = exact(input, ["name", "parentPath", "objective", "stack"])
  if (!record) return null
  const name = projectName(record.name)
  const parentPath = absolutePath(record.parentPath)
  const objective = boundedSafeText(record.objective, 4_096)
  if (!name || !parentPath || !objective || record.stack !== astraProjectCreationStack) return null
  return { name, parentPath, objective, stack: astraProjectCreationStack }
}

function exact(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  if (!parsed.ok || fields.some((field) => !Object.hasOwn(parsed.value, field))) return null
  return parsed.value
}

function broad(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  return parsed.ok ? parsed.value : null
}

function projectName(input: unknown) {
  const parsed = parseBoundedString(input, "$.name", 80)
  if (!parsed.ok || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(parsed.value)) return null
  return parsed.value
}

function absolutePath(input: unknown) {
  const parsed = parseBoundedString(input, "$.path", 4_096)
  if (
    !parsed.ok ||
    !parsed.value.startsWith("/") ||
    parsed.value.includes("//") ||
    (parsed.value !== "/" && parsed.value.endsWith("/"))
  ) {
    return null
  }
  return parsed.value
}

function relativeFilePath(input: unknown) {
  const parsed = parseBoundedString(input, "$.file.path", 1_024)
  if (
    !parsed.ok ||
    parsed.value.startsWith("/") ||
    parsed.value.includes("\\") ||
    parsed.value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null
  }
  return parsed.value
}

function boundedSafeText(input: unknown, maximumLength: number) {
  return parseBoundedString(input, "$.text", maximumLength).ok ? (input as string) : null
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[a-f0-9]{64}$/.test(input)
}

function nullableID(input: unknown) {
  if (input === null) return null
  if (typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)) {
    return input
  }
  return undefined
}

function resultStatus(input: unknown): input is AstraProjectCreationResultStatus {
  return (
    input === "denied_without_effect" ||
    input === "effect_observed" ||
    input === "failed_without_effect" ||
    input === "reconciliation_required" ||
    input === "verified"
  )
}

function valid<Value>(value: Value): AstraProjectCreationUiParseResult<Value> {
  return { ok: true, value }
}

function invalid(): AstraProjectCreationUiParseResult<never> {
  return { ok: false, reason: "invalid_project_creation_ui" }
}
