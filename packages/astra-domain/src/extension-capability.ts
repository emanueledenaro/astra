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

export type SkillActivationCapabilityManifest = Readonly<{
  schemaVersion: 1
  kind: "skill_instruction_activation"
  grant: Readonly<{
    capabilityGrantID: CapabilityGrantID
    operationID: OperationID
    attemptID: AttemptID
    baselineDigest: ContentDigest
    expiresAt: string
  }>
  session: Readonly<{
    sessionID: string
    lifetime: "astra_session"
  }>
  workspace: Readonly<{
    canonicalPath: string
    device: string
    inode: string
    securityDigest: ContentDigest
  }>
  skill: Readonly<{
    source: "workspace_opencode"
    name: string
    relativePath: string
    fileIdentity: Readonly<{
      device: string
      inode: string
    }>
    fileDigest: ContentDigest
    fileBytes: number
    instructionsDigest: ContentDigest
    instructionsBytes: number
    descriptionDigest: ContentDigest
  }>
  exposure: Readonly<{
    systemPrompt: "fixed_safe_description"
    toolResult: "approved_content_only"
    resourceDiscovery: "none"
    trust: "untrusted_instruction_data"
  }>
  authority: Readonly<{
    workspaceRead: string
    workspaceWrite: "none"
    runtimeWrite: "private_session_skill_bundle"
    process: "none"
    shell: "none"
    network: "none"
    plugins: "none"
    mcp: "none"
  }>
  limits: Readonly<{
    maxCandidates: number
    maxEntries: number
    maxFileBytes: number
    maxTotalBytes: number
    maxDurationMs: number
  }>
}>

export type SkillActivationCapability = Readonly<{
  manifest: SkillActivationCapabilityManifest
  capabilityDigest: ContentDigest
}>

export type SkillActivationCapabilityParseResult =
  | Readonly<{ ok: true; value: SkillActivationCapability }>
  | Readonly<{ ok: false; reason: "invalid_capability" }>

const manifestKeys = [
  "schemaVersion",
  "kind",
  "grant",
  "session",
  "workspace",
  "skill",
  "exposure",
  "authority",
  "limits",
] as const
const invalidSnapshot = Symbol("invalid-skill-capability-snapshot")
type CapabilitySnapshot = null | string | boolean | number | CapabilitySnapshotRecord
interface CapabilitySnapshotRecord {
  readonly [key: string]: CapabilitySnapshot
}

/** Computes the authority digest over every field that can affect skill exposure. */
export function computeSkillActivationCapabilityDigest(
  manifest: SkillActivationCapabilityManifest,
): ContentDigest {
  return requireContentDigest(
    `sha256:${createHash("sha256")
      .update(`astra.skill-activation-capability.v1\0${canonicalJson(manifest)}`)
      .digest("hex")}`,
  )
}

/** Strictly parses one session-only, data-only skill activation capability. */
export function parseSkillActivationCapability(input: unknown): SkillActivationCapabilityParseResult {
  const snapshot = snapshotCapabilityData(input)
  if (snapshot === invalidSnapshot || !recordWithKeys(snapshot, ["manifest", "capabilityDigest"])) {
    return invalidCapability()
  }
  if (!validManifest(snapshot.manifest)) return invalidCapability()
  const capabilityDigest = parseContentDigest(snapshot.capabilityDigest)
  if (!capabilityDigest.ok || capabilityDigest.value !== computeSkillActivationCapabilityDigest(snapshot.manifest)) {
    return invalidCapability()
  }
  const manifest = copyManifest(snapshot.manifest)
  return Object.freeze({
    ok: true,
    value: Object.freeze({ manifest: freezeManifest(manifest), capabilityDigest: capabilityDigest.value }),
  })
}

/** Accepts only workspace-local OpenCode skill files and rejects path expansion. */
export function isWorkspaceOpenCodeSkillPath(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0 || input.length > 16_384 || input.includes("\0")) return false
  if (input.startsWith("/") || input.includes("\\") || posix.normalize(input) !== input) return false
  const segments = input.split("/")
  if (segments.length < 4 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false
  }
  if (segments[0] !== ".opencode" || (segments[1] !== "skill" && segments[1] !== "skills")) return false
  return segments.at(-1) === "SKILL.md"
}

