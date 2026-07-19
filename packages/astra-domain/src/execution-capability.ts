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

export type ExecutionCapabilityManifest = Readonly<{
  schemaVersion: 1
  grant: Readonly<{
    capabilityGrantID: CapabilityGrantID
    operationID: OperationID
    attemptID: AttemptID
    baselineDigest: ContentDigest
    expiresAt: string
  }>
  isolation: Readonly<{
    platform: "darwin"
    backend: "host" | "seatbelt"
    fallback: "deny"
  }>
  process: Readonly<{
    executable: Readonly<{
      canonicalPath: string
      device: string
      inode: string
      digest: ContentDigest
    }>
    programDigest: ContentDigest
    arguments: ReadonlyArray<string>
    workingDirectory: string
    stdinDigest: ContentDigest
  }>
  filesystem: Readonly<{
    workspace: Readonly<{
      canonicalPath: string
      device: string
      inode: string
    }>
    runtimeScratch: Readonly<{
      canonicalPath: string
      lifecycle: "private_ephemeral"
    }>
    readOnlyRoots: ReadonlyArray<string>
    createOnlyFiles: ReadonlyArray<string>
    writableFiles: ReadonlyArray<string>
  }>
  network: Readonly<{ mode: "none" | "host_unrestricted" }>
  environment: Readonly<{
    variables: ReadonlyArray<Readonly<{ name: "LANG" | "LC_ALL" | "TMPDIR" | "TZ"; value: string }>>
  }>
  limits: Readonly<{
    timeoutMs: number
    maxStdoutBytes: number
    maxStderrBytes: number
  }>
}>

export type ExecutionCapability = Readonly<{
  manifest: ExecutionCapabilityManifest
  capabilityDigest: ContentDigest
}>

export type ExecutionCapabilityParseResult =
  | Readonly<{ ok: true; value: ExecutionCapability }>
  | Readonly<{ ok: false; reason: "invalid_capability" }>

const manifestKeys = [
  "schemaVersion",
  "grant",
  "isolation",
  "process",
  "filesystem",
  "network",
  "environment",
  "limits",
] as const

const permittedEnvironmentNames = new Set(["LANG", "LC_ALL", "TMPDIR", "TZ"])

/** Computes the authority digest over every field that may affect execution. */
export function computeExecutionCapabilityDigest(manifest: ExecutionCapabilityManifest): ContentDigest {
  return requireContentDigest(
    `sha256:${createHash("sha256")
      .update(`astra.execution-capability.v1\0${canonicalJson(manifest)}`)
      .digest("hex")}`,
  )
}

/** Strictly parses a fail-closed capability and rejects authority expansion. */
export function parseExecutionCapability(input: unknown): ExecutionCapabilityParseResult {
  if (!recordWithKeys(input, ["manifest", "capabilityDigest"])) return invalidCapability()
  if (!validManifest(input.manifest)) return invalidCapability()
  const capabilityDigest = parseContentDigest(input.capabilityDigest)
  if (!capabilityDigest.ok || capabilityDigest.value !== computeExecutionCapabilityDigest(input.manifest)) {
    return invalidCapability()
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      manifest: freezeManifest(copyManifest(input.manifest)),
      capabilityDigest: capabilityDigest.value,
    }),
  })
}

function validManifest(input: unknown): input is ExecutionCapabilityManifest {
  if (!recordWithKeys(input, manifestKeys) || input.schemaVersion !== 1) return false
  if (
    validGrant(input.grant) &&
    validIsolation(input.isolation) &&
    validProcess(input.process) &&
    validFilesystem(input.filesystem) &&
    validNetwork(input.network) &&
    validEnvironment(input.environment) &&
    validLimits(input.limits)
  ) {
    return (
      validWorkingDirectory(input.process, input.filesystem.workspace, input.isolation.backend) &&
      validEnvironmentLocation(input.environment, input.filesystem.runtimeScratch, input.isolation.backend) &&
      validNetworkBoundary(input.network, input.isolation.backend)
    )
  }
  return false
}

function validGrant(input: unknown): input is ExecutionCapabilityManifest["grant"] {
  if (!recordWithKeys(input, ["capabilityGrantID", "operationID", "attemptID", "baselineDigest", "expiresAt"])) {
    return false
  }
  return (
    parseCapabilityGrantID(input.capabilityGrantID).ok &&
    parseOperationID(input.operationID).ok &&
    parseAttemptID(input.attemptID).ok &&
    parseContentDigest(input.baselineDigest).ok &&
    canonicalTimestamp(input.expiresAt)
  )
}

