import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { parseExactRecord } from "./operation-contract-validation"

export const gitUnstageAllBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const
export const gitUnstageAllLimitations = Object.freeze([
  "host_network_not_isolated",
  "object_store_not_observed",
] as const)

export type GitUnstageAllBaseline = Readonly<{
  snapshotDigest: `sha256:${string}`
  rootIdentity: Readonly<{ device: string; inode: string }>
  gitIdentity: Readonly<{ device: string; inode: string }>
  indexDigest: `sha256:${string}`
  indexMetadataDigest: `sha256:${string}`
  head: Readonly<{ kind: "symbolic"; symbolicRef: string; oid: string }> | Readonly<{ kind: "detached"; oid: string }>
  refsDigest: `sha256:${string}`
  worktreeDigest: `sha256:${string}`
}>

export type GitUnstageAllPreviewAuthority = Readonly<{
  schemaVersion: 1
  operation: "git_unstage_all"
  boundary: "host_no_sandbox"
  boundaryLabel: typeof gitUnstageAllBoundaryLabel
  verification: "not_verified"
  workspaceRoot: string
  nonce: string
  createdAt: string
  expiresAt: string
  runtimeScratch: string
  stagedCount: number
  baseline: GitUnstageAllBaseline
  inspection: Readonly<{
    observationDigest: `sha256:${string}`
    reportDigest: `sha256:${string}`
  }>
  executableDigest: `sha256:${string}`
  invocation: Readonly<{
    argumentsDigest: `sha256:${string}`
    environmentDigest: `sha256:${string}`
    timeoutMs: number
    maxStdoutBytes: number
    maxStderrBytes: number
  }>
  repositoryWrites: readonly [".git/index", ".git/index.lock"]
  scratchWrites: readonly [string, string, string]
  sealedExecutableScratch: Readonly<{
    root: "/private/tmp"
    directoryPrefix: "astra-git-exec-"
    executableName: "git"
    lifecycle: "created_after_claim_cleanup_required_before_return"
    purposes: readonly [
      "baseline_revalidation",
      "operation_execution",
      "post_state_observation",
      "independent_verification",
    ]
  }>
  scratchCleanup: "required_before_return"
  authorizationConsumption: "durable_operation_kernel_claim_required"
  preserves: Readonly<{
    worktree: "required"
    head: "required"
    refs: "required"
    objectStore: "not_observed"
  }>
  network: "not_requested_host_unrestricted"
  splitIndex: Readonly<{
    config: "validated_after_claim"
    sharedIndexFiles: "validated_after_claim"
    indexExtension: "rejected_by_baseline"
    invocation: "forced_disabled"
  }>
  limitations: typeof gitUnstageAllLimitations
}>

export type GitUnstageAllPreview = GitUnstageAllPreviewAuthority & Readonly<{ proposalDigest: `sha256:${string}` }>

export type GitUnstageAllObservation = Readonly<{
  schemaVersion: 1
  operation: "git_unstage_all"
  status: "effect_observed"
  verification: "not_verified"
  proposalDigest: `sha256:${string}`
  beforeSnapshotDigest: `sha256:${string}`
  afterSnapshotDigest: `sha256:${string}`
  afterIndexDigest: `sha256:${string}`
  afterIndexMetadataDigest: `sha256:${string}`
  processObservationDigest: `sha256:${string}`
  scratchCleanup: "observed_absent_before_return"
  limitations: typeof gitUnstageAllLimitations
}>

export type GitUnstageAllDecision = Readonly<{
  schemaVersion: 1
  operation: "git_unstage_all"
  proposalDigest: `sha256:${string}`
  nonce: string
  decision: "approved" | "rejected"
  decidedAt: string
}>

export type GitUnstageAllParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{
      ok: false
      reason:
        | "invalid_preview_shape"
        | "invalid_preview_value"
        | "invalid_proposal_digest"
        | "invalid_decision_shape"
        | "invalid_decision_value"
        | "invalid_observation_shape"
        | "invalid_observation_value"
    }>

