import { createHash } from "node:crypto"
import { isAbsolute, join, normalize } from "node:path"
import { parseWorkspaceBaseline, type WorkspaceBaseline } from "./operation-contract"

export const projectCreationLimits = Object.freeze({
  maxTargetNameBytes: 80,
  maxObjectiveBytes: 4_096,
  maxFiles: 32,
  maxFileBytes: 64 * 1_024,
  maxTotalBytes: 256 * 1_024,
  maxPathSegments: 8,
})

export type ProjectCreationLimits = typeof projectCreationLimits

export type ProjectCreationTextFile = Readonly<{
  path: string
  content: string
}>

export type ProjectCreationDraft = Readonly<{
  name: string
  parentPath: string
  objective: string
  stack: string
  files: ReadonlyArray<ProjectCreationTextFile>
  initializeGit: boolean
}>

export type ProjectParentAuthority = Readonly<{
  schemaVersion: 1
  parentPath: string
  parentIdentity: Readonly<{ device: string; inode: string }>
  targetPath: string
  targetName: string
  targetState: "absent"
  observationDigest: `sha256:${string}`
  observedAt: string
  limits: ProjectCreationLimits
}>

export type ProjectParentAuthorityInput = Omit<ProjectParentAuthority, "observationDigest">

export type ProjectCreationControlReason =
  | "accessor_not_allowed"
  | "unsupported_draft_field"
  | "unsupported_file_field"
  | "draft_not_object"
  | "name_invalid"
  | "parent_path_not_absolute"
  | "parent_path_not_canonical"
  | "objective_invalid"
  | "objective_too_large"
  | "stack_invalid"
  | "files_not_array"
  | "too_many_files"
  | "file_not_object"
  | "file_path_not_relative"
  | "file_path_traversal"
  | "file_path_too_deep"
  | "file_path_invalid"
  | "duplicate_file_path"
  | "file_content_not_text"
  | "file_too_large"
  | "total_files_too_large"
  | "initialize_git_invalid"
  | "authority_not_object"
  | "unsupported_authority_field"
  | "schema_unsupported"
  | "parent_identity_invalid"
  | "target_path_mismatch"
  | "target_state_not_absent"
  | "observed_at_invalid"
  | "limits_changed"
  | "observation_digest_invalid"
  | "observation_digest_mismatch"

export type ProjectCreationControlResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: ProjectCreationControlReason }>

const draftKeys = ["name", "parentPath", "objective", "stack", "files", "initializeGit"] as const
const fileKeys = ["path", "content"] as const
const authorityInputKeys = [
  "schemaVersion",
  "parentPath",
  "parentIdentity",
  "targetPath",
  "targetName",
  "targetState",
  "observedAt",
  "limits",
] as const
const authorityKeys = [...authorityInputKeys, "observationDigest"] as const

export function parseProjectCreationDraft(input: unknown): ProjectCreationControlResult<ProjectCreationDraft> {
  const record = readDataRecord(input)
  if (!record.ok) return failure(record.reason === "not_object" ? "draft_not_object" : record.reason)
  if (!exactKeys(record.value, draftKeys)) return failure("unsupported_draft_field")

  const name = parseProjectCreationTargetName(record.value.name)
  if (!name.ok) return failure("name_invalid")
  const parentPath = parseCanonicalAbsolutePath(record.value.parentPath)
  if (!parentPath.ok) return parentPath
  if (typeof record.value.objective !== "string" || record.value.objective.length === 0) {
    return failure("objective_invalid")
  }
  if (!safeText(record.value.objective)) return failure("objective_invalid")
  if (Buffer.byteLength(record.value.objective, "utf8") > projectCreationLimits.maxObjectiveBytes) {
    return failure("objective_too_large")
  }
  if (
    typeof record.value.stack !== "string" ||
    Buffer.byteLength(record.value.stack, "utf8") > 64 ||
    !/^[a-z0-9][a-z0-9._+-]*$/.test(record.value.stack)
  ) {
    return failure("stack_invalid")
  }
  const files = readDataArray(record.value.files)
  if (!files.ok) return failure(files.reason === "accessor_not_allowed" ? files.reason : "files_not_array")
  if (files.value.length > projectCreationLimits.maxFiles) return failure("too_many_files")

  const paths = new Set<string>()
  let totalBytes = 0
  const parsedFiles: Array<ProjectCreationTextFile> = []
  for (const fileInput of files.value) {
    const file = readDataRecord(fileInput)
    if (!file.ok) return failure(file.reason === "not_object" ? "file_not_object" : file.reason)
    if (!exactKeys(file.value, fileKeys)) return failure("unsupported_file_field")
    const path = parseRelativeFilePath(file.value.path)
    if (!path.ok) return path
    if (paths.has(path.value)) return failure("duplicate_file_path")
    if (typeof file.value.content !== "string" || !safeText(file.value.content)) {
      return failure("file_content_not_text")
    }
    const bytes = Buffer.byteLength(file.value.content, "utf8")
    if (bytes > projectCreationLimits.maxFileBytes) return failure("file_too_large")
    totalBytes += bytes
    if (totalBytes > projectCreationLimits.maxTotalBytes) return failure("total_files_too_large")
    paths.add(path.value)
    parsedFiles.push(Object.freeze({ path: path.value, content: file.value.content }))
  }

  if (typeof record.value.initializeGit !== "boolean") return failure("initialize_git_invalid")
  return success(
    Object.freeze({
      name: name.value,
      parentPath: parentPath.value,
      objective: record.value.objective,
      stack: record.value.stack,
      files: Object.freeze(parsedFiles),
      initializeGit: record.value.initializeGit,
    }),
  )
}