function validIsolation(input: unknown): input is ExecutionCapabilityManifest["isolation"] {
  return (
    recordWithKeys(input, ["platform", "backend", "fallback"]) &&
    input.platform === "darwin" &&
    (input.backend === "host" || input.backend === "seatbelt") &&
    input.fallback === "deny"
  )
}

function validProcess(input: unknown): input is ExecutionCapabilityManifest["process"] {
  if (
    !recordWithKeys(input, ["executable", "programDigest", "arguments", "workingDirectory", "stdinDigest"]) ||
    !validExecutableIdentity(input.executable) ||
    !parseContentDigest(input.programDigest).ok ||
    !parseContentDigest(input.stdinDigest).ok ||
    !canonicalAbsolutePath(input.workingDirectory) ||
    !Array.isArray(input.arguments) ||
    input.arguments.length > 128
  ) {
    return false
  }
  return input.arguments.every((argument) => boundedString(argument, 16_384))
}

function validExecutableIdentity(input: unknown): input is ExecutionCapabilityManifest["process"]["executable"] {
  return (
    recordWithKeys(input, ["canonicalPath", "device", "inode", "digest"]) &&
    canonicalAbsolutePath(input.canonicalPath) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode) &&
    parseContentDigest(input.digest).ok
  )
}

function validFilesystem(input: unknown): input is ExecutionCapabilityManifest["filesystem"] {
  if (!recordWithKeys(input, ["workspace", "runtimeScratch", "readOnlyRoots", "createOnlyFiles", "writableFiles"])) {
    return false
  }
  const workspace = input.workspace
  if (
    !validWorkspaceIdentity(workspace) ||
    !validRuntimeScratch(input.runtimeScratch) ||
    !canonicalPathList(input.readOnlyRoots) ||
    !canonicalPathList(input.createOnlyFiles) ||
    !canonicalPathList(input.writableFiles)
  ) {
    return false
  }
  const writePaths = [...input.createOnlyFiles, ...input.writableFiles]
  if (new Set(writePaths).size !== writePaths.length) return false
  return (
    input.readOnlyRoots.length > 0 &&
    input.readOnlyRoots.includes(workspace.canonicalPath) &&
    !pathWithinOrEqual(input.runtimeScratch.canonicalPath, workspace.canonicalPath) &&
    !pathWithinOrEqual(workspace.canonicalPath, input.runtimeScratch.canonicalPath) &&
    input.readOnlyRoots.every((path) => pathWithinOrEqual(path, workspace.canonicalPath)) &&
    writePaths.every((path) => path !== workspace.canonicalPath && pathWithin(path, workspace.canonicalPath))
  )
}

function validRuntimeScratch(input: unknown): input is ExecutionCapabilityManifest["filesystem"]["runtimeScratch"] {
  return (
    recordWithKeys(input, ["canonicalPath", "lifecycle"]) &&
    canonicalAbsolutePath(input.canonicalPath) &&
    input.lifecycle === "private_ephemeral"
  )
}

function validWorkspaceIdentity(input: unknown): input is ExecutionCapabilityManifest["filesystem"]["workspace"] {
  return (
    recordWithKeys(input, ["canonicalPath", "device", "inode"]) &&
    canonicalAbsolutePath(input.canonicalPath) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode)
  )
}

function validNetwork(input: unknown): input is ExecutionCapabilityManifest["network"] {
  return recordWithKeys(input, ["mode"]) && (input.mode === "none" || input.mode === "host_unrestricted")
}

function validNetworkBoundary(
  network: ExecutionCapabilityManifest["network"],
  backend: ExecutionCapabilityManifest["isolation"]["backend"],
) {
  return backend === "seatbelt" ? network.mode === "none" : network.mode === "host_unrestricted"
}

function validWorkingDirectory(
  process: ExecutionCapabilityManifest["process"],
  workspace: ExecutionCapabilityManifest["filesystem"]["workspace"],
  backend: ExecutionCapabilityManifest["isolation"]["backend"],
) {
  return backend === "seatbelt"
    ? process.workingDirectory === workspace.canonicalPath
    : process.workingDirectory === "/"
}

function validEnvironment(input: unknown): input is ExecutionCapabilityManifest["environment"] {
  if (!recordWithKeys(input, ["variables"]) || !Array.isArray(input.variables) || input.variables.length > 16) {
    return false
  }
  const variables = input.variables
  if (!variables.every(validEnvironmentVariable)) return false
  return variables.every((variable, index) => index === 0 || variables[index - 1]!.name < variable.name)
}

function validEnvironmentVariable(
  input: unknown,
): input is ExecutionCapabilityManifest["environment"]["variables"][number] {
  return (
    recordWithKeys(input, ["name", "value"]) &&
    typeof input.name === "string" &&
    permittedEnvironmentNames.has(input.name) &&
    boundedString(input.value, 4_096)
  )
}