function validManifest(input: unknown): input is SkillActivationCapabilityManifest {
  if (
    !recordWithKeys(input, manifestKeys) ||
    input.schemaVersion !== 1 ||
    input.kind !== "skill_instruction_activation"
  ) {
    return false
  }
  if (
    !validGrant(input.grant) ||
    !validSession(input.session) ||
    !validWorkspace(input.workspace) ||
    !validSkill(input.skill) ||
    !validExposure(input.exposure) ||
    !validAuthority(input.authority) ||
    !validLimits(input.limits)
  ) {
    return false
  }
  return (
    input.skill.relativePath === input.authority.workspaceRead &&
    input.skill.fileBytes <= input.limits.maxFileBytes &&
    input.skill.instructionsBytes <= input.skill.fileBytes &&
    input.skill.fileBytes <= input.limits.maxTotalBytes
  )
}

function validGrant(input: unknown): input is SkillActivationCapabilityManifest["grant"] {
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

function validSession(input: unknown): input is SkillActivationCapabilityManifest["session"] {
  return (
    recordWithKeys(input, ["sessionID", "lifetime"]) &&
    uuid(input.sessionID) &&
    input.lifetime === "astra_session"
  )
}

function validWorkspace(input: unknown): input is SkillActivationCapabilityManifest["workspace"] {
  return (
    recordWithKeys(input, ["canonicalPath", "device", "inode", "securityDigest"]) &&
    canonicalAbsolutePath(input.canonicalPath) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode) &&
    parseContentDigest(input.securityDigest).ok
  )
}

function validSkill(input: unknown): input is SkillActivationCapabilityManifest["skill"] {
  if (
    !recordWithKeys(input, [
      "source",
      "name",
      "relativePath",
      "fileIdentity",
      "fileDigest",
      "fileBytes",
      "instructionsDigest",
      "instructionsBytes",
      "descriptionDigest",
    ]) ||
    input.source !== "workspace_opencode" ||
    !skillName(input.name) ||
    !isWorkspaceOpenCodeSkillPath(input.relativePath) ||
    !validFileIdentity(input.fileIdentity) ||
    !parseContentDigest(input.fileDigest).ok ||
    !positiveBoundedInteger(input.fileBytes, 65_536) ||
    !parseContentDigest(input.instructionsDigest).ok ||
    !positiveBoundedInteger(input.instructionsBytes, 65_536) ||
    !parseContentDigest(input.descriptionDigest).ok
  ) {
    return false
  }
  return true
}

function validFileIdentity(input: unknown): input is SkillActivationCapabilityManifest["skill"]["fileIdentity"] {
  return (
    recordWithKeys(input, ["device", "inode"]) && decimalIdentity(input.device) && decimalIdentity(input.inode)
  )
}

function validExposure(input: unknown): input is SkillActivationCapabilityManifest["exposure"] {
  return (
    recordWithKeys(input, ["systemPrompt", "toolResult", "resourceDiscovery", "trust"]) &&
    input.systemPrompt === "fixed_safe_description" &&
    input.toolResult === "approved_content_only" &&
    input.resourceDiscovery === "none" &&
    input.trust === "untrusted_instruction_data"
  )
}

function validAuthority(input: unknown): input is SkillActivationCapabilityManifest["authority"] {
  return (
    recordWithKeys(input, [
      "workspaceRead",
      "workspaceWrite",
      "runtimeWrite",
      "process",
      "shell",
      "network",
      "plugins",
      "mcp",
    ]) &&
    isWorkspaceOpenCodeSkillPath(input.workspaceRead) &&
    input.workspaceWrite === "none" &&
    input.runtimeWrite === "private_session_skill_bundle" &&
    input.process === "none" &&
    input.shell === "none" &&
    input.network === "none" &&
    input.plugins === "none" &&
    input.mcp === "none"
  )
}

