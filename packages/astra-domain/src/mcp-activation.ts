import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { parseContentDigest, parseOperationID, type ContentDigest } from "./operation-contract"

export const mcpActivationBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const
export const mcpActivationNetworkLabel = "NETWORK EGRESS — EXACT DESTINATION" as const
export const mcpActivationRequestBudget = Object.freeze([
  "initialize",
  "notifications/initialized",
  "tools/list",
] as const)
export const mcpActivationLeaseMilliseconds = 15 * 60_000

export type McpActivationProposal = Readonly<{
  schemaVersion: 1
  operationID: string
  policyAskedAt: string
  authorizationExpiresAt: string
  leaseExpiresAt: string
  session: Readonly<{ mode: "activate-once"; trust: "trusted_once" }>
  candidate: Readonly<{
    candidateID: ContentDigest
    displayName: string
    sourcePath: string
    transport: "streamable_http"
    endpoint: string
  }>
  boundary: "host_no_sandbox"
  boundaryLabel: typeof mcpActivationBoundaryLabel
  networkLabel: typeof mcpActivationNetworkLabel
  requestBudget: typeof mcpActivationRequestBudget
  guarantees: Readonly<{
    credentials: "none"
    workspaceRootShared: "none"
    redirects: "forbidden"
    retries: "none"
    reconnect: "none"
    proxyEnvironment: "ignored"
    instructions: "untrusted_withheld"
    prompts: "not_loaded"
    resources: "not_loaded"
    toolInvocation: "forbidden"
    catalog: "bounded_observed_not_verified"
    sourceRevalidation: "device_inode_digest_after_claim"
    stop: "explicit_or_lease_or_session_close"
  }>
  capabilityDigest: ContentDigest
}>

export type McpActivationProposalParseResult =
  | Readonly<{ ok: true; value: McpActivationProposal }>
  | Readonly<{ ok: false; reason: "invalid_proposal" }>

export function computeMcpActivationCapabilityDigest(
  input: Omit<McpActivationProposal, "capabilityDigest">,
): ContentDigest {
  return requireDigest(
    `sha256:${createHash("sha256")
      .update(`astra.mcp-activation-capability.v1\0${canonicalJson(input)}`)
      .digest("hex")}`,
  )
}