function validEnvironmentLocation(
  environment: ExecutionCapabilityManifest["environment"],
  runtimeScratch: ExecutionCapabilityManifest["filesystem"]["runtimeScratch"],
  backend: ExecutionCapabilityManifest["isolation"]["backend"],
) {
  const temporaryDirectory = environment.variables.find((variable) => variable.name === "TMPDIR")?.value
  return backend === "seatbelt" ? temporaryDirectory === runtimeScratch.canonicalPath : temporaryDirectory === undefined
}

function validLimits(input: unknown): input is ExecutionCapabilityManifest["limits"] {
  return (
    recordWithKeys(input, ["timeoutMs", "maxStdoutBytes", "maxStderrBytes"]) &&
    positiveBoundedInteger(input.timeoutMs, 300_000) &&
    positiveBoundedInteger(input.maxStdoutBytes, 16_777_216) &&
    positiveBoundedInteger(input.maxStderrBytes, 16_777_216)
  )
}

function canonicalPathList(input: unknown): input is ReadonlyArray<string> {
  return Array.isArray(input) && input.length <= 256 && sortedDistinct(input) && input.every(canonicalAbsolutePath)
}

function canonicalAbsolutePath(input: unknown): input is string {
  return (
    boundedString(input, 16_384) &&
    input.startsWith("/") &&
    posix.normalize(input) === input &&
    (input === "/" || !input.endsWith("/"))
  )
}

function pathWithin(path: string, root: string) {
  return root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`)
}

function pathWithinOrEqual(path: string, root: string) {
  return path === root || pathWithin(path, root)
}

function canonicalTimestamp(input: unknown): input is string {
  if (typeof input !== "string") return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function decimalIdentity(input: unknown): input is string {
  return typeof input === "string" && /^(0|[1-9][0-9]{0,39})$/u.test(input)
}

function boundedString(input: unknown, maximumLength: number): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= maximumLength && !input.includes("\0")
}

function sortedDistinct(input: ReadonlyArray<unknown>) {
  if (!input.every((value) => typeof value === "string")) return false
  return input.every((value, index) => index === 0 || input[index - 1]! < value)
}

function positiveBoundedInteger(input: unknown, maximum: number): input is number {
  return Number.isSafeInteger(input) && Number(input) > 0 && Number(input) <= maximum
}

function recordWithKeys<const Keys extends readonly string[]>(
  input: unknown,
  keys: Keys,
): input is { [Key in Keys[number]]: unknown } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const actual = Object.keys(input)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(input, key))
}

function copyManifest(manifest: ExecutionCapabilityManifest): ExecutionCapabilityManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    grant: { ...manifest.grant },
    isolation: { ...manifest.isolation },
    process: {
      ...manifest.process,
      executable: { ...manifest.process.executable },
      arguments: [...manifest.process.arguments],
    },
    filesystem: {
      workspace: { ...manifest.filesystem.workspace },
      runtimeScratch: { ...manifest.filesystem.runtimeScratch },
      readOnlyRoots: [...manifest.filesystem.readOnlyRoots],
      createOnlyFiles: [...manifest.filesystem.createOnlyFiles],
      writableFiles: [...manifest.filesystem.writableFiles],
    },
    network: { ...manifest.network },
    environment: { variables: manifest.environment.variables.map((variable) => ({ ...variable })) },
    limits: { ...manifest.limits },
  }
}

function freezeManifest(manifest: ExecutionCapabilityManifest): ExecutionCapabilityManifest {
  manifest.environment.variables.forEach(Object.freeze)
  Object.freeze(manifest.filesystem.readOnlyRoots)
  Object.freeze(manifest.filesystem.createOnlyFiles)
  Object.freeze(manifest.filesystem.writableFiles)
  Object.freeze(manifest.process.arguments)
  Object.freeze(manifest.environment.variables)
  Object.freeze(manifest.grant)
  Object.freeze(manifest.isolation)
  Object.freeze(manifest.process.executable)
  Object.freeze(manifest.process)
  Object.freeze(manifest.filesystem.workspace)
  Object.freeze(manifest.filesystem.runtimeScratch)
  Object.freeze(manifest.filesystem)
  Object.freeze(manifest.network)
  Object.freeze(manifest.environment)
  Object.freeze(manifest.limits)
  return Object.freeze(manifest)
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("Execution capability digest is invalid")
  return parsed.value
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Execution capability must be canonical JSON")
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`
}

function invalidCapability(): ExecutionCapabilityParseResult {
  return { ok: false, reason: "invalid_capability" }
}
