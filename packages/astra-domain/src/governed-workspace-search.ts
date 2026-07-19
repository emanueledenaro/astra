import { createHash } from "node:crypto"
import { posix } from "node:path"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseOperationID,
  type AttemptID,
  type CapabilityGrantID,
  type ContentDigest,
  type OperationID,
} from "./operation-contract"

export const governedWorkspaceSearchTaskID = "workspace_fixed_string_search_v1" as const

export const governedWorkspaceSearchQueryLimitBytes = 512

export type GovernedWorkspaceSearchCapabilityManifest = Readonly<{
  schemaVersion: 1
  grant: Readonly<{
    capabilityGrantID: CapabilityGrantID
    operationID: OperationID
    attemptID: AttemptID
    baselineDigest: ContentDigest
    expiresAt: string
  }>
  boundary: "host_no_sandbox"
  task: Readonly<{
    taskID: typeof governedWorkspaceSearchTaskID
    queryDigest: ContentDigest
    queryBytes: number
  }>
  process: Readonly<{
    launcherExecutable: Readonly<{ canonicalPath: string; device: string; inode: string; digest: ContentDigest }>
    programDigest: ContentDigest
    arguments: ReadonlyArray<string>
    workingDirectory: string
    stdinDigest: ContentDigest
    searchExecutable: Readonly<{
      canonicalPath: "/usr/bin/grep"
      device: string
      inode: string
      digest: ContentDigest
    }>
    searchArguments: ReadonlyArray<string>
  }>
  filesystem: Readonly<{
    workspace: Readonly<{ canonicalPath: string; device: string; inode: string }>
    readOnlyRoots: ReadonlyArray<string>
    writableFiles: ReadonlyArray<never>
  }>
  network: Readonly<{ mode: "host_unrestricted" }>
  environment: Readonly<{
    variables: ReadonlyArray<Readonly<{ name: "LANG" | "LC_ALL" | "TZ"; value: string }>>
  }>
  limits: Readonly<{ timeoutMs: 5_000; maxStdoutBytes: 65_536; maxStderrBytes: 4_096 }>
}>

export type GovernedWorkspaceSearchCapability = Readonly<{
  manifest: GovernedWorkspaceSearchCapabilityManifest
  capabilityDigest: ContentDigest
}>

export type GovernedWorkspaceSearchCapabilityParseResult =
  | Readonly<{ ok: true; value: GovernedWorkspaceSearchCapability }>
  | Readonly<{ ok: false; issue: "invalid_capability" }>

const invalidSearchSnapshot = Symbol("invalid-governed-workspace-search-snapshot")
type SearchSnapshot = null | string | boolean | number | SearchSnapshotRecord | ReadonlyArray<SearchSnapshot>
interface SearchSnapshotRecord {
  readonly [key: string]: SearchSnapshot
}

export function computeGovernedWorkspaceSearchCapabilityDigest(
  manifest: GovernedWorkspaceSearchCapabilityManifest,
): ContentDigest {
  return requireContentDigest(
    `sha256:${createHash("sha256")
      .update(`astra.governed-workspace-search-capability.v1\0${canonicalJson(manifest)}`)
      .digest("hex")}`,
  )
}

/** Strictly validates the complete authority for the one sealed search task. */
export function parseGovernedWorkspaceSearchCapability(input: unknown): GovernedWorkspaceSearchCapabilityParseResult {
  const snapshot = snapshotSearchData(input)
  if (
    snapshot === invalidSearchSnapshot ||
    !recordWithKeys(snapshot, ["manifest", "capabilityDigest"]) ||
    !validCapabilityManifest(snapshot.manifest)
  ) {
    return { ok: false, issue: "invalid_capability" }
  }
  const capabilityDigest = parseContentDigest(snapshot.capabilityDigest)
  if (
    !capabilityDigest.ok ||
    capabilityDigest.value !== computeGovernedWorkspaceSearchCapabilityDigest(snapshot.manifest)
  ) {
    return { ok: false, issue: "invalid_capability" }
  }
  return {
    ok: true,
    value: deepFreeze(structuredClone({ manifest: snapshot.manifest, capabilityDigest: capabilityDigest.value })),
  }
}

export type GovernedWorkspaceSearchRequest = Readonly<{
  taskID: typeof governedWorkspaceSearchTaskID
  query: string
  queryBytes: number
}>

export type GovernedWorkspaceSearchParseResult =
  | Readonly<{ ok: true; value: GovernedWorkspaceSearchRequest }>
  | Readonly<{
      ok: false
      issue: "invalid_shape" | "invalid_task" | "empty_query" | "unsafe_query" | "query_too_large"
    }>

