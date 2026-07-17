import { createHash } from "node:crypto"
import { posix } from "node:path"
import { parseContentDigest, parseOperationID, type ContentDigest } from "./operation-contract"

export const extensionInventoryBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const

export const extensionInventoryAllowlist = Object.freeze([
  "opencode.json",
  "opencode.jsonc",
  ".mcp.json",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
  ".opencode/plugin/* (regular direct children only)",
  ".opencode/plugins/* (regular direct children only)",
] as const)

export const extensionInventoryResourceClasses = Object.freeze([
  "workspace_extension_config_read",
  "workspace_plugin_source_read",
  "trusted_helper_process",
  "private_helper_execution_snapshot",
  "private_parent_pipe",
  "private_operation_state",
] as const)

export const extensionInventoryLimits = Object.freeze({
  maxRecords: 64,
  maxFileBytes: 256 * 1024,
  maxTotalInputBytes: 1024 * 1024,
  maxProtocolBytes: 2 * 1024 * 1024,
  maxStderrBytes: 4 * 1024,
  timeoutMilliseconds: 2_000,
} as const)

export type ExtensionInventoryHelperIdentity = Readonly<{
  canonicalPath: string
  device: string
  inode: string
  size: number
  digest: ContentDigest
}>

export type ExtensionInventoryProposal = Readonly<{
  schemaVersion: 1
  operationID: string
  policyAskedAt: string
  authorizationExpiresAt: string
  session: Readonly<{ mode: "activate-once"; trust: "trusted_once" }>
  boundary: "host_no_sandbox"
  boundaryLabel: typeof extensionInventoryBoundaryLabel
  workspace: Readonly<{
    canonicalPath: string
    identity: Readonly<{ device: string; inode: string }>
    securityDigest: ContentDigest
    descriptor: Readonly<{
      childFD: 3
      flags: ReadonlyArray<"O_RDONLY" | "O_DIRECTORY" | "O_NOFOLLOW">
      validation: "device_and_inode_after_durable_claim"
    }>
  }>
  helper: ExtensionInventoryHelperIdentity
  allowlist: typeof extensionInventoryAllowlist
  resourceClasses: typeof extensionInventoryResourceClasses
  limits: typeof extensionInventoryLimits
  guarantees: Readonly<{
    automaticInitialization: "none"
    parsing: "static_json_jsonc_only"
    substitutions: "forbidden"
    imports: "forbidden"
    activation: "none"
    rawBytes: "private_parent_pipe_only"
    helperExecution: "private_verified_snapshot_after_claim"
    rejection: "no_workspace_open_no_child"
  }>
  capabilityDigest: ContentDigest
}>

export type ExtensionInventoryCandidate = Readonly<{
  candidateID: ContentDigest
  kind: "plugin" | "mcp"
  displayName: string
  source: "config" | "workspace_file"
  sourcePath: string
  referenceClass: "package" | "remote" | "local_path" | "process" | "unknown"
  referenceDigest: ContentDigest
  state: "inactive"
  verification: "not_verified"
}>

export type ExtensionInventoryReport = Readonly<{
  schemaVersion: 1
  status: "complete"
  candidates: ReadonlyArray<ExtensionInventoryCandidate>
  sourceFileCount: number
  sourceByteCount: number
  candidateCounts: Readonly<{ plugins: number; mcp: number }>
  state: "inactive"
  verification: "not_verified"
  redaction: "secrets_removed"
}>

export type ExtensionInventoryProposalParseResult =
  | Readonly<{ ok: true; value: ExtensionInventoryProposal }>
  | Readonly<{ ok: false; reason: "invalid_proposal" }>

export type ExtensionInventoryReportParseResult =
  | Readonly<{ ok: true; value: ExtensionInventoryReport }>
  | Readonly<{ ok: false; reason: "invalid_report" }>

/** Computes authority over every field displayed before consent. */
export function computeExtensionInventoryCapabilityDigest(
  input: Omit<ExtensionInventoryProposal, "capabilityDigest">,
): ContentDigest {
  return requireContentDigest(
    `sha256:${createHash("sha256")
      .update(`astra.extension-inventory-capability.v1\0${canonicalJson(input)}`)
      .digest("hex")}`,
  )
}