function validLimits(input: unknown): input is SkillActivationCapabilityManifest["limits"] {
  return (
    recordWithKeys(input, ["maxCandidates", "maxEntries", "maxFileBytes", "maxTotalBytes", "maxDurationMs"]) &&
    positiveBoundedInteger(input.maxCandidates, 128) &&
    positiveBoundedInteger(input.maxEntries, 4_096) &&
    positiveBoundedInteger(input.maxFileBytes, 65_536) &&
    positiveBoundedInteger(input.maxTotalBytes, 262_144) &&
    positiveBoundedInteger(input.maxDurationMs, 10_000)
  )
}

function copyManifest(manifest: SkillActivationCapabilityManifest): SkillActivationCapabilityManifest {
  return {
    schemaVersion: 1,
    kind: "skill_instruction_activation",
    grant: { ...manifest.grant },
    session: { ...manifest.session },
    workspace: { ...manifest.workspace },
    skill: { ...manifest.skill, fileIdentity: { ...manifest.skill.fileIdentity } },
    exposure: { ...manifest.exposure },
    authority: { ...manifest.authority },
    limits: { ...manifest.limits },
  }
}

function freezeManifest(manifest: SkillActivationCapabilityManifest): SkillActivationCapabilityManifest {
  Object.freeze(manifest.grant)
  Object.freeze(manifest.session)
  Object.freeze(manifest.workspace)
  Object.freeze(manifest.skill.fileIdentity)
  Object.freeze(manifest.skill)
  Object.freeze(manifest.exposure)
  Object.freeze(manifest.authority)
  Object.freeze(manifest.limits)
  return Object.freeze(manifest)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Skill capability must be canonical JSON")
  const entries = Reflect.ownKeys(value).map((key) => {
    if (typeof key !== "string") throw new TypeError("Skill capability must not contain symbol keys")
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) throw new TypeError("Skill capability accessors are not allowed")
    return [key, descriptor.value] as const
  })
  return `{${entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function snapshotCapabilityData(
  input: unknown,
  depth = 0,
  budget = { fields: 0 },
): CapabilitySnapshot | typeof invalidSnapshot {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number" && Number.isFinite(input)) return input
  if (typeof input !== "object" || Array.isArray(input) || depth > 12) return invalidSnapshot
  try {
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return invalidSnapshot
    const output: Record<string, CapabilitySnapshot> = Object.create(null)
    for (const key of Reflect.ownKeys(input)) {
      budget.fields += 1
      if (budget.fields > 96 || typeof key !== "string") return invalidSnapshot
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !("value" in descriptor)) return invalidSnapshot
      const value = snapshotCapabilityData(descriptor.value, depth + 1, budget)
      if (value === invalidSnapshot) return invalidSnapshot
      Object.defineProperty(output, key, { value, enumerable: true, writable: true, configurable: true })
    }
    return output
  } catch {
    return invalidSnapshot
  }
}

function canonicalAbsolutePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 16_384 &&
    !input.includes("\0") &&
    input.startsWith("/") &&
    posix.normalize(input) === input &&
    (input === "/" || !input.endsWith("/"))
  )
}

function skillName(input: unknown): input is string {
  return typeof input === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input)
}

function decimalIdentity(input: unknown): input is string {
  return typeof input === "string" && /^(0|[1-9][0-9]{0,39})$/u.test(input)
}

function canonicalTimestamp(input: unknown): input is string {
  if (typeof input !== "string") return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function uuid(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)
  )
}

function positiveBoundedInteger(input: unknown, maximum: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 && input <= maximum
}

function recordWithKeys<const Keys extends readonly string[]>(
  input: unknown,
  keys: Keys,
): input is { [Key in Keys[number]]: unknown } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return false
  const actual = Reflect.ownKeys(input)
  if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length) return false
  return keys.every((key) => Object.hasOwn(input, key))
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The skill activation digest is invalid")
  return parsed.value
}

function invalidCapability() {
  return Object.freeze({ ok: false as const, reason: "invalid_capability" as const })
}
