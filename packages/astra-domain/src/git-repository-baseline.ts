import { createHash } from "node:crypto"

export type GitRepositoryBaselineLimits = Readonly<{
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  maxEntries: number
  maxBoundaryEntries: number
  maxBoundaryDurationMs: number
  maxGitBinaryBytes: number
  maxContentEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDurationMs: number
}>

export type GitRepositoryBaselineIdentity = Readonly<{
  canonicalPath: string
  device: string
  inode: string
}>

export type GitRepositoryBaselineHead =
  | Readonly<{ kind: "unborn"; symbolicRef: string }>
  | Readonly<{ kind: "symbolic"; symbolicRef: string; oid: string }>
  | Readonly<{ kind: "detached"; oid: string }>

export type GitRepositoryBaselineSnapshot = Readonly<{
  schemaVersion: 1
  mode: "bounded_read_only"
  durability: "ephemeral"
  verification: "not_verified"
  contentPolicy: Readonly<{
    tracked: "raw_content_type_and_executable"
    untracked: "raw_content_type_and_executable"
    symlinks: "raw_link_text_no_follow"
    ignored: "excluded"
    specialFiles: "blocked"
  }>
  root: GitRepositoryBaselineIdentity
  gitDirectory: GitRepositoryBaselineIdentity
  commonDirectory: GitRepositoryBaselineIdentity
  head: GitRepositoryBaselineHead
  refs: Readonly<{
    digest: `sha256:${string}`
    count: number
  }>
  index: Readonly<{
    digest: `sha256:${string}`
    metadataDigest: `sha256:${string}`
    entryCount: number
  }>
  worktree: Readonly<{
    digest: `sha256:${string}`
    ignored: "excluded"
    trackedPaths: number
    untrackedPaths: number
    contentEntries: number
    totalBytes: number
  }>
  metadata: Readonly<{
    digest: `sha256:${string}`
    fileCount: number
    totalBytes: number
    externalConfig: "unsupported"
  }>
  observer: Readonly<{
    adapter: "astra.git-baseline.v1"
    adapterDigest: `sha256:${string}`
    gitBinaryDigest: `sha256:${string}`
    observationDigest: `sha256:${string}`
  }>
  limits: GitRepositoryBaselineLimits
  snapshotDigest: `sha256:${string}`
}>

export type GitRepositoryBaselineSnapshotAuthority = Omit<GitRepositoryBaselineSnapshot, "snapshotDigest">

export const gitRepositoryBaselineBlockReasons = [
  "unsupported_platform",
  "invalid_limits",
  "invalid_snapshot",
  "schema_unsupported",
  "adapter_policy_changed",
  "workspace_path_not_absolute",
  "workspace_unreadable",
  "workspace_not_directory",
  "workspace_not_canonical",
  "workspace_identity_changed",
  "git_metadata_missing",
  "git_metadata_not_directory",
  "git_metadata_case_variant",
  "git_metadata_identity_changed",
  "git_commondir_unsupported",
  "git_alternates_unsupported",
  "git_metadata_symlink",
  "git_worktree_metadata_unsupported",
  "git_modules_metadata_unsupported",
  "ancestor_git_repository",
  "nested_git_repository",
  "boundary_entry_limit_exceeded",
  "boundary_time_limit_exceeded",
  "boundary_unreadable",
  "developer_directory_untrusted",
  "git_binary_untrusted",
  "sandbox_binary_untrusted",
  "sandbox_profile_rejected",
  "git_process_failed",
  "git_process_stderr",
  "git_process_timeout",
  "git_stdout_limit_exceeded",
  "git_stderr_limit_exceeded",
  "git_output_invalid_utf8",
  "git_output_malformed",
  "git_entry_limit_exceeded",
  "git_index_assume_unchanged",
  "git_index_skip_worktree",
  "git_index_fsmonitor_valid",
  "git_index_fsmonitor_uninspectable",
  "git_index_observation_mismatch",
  "git_index_format_unsupported",
  "git_index_extension_unsupported",
  "git_config_include_unsupported",
  "git_head_mismatch",
  "git_refs_malformed",
  "submodules_uninspected",
  "observation_changed",
  "git_ephemeral_copy_failed",
  "git_ephemeral_identity_changed",
  "git_ephemeral_cleanup_failed",
  "content_entry_limit_exceeded",
  "content_file_limit_exceeded",
  "content_total_limit_exceeded",
  "content_time_limit_exceeded",
  "content_path_unreadable",
  "content_path_traversal",
  "content_intermediate_symlink",
  "content_special_file",
  "content_identity_changed",
  "content_observation_changed",
  "metadata_content_changed",
] as const