export function computeGitUnstageAllProposalDigest(preview: GitUnstageAllPreviewAuthority): `sha256:${string}` {
  return digest(`astra.git-unstage-all-preview.v1\0${JSON.stringify(preview)}`)
}

export function parseGitUnstageAllPreview(input: unknown): GitUnstageAllParseResult<GitUnstageAllPreview> {
  const record = parseExactRecord(input, [...previewKeys, "proposalDigest"])
  if (!record.ok) return rejected("invalid_preview_shape")
  const authority = parsePreviewAuthority(Object.fromEntries(previewKeys.map((key) => [key, record.value[key]])))
  if (!authority.ok) return authority
  if (!isDigest(record.value.proposalDigest)) return rejected("invalid_proposal_digest")
  if (record.value.proposalDigest !== computeGitUnstageAllProposalDigest(authority.value)) {
    return rejected("invalid_proposal_digest")
  }
  return { ok: true, value: { ...authority.value, proposalDigest: record.value.proposalDigest } }
}

export function parseGitUnstageAllObservation(input: unknown): GitUnstageAllParseResult<GitUnstageAllObservation> {
  const record = parseExactRecord(input, [
    "schemaVersion",
    "operation",
    "status",
    "verification",
    "proposalDigest",
    "beforeSnapshotDigest",
    "afterSnapshotDigest",
    "afterIndexDigest",
    "afterIndexMetadataDigest",
    "processObservationDigest",
    "scratchCleanup",
    "limitations",
  ])
  if (!record.ok) return rejected("invalid_observation_shape")
  if (
    record.value.schemaVersion !== 1 ||
    record.value.operation !== "git_unstage_all" ||
    record.value.status !== "effect_observed" ||
    record.value.verification !== "not_verified" ||
    !isDigest(record.value.proposalDigest) ||
    !isDigest(record.value.beforeSnapshotDigest) ||
    !isDigest(record.value.afterSnapshotDigest) ||
    !isDigest(record.value.afterIndexDigest) ||
    !isDigest(record.value.afterIndexMetadataDigest) ||
    !isDigest(record.value.processObservationDigest) ||
    record.value.scratchCleanup !== "observed_absent_before_return" ||
    !exactLimitations(record.value.limitations)
  ) {
    return rejected("invalid_observation_value")
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      operation: "git_unstage_all",
      status: "effect_observed",
      verification: "not_verified",
      proposalDigest: record.value.proposalDigest,
      beforeSnapshotDigest: record.value.beforeSnapshotDigest,
      afterSnapshotDigest: record.value.afterSnapshotDigest,
      afterIndexDigest: record.value.afterIndexDigest,
      afterIndexMetadataDigest: record.value.afterIndexMetadataDigest,
      processObservationDigest: record.value.processObservationDigest,
      scratchCleanup: "observed_absent_before_return",
      limitations: gitUnstageAllLimitations,
    },
  }
}

export function parseGitUnstageAllDecision(input: unknown): GitUnstageAllParseResult<GitUnstageAllDecision> {
  const record = parseExactRecord(input, [
    "schemaVersion",
    "operation",
    "proposalDigest",
    "nonce",
    "decision",
    "decidedAt",
  ])
  if (!record.ok) return rejected("invalid_decision_shape")
  if (
    record.value.schemaVersion !== 1 ||
    record.value.operation !== "git_unstage_all" ||
    !isDigest(record.value.proposalDigest) ||
    !uuid(record.value.nonce) ||
    !timestamp(record.value.decidedAt) ||
    (record.value.decision !== "approved" && record.value.decision !== "rejected")
  ) {
    return rejected("invalid_decision_value")
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      operation: "git_unstage_all",
      proposalDigest: record.value.proposalDigest,
      nonce: record.value.nonce,
      decision: record.value.decision,
      decidedAt: record.value.decidedAt,
    },
  }
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
  "stagedCount",
  "baseline",
  "inspection",
  "executableDigest",
  "invocation",
  "repositoryWrites",
  "scratchWrites",
  "sealedExecutableScratch",
  "scratchCleanup",
  "authorizationConsumption",
  "preserves",
  "network",
  "splitIndex",
  "limitations",
] as const