export function parseProjectCreationTargetName(input: unknown): ProjectCreationControlResult<string> {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input === "." ||
    input === ".." ||
    input !== input.normalize("NFC") ||
    input.trim() !== input ||
    input.includes("/") ||
    input.includes("\\") ||
    !safeText(input) ||
    Buffer.byteLength(input, "utf8") > projectCreationLimits.maxTargetNameBytes
  ) {
    return failure("name_invalid")
  }
  return success(input)
}

export function sealProjectParentAuthority(
  input: unknown,
): ProjectCreationControlResult<ProjectParentAuthority> {
  const parsed = parseProjectParentAuthorityInput(input)
  if (!parsed.ok) return parsed
  const observationDigest = computeProjectParentObservationDigest(parsed.value)
  return success(Object.freeze({ ...parsed.value, observationDigest }))
}

export function parseProjectParentAuthority(
  input: unknown,
): ProjectCreationControlResult<ProjectParentAuthority> {
  const record = readDataRecord(input)
  if (!record.ok) return failure(record.reason === "not_object" ? "authority_not_object" : record.reason)
  if (!exactKeys(record.value, authorityKeys)) return failure("unsupported_authority_field")
  const parsed = parseProjectParentAuthorityInput(
    Object.fromEntries(authorityInputKeys.map((key) => [key, record.value[key]])),
  )
  if (!parsed.ok) return parsed
  if (
    typeof record.value.observationDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.value.observationDigest)
  ) {
    return failure("observation_digest_invalid")
  }
  if (record.value.observationDigest !== computeProjectParentObservationDigest(parsed.value)) {
    return failure("observation_digest_mismatch")
  }
  return success(Object.freeze({ ...parsed.value, observationDigest: record.value.observationDigest }))
}

/**
 * Projects the existing parent into the ledger's existing workspace-shaped authority envelope.
 * The `non_git` member is an authority marker, not a claim that the parent was inspected as a repository.
 */
export function makeProjectCreationWorkspaceBaseline(
  authorityInput: unknown,
  draftInput: unknown,
): WorkspaceBaseline {
  const authority = parseProjectParentAuthority(authorityInput)
  if (!authority.ok) throw new TypeError(`Invalid project-parent authority: ${authority.reason}`)
  const draft = parseProjectCreationDraft(draftInput)
  if (!draft.ok) throw new TypeError(`Invalid project creation draft: ${draft.reason}`)
  if (
    draft.value.parentPath !== authority.value.parentPath ||
    draft.value.name !== authority.value.targetName ||
    join(draft.value.parentPath, draft.value.name) !== authority.value.targetPath
  ) {
    throw new TypeError("The project draft does not match its parent authority")
  }

  const material = { authority: authority.value, draft: draft.value }
  const baseline = {
    kind: "workspace",
    locationID: projectParentAuthorityLocationID(authority.value.parentPath),
    workspaceIdentity: authority.value.parentIdentity,
    trustDigest: digest("astra.project-parent.trust.v1", material),
    repository: { kind: "non_git", markerDigest: digest("astra.project-parent.non-git-envelope.v1", material) },
    policyDigest: digest("astra.project-parent.policy.v1", material),
    adapterDigest: digest("astra.project-parent.adapter.v1", material),
  }
  const parsed = parseWorkspaceBaseline(baseline)
  if (!parsed.ok) throw new TypeError(`Invalid project-parent ledger baseline: ${parsed.issue.reason}`)
  return deepFreeze(parsed.value)
}

export function computeProjectParentObservationDigest(
  input: ProjectParentAuthorityInput,
): `sha256:${string}` {
  return digest("astra.project-parent.observation.v1", input)
}