/** Parses the one closed search task without normalizing or interpreting query bytes. */
export function parseGovernedWorkspaceSearchRequest(input: unknown): GovernedWorkspaceSearchParseResult {
  const snapshot = snapshotSearchData(input)
  if (
    snapshot === invalidSearchSnapshot ||
    !isRecord(snapshot) ||
    Object.keys(snapshot).some((key) => key !== "taskID" && key !== "query" && key !== "queryBytes")
  ) {
    return { ok: false, issue: "invalid_shape" }
  }
  if (snapshot.taskID !== governedWorkspaceSearchTaskID) return { ok: false, issue: "invalid_task" }
  if (typeof snapshot.query !== "string") return { ok: false, issue: "invalid_shape" }
  if (snapshot.query.length === 0) return { ok: false, issue: "empty_query" }
  if (!isSafeLiteralQuery(snapshot.query)) return { ok: false, issue: "unsafe_query" }
  const queryBytes = Buffer.byteLength(snapshot.query, "utf8")
  if (queryBytes > governedWorkspaceSearchQueryLimitBytes) return { ok: false, issue: "query_too_large" }
  if ("queryBytes" in snapshot && snapshot.queryBytes !== queryBytes) return { ok: false, issue: "invalid_shape" }
  return {
    ok: true,
    value: Object.freeze({ taskID: governedWorkspaceSearchTaskID, query: snapshot.query, queryBytes }),
  }
}

function isSafeLiteralQuery(input: string) {
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false
      index++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function validCapabilityManifest(input: unknown): input is GovernedWorkspaceSearchCapabilityManifest {
  if (
    !recordWithKeys(input, [
      "schemaVersion",
      "grant",
      "boundary",
      "task",
      "process",
      "filesystem",
      "network",
      "environment",
      "limits",
    ]) ||
    input.schemaVersion !== 1 ||
    input.boundary !== "host_no_sandbox" ||
    !validGrant(input.grant) ||
    !validTask(input.task) ||
    !validProcess(input.process) ||
    !validFilesystem(input.filesystem) ||
    !validEnvironment(input.environment) ||
    !recordWithKeys(input.network, ["mode"]) ||
    input.network.mode !== "host_unrestricted" ||
    !recordWithKeys(input.limits, ["timeoutMs", "maxStdoutBytes", "maxStderrBytes"]) ||
    input.limits.timeoutMs !== 5_000 ||
    input.limits.maxStdoutBytes !== 65_536 ||
    input.limits.maxStderrBytes !== 4_096
  ) {
    return false
  }
  const request = parseGovernedWorkspaceSearchRequest({
    taskID: input.task.taskID,
    query: input.process.searchArguments[7],
    queryBytes: input.task.queryBytes,
  })
  return (
    request.ok &&
    sha256(Buffer.from(request.value.query)) === input.task.queryDigest &&
    input.process.workingDirectory === input.filesystem.workspace.canonicalPath &&
    input.filesystem.readOnlyRoots.length === 1 &&
    input.filesystem.readOnlyRoots[0] === input.filesystem.workspace.canonicalPath &&
    input.filesystem.writableFiles.length === 0
  )
}

function validGrant(input: unknown): input is GovernedWorkspaceSearchCapabilityManifest["grant"] {
  return (
    recordWithKeys(input, ["capabilityGrantID", "operationID", "attemptID", "baselineDigest", "expiresAt"]) &&
    parseCapabilityGrantID(input.capabilityGrantID).ok &&
    parseOperationID(input.operationID).ok &&
    parseAttemptID(input.attemptID).ok &&
    parseContentDigest(input.baselineDigest).ok &&
    canonicalTimestamp(input.expiresAt)
  )
}

function validTask(input: unknown): input is GovernedWorkspaceSearchCapabilityManifest["task"] {
  return (
    recordWithKeys(input, ["taskID", "queryDigest", "queryBytes"]) &&
    input.taskID === governedWorkspaceSearchTaskID &&
    parseContentDigest(input.queryDigest).ok &&
    typeof input.queryBytes === "number" &&
    Number.isSafeInteger(input.queryBytes) &&
    input.queryBytes > 0 &&
    input.queryBytes <= governedWorkspaceSearchQueryLimitBytes
  )
}

function validProcess(input: unknown): input is GovernedWorkspaceSearchCapabilityManifest["process"] {
  return (
    recordWithKeys(input, [
      "launcherExecutable",
      "programDigest",
      "arguments",
      "workingDirectory",
      "stdinDigest",
      "searchExecutable",
      "searchArguments",
    ]) &&
    validLauncherExecutable(input.launcherExecutable) &&
    parseContentDigest(input.programDigest).ok &&
    parseContentDigest(input.stdinDigest).ok &&
    canonicalAbsolutePath(input.workingDirectory) &&
    Array.isArray(input.arguments) &&
    input.arguments.length === 5 &&
    input.arguments[0] === "--no-install" &&
    input.arguments[1] === "--no-env-file" &&
    input.arguments[2] === "--config=/dev/null" &&
    input.arguments[3] === "--eval" &&
    typeof input.arguments[4] === "string" &&
    sha256(Buffer.from(input.arguments[4])) === input.programDigest &&
    validSearchExecutable(input.searchExecutable) &&
    validSearchArguments(input.searchArguments)
  )
}

function validLauncherExecutable(
  input: unknown,
): input is GovernedWorkspaceSearchCapabilityManifest["process"]["launcherExecutable"] {
  return (
    recordWithKeys(input, ["canonicalPath", "device", "inode", "digest"]) &&
    canonicalAbsolutePath(input.canonicalPath) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode) &&
    parseContentDigest(input.digest).ok
  )
}