function parsePreviewAuthority(input: unknown): GitUnstageAllParseResult<GitUnstageAllPreviewAuthority> {
  const record = parseExactRecord(input, previewKeys)
  if (!record.ok) return rejected("invalid_preview_shape")
  const baseline = parseBaseline(record.value.baseline)
  const inspection = parseInspection(record.value.inspection)
  const invocation = parseInvocation(record.value.invocation)
  const preserves = parsePreserves(record.value.preserves)
  const splitIndex = parseSplitIndex(record.value.splitIndex)
  const sealedExecutableScratch = parseSealedExecutableScratch(record.value.sealedExecutableScratch)
  if (
    !baseline ||
    !inspection ||
    !invocation ||
    !preserves ||
    !splitIndex ||
    !sealedExecutableScratch ||
    record.value.schemaVersion !== 1 ||
    record.value.operation !== "git_unstage_all" ||
    record.value.boundary !== "host_no_sandbox" ||
    record.value.boundaryLabel !== gitUnstageAllBoundaryLabel ||
    record.value.verification !== "not_verified" ||
    !safeAbsolutePath(record.value.workspaceRoot) ||
    !uuid(record.value.nonce) ||
    !validTimeline(record.value.createdAt, record.value.expiresAt) ||
    !safeAbsolutePath(record.value.runtimeScratch) ||
    !positiveBoundedCount(record.value.stagedCount) ||
    !isDigest(record.value.executableDigest) ||
    !exactRepositoryWrites(record.value.repositoryWrites) ||
    !exactScratchWrites(record.value.scratchWrites, record.value.runtimeScratch) ||
    record.value.scratchCleanup !== "required_before_return" ||
    record.value.authorizationConsumption !== "durable_operation_kernel_claim_required" ||
    record.value.network !== "not_requested_host_unrestricted" ||
    !exactLimitations(record.value.limitations)
  ) {
    return rejected("invalid_preview_value")
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      operation: "git_unstage_all",
      boundary: "host_no_sandbox",
      boundaryLabel: gitUnstageAllBoundaryLabel,
      verification: "not_verified",
      workspaceRoot: record.value.workspaceRoot,
      nonce: record.value.nonce,
      createdAt: String(record.value.createdAt),
      expiresAt: String(record.value.expiresAt),
      runtimeScratch: record.value.runtimeScratch,
      stagedCount: record.value.stagedCount,
      baseline,
      inspection,
      executableDigest: record.value.executableDigest,
      invocation,
      repositoryWrites: [".git/index", ".git/index.lock"],
      scratchWrites: [
        record.value.runtimeScratch,
        join(record.value.runtimeScratch, "index"),
        join(record.value.runtimeScratch, "index.lock"),
      ],
      sealedExecutableScratch,
      scratchCleanup: "required_before_return",
      authorizationConsumption: "durable_operation_kernel_claim_required",
      preserves,
      network: "not_requested_host_unrestricted",
      splitIndex,
      limitations: gitUnstageAllLimitations,
    },
  }
}