export type GitRepositoryBaselineBlockReason = (typeof gitRepositoryBaselineBlockReasons)[number]

export type GitRepositoryBaselineCaptureResult =
  | Readonly<{ status: "complete"; snapshot: GitRepositoryBaselineSnapshot }>
  | Readonly<{
      status: "blocked"
      mode: "bounded_read_only"
      durability: "ephemeral"
      verification: "not_verified"
      workspaceRoot: string
      reason: GitRepositoryBaselineBlockReason
    }>

export type GitRepositoryBaselineRevalidationResult =
  | Readonly<{
      status: "current"
      expectedSnapshotDigest: `sha256:${string}`
      currentSnapshotDigest: `sha256:${string}`
    }>
  | Readonly<{
      status: "stale"
      expectedSnapshotDigest: `sha256:${string}`
      currentSnapshotDigest: `sha256:${string}`
    }>
  | Readonly<{
      status: "blocked"
      expectedSnapshotDigest: `sha256:${string}` | null
      reason: GitRepositoryBaselineBlockReason
    }>

export type GitRepositoryBaselineParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: "invalid_limits" | "invalid_snapshot" | "invalid_result" }>

const limitKeys = [
  "timeoutMs",
  "maxStdoutBytes",
  "maxStderrBytes",
  "maxEntries",
  "maxBoundaryEntries",
  "maxBoundaryDurationMs",
  "maxGitBinaryBytes",
  "maxContentEntries",
  "maxFileBytes",
  "maxTotalBytes",
  "maxDurationMs",
] as const

export function parseGitRepositoryBaselineLimits(
  input: unknown,
): GitRepositoryBaselineParseResult<GitRepositoryBaselineLimits> {
  if (!recordWithKeys(input, limitKeys)) return { ok: false, reason: "invalid_limits" }
  if (
    !positiveSafeInteger(input.timeoutMs) ||
    !positiveSafeInteger(input.maxStdoutBytes) ||
    !positiveSafeInteger(input.maxStderrBytes) ||
    !positiveSafeInteger(input.maxEntries) ||
    !positiveSafeInteger(input.maxBoundaryEntries) ||
    !positiveSafeInteger(input.maxBoundaryDurationMs) ||
    !positiveSafeInteger(input.maxGitBinaryBytes) ||
    !positiveSafeInteger(input.maxContentEntries) ||
    !positiveSafeInteger(input.maxFileBytes) ||
    !positiveSafeInteger(input.maxTotalBytes) ||
    !positiveSafeInteger(input.maxDurationMs)
  ) {
    return { ok: false, reason: "invalid_limits" }
  }
  return {
    ok: true,
    value: {
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: input.maxStdoutBytes,
      maxStderrBytes: input.maxStderrBytes,
      maxEntries: input.maxEntries,
      maxBoundaryEntries: input.maxBoundaryEntries,
      maxBoundaryDurationMs: input.maxBoundaryDurationMs,
      maxGitBinaryBytes: input.maxGitBinaryBytes,
      maxContentEntries: input.maxContentEntries,
      maxFileBytes: input.maxFileBytes,
      maxTotalBytes: input.maxTotalBytes,
      maxDurationMs: input.maxDurationMs,
    },
  }
}

export function parseGitRepositoryBaselineSnapshot(
  input: unknown,
): GitRepositoryBaselineParseResult<GitRepositoryBaselineSnapshot> {
  if (!validSnapshot(input)) return { ok: false, reason: "invalid_snapshot" }
  return { ok: true, value: copyGitRepositoryBaselineSnapshot(input) }
}

/** Computes the canonical digest that binds every authority-bearing baseline field. */
export function computeGitRepositoryBaselineSnapshotDigest(
  authority: GitRepositoryBaselineSnapshotAuthority,
): `sha256:${string}` {
  const hash = createHash("sha256")
  hash.update(`astra.git-repository-baseline.v1\0${canonicalJson(authority)}`)
  return `sha256:${hash.digest("hex")}`
}