/** Strictly accepts only the fixed, data-only inventory authority. */
export function parseExtensionInventoryProposal(input: unknown): ExtensionInventoryProposalParseResult {
  const value = snapshot(input)
  if (!value || !exactKeys(value, proposalKeys)) return invalidProposal()
  const operationID = parseOperationID(value.operationID)
  const capabilityDigest = parseContentDigest(value.capabilityDigest)
  if (
    value.schemaVersion !== 1 ||
    !operationID.ok ||
    !canonicalTimestamp(value.policyAskedAt) ||
    !canonicalTimestamp(value.authorizationExpiresAt) ||
    Date.parse(value.authorizationExpiresAt) <= Date.parse(value.policyAskedAt) ||
    !exactRecord(value.session, { mode: "activate-once", trust: "trusted_once" }) ||
    value.boundary !== "host_no_sandbox" ||
    value.boundaryLabel !== extensionInventoryBoundaryLabel ||
    !validWorkspace(value.workspace) ||
    !validHelper(value.helper) ||
    canonicalJson(value.allowlist) !== canonicalJson(extensionInventoryAllowlist) ||
    canonicalJson(value.resourceClasses) !== canonicalJson(extensionInventoryResourceClasses) ||
    canonicalJson(value.limits) !== canonicalJson(extensionInventoryLimits) ||
    !exactRecord(value.guarantees, {
      automaticInitialization: "none",
      parsing: "static_json_jsonc_only",
      substitutions: "forbidden",
      imports: "forbidden",
      activation: "none",
      rawBytes: "private_parent_pipe_only",
      helperExecution: "private_verified_snapshot_after_claim",
      rejection: "no_workspace_open_no_child",
    }) ||
    !capabilityDigest.ok
  ) {
    return invalidProposal()
  }
  const withoutDigest = {
    schemaVersion: 1,
    operationID: operationID.value,
    policyAskedAt: value.policyAskedAt,
    authorizationExpiresAt: value.authorizationExpiresAt,
    session: { mode: "activate-once", trust: "trusted_once" },
    boundary: "host_no_sandbox",
    boundaryLabel: extensionInventoryBoundaryLabel,
    workspace: deepFreeze(structuredClone(value.workspace)),
    helper: deepFreeze(structuredClone(value.helper)),
    allowlist: extensionInventoryAllowlist,
    resourceClasses: extensionInventoryResourceClasses,
    limits: extensionInventoryLimits,
    guarantees: {
      automaticInitialization: "none",
      parsing: "static_json_jsonc_only",
      substitutions: "forbidden",
      imports: "forbidden",
      activation: "none",
      rawBytes: "private_parent_pipe_only",
      helperExecution: "private_verified_snapshot_after_claim",
      rejection: "no_workspace_open_no_child",
    },
  } as const satisfies Omit<ExtensionInventoryProposal, "capabilityDigest">
  if (capabilityDigest.value !== computeExtensionInventoryCapabilityDigest(withoutDigest)) return invalidProposal()
  return Object.freeze({
    ok: true,
    value: deepFreeze({ ...withoutDigest, capabilityDigest: capabilityDigest.value }),
  })
}