function parseBaseline(input: unknown): GitUnstageAllBaseline | null {
  const record = parseExactRecord(input, [
    "snapshotDigest",
    "rootIdentity",
    "gitIdentity",
    "indexDigest",
    "indexMetadataDigest",
    "head",
    "refsDigest",
    "worktreeDigest",
  ])
  if (!record.ok) return null
  const rootIdentity = parseIdentity(record.value.rootIdentity)
  const gitIdentity = parseIdentity(record.value.gitIdentity)
  const head = parseHead(record.value.head)
  if (
    !head ||
    !rootIdentity ||
    !gitIdentity ||
    !isDigest(record.value.snapshotDigest) ||
    !isDigest(record.value.indexDigest) ||
    !isDigest(record.value.indexMetadataDigest) ||
    !isDigest(record.value.refsDigest) ||
    !isDigest(record.value.worktreeDigest)
  ) {
    return null
  }
  return {
    snapshotDigest: record.value.snapshotDigest,
    rootIdentity,
    gitIdentity,
    indexDigest: record.value.indexDigest,
    indexMetadataDigest: record.value.indexMetadataDigest,
    head,
    refsDigest: record.value.refsDigest,
    worktreeDigest: record.value.worktreeDigest,
  }
}

function parseIdentity(input: unknown): GitUnstageAllBaseline["rootIdentity"] | null {
  const record = parseExactRecord(input, ["device", "inode"])
  if (
    !record.ok ||
    typeof record.value.device !== "string" ||
    !/^[1-9][0-9]*$/u.test(record.value.device) ||
    typeof record.value.inode !== "string" ||
    !/^[1-9][0-9]*$/u.test(record.value.inode)
  ) {
    return null
  }
  return { device: record.value.device, inode: record.value.inode }
}

function parseHead(input: unknown): GitUnstageAllBaseline["head"] | null {
  const symbolic = parseExactRecord(input, ["kind", "symbolicRef", "oid"])
  if (
    symbolic.ok &&
    symbolic.value.kind === "symbolic" &&
    safeRef(symbolic.value.symbolicRef) &&
    objectID(symbolic.value.oid)
  ) {
    return { kind: "symbolic", symbolicRef: symbolic.value.symbolicRef, oid: symbolic.value.oid }
  }
  const detached = parseExactRecord(input, ["kind", "oid"])
  if (!detached.ok || detached.value.kind !== "detached" || !objectID(detached.value.oid)) return null
  return { kind: "detached", oid: detached.value.oid }
}

function parseInspection(input: unknown): GitUnstageAllPreviewAuthority["inspection"] | null {
  const record = parseExactRecord(input, ["observationDigest", "reportDigest"])
  if (!record.ok || !isDigest(record.value.observationDigest) || !isDigest(record.value.reportDigest)) return null
  return { observationDigest: record.value.observationDigest, reportDigest: record.value.reportDigest }
}

function parseInvocation(input: unknown): GitUnstageAllPreviewAuthority["invocation"] | null {
  const record = parseExactRecord(input, [
    "argumentsDigest",
    "environmentDigest",
    "timeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
  ])
  if (
    !record.ok ||
    !isDigest(record.value.argumentsDigest) ||
    !isDigest(record.value.environmentDigest) ||
    !positiveLimit(record.value.timeoutMs, 60_000) ||
    !positiveLimit(record.value.maxStdoutBytes, 1024 * 1024) ||
    !positiveLimit(record.value.maxStderrBytes, 1024 * 1024)
  ) {
    return null
  }
  return {
    argumentsDigest: record.value.argumentsDigest,
    environmentDigest: record.value.environmentDigest,
    timeoutMs: record.value.timeoutMs,
    maxStdoutBytes: record.value.maxStdoutBytes,
    maxStderrBytes: record.value.maxStderrBytes,
  }
}

function parsePreserves(input: unknown): GitUnstageAllPreviewAuthority["preserves"] | null {
  const record = parseExactRecord(input, ["worktree", "head", "refs", "objectStore"])
  if (
    !record.ok ||
    record.value.worktree !== "required" ||
    record.value.head !== "required" ||
    record.value.refs !== "required" ||
    record.value.objectStore !== "not_observed"
  ) {
    return null
  }
  return { worktree: "required", head: "required", refs: "required", objectStore: "not_observed" }
}