function validSnapshot(input: unknown): input is GitRepositoryBaselineSnapshot {
  if (
    !recordWithKeys(input, [
      "schemaVersion",
      "mode",
      "durability",
      "verification",
      "contentPolicy",
      "root",
      "gitDirectory",
      "commonDirectory",
      "head",
      "refs",
      "index",
      "worktree",
      "metadata",
      "observer",
      "limits",
      "snapshotDigest",
    ])
  ) {
    return false
  }
  const parsedLimits = parseGitRepositoryBaselineLimits(input.limits)
  if (
    input.schemaVersion !== 1 ||
    input.mode !== "bounded_read_only" ||
    input.durability !== "ephemeral" ||
    input.verification !== "not_verified" ||
    !contentPolicy(input.contentPolicy) ||
    !identity(input.root) ||
    !identity(input.gitDirectory) ||
    !identity(input.commonDirectory) ||
    !head(input.head) ||
    !referenceList(input.refs) ||
    !index(input.index) ||
    !worktree(input.worktree) ||
    !metadata(input.metadata) ||
    !observer(input.observer) ||
    !parsedLimits.ok ||
    !digest(input.snapshotDigest)
  ) {
    return false
  }
  const authority: GitRepositoryBaselineSnapshotAuthority = {
    schemaVersion: input.schemaVersion,
    mode: input.mode,
    durability: input.durability,
    verification: input.verification,
    contentPolicy: input.contentPolicy,
    root: input.root,
    gitDirectory: input.gitDirectory,
    commonDirectory: input.commonDirectory,
    head: input.head,
    refs: input.refs,
    index: input.index,
    worktree: input.worktree,
    metadata: input.metadata,
    observer: input.observer,
    limits: parsedLimits.value,
  }
  return input.snapshotDigest === computeGitRepositoryBaselineSnapshotDigest(authority)
}

function copyGitRepositoryBaselineSnapshot(snapshot: GitRepositoryBaselineSnapshot): GitRepositoryBaselineSnapshot {
  return {
    schemaVersion: snapshot.schemaVersion,
    mode: snapshot.mode,
    durability: snapshot.durability,
    verification: snapshot.verification,
    contentPolicy: { ...snapshot.contentPolicy },
    root: { ...snapshot.root },
    gitDirectory: { ...snapshot.gitDirectory },
    commonDirectory: { ...snapshot.commonDirectory },
    head: { ...snapshot.head },
    refs: { ...snapshot.refs },
    index: { ...snapshot.index },
    worktree: { ...snapshot.worktree },
    metadata: { ...snapshot.metadata },
    observer: { ...snapshot.observer },
    limits: { ...snapshot.limits },
    snapshotDigest: snapshot.snapshotDigest,
  }
}

function contentPolicy(input: unknown): input is GitRepositoryBaselineSnapshot["contentPolicy"] {
  return (
    recordWithKeys(input, ["tracked", "untracked", "symlinks", "ignored", "specialFiles"]) &&
    input.tracked === "raw_content_type_and_executable" &&
    input.untracked === "raw_content_type_and_executable" &&
    input.symlinks === "raw_link_text_no_follow" &&
    input.ignored === "excluded" &&
    input.specialFiles === "blocked"
  )
}

export function parseGitRepositoryBaselineCaptureResult(
  input: unknown,
): GitRepositoryBaselineParseResult<GitRepositoryBaselineCaptureResult> {
  if (!plainRecord(input) || typeof input.status !== "string") return { ok: false, reason: "invalid_result" }
  if (input.status === "complete" && recordWithKeys(input, ["status", "snapshot"])) {
    const parsed = parseGitRepositoryBaselineSnapshot(input.snapshot)
    if (!parsed.ok) return { ok: false, reason: "invalid_result" }
    return { ok: true, value: { status: "complete", snapshot: parsed.value } }
  }
  if (
    input.status === "blocked" &&
    recordWithKeys(input, ["status", "mode", "durability", "verification", "workspaceRoot", "reason"]) &&
    input.mode === "bounded_read_only" &&
    input.durability === "ephemeral" &&
    input.verification === "not_verified" &&
    typeof input.workspaceRoot === "string" &&
    blockReason(input.reason)
  ) {
    return {
      ok: true,
      value: {
        status: "blocked",
        mode: "bounded_read_only",
        durability: "ephemeral",
        verification: "not_verified",
        workspaceRoot: input.workspaceRoot,
        reason: input.reason,
      },
    }
  }
  return { ok: false, reason: "invalid_result" }
}

export function parseGitRepositoryBaselineRevalidationResult(
  input: unknown,
): GitRepositoryBaselineParseResult<GitRepositoryBaselineRevalidationResult> {
  if (!plainRecord(input) || typeof input.status !== "string") return { ok: false, reason: "invalid_result" }
  if (
    (input.status === "current" || input.status === "stale") &&
    recordWithKeys(input, ["status", "expectedSnapshotDigest", "currentSnapshotDigest"]) &&
    digest(input.expectedSnapshotDigest) &&
    digest(input.currentSnapshotDigest) &&
    ((input.status === "current" && input.expectedSnapshotDigest === input.currentSnapshotDigest) ||
      (input.status === "stale" && input.expectedSnapshotDigest !== input.currentSnapshotDigest))
  ) {
    return {
      ok: true,
      value: {
        status: input.status,
        expectedSnapshotDigest: input.expectedSnapshotDigest,
        currentSnapshotDigest: input.currentSnapshotDigest,
      },
    }
  }
  if (
    input.status === "blocked" &&
    recordWithKeys(input, ["status", "expectedSnapshotDigest", "reason"]) &&
    (input.expectedSnapshotDigest === null || digest(input.expectedSnapshotDigest)) &&
    blockReason(input.reason)
  ) {
    return {
      ok: true,
      value: {
        status: "blocked",
        expectedSnapshotDigest: input.expectedSnapshotDigest,
        reason: input.reason,
      },
    }
  }
  return { ok: false, reason: "invalid_result" }
}