/** Validates the public, redacted inventory before it crosses a control boundary. */
export function parseExtensionInventoryReport(input: unknown): ExtensionInventoryReportParseResult {
  const value = snapshot(input)
  if (!value || !exactKeys(value, reportKeys) || !Array.isArray(value.candidates)) return invalidReport()
  const candidates = value.candidates.filter(validCandidate)
  if (
    value.schemaVersion !== 1 ||
    value.status !== "complete" ||
    value.state !== "inactive" ||
    value.verification !== "not_verified" ||
    value.redaction !== "secrets_removed" ||
    !boundedInteger(value.sourceFileCount, 0, extensionInventoryLimits.maxRecords) ||
    !boundedInteger(value.sourceByteCount, 0, extensionInventoryLimits.maxTotalInputBytes) ||
    !validCandidateCounts(value.candidateCounts) ||
    value.candidates.length > 256 ||
    candidates.length !== value.candidates.length
  ) {
    return invalidReport()
  }
  const plugins = candidates.filter((candidate) => candidate.kind === "plugin").length
  const mcp = candidates.filter((candidate) => candidate.kind === "mcp").length
  if (
    !isRecord(value.candidateCounts) ||
    value.candidateCounts.plugins !== plugins ||
    value.candidateCounts.mcp !== mcp ||
    !sortedUniqueCandidates(candidates)
  ) {
    return invalidReport()
  }
  const report: ExtensionInventoryReport = {
    schemaVersion: 1,
    status: "complete",
    candidates: structuredClone(candidates),
    sourceFileCount: value.sourceFileCount,
    sourceByteCount: value.sourceByteCount,
    candidateCounts: structuredClone(value.candidateCounts),
    state: "inactive",
    verification: "not_verified",
    redaction: "secrets_removed",
  }
  return Object.freeze({ ok: true, value: deepFreeze(report) })
}

const proposalKeys = [
  "schemaVersion",
  "operationID",
  "policyAskedAt",
  "authorizationExpiresAt",
  "session",
  "boundary",
  "boundaryLabel",
  "workspace",
  "helper",
  "allowlist",
  "resourceClasses",
  "limits",
  "guarantees",
  "capabilityDigest",
] as const

const reportKeys = [
  "schemaVersion",
  "status",
  "candidates",
  "sourceFileCount",
  "sourceByteCount",
  "candidateCounts",
  "state",
  "verification",
  "redaction",
] as const

function validWorkspace(input: unknown): input is ExtensionInventoryProposal["workspace"] {
  if (!isRecord(input) || !exactKeys(input, ["canonicalPath", "identity", "securityDigest", "descriptor"])) return false
  if (
    !canonicalAbsolutePath(input.canonicalPath) ||
    !validIdentity(input.identity) ||
    !parseContentDigest(input.securityDigest).ok ||
    !isRecord(input.descriptor)
  ) {
    return false
  }
  return (
    exactKeys(input.descriptor, ["childFD", "flags", "validation"]) &&
    input.descriptor.childFD === 3 &&
    canonicalJson(input.descriptor.flags) === canonicalJson(["O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW"]) &&
    input.descriptor.validation === "device_and_inode_after_durable_claim"
  )
}

function validHelper(input: unknown): input is ExtensionInventoryHelperIdentity {
  return (
    isRecord(input) &&
    exactKeys(input, ["canonicalPath", "device", "inode", "size", "digest"]) &&
    canonicalAbsolutePath(input.canonicalPath) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode) &&
    boundedInteger(input.size, 1, 32 * 1024 * 1024) &&
    parseContentDigest(input.digest).ok
  )
}

function validIdentity(input: unknown) {
  return (
    isRecord(input) &&
    exactKeys(input, ["device", "inode"]) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode)
  )
}

function validCandidate(input: unknown): input is ExtensionInventoryCandidate {
  if (!isRecord(input) || !exactKeys(input, candidateKeys)) return false
  return (
    parseContentDigest(input.candidateID).ok &&
    (input.kind === "plugin" || input.kind === "mcp") &&
    safePublicText(input.displayName, 128) &&
    (input.source === "config" || input.source === "workspace_file") &&
    safeRelativePath(input.sourcePath) &&
    (input.referenceClass === "package" ||
      input.referenceClass === "remote" ||
      input.referenceClass === "local_path" ||
      input.referenceClass === "process" ||
      input.referenceClass === "unknown") &&
    parseContentDigest(input.referenceDigest).ok &&
    input.state === "inactive" &&
    input.verification === "not_verified"
  )
}

const candidateKeys = [
  "candidateID",
  "kind",
  "displayName",
  "source",
  "sourcePath",
  "referenceClass",
  "referenceDigest",
  "state",
  "verification",
] as const