function validSearchExecutable(
  input: unknown,
): input is GovernedWorkspaceSearchCapabilityManifest["process"]["searchExecutable"] {
  return validLauncherExecutable(input) && input.canonicalPath === "/usr/bin/grep"
}

function validSearchArguments(input: unknown): input is ReadonlyArray<string> {
  return (
    Array.isArray(input) &&
    input.length === 9 &&
    input[0] === "-r" &&
    input[1] === "-I" &&
    input[2] === "-n" &&
    input[3] === "-F" &&
    input[4] === "--exclude-dir=.git" &&
    input[5] === "--exclude-dir=node_modules" &&
    input[6] === "--" &&
    typeof input[7] === "string" &&
    input[8] === "."
  )
}

function validFilesystem(input: unknown): input is GovernedWorkspaceSearchCapabilityManifest["filesystem"] {
  return (
    recordWithKeys(input, ["workspace", "readOnlyRoots", "writableFiles"]) &&
    recordWithKeys(input.workspace, ["canonicalPath", "device", "inode"]) &&
    canonicalAbsolutePath(input.workspace.canonicalPath) &&
    decimalIdentity(input.workspace.device) &&
    decimalIdentity(input.workspace.inode) &&
    Array.isArray(input.readOnlyRoots) &&
    input.readOnlyRoots.every(canonicalAbsolutePath) &&
    Array.isArray(input.writableFiles)
  )
}

function validEnvironment(input: unknown): input is GovernedWorkspaceSearchCapabilityManifest["environment"] {
  if (!recordWithKeys(input, ["variables"]) || !Array.isArray(input.variables)) return false
  return (
    canonicalJson(input.variables) ===
    canonicalJson([
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TZ", value: "UTC" },
    ])
  )
}

function recordWithKeys(input: unknown, keys: ReadonlyArray<string>): input is Record<string, unknown> {
  return isRecord(input) && Object.keys(input).length === keys.length && keys.every((key) => key in input)
}

function canonicalTimestamp(input: unknown): input is string {
  if (typeof input !== "string") return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function canonicalAbsolutePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 16_384 &&
    input.startsWith("/") &&
    posix.normalize(input) === input &&
    (input === "/" || !input.endsWith("/"))
  )
}

function decimalIdentity(input: unknown): input is string {
  return typeof input === "string" && /^(0|[1-9][0-9]*)$/.test(input)
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search digest is invalid")
  return parsed.value
}

function sha256(input: Uint8Array) {
  return requireContentDigest(`sha256:${createHash("sha256").update(input).digest("hex")}`)
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input)
  if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input)
  const snapshot = snapshotSearchData(input)
  if (snapshot === invalidSearchSnapshot) throw new TypeError("Search capability must be canonical JSON data")
  if (Array.isArray(snapshot)) return `[${snapshot.map(canonicalJson).join(",")}]`
  if (!isRecord(snapshot)) throw new TypeError("Search capability must be canonical JSON data")
  return `{${Object.entries(snapshot)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}

function snapshotSearchData(
  input: unknown,
  depth = 0,
  budget = { fields: 0 },
): SearchSnapshot | typeof invalidSearchSnapshot {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number" && Number.isFinite(input)) return input
  if (typeof input !== "object" || depth > 12) return invalidSearchSnapshot
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 128) return invalidSearchSnapshot
      const keys = Reflect.ownKeys(input)
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
        return invalidSearchSnapshot
      }
      const values: Array<SearchSnapshot> = []
      for (let index = 0; index < input.length; index++) {
        budget.fields += 1
        if (budget.fields > 512) return invalidSearchSnapshot
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor || !("value" in descriptor)) return invalidSearchSnapshot
        const value = snapshotSearchData(descriptor.value, depth + 1, budget)
        if (value === invalidSearchSnapshot) return invalidSearchSnapshot
        values.push(value)
      }
      return values
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return invalidSearchSnapshot
    const output: Record<string, SearchSnapshot> = Object.create(null)
    for (const key of Reflect.ownKeys(input)) {
      budget.fields += 1
      if (budget.fields > 512 || typeof key !== "string") return invalidSearchSnapshot
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !("value" in descriptor)) return invalidSearchSnapshot
      const value = snapshotSearchData(descriptor.value, depth + 1, budget)
      if (value === invalidSearchSnapshot) return invalidSearchSnapshot
      Object.defineProperty(output, key, { value, enumerable: true, writable: true, configurable: true })
    }
    return output
  } catch {
    return invalidSearchSnapshot
  }
}