function identity(input: unknown): input is GitRepositoryBaselineIdentity {
  return (
    recordWithKeys(input, ["canonicalPath", "device", "inode"]) &&
    absolutePath(input.canonicalPath) &&
    decimalIdentity(input.device) &&
    decimalIdentity(input.inode)
  )
}

function head(input: unknown): input is GitRepositoryBaselineHead {
  if (!plainRecord(input) || typeof input.kind !== "string") return false
  if (input.kind === "unborn") {
    return recordWithKeys(input, ["kind", "symbolicRef"]) && referenceName(input.symbolicRef)
  }
  if (input.kind === "symbolic") {
    return (
      recordWithKeys(input, ["kind", "symbolicRef", "oid"]) && referenceName(input.symbolicRef) && objectId(input.oid)
    )
  }
  return input.kind === "detached" && recordWithKeys(input, ["kind", "oid"]) && objectId(input.oid)
}

function referenceList(input: unknown): input is GitRepositoryBaselineSnapshot["refs"] {
  return recordWithKeys(input, ["digest", "count"]) && digest(input.digest) && nonnegativeSafeInteger(input.count)
}

function index(input: unknown): input is GitRepositoryBaselineSnapshot["index"] {
  return (
    recordWithKeys(input, ["digest", "metadataDigest", "entryCount"]) &&
    digest(input.digest) &&
    digest(input.metadataDigest) &&
    nonnegativeSafeInteger(input.entryCount)
  )
}

function worktree(input: unknown): input is GitRepositoryBaselineSnapshot["worktree"] {
  return (
    recordWithKeys(input, ["digest", "ignored", "trackedPaths", "untrackedPaths", "contentEntries", "totalBytes"]) &&
    digest(input.digest) &&
    input.ignored === "excluded" &&
    nonnegativeSafeInteger(input.trackedPaths) &&
    nonnegativeSafeInteger(input.untrackedPaths) &&
    nonnegativeSafeInteger(input.contentEntries) &&
    nonnegativeSafeInteger(input.totalBytes)
  )
}

function metadata(input: unknown): input is GitRepositoryBaselineSnapshot["metadata"] {
  return (
    recordWithKeys(input, ["digest", "fileCount", "totalBytes", "externalConfig"]) &&
    digest(input.digest) &&
    input.externalConfig === "unsupported" &&
    nonnegativeSafeInteger(input.fileCount) &&
    nonnegativeSafeInteger(input.totalBytes)
  )
}

function observer(input: unknown): input is GitRepositoryBaselineSnapshot["observer"] {
  return (
    recordWithKeys(input, ["adapter", "adapterDigest", "gitBinaryDigest", "observationDigest"]) &&
    input.adapter === "astra.git-baseline.v1" &&
    digest(input.adapterDigest) &&
    digest(input.gitBinaryDigest) &&
    digest(input.observationDigest)
  )
}

function recordWithKeys<T extends string>(input: unknown, keys: ReadonlyArray<T>): input is Record<T, unknown> {
  return plainRecord(input) && Object.keys(input).sort().join("\0") === [...keys].sort().join("\0")
}

function plainRecord(input: unknown): input is Record<string, unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.getPrototypeOf(input) === Object.prototype
  )
}

function positiveSafeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
}

function nonnegativeSafeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
}

function decimalIdentity(input: unknown) {
  return typeof input === "string" && /^(0|[1-9][0-9]*)$/u.test(input)
}

function absolutePath(input: unknown) {
  return typeof input === "string" && input.startsWith("/") && !/[\u0000-\u001f\u007f]/u.test(input)
}

function referenceName(input: unknown): input is string {
  return typeof input === "string" && /^refs\/[A-Za-z0-9][^\u0000-\u0020\u007f~^:?*[\\]*$/u.test(input)
}

function objectId(input: unknown): input is string {
  return typeof input === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(input) && !/^0+$/u.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input)
}

function blockReason(input: unknown): input is GitRepositoryBaselineBlockReason {
  return gitRepositoryBaselineBlockReasons.some((reason) => reason === input)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