/** Strictly accepts only the public, redacted authority displayed before consent. */
export function parseMcpActivationProposal(input: unknown): McpActivationProposalParseResult {
  try {
    const value = exactRecord(input, [
      "schemaVersion",
      "operationID",
      "policyAskedAt",
      "authorizationExpiresAt",
      "leaseExpiresAt",
      "session",
      "candidate",
      "boundary",
      "boundaryLabel",
      "networkLabel",
      "requestBudget",
      "guarantees",
      "capabilityDigest",
    ])
    const operationID = parseOperationID(value.operationID)
    const capabilityDigest = parseContentDigest(value.capabilityDigest)
    const session = exactRecord(value.session, ["mode", "trust"])
    const candidate = exactRecord(value.candidate, ["candidateID", "displayName", "sourcePath", "transport", "endpoint"])
    const guarantees = exactRecord(value.guarantees, [
      "credentials",
      "workspaceRootShared",
      "redirects",
      "retries",
      "reconnect",
      "proxyEnvironment",
      "instructions",
      "prompts",
      "resources",
      "toolInvocation",
      "catalog",
      "sourceRevalidation",
      "stop",
    ])
    const candidateID = parseContentDigest(candidate.candidateID)
    if (
      value.schemaVersion !== 1 ||
      !operationID.ok ||
      !capabilityDigest.ok ||
      !candidateID.ok ||
      !timestamp(value.policyAskedAt) ||
      !timestamp(value.authorizationExpiresAt) ||
      !timestamp(value.leaseExpiresAt) ||
      Date.parse(value.authorizationExpiresAt) <= Date.parse(value.policyAskedAt) ||
      Date.parse(value.authorizationExpiresAt) !== Date.parse(value.leaseExpiresAt) ||
      Date.parse(value.leaseExpiresAt) !== Date.parse(value.policyAskedAt) + mcpActivationLeaseMilliseconds ||
      session.mode !== "activate-once" ||
      session.trust !== "trusted_once" ||
      candidate.transport !== "streamable_http" ||
      !safeDisplay(candidate.displayName, 128) ||
      !safeSourcePath(candidate.sourcePath) ||
      !safeEndpoint(candidate.endpoint) ||
      value.boundary !== "host_no_sandbox" ||
      value.boundaryLabel !== mcpActivationBoundaryLabel ||
      value.networkLabel !== mcpActivationNetworkLabel ||
      !exactArray(value.requestBudget, mcpActivationRequestBudget) ||
      guarantees.credentials !== "none" ||
      guarantees.workspaceRootShared !== "none" ||
      guarantees.redirects !== "forbidden" ||
      guarantees.retries !== "none" ||
      guarantees.reconnect !== "none" ||
      guarantees.proxyEnvironment !== "ignored" ||
      guarantees.instructions !== "untrusted_withheld" ||
      guarantees.prompts !== "not_loaded" ||
      guarantees.resources !== "not_loaded" ||
      guarantees.toolInvocation !== "forbidden" ||
      guarantees.catalog !== "bounded_observed_not_verified" ||
      guarantees.sourceRevalidation !== "device_inode_digest_after_claim" ||
      guarantees.stop !== "explicit_or_lease_or_session_close"
    ) {
      return invalid()
    }
    const proposal: McpActivationProposal = deepFreeze({
      schemaVersion: 1,
      operationID: operationID.value,
      policyAskedAt: value.policyAskedAt,
      authorizationExpiresAt: value.authorizationExpiresAt,
      leaseExpiresAt: value.leaseExpiresAt,
      session: { mode: "activate-once", trust: "trusted_once" },
      candidate: {
        candidateID: candidateID.value,
        displayName: candidate.displayName,
        sourcePath: candidate.sourcePath,
        transport: "streamable_http",
        endpoint: candidate.endpoint,
      },
      boundary: "host_no_sandbox",
      boundaryLabel: mcpActivationBoundaryLabel,
      networkLabel: mcpActivationNetworkLabel,
      requestBudget: mcpActivationRequestBudget,
      guarantees: {
        credentials: "none",
        workspaceRootShared: "none",
        redirects: "forbidden",
        retries: "none",
        reconnect: "none",
        proxyEnvironment: "ignored",
        instructions: "untrusted_withheld",
        prompts: "not_loaded",
        resources: "not_loaded",
        toolInvocation: "forbidden",
        catalog: "bounded_observed_not_verified",
        sourceRevalidation: "device_inode_digest_after_claim",
        stop: "explicit_or_lease_or_session_close",
      },
      capabilityDigest: capabilityDigest.value,
    })
    const { capabilityDigest: _ignored, ...withoutDigest } = proposal
    if (computeMcpActivationCapabilityDigest(withoutDigest) !== capabilityDigest.value) return invalid()
    return { ok: true, value: proposal }
  } catch {
    return invalid()
  }
}

export function isAllowedMcpActivationEndpoint(input: string) {
  return safeEndpoint(input)
}

function safeEndpoint(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 2_048 || hasControl(input)) return false
  try {
    const url = new URL(input)
    if (url.username || url.password || url.search || url.hash) return false
    if (url.protocol === "https:") return url.hostname.length > 0
    if (url.protocol !== "http:") return false
    const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname
    if (isIP(hostname) === 4) return hostname.startsWith("127.")
    return isIP(hostname) === 6 && hostname === "::1"
  } catch {
    return false
  }
}

function safeDisplay(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= maximum && !hasControl(input)
}

function safeSourcePath(input: unknown): input is string {
  return safeDisplay(input, 512) && !input.startsWith("/") && !input.split("/").includes("..")
}

function hasControl(input: string) {
  return /[\p{Cc}\p{Cf}]/u.test(input)
}

function timestamp(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) && new Date(Date.parse(input)).toISOString() === input
}

function exactArray(input: unknown, expected: ReadonlyArray<string>) {
  return Array.isArray(input) && input.length === expected.length && input.every((value, index) => value === expected[index])
}

function exactRecord(input: unknown, keys: ReadonlyArray<string>) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Expected an exact record")
  }
  const ownKeys = Reflect.ownKeys(input)
  if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError("Unexpected record keys")
  const record = Object.fromEntries(ownKeys.map((key) => [key, Reflect.get(input, key)]))
  const actual = Object.keys(record).toSorted()
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].toSorted()[index])) {
    throw new TypeError("Unexpected record keys")
  }
  return record
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  return `{${Object.keys(input)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(input, key))}`)
    .join(",")}}`
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object") {
    Object.freeze(input)
    for (const value of Object.values(input)) deepFreeze(value)
  }
  return input
}

function requireDigest(input: string) {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("Invalid digest")
  return parsed.value
}

function invalid(): McpActivationProposalParseResult {
  return { ok: false, reason: "invalid_proposal" }
}