function validCandidateCounts(input: unknown): input is ExtensionInventoryReport["candidateCounts"] {
  return (
    isRecord(input) &&
    exactKeys(input, ["plugins", "mcp"]) &&
    boundedInteger(input.plugins, 0, 256) &&
    boundedInteger(input.mcp, 0, 256)
  )
}

function sortedUniqueCandidates(input: ReadonlyArray<ExtensionInventoryCandidate>) {
  const keys = input.map((candidate) => `${candidate.kind}\0${candidate.sourcePath}\0${candidate.candidateID}`)
  return new Set(keys).size === keys.length && keys.every((value, index) => index === 0 || keys[index - 1]! < value)
}

function safeRelativePath(input: unknown) {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 1024 &&
    !input.startsWith("/") &&
    !input.includes("\\") &&
    !hasUnsafeText(input) &&
    posix.normalize(input) === input &&
    input.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
}

function safePublicText(input: unknown, maxBytes: number) {
  return typeof input === "string" && input.length > 0 && Buffer.byteLength(input) <= maxBytes && !hasUnsafeText(input)
}

function hasUnsafeText(input: string) {
  return /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(input)
}

function canonicalAbsolutePath(input: unknown) {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 16_384 &&
    input.startsWith("/") &&
    !input.includes("\0") &&
    posix.normalize(input) === input &&
    (input === "/" || !input.endsWith("/"))
  )
}

function decimalIdentity(input: unknown) {
  return typeof input === "string" && /^(0|[1-9][0-9]*)$/.test(input)
}

function boundedInteger(input: unknown, minimum: number, maximum: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= minimum && input <= maximum
}

function canonicalTimestamp(input: unknown): input is string {
  if (typeof input !== "string") return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function exactRecord(input: unknown, expected: Readonly<Record<string, string>>) {
  return isRecord(input) && exactKeys(input, Object.keys(expected)) && canonicalJson(input) === canonicalJson(expected)
}

function exactKeys(input: Record<string, unknown>, keys: ReadonlyArray<string>) {
  const actual = Object.keys(input)
  return actual.length === keys.length && keys.every((key) => key in input)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The extension inventory digest is invalid")
  return parsed.value
}

function invalidProposal(): ExtensionInventoryProposalParseResult {
  return Object.freeze({ ok: false, reason: "invalid_proposal" })
}

function invalidReport(): ExtensionInventoryReportParseResult {
  return Object.freeze({ ok: false, reason: "invalid_report" })
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input)
  if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  if (!isRecord(input)) throw new TypeError("Extension inventory data must be canonical JSON")
  return `{${Object.entries(input)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`
}

function snapshot(input: unknown, depth = 0, budget = { fields: 0 }): Record<string, unknown> | null {
  if (!isRecord(input) || depth > 16 || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    return null
  }
  const output: Record<string, unknown> = Object.create(null)
  try {
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || ++budget.fields > 4096) return null
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !("value" in descriptor)) return null
      const value = snapshotValue(descriptor.value, depth + 1, budget)
      if (value === invalidSnapshot) return null
      output[key] = value
    }
    return output
  } catch {
    return null
  }
}

const invalidSnapshot = Symbol("invalid-extension-inventory-snapshot")

function snapshotValue(input: unknown, depth: number, budget: { fields: number }): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number" && Number.isFinite(input)) return input
  if (depth > 16 || typeof input !== "object") return invalidSnapshot
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 1024) return invalidSnapshot
    const keys = Reflect.ownKeys(input)
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
          (key !== "length" && Number(key) >= input.length),
      )
    ) {
      return invalidSnapshot
    }
    const values: Array<unknown> = []
    for (let index = 0; index < input.length; index++) {
      if (++budget.fields > 4096) return invalidSnapshot
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
      if (!descriptor || !("value" in descriptor)) return invalidSnapshot
      const value = snapshotValue(descriptor.value, depth + 1, budget)
      if (value === invalidSnapshot) return invalidSnapshot
      values.push(value)
    }
    return values
  }
  return snapshot(input, depth, budget) ?? invalidSnapshot
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}