function parseProjectParentAuthorityInput(
  input: unknown,
): ProjectCreationControlResult<ProjectParentAuthorityInput> {
  const record = readDataRecord(input)
  if (!record.ok) return failure(record.reason === "not_object" ? "authority_not_object" : record.reason)
  if (!exactKeys(record.value, authorityInputKeys)) return failure("unsupported_authority_field")
  if (record.value.schemaVersion !== 1) return failure("schema_unsupported")
  const parentPath = parseCanonicalAbsolutePath(record.value.parentPath)
  if (!parentPath.ok) return parentPath
  const identity = readDataRecord(record.value.parentIdentity)
  if (
    !identity.ok ||
    !exactKeys(identity.value, ["device", "inode"]) ||
    !decimalIdentity(identity.value.device) ||
    !decimalIdentity(identity.value.inode)
  ) {
    return failure(identity.ok || identity.reason === "not_object" ? "parent_identity_invalid" : identity.reason)
  }
  const targetName = parseProjectCreationTargetName(record.value.targetName)
  if (!targetName.ok) return failure("name_invalid")
  if (record.value.targetPath !== join(parentPath.value, targetName.value)) return failure("target_path_mismatch")
  if (record.value.targetState !== "absent") return failure("target_state_not_absent")
  if (!canonicalTimestamp(record.value.observedAt)) return failure("observed_at_invalid")
  if (!fixedLimits(record.value.limits)) return failure("limits_changed")
  return success(
    Object.freeze({
      schemaVersion: 1,
      parentPath: parentPath.value,
      parentIdentity: Object.freeze({ device: identity.value.device, inode: identity.value.inode }),
      targetPath: record.value.targetPath,
      targetName: targetName.value,
      targetState: "absent",
      observedAt: record.value.observedAt,
      limits: projectCreationLimits,
    }),
  )
}

function parseCanonicalAbsolutePath(input: unknown): ProjectCreationControlResult<string> {
  if (typeof input !== "string" || !isAbsolute(input)) return failure("parent_path_not_absolute")
  if (!safeText(input) || normalize(input) !== input) return failure("parent_path_not_canonical")
  return success(input)
}

function parseRelativeFilePath(input: unknown): ProjectCreationControlResult<string> {
  if (typeof input !== "string" || input.length === 0) return failure("file_path_invalid")
  if (isAbsolute(input) || input.startsWith("\\") || /^[a-zA-Z]:/.test(input)) {
    return failure("file_path_not_relative")
  }
  if (input.includes("\\") || !safeText(input) || input !== input.normalize("NFC")) {
    return failure("file_path_invalid")
  }
  const segments = input.split("/")
  if (segments.some((segment) => segment === "." || segment === "..")) return failure("file_path_traversal")
  if (segments.some((segment) => segment.length === 0)) return failure("file_path_invalid")
  if (segments.length > projectCreationLimits.maxPathSegments) return failure("file_path_too_deep")
  if (Buffer.byteLength(input, "utf8") > 1_024) return failure("file_path_invalid")
  return success(input)
}

function safeText(input: string) {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input) && !/[\ud800-\udfff]/u.test(input)
}

function canonicalTimestamp(input: unknown): input is string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function decimalIdentity(input: unknown): input is string {
  return typeof input === "string" && /^(?:0|[1-9][0-9]*)$/.test(input) && input.length <= 32
}

function fixedLimits(input: unknown): input is ProjectCreationLimits {
  const record = readDataRecord(input)
  return (
    record.ok &&
    exactKeys(record.value, Object.keys(projectCreationLimits)) &&
    canonicalJson(record.value) === canonicalJson(projectCreationLimits)
  )
}

function readDataRecord(
  input: unknown,
):
  | Readonly<{ ok: true; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; reason: "not_object" | "accessor_not_allowed" }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "not_object" }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return { ok: false, reason: "not_object" }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) return { ok: false, reason: "not_object" }
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    return { ok: false, reason: "accessor_not_allowed" }
  }
  return {
    ok: true,
    value: Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])),
  }
}

function readDataArray(
  input: unknown,
):
  | Readonly<{ ok: true; value: ReadonlyArray<unknown> }>
  | Readonly<{ ok: false; reason: "not_array" | "accessor_not_allowed" }> {
  if (!Array.isArray(input)) return { ok: false, reason: "not_array" }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    return { ok: false, reason: "accessor_not_allowed" }
  }
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value
  if (!Number.isSafeInteger(length) || length < 0) return { ok: false, reason: "not_array" }
  const keys = Object.keys(descriptors).filter((key) => key !== "length")
  if (keys.length !== length || keys.some((key, index) => key !== String(index))) {
    return { ok: false, reason: "not_array" }
  }
  return { ok: true, value: Object.freeze(keys.map((key) => descriptors[key]?.value)) }
}

function exactKeys(input: Readonly<Record<string, unknown>>, expected: ReadonlyArray<string>) {
  const keys = Object.keys(input)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(input, key))
}

function digest(domain: string, input: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${domain}\0${canonicalJson(input)}`).digest("hex")}`
}

function projectParentAuthorityLocationID(parentPath: string) {
  return `project-parent-authority:${digest("astra.project-parent.location.v1", { parentPath }).slice("sha256:".length)}`
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  return `{${Object.entries(input)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`
}

function deepFreeze<Value>(input: Value): Value {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  Object.values(input).forEach(deepFreeze)
  return Object.freeze(input)
}

function success<Value>(value: Value): Readonly<{ ok: true; value: Value }> {
  return Object.freeze({ ok: true, value })
}

function failure(reason: ProjectCreationControlReason): Readonly<{ ok: false; reason: ProjectCreationControlReason }> {
  return Object.freeze({ ok: false, reason })
}