function parseSplitIndex(input: unknown): GitUnstageAllPreviewAuthority["splitIndex"] | null {
  const record = parseExactRecord(input, ["config", "sharedIndexFiles", "indexExtension", "invocation"])
  if (
    !record.ok ||
    record.value.config !== "validated_after_claim" ||
    record.value.sharedIndexFiles !== "validated_after_claim" ||
    record.value.indexExtension !== "rejected_by_baseline" ||
    record.value.invocation !== "forced_disabled"
  ) {
    return null
  }
  return {
    config: "validated_after_claim",
    sharedIndexFiles: "validated_after_claim",
    indexExtension: "rejected_by_baseline",
    invocation: "forced_disabled",
  }
}

function parseSealedExecutableScratch(input: unknown): GitUnstageAllPreviewAuthority["sealedExecutableScratch"] | null {
  const record = parseExactRecord(input, ["root", "directoryPrefix", "executableName", "lifecycle", "purposes"])
  if (
    !record.ok ||
    record.value.root !== "/private/tmp" ||
    record.value.directoryPrefix !== "astra-git-exec-" ||
    record.value.executableName !== "git" ||
    record.value.lifecycle !== "created_after_claim_cleanup_required_before_return" ||
    !Array.isArray(record.value.purposes) ||
    record.value.purposes.length !== 4 ||
    record.value.purposes[0] !== "baseline_revalidation" ||
    record.value.purposes[1] !== "operation_execution" ||
    record.value.purposes[2] !== "post_state_observation" ||
    record.value.purposes[3] !== "independent_verification"
  ) {
    return null
  }
  return {
    root: "/private/tmp",
    directoryPrefix: "astra-git-exec-",
    executableName: "git",
    lifecycle: "created_after_claim_cleanup_required_before_return",
    purposes: ["baseline_revalidation", "operation_execution", "post_state_observation", "independent_verification"],
  }
}

function exactRepositoryWrites(input: unknown): input is GitUnstageAllPreviewAuthority["repositoryWrites"] {
  return Array.isArray(input) && input.length === 2 && input[0] === ".git/index" && input[1] === ".git/index.lock"
}

function exactScratchWrites(
  input: unknown,
  runtimeScratch: unknown,
): input is GitUnstageAllPreviewAuthority["scratchWrites"] {
  return (
    safeAbsolutePath(runtimeScratch) &&
    Array.isArray(input) &&
    input.length === 3 &&
    input[0] === runtimeScratch &&
    input[1] === join(runtimeScratch, "index") &&
    input[2] === join(runtimeScratch, "index.lock")
  )
}

function exactLimitations(input: unknown): input is typeof gitUnstageAllLimitations {
  return (
    Array.isArray(input) &&
    input.length === 2 &&
    input[0] === "host_network_not_isolated" &&
    input[1] === "object_store_not_observed"
  )
}

function safeAbsolutePath(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    Buffer.byteLength(input) <= 4096 &&
    isAbsolute(input) &&
    !/[\u0000-\u001f\u007f]/u.test(input)
  )
}

function positiveBoundedCount(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 && input <= 10_000
}

function positiveLimit(input: unknown, maximum: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 && input <= maximum
}

function validTimeline(createdAt: unknown, expiresAt: unknown) {
  if (!timestamp(createdAt) || !timestamp(expiresAt)) return false
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt)
  return lifetime > 0 && lifetime <= 5 * 60 * 1000
}

function timestamp(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input
}

function uuid(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input)
  )
}

function safeRef(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^refs\/[A-Za-z0-9][^\u0000-\u0020\u007f~^:?*[\\]*$/u.test(input) &&
    !input.includes("..") &&
    !input.endsWith(".")
  )
}

function objectID(input: unknown): input is string {
  return typeof input === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(input) && !/^0+$/u.test(input)
}

function isDigest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input)
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function rejected(reason: Exclude<GitUnstageAllParseResult<never>, { ok: true }>["reason"]) {
  return { ok: false as const, reason }
}
