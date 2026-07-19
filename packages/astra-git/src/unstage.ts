import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm, type FileHandle } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import {
  computeGitUnstageAllProposalDigest,
  gitUnstageAllBoundaryLabel,
  gitUnstageAllLimitations,
  parseGitUnstageAllDecision,
  parseGitUnstageAllObservation,
  parseGitUnstageAllPreview,
  type GitUnstageAllObservation,
  type GitUnstageAllPreview,
  type GitUnstageAllPreviewAuthority,
  type GitUnstageAllDecision,
} from "@astra/domain/git-control-mutation"
import {
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import {
  captureGitRepositoryBaseline,
  captureGitRepositoryBaselineWithDependencies,
  revalidateGitRepositoryBaseline,
  revalidateGitRepositoryBaselineWithDependencies,
} from "./baseline"
import {
  defaultGitInspectionLimits,
  GitEphemeralCleanupError,
  inspectGitWorkspaceWithDependencies,
  prepareTrustedBinaries,
  runSandboxedGit,
  validatePreparedGit,
  type TrustedBinaries,
} from "./inspect"
import type { GitInspectionResult } from "./types"

const executionLimits = {
  timeoutMs: 5_000,
  maxStdoutBytes: 16 * 1024,
  maxStderrBytes: 16 * 1024,
} as const
const authorizationLifetimeMs = 5 * 60 * 1000
const gitUnstageRuntimeBase = "/private/tmp"
const unstageObservationDependencies = {
  platform: process.platform,
  prepareTrustedBinaries: (
    workspaceRoot: string,
    limits: Parameters<typeof prepareTrustedBinaries>[1],
    deadline?: number,
  ) => prepareTrustedBinaries(workspaceRoot, limits, deadline, gitUnstageRuntimeBase),
  validatePreparedGit,
  runSandboxedGit,
}

export type GitUnstageAllBlockReason =
  | "unsupported_platform"
  | "invalid_input"
  | "baseline_stale"
  | "baseline_unavailable"
  | "unborn_head"
  | "nothing_staged"
  | "conflicts_present"
  | "inspection_unavailable"
  | "trusted_git_unavailable"
  | "trusted_git_changed"
  | "trusted_git_cleanup_failed"
  | "index_lock_present"
  | "split_index_unsupported"
  | "approved_index_changed"
  | "runtime_scratch_unavailable"
  | "proposal_expired"
  | "proposal_consumed"
  | "durable_claim_unavailable"

export type GitUnstageAllPreparationResult =
  | Readonly<{ status: "ready"; preview: GitUnstageAllPreview }>
  | Readonly<{ status: "blocked"; reason: GitUnstageAllBlockReason }>

export type GitUnstageAllConsent = GitUnstageAllDecision

export type GitUnstageAllExecutionResult =
  | Readonly<{ status: "denied_without_effect"; verification: "not_verified" }>
  | Readonly<{
      status: "blocked_without_effect"
      verification: "not_verified"
      reason: GitUnstageAllBlockReason
    }>
  | Readonly<{
      status: "effect_unknown"
      verification: "not_verified"
      reason:
        | "process_failed"
        | "process_timed_out"
        | "process_output_limit_exceeded"
        | "process_output_unexpected"
        | "post_state_unavailable"
        | "post_state_mismatch"
        | "trusted_git_cleanup_failed"
        | "post_state_changed"
        | "index_lock_present"
    }>
  | Readonly<{
      status: "effect_observed"
      verification: "not_verified"
      observation: GitUnstageAllObservation
    }>

export type GitUnstageAllVerificationResult =
  | Readonly<{
      status: "verified"
      verification: "independent_post_state"
      proposalDigest: `sha256:${string}`
      snapshotDigest: `sha256:${string}`
      limitations: typeof gitUnstageAllLimitations
    }>
  | Readonly<{
      status: "stale"
      verification: "not_verified"
      reason: "post_state_changed"
    }>
  | Readonly<{
      status: "blocked"
      verification: "not_verified"
      reason: "invalid_input" | "post_state_unavailable" | "post_state_mismatch" | "index_lock_present"
    }>

export type GitUnstageHostInvocation = Readonly<{
  executablePath: string
  arguments: ReadonlyArray<string>
  environment: Readonly<Record<string, string>>
  workingDirectory: "/"
  stdin: "ignore"
  limits: typeof executionLimits
}>

export type GitUnstageHostObservation =
  | Readonly<{ started: false }>
  | Readonly<{
      started: true
      termination: "exited" | "timed_out" | "output_limit_exceeded"
      exitCode: number | null
      stdout: Uint8Array
      stderr: Uint8Array
    }>

export type GitUnstageAllDependencies = Readonly<{
  platform: string
  inspect: (workspaceRoot: string) => Promise<GitInspectionResult>
  captureBaseline: (workspaceRoot: string) => ReturnType<typeof captureGitRepositoryBaseline>
  revalidateBaseline: (
    workspaceRoot: string,
    expected: GitRepositoryBaselineSnapshot,
  ) => ReturnType<typeof revalidateGitRepositoryBaseline>
  prepareTrustedGit: (workspaceRoot: string) => Promise<TrustedBinaries | null>
  validateTrustedGit: (binaries: TrustedBinaries) => Promise<boolean>
  runHostGit: (invocation: GitUnstageHostInvocation) => Promise<GitUnstageHostObservation>
  indexLockAbsent: (workspaceRoot: string) => Promise<boolean>
  claimProposal: (claim: GitUnstageAllDurableClaim) => Promise<GitUnstageAllDurableClaimResult>
}>

export type GitUnstageAllDurableClaim = Readonly<{
  proposalDigest: `sha256:${string}`
  nonce: string
  expiresAt: string
  decision: "approved"
}>

export type GitUnstageAllDurableClaimResult = "claimed" | "already_claimed" | "unavailable"

const productionDependencies: GitUnstageAllDependencies = {
  platform: process.platform,
  inspect: (workspaceRoot) => inspectGitWorkspaceWithDependencies(workspaceRoot, {}, unstageObservationDependencies),
  captureBaseline: (workspaceRoot) =>
    captureGitRepositoryBaselineWithDependencies(workspaceRoot, {}, unstageObservationDependencies),
  revalidateBaseline: (workspaceRoot, baseline) =>
    revalidateGitRepositoryBaselineWithDependencies(workspaceRoot, baseline, unstageObservationDependencies),
  prepareTrustedGit: (workspaceRoot) =>
    prepareTrustedBinaries(workspaceRoot, defaultGitInspectionLimits, undefined, gitUnstageRuntimeBase),
  validateTrustedGit: (binaries) => validatePreparedGit(binaries, defaultGitInspectionLimits),
  runHostGit,
  indexLockAbsent,
  async claimProposal() {
    return "unavailable"
  },
}

/** Prepares an exact index-only operation from the already observed Workspace
 * Gate facts. Preparation is static: it performs no filesystem access, starts
 * no process, and writes nothing before explicit consent. */
export async function prepareGitUnstageAll(
  workspaceRoot: string,
  expectedBaseline: GitRepositoryBaselineSnapshot,
  approvedInspection: Extract<GitInspectionResult, { status: "complete" }>,
  dependencies: GitUnstageAllDependencies = productionDependencies,
): Promise<GitUnstageAllPreparationResult> {
  if (dependencies.platform !== "darwin") return blocked("unsupported_platform")
  const baseline = parseExpectedBaseline(workspaceRoot, expectedBaseline)
  if (!baseline.ok) return blocked(baseline.reason)
  if (baseline.value.head.kind === "unborn") return blocked("unborn_head")
  const inspection = requireApprovedInspection(baseline.value, approvedInspection)
  if (!inspection) return blocked("inspection_unavailable")
  if (inspection.conflicts.length > 0) return blocked("conflicts_present")
  if (inspection.staged.length < 1) return blocked("nothing_staged")
  const nonce = randomUUID()
  const createdAt = new Date().toISOString()
  const runtimeScratch = join(gitUnstageRuntimeBase, `astra-git-unstage-${nonce}`)
  const invocation = buildGitUnstageAllInvocation(
    "/post-claim/sealed-git",
    baseline.value.root.canonicalPath,
    headOID(baseline.value),
    join(runtimeScratch, "index"),
  )
  const authority = makePreviewAuthority(
    baseline.value,
    inspection,
    baseline.value.observer.gitBinaryDigest,
    invocation,
    nonce,
    createdAt,
    new Date(Date.parse(createdAt) + authorizationLifetimeMs).toISOString(),
    runtimeScratch,
  )
  const preview = { ...authority, proposalDigest: computeGitUnstageAllProposalDigest(authority) }
  return { status: "ready", preview: freezePreview(preview) }
}

/** Executes one exact approved operation. A rejected decision never reaches the process seam. */
export async function executeGitUnstageAll(
  input: Readonly<{
    preview: GitUnstageAllPreview
    expectedBaseline: GitRepositoryBaselineSnapshot
    consent: GitUnstageAllConsent
  }>,
  dependencies: GitUnstageAllDependencies = productionDependencies,
): Promise<GitUnstageAllExecutionResult> {
  const parsed = parseGitUnstageAllPreview(input.preview)
  if (!parsed.ok) return blockedWithoutEffect("invalid_input")
  const consent = parseGitUnstageAllDecision(input.consent)
  if (
    !consent.ok ||
    consent.value.proposalDigest !== parsed.value.proposalDigest ||
    consent.value.nonce !== parsed.value.nonce
  ) {
    return blockedWithoutEffect("invalid_input")
  }
  if (
    Date.parse(consent.value.decidedAt) < Date.parse(parsed.value.createdAt) ||
    Date.parse(consent.value.decidedAt) > Date.parse(parsed.value.expiresAt) ||
    Date.now() > Date.parse(parsed.value.expiresAt)
  ) {
    return blockedWithoutEffect("proposal_expired")
  }
  const baseline = parseExpectedBaseline(parsed.value.workspaceRoot, input.expectedBaseline)
  if (!baseline.ok || !previewMatchesBaseline(parsed.value, baseline.value)) {
    return blockedWithoutEffect("invalid_input")
  }
  if (consent.value.decision === "rejected") {
    return { status: "denied_without_effect", verification: "not_verified" }
  }
  if (dependencies.platform !== "darwin") return blockedWithoutEffect("unsupported_platform")
  const claim = await dependencies
    .claimProposal({
      proposalDigest: parsed.value.proposalDigest,
      nonce: parsed.value.nonce,
      expiresAt: parsed.value.expiresAt,
      decision: "approved",
    })
    .catch(() => "unavailable" as const)
  if (claim === "already_claimed") return blockedWithoutEffect("proposal_consumed")
  if (claim !== "claimed") return blockedWithoutEffect("durable_claim_unavailable")
  if (!(await matchesRuntimeScratch(parsed.value))) return blockedWithoutEffect("invalid_input")
  const current = await dependencies.revalidateBaseline(parsed.value.workspaceRoot, baseline.value).catch(() => null)
  if (current?.status === "blocked" && current.reason === "git_ephemeral_cleanup_failed") {
    return unknown("trusted_git_cleanup_failed")
  }
  if (!current || current.status === "blocked") return blockedWithoutEffect("baseline_unavailable")
  if (current.status !== "current") return blockedWithoutEffect("baseline_stale")
  if (!(await dependencies.indexLockAbsent(parsed.value.workspaceRoot))) {
    return blockedWithoutEffect("index_lock_present")
  }

  const prepared = await dependencies.prepareTrustedGit(parsed.value.workspaceRoot).then(
    (binaries) => ({ binaries, cleanupUnknown: false }),
    (error) => ({ binaries: null, cleanupUnknown: error instanceof GitEphemeralCleanupError }),
  )
  if (prepared.cleanupUnknown) return unknown("trusted_git_cleanup_failed")
  const binaries = prepared.binaries
  if (!binaries) return blockedWithoutEffect("trusted_git_unavailable")
  const result = await executeWithTrustedGit(parsed.value, baseline.value, binaries, dependencies).catch(() =>
    unknown("process_failed"),
  )
  return (await binaries.cleanup().catch(() => false)) ? result : unknown("trusted_git_cleanup_failed")
}

/** Executes through the production host adapter while delegating the one-shot
 * authority claim to the durable Operation coordinator. */
export async function executeClaimedGitUnstageAll(
  input: Readonly<{
    preview: GitUnstageAllPreview
    expectedBaseline: GitRepositoryBaselineSnapshot
    consent: GitUnstageAllConsent
  }>,
  claimProposal: GitUnstageAllDependencies["claimProposal"],
): Promise<GitUnstageAllExecutionResult> {
  return executeGitUnstageAll(input, { ...productionDependencies, claimProposal })
}

async function executeWithTrustedGit(
  preview: GitUnstageAllPreview,
  baseline: GitRepositoryBaselineSnapshot,
  binaries: TrustedBinaries,
  dependencies: GitUnstageAllDependencies,
): Promise<GitUnstageAllExecutionResult> {
  if (
    binaries.gitIdentity.digest !== preview.executableDigest ||
    !matchesSealedExecutableScratch(preview, binaries) ||
    !(await dependencies.validateTrustedGit(binaries))
  ) {
    return blockedWithoutEffect("trusted_git_changed")
  }
  if (!(await inspectSplitIndexPolicy(preview.workspaceRoot, binaries))) {
    return blockedWithoutEffect("split_index_unsupported")
  }
  const invocation = buildGitUnstageAllInvocation(
    binaries.gitPath,
    preview.workspaceRoot,
    headOID(baseline),
    join(preview.runtimeScratch, "index"),
  )
  if (!previewMatchesInvocation(preview, invocation)) return blockedWithoutEffect("invalid_input")
  const finalAuthority = await dependencies.revalidateBaseline(preview.workspaceRoot, baseline).catch(() => null)
  if (finalAuthority?.status === "blocked" && finalAuthority.reason === "git_ephemeral_cleanup_failed") {
    return unknown("trusted_git_cleanup_failed")
  }
  if (!finalAuthority || finalAuthority.status === "blocked") return blockedWithoutEffect("baseline_unavailable")
  if (finalAuthority.status !== "current") return blockedWithoutEffect("baseline_stale")
  if (!(await dependencies.validateTrustedGit(binaries))) return blockedWithoutEffect("trusted_git_changed")
  if (!(await inspectSplitIndexPolicy(preview.workspaceRoot, binaries))) {
    return blockedWithoutEffect("split_index_unsupported")
  }
  const approvedIndex = await inspectIndexFile(preview.workspaceRoot, baseline).catch(() => null)
  if (!approvedIndex) return blockedWithoutEffect("approved_index_changed")

  const preparedScratch = await prepareIsolatedIndex(preview, approvedIndex).then(
    (scratch) => ({ scratch, cleanupUnknown: false }),
    (error) => ({ scratch: null, cleanupUnknown: error instanceof GitEphemeralCleanupError }),
  )
  if (preparedScratch.cleanupUnknown) return unknown("trusted_git_cleanup_failed")
  const scratch = preparedScratch.scratch
  if (!scratch) return blockedWithoutEffect("runtime_scratch_unavailable")
  let result: GitUnstageAllExecutionResult
  try {
    const process = await dependencies.runHostGit(invocation).catch(() => ({ started: false }) as const)
    result = await completePreparedExecution(
      preview,
      baseline,
      approvedIndex,
      scratch.indexPath,
      process,
      dependencies,
      binaries,
    )
  } finally {
    if (!(await cleanupRuntimeScratch(preview.runtimeScratch))) result = unknown("trusted_git_cleanup_failed")
  }
  return result
}

async function completePreparedExecution(
  preview: GitUnstageAllPreview,
  baseline: GitRepositoryBaselineSnapshot,
  approvedIndex: IndexAuthority,
  preparedIndexPath: string,
  process: GitUnstageHostObservation,
  dependencies: GitUnstageAllDependencies,
  binaries: TrustedBinaries,
): Promise<GitUnstageAllExecutionResult> {
  if (!process.started) return blockedWithoutEffect("trusted_git_unavailable")
  if (process.termination === "timed_out") return unknown("process_timed_out")
  if (process.termination === "output_limit_exceeded") return unknown("process_output_limit_exceeded")
  if (process.exitCode !== 0) return unknown("process_failed")
  if (process.stdout.byteLength > 0 || process.stderr.byteLength > 0) return unknown("process_output_unexpected")
  if (!(await installPreparedIndex(preview, approvedIndex, preparedIndexPath))) return unknown("post_state_changed")

  const post = await observeCoherentPostState(preview, dependencies, binaries)
  if (!post.ok) return unknown(post.reason)
  return {
    status: "effect_observed",
    verification: "not_verified",
    observation: {
      schemaVersion: 1,
      operation: "git_unstage_all",
      status: "effect_observed",
      verification: "not_verified",
      proposalDigest: preview.proposalDigest,
      beforeSnapshotDigest: baseline.snapshotDigest,
      afterSnapshotDigest: post.baseline.snapshotDigest,
      afterIndexDigest: post.baseline.index.digest,
      afterIndexMetadataDigest: post.baseline.index.metadataDigest,
      processObservationDigest: computeProcessObservationDigest(preview, post.baseline.snapshotDigest),
      scratchCleanup: "observed_absent_before_return",
      limitations: gitUnstageAllLimitations,
    },
  }
}

/** Independently recaptures the repository; it never trusts the process exit code. */
export async function verifyGitUnstageAll(
  input: Readonly<{ preview: GitUnstageAllPreview; observation: GitUnstageAllObservation }>,
  dependencies: GitUnstageAllDependencies = productionDependencies,
): Promise<GitUnstageAllVerificationResult> {
  const preview = parseGitUnstageAllPreview(input.preview)
  const observation = parseGitUnstageAllObservation(input.observation)
  if (
    !preview.ok ||
    !observation.ok ||
    observation.value.proposalDigest !== preview.value.proposalDigest ||
    observation.value.beforeSnapshotDigest !== preview.value.baseline.snapshotDigest ||
    observation.value.processObservationDigest !==
      computeProcessObservationDigest(preview.value, observation.value.afterSnapshotDigest)
  ) {
    return verificationBlocked("invalid_input")
  }
  if (await pathExists(preview.value.runtimeScratch).catch(() => true)) {
    return verificationBlocked("post_state_mismatch")
  }
  const prepared = await dependencies.prepareTrustedGit(preview.value.workspaceRoot).then(
    (binaries) => ({ binaries, cleanupUnknown: false }),
    (error) => ({ binaries: null, cleanupUnknown: error instanceof GitEphemeralCleanupError }),
  )
  if (prepared.cleanupUnknown) return verificationBlocked("post_state_unavailable")
  const binaries = prepared.binaries
  if (!binaries) return verificationBlocked("post_state_unavailable")
  if (
    binaries.gitIdentity.digest !== preview.value.executableDigest ||
    !matchesSealedExecutableScratch(preview.value, binaries) ||
    !(await dependencies.validateTrustedGit(binaries).catch(() => false))
  ) {
    await binaries.cleanup().catch(() => false)
    return verificationBlocked("post_state_unavailable")
  }
  const coherent = await observeCoherentPostState(preview.value, dependencies, binaries).catch(() => null)
  const cleanupSucceeded = await binaries.cleanup().catch(() => false)
  if (!cleanupSucceeded || !coherent) {
    return verificationBlocked("post_state_unavailable")
  }
  if (!coherent.ok) {
    if (coherent.reason === "index_lock_present") return verificationBlocked("index_lock_present")
    if (coherent.reason === "post_state_changed") {
      return { status: "stale", verification: "not_verified", reason: "post_state_changed" }
    }
    return verificationBlocked(coherent.reason)
  }
  if (
    coherent.baseline.snapshotDigest !== observation.value.afterSnapshotDigest ||
    coherent.baseline.index.digest !== observation.value.afterIndexDigest ||
    coherent.baseline.index.metadataDigest !== observation.value.afterIndexMetadataDigest ||
    observation.value.processObservationDigest !==
      computeProcessObservationDigest(preview.value, observation.value.afterSnapshotDigest)
  ) {
    return { status: "stale", verification: "not_verified", reason: "post_state_changed" }
  }
  return {
    status: "verified",
    verification: "independent_post_state",
    proposalDigest: preview.value.proposalDigest,
    snapshotDigest: coherent.baseline.snapshotDigest,
    limitations: gitUnstageAllLimitations,
  }
}

export function buildGitUnstageAllInvocation(
  executablePath: string,
  workspaceRoot: string,
  sourceOID: string,
  isolatedIndexPath = "/private/tmp/astra-git-unstage-authorized/index",
): GitUnstageHostInvocation {
  return {
    executablePath,
    arguments: [
      "--no-pager",
      "--no-lazy-fetch",
      "--no-optional-locks",
      "--no-replace-objects",
      `--git-dir=${join(workspaceRoot, ".git")}`,
      `--work-tree=${workspaceRoot}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.preloadIndex=false",
      "-c",
      "core.splitIndex=false",
      "-c",
      "core.filemode=true",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.excludesFile=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "core.editor=true",
      "-c",
      "sequence.editor=true",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "interactive.diffFilter=",
      "-c",
      "submodule.recurse=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "restore",
      "--staged",
      `--source=${sourceOID}`,
      "--",
      ":(top)",
    ],
    environment: {
      ...baseGitEnvironment(),
      GIT_INDEX_FILE: isolatedIndexPath,
    },
    workingDirectory: "/",
    stdin: "ignore",
    limits: executionLimits,
  }
}

async function runHostGit(invocation: GitUnstageHostInvocation): Promise<GitUnstageHostObservation> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([invocation.executablePath, ...invocation.arguments], {
      cwd: invocation.workingDirectory,
      env: { ...invocation.environment },
      stdin: invocation.stdin,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch {
    return { started: false }
  }
  const stdoutStream = child.stdout
  const stderrStream = child.stderr
  if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
    killProcessGroup(child)
    await child.exited.catch(() => null)
    return {
      started: true,
      termination: "output_limit_exceeded",
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    }
  }

  let timedOut = false
  let outputLimited = false
  const timeout = setTimeout(() => {
    timedOut = true
    killProcessGroup(child)
  }, invocation.limits.timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(stdoutStream, invocation.limits.maxStdoutBytes, () => {
      outputLimited = true
      killProcessGroup(child)
    }),
    readBounded(stderrStream, invocation.limits.maxStderrBytes, () => {
      outputLimited = true
      killProcessGroup(child)
    }),
  ])
  clearTimeout(timeout)
  return {
    started: true,
    termination: timedOut ? "timed_out" : outputLimited ? "output_limit_exceeded" : "exited",
    exitCode,
    stdout,
    stderr,
  }
}

type IndexAuthority = Readonly<{
  device: string
  inode: string
  size: number
  digest: `sha256:${string}`
  bytes: Uint8Array
}>

async function inspectIndexFile(
  workspaceRoot: string,
  baseline: GitRepositoryBaselineSnapshot,
): Promise<IndexAuthority | null> {
  const authority = await inspectRegularFile(join(workspaceRoot, ".git", "index"), baseline.limits.maxFileBytes)
  if (!authority || authority.digest !== baseline.index.metadataDigest) return null
  return authority
}

async function inspectRegularFile(path: string, maximumBytes: number): Promise<IndexAuthority | null> {
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    const size = Number(before.size)
    if (!before.isFile() || !Number.isSafeInteger(size) || size < 1 || size > maximumBytes) {
      return null
    }
    const bytes = await readExact(handle, size)
    if (!bytes) return null
    const after = await handle.stat({ bigint: true })
    if (!sameOpenedFacts(before, after)) return null
    return {
      device: String(after.dev),
      inode: String(after.ino),
      size,
      digest: digestBytes(bytes),
      bytes,
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readExact(handle: FileHandle, size: number) {
  const bytes = Buffer.allocUnsafe(size)
  let position = 0
  while (position < size) {
    const chunk = await handle.read(bytes, position, Math.min(64 * 1024, size - position), position)
    if (chunk.bytesRead < 1) return null
    position += chunk.bytesRead
  }
  return new Uint8Array(bytes)
}

function sameOpenedFacts(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameIndexAuthority(
  left: Pick<IndexAuthority, "device" | "inode" | "size" | "digest">,
  right:
    | Pick<IndexAuthority, "device" | "inode" | "size" | "digest">
    | Readonly<{ device: string; inode: string; size: number }>,
) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    (!("digest" in right) || left.digest === right.digest)
  )
}

async function prepareIsolatedIndex(preview: GitUnstageAllPreview, approvedIndex: IndexAuthority) {
  if (!(await matchesRuntimeScratch(preview)) || (await pathExists(preview.runtimeScratch))) return null
  const attempt = await createIsolatedIndex(preview, approvedIndex)
  if (attempt.scratch) return attempt.scratch
  if (attempt.created && !(await cleanupRuntimeScratch(preview.runtimeScratch))) {
    throw new GitEphemeralCleanupError()
  }
  return null
}

async function createIsolatedIndex(preview: GitUnstageAllPreview, approvedIndex: IndexAuthority) {
  let created = false
  try {
    await mkdir(preview.runtimeScratch, { mode: 0o700 })
    created = true
    await chmod(preview.runtimeScratch, 0o700)
    const directory = await lstat(preview.runtimeScratch)
    const owner = process.getuid?.()
    if (
      owner === undefined ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== owner ||
      (directory.mode & 0o777) !== 0o700 ||
      (await realpath(preview.runtimeScratch)) !== preview.runtimeScratch
    ) {
      return { created, scratch: null }
    }
    const indexPath = join(preview.runtimeScratch, "index")
    const handle = await open(
      indexPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(approvedIndex.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const prepared = await inspectRegularFile(indexPath, approvedIndex.size)
    if (!prepared || prepared.digest !== approvedIndex.digest || prepared.size !== approvedIndex.size) {
      return { created, scratch: null }
    }
    return { created, scratch: { indexPath } as const }
  } catch {
    return { created, scratch: null }
  }
}

async function installPreparedIndex(
  preview: GitUnstageAllPreview,
  approvedIndex: IndexAuthority,
  preparedIndexPath: string,
) {
  if (!(await scratchContainsOnlyPreparedIndex(preview.runtimeScratch))) return false
  const prepared = await inspectRegularFile(preparedIndexPath, approvedIndex.size)
  if (!prepared) return false
  const gitDirectory = join(preview.workspaceRoot, ".git")
  const lockPath = join(gitDirectory, "index.lock")
  const indexPath = join(gitDirectory, "index")
  let lock: FileHandle | null = null
  let ownsLock = false
  let installed = false
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    ownsLock = true
    const current = await inspectRegularFile(indexPath, approvedIndex.size)
    if (!current || !sameIndexAuthority(current, approvedIndex)) return false
    await lock.writeFile(prepared.bytes)
    await lock.sync()
    const final = await inspectRegularFile(indexPath, approvedIndex.size)
    if (!final || !sameIndexAuthority(final, approvedIndex)) return false
    await lock.close()
    lock = null
    await rename(lockPath, indexPath)
    installed = true
    ownsLock = false
    const directory = await open(gitDirectory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return true
  } catch {
    return false
  } finally {
    await lock?.close().catch(() => undefined)
    if (!installed && ownsLock) await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function scratchContainsOnlyPreparedIndex(runtimeScratch: string) {
  let directory: Awaited<ReturnType<typeof opendir>> | null = null
  try {
    directory = await opendir(runtimeScratch)
    const names: Array<string> = []
    for await (const entry of directory) {
      names.push(entry.name)
      if (names.length > 1 || entry.name !== "index" || !entry.isFile()) return false
    }
    return names.length === 1
  } catch {
    return false
  } finally {
    if (directory) {
      try {
        await directory.close()
      } catch {
        // The async iterator closes a fully consumed directory.
      }
    }
  }
}

async function cleanupRuntimeScratch(runtimeScratch: string) {
  try {
    const facts = await lstat(runtimeScratch)
    const owner = process.getuid?.()
    if (
      owner === undefined ||
      !facts.isDirectory() ||
      facts.isSymbolicLink() ||
      facts.uid !== owner ||
      (await realpath(runtimeScratch)) !== runtimeScratch
    ) {
      return false
    }
    await rm(runtimeScratch, { recursive: true, force: true })
    return !(await pathExists(runtimeScratch))
  } catch (error) {
    return fileSystemCode(error) === "ENOENT"
  }
}

async function matchesRuntimeScratch(preview: Pick<GitUnstageAllPreview, "nonce" | "runtimeScratch">) {
  const base = await realpath(gitUnstageRuntimeBase).catch(() => null)
  return base === gitUnstageRuntimeBase && preview.runtimeScratch === join(base, `astra-git-unstage-${preview.nonce}`)
}

async function inspectSplitIndexPolicy(workspaceRoot: string, binaries: TrustedBinaries) {
  if (await hasSharedIndexFile(join(workspaceRoot, ".git"))) return false
  const observation = await runHostGit(buildSplitIndexInspectionInvocation(binaries.gitPath, workspaceRoot)).catch(
    () => ({ started: false }) as const,
  )
  return (
    observation.started &&
    observation.termination === "exited" &&
    observation.exitCode === 1 &&
    observation.stdout.byteLength === 0 &&
    observation.stderr.byteLength === 0
  )
}

function buildSplitIndexInspectionInvocation(executablePath: string, workspaceRoot: string): GitUnstageHostInvocation {
  return {
    executablePath,
    arguments: [
      "--no-pager",
      "--no-lazy-fetch",
      "--no-optional-locks",
      "--no-replace-objects",
      `--git-dir=${join(workspaceRoot, ".git")}`,
      `--work-tree=${workspaceRoot}`,
      "config",
      "--local",
      "--no-includes",
      "--get-all",
      "core.splitIndex",
    ],
    environment: baseGitEnvironment(),
    workingDirectory: "/",
    stdin: "ignore",
    limits: executionLimits,
  }
}

async function hasSharedIndexFile(gitDirectory: string) {
  let directory: Awaited<ReturnType<typeof opendir>> | null = null
  const deadline = performance.now() + 2_000
  let count = 0
  try {
    directory = await opendir(gitDirectory)
    for await (const entry of directory) {
      count += 1
      if (count > 10_000 || performance.now() > deadline) return true
      if (entry.name.toLowerCase().startsWith("sharedindex.")) return true
    }
    return false
  } catch {
    return true
  } finally {
    if (directory) {
      try {
        await directory.close()
      } catch {
        // The async iterator closes a fully consumed directory.
      }
    }
  }
}

function baseGitEnvironment(): Readonly<Record<string, string>> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ADVICE: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PATH: "/usr/bin:/bin",
  }
}

function killProcessGroup(child: ReturnType<typeof Bun.spawn>) {
  const pid = child.pid
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL")
      return
    } catch {
      // Fall through when the child exited before its process group could be signalled.
    }
  }
  child.kill("SIGKILL")
}

async function pathExists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (fileSystemCode(error) === "ENOENT") return false
    throw error
  }
}

function fileSystemCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

async function observeCoherentPostState(
  preview: GitUnstageAllPreview,
  dependencies: GitUnstageAllDependencies,
  binaries: TrustedBinaries,
): Promise<
  | Readonly<{ ok: true; baseline: GitRepositoryBaselineSnapshot }>
  | Readonly<{
      ok: false
      reason: "post_state_unavailable" | "post_state_mismatch" | "post_state_changed" | "index_lock_present"
    }>
> {
  if (!(await dependencies.indexLockAbsent(preview.workspaceRoot).catch(() => false))) {
    return { ok: false, reason: "index_lock_present" }
  }
  if (!(await inspectSplitIndexPolicy(preview.workspaceRoot, binaries))) {
    return { ok: false, reason: "post_state_mismatch" }
  }
  const first = await dependencies.captureBaseline(preview.workspaceRoot).catch(() => null)
  if (!first || first.status !== "complete") return { ok: false, reason: "post_state_unavailable" }
  const inspection = await dependencies.inspect(preview.workspaceRoot).catch(() => null)
  if (!inspection || inspection.status !== "complete") return { ok: false, reason: "post_state_unavailable" }
  const second = await dependencies.captureBaseline(preview.workspaceRoot).catch(() => null)
  if (!second || second.status !== "complete") return { ok: false, reason: "post_state_unavailable" }
  if (first.snapshot.snapshotDigest !== second.snapshot.snapshotDigest) {
    return { ok: false, reason: "post_state_changed" }
  }
  if (!(await dependencies.indexLockAbsent(preview.workspaceRoot).catch(() => false))) {
    return { ok: false, reason: "index_lock_present" }
  }
  if (!(await inspectSplitIndexPolicy(preview.workspaceRoot, binaries))) {
    return { ok: false, reason: "post_state_mismatch" }
  }
  if (!validPostState(preview, second.snapshot, inspection)) return { ok: false, reason: "post_state_mismatch" }
  return { ok: true, baseline: second.snapshot }
}

function validPostState(
  preview: GitUnstageAllPreview,
  baseline: GitRepositoryBaselineSnapshot,
  inspection: GitInspectionResult,
) {
  return (
    inspection.status === "complete" &&
    inspection.workspaceRoot === preview.workspaceRoot &&
    inspection.staged.length === 0 &&
    inspection.conflicts.length === 0 &&
    baseline.root.canonicalPath === preview.workspaceRoot &&
    baseline.root.device === preview.baseline.rootIdentity.device &&
    baseline.root.inode === preview.baseline.rootIdentity.inode &&
    baseline.gitDirectory.device === preview.baseline.gitIdentity.device &&
    baseline.gitDirectory.inode === preview.baseline.gitIdentity.inode &&
    sameHead(baseline.head, preview.baseline.head) &&
    baseline.refs.digest === preview.baseline.refsDigest &&
    baseline.worktree.digest === preview.baseline.worktreeDigest &&
    baseline.index.digest !== preview.baseline.indexDigest
  )
}

function makePreviewAuthority(
  baseline: GitRepositoryBaselineSnapshot,
  inspection: Extract<GitInspectionResult, { status: "complete" }>,
  executableDigest: `sha256:${string}`,
  invocation: GitUnstageHostInvocation,
  nonce: string,
  createdAt: string,
  expiresAt: string,
  runtimeScratch: string,
): GitUnstageAllPreviewAuthority {
  if (baseline.head.kind === "unborn") throw new TypeError("An unborn HEAD cannot be an unstage source")
  return {
    schemaVersion: 1,
    operation: "git_unstage_all",
    boundary: "host_no_sandbox",
    boundaryLabel: gitUnstageAllBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: baseline.root.canonicalPath,
    nonce,
    createdAt,
    expiresAt,
    runtimeScratch,
    stagedCount: inspection.staged.length,
    baseline: {
      snapshotDigest: baseline.snapshotDigest,
      rootIdentity: { device: baseline.root.device, inode: baseline.root.inode },
      gitIdentity: { device: baseline.gitDirectory.device, inode: baseline.gitDirectory.inode },
      indexDigest: baseline.index.digest,
      indexMetadataDigest: baseline.index.metadataDigest,
      head: baseline.head,
      refsDigest: baseline.refs.digest,
      worktreeDigest: baseline.worktree.digest,
    },
    inspection: { observationDigest: inspection.outputDigest, reportDigest: inspection.reportDigest },
    executableDigest,
    invocation: {
      argumentsDigest: digest(JSON.stringify(invocation.arguments)),
      environmentDigest: digest(JSON.stringify(invocation.environment)),
      ...invocation.limits,
    },
    repositoryWrites: [".git/index", ".git/index.lock"],
    scratchWrites: [runtimeScratch, join(runtimeScratch, "index"), join(runtimeScratch, "index.lock")],
    sealedExecutableScratch: {
      root: gitUnstageRuntimeBase,
      directoryPrefix: "astra-git-exec-",
      executableName: "git",
      lifecycle: "created_after_claim_cleanup_required_before_return",
      purposes: ["baseline_revalidation", "operation_execution", "post_state_observation", "independent_verification"],
    },
    scratchCleanup: "required_before_return",
    authorizationConsumption: "durable_operation_kernel_claim_required",
    preserves: { worktree: "required", head: "required", refs: "required", objectStore: "not_observed" },
    network: "not_requested_host_unrestricted",
    splitIndex: {
      config: "validated_after_claim",
      sharedIndexFiles: "validated_after_claim",
      indexExtension: "rejected_by_baseline",
      invocation: "forced_disabled",
    },
    limitations: gitUnstageAllLimitations,
  }
}

function previewMatchesBaseline(preview: GitUnstageAllPreview, baseline: GitRepositoryBaselineSnapshot) {
  return (
    baseline.head.kind !== "unborn" &&
    preview.workspaceRoot === baseline.root.canonicalPath &&
    preview.baseline.snapshotDigest === baseline.snapshotDigest &&
    preview.baseline.rootIdentity.device === baseline.root.device &&
    preview.baseline.rootIdentity.inode === baseline.root.inode &&
    preview.baseline.gitIdentity.device === baseline.gitDirectory.device &&
    preview.baseline.gitIdentity.inode === baseline.gitDirectory.inode &&
    preview.baseline.indexDigest === baseline.index.digest &&
    preview.baseline.indexMetadataDigest === baseline.index.metadataDigest &&
    sameHead(preview.baseline.head, baseline.head) &&
    preview.baseline.refsDigest === baseline.refs.digest &&
    preview.baseline.worktreeDigest === baseline.worktree.digest
  )
}

function previewMatchesInvocation(preview: GitUnstageAllPreview, invocation: GitUnstageHostInvocation) {
  return (
    preview.invocation.argumentsDigest === digest(JSON.stringify(invocation.arguments)) &&
    preview.invocation.environmentDigest === digest(JSON.stringify(invocation.environment)) &&
    preview.invocation.timeoutMs === invocation.limits.timeoutMs &&
    preview.invocation.maxStdoutBytes === invocation.limits.maxStdoutBytes &&
    preview.invocation.maxStderrBytes === invocation.limits.maxStderrBytes
  )
}

function matchesSealedExecutableScratch(preview: GitUnstageAllPreview, binaries: TrustedBinaries) {
  const directory = dirname(binaries.gitPath)
  const directoryName = basename(directory)
  return (
    dirname(directory) === preview.sealedExecutableScratch.root &&
    directoryName.startsWith(preview.sealedExecutableScratch.directoryPrefix) &&
    directoryName.length > preview.sealedExecutableScratch.directoryPrefix.length &&
    directoryName.length <= preview.sealedExecutableScratch.directoryPrefix.length + 64 &&
    basename(binaries.gitPath) === preview.sealedExecutableScratch.executableName
  )
}

function parseExpectedBaseline(
  workspaceRoot: string,
  input: GitRepositoryBaselineSnapshot,
): Readonly<{ ok: true; value: GitRepositoryBaselineSnapshot }> | Readonly<{ ok: false; reason: "invalid_input" }> {
  const parsed = parseGitRepositoryBaselineSnapshot(input)
  if (!parsed.ok) return { ok: false, reason: "invalid_input" as const }
  if (resolve(workspaceRoot) !== parsed.value.root.canonicalPath) {
    return { ok: false, reason: "invalid_input" as const }
  }
  return { ok: true, value: parsed.value } as const
}

function requireApprovedInspection(
  baseline: GitRepositoryBaselineSnapshot,
  inspection: Extract<GitInspectionResult, { status: "complete" }>,
) {
  if (
    inspection.status !== "complete" ||
    inspection.mode !== "bounded_read_only" ||
    inspection.baseline !== "not_captured" ||
    !Object.is(Reflect.get(inspection, "activationAllowed"), false) ||
    inspection.verification !== "not_verified" ||
    inspection.submodules !== "not_inspected" ||
    inspection.workspaceRoot !== baseline.root.canonicalPath ||
    !Array.isArray(inspection.staged) ||
    !Array.isArray(inspection.unstaged) ||
    !Array.isArray(inspection.untracked) ||
    !Array.isArray(inspection.conflicts) ||
    typeof inspection.diff !== "object" ||
    inspection.diff === null ||
    !Number.isSafeInteger(inspection.entryCount) ||
    inspection.entryCount < 0 ||
    inspection.entryCount > baseline.limits.maxEntries ||
    !digestValue(inspection.outputDigest) ||
    !digestValue(inspection.reportDigest) ||
    inspection.diff.source !== "status_porcelain_v2" ||
    inspection.diff.format !== "metadata_only" ||
    inspection.diff.renames !== "disabled" ||
    inspection.diff.durability !== "ephemeral" ||
    inspection.diff.verification !== "not_verified" ||
    inspection.diff.untrackedContent !== "not_inspected" ||
    inspection.diff.conflictContent !== "not_inspected" ||
    inspection.diff.observationDigest !== inspection.outputDigest
  ) {
    return null
  }
  return inspection
}

function headOID(baseline: GitRepositoryBaselineSnapshot) {
  if (baseline.head.kind === "unborn") throw new TypeError("An unborn HEAD cannot be an unstage source")
  return baseline.head.oid
}

function sameHead(left: GitRepositoryBaselineSnapshot["head"], right: GitRepositoryBaselineSnapshot["head"]) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function indexLockAbsent(workspaceRoot: string) {
  try {
    await lstat(join(workspaceRoot, ".git", "index.lock"))
    return false
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onLimit: () => void) {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) return Buffer.concat(chunks, length)
    length += next.value.byteLength
    if (length > limit) {
      onLimit()
      return new Uint8Array()
    }
    chunks.push(next.value)
  }
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function digestValue(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input)
}

function computeProcessObservationDigest(preview: GitUnstageAllPreview, afterSnapshotDigest: `sha256:${string}`) {
  return digest(
    `astra.git-unstage-process-observation.v1\0${preview.proposalDigest}\0${afterSnapshotDigest}\0prepared-index-installed\0stdout:0\0stderr:0`,
  )
}

function freezePreview(preview: GitUnstageAllPreview): GitUnstageAllPreview {
  Object.freeze(preview.baseline.rootIdentity)
  Object.freeze(preview.baseline.gitIdentity)
  Object.freeze(preview.baseline.head)
  Object.freeze(preview.baseline)
  Object.freeze(preview.inspection)
  Object.freeze(preview.invocation)
  Object.freeze(preview.repositoryWrites)
  Object.freeze(preview.scratchWrites)
  Object.freeze(preview.sealedExecutableScratch.purposes)
  Object.freeze(preview.sealedExecutableScratch)
  Object.freeze(preview.preserves)
  Object.freeze(preview.splitIndex)
  Object.freeze(preview.limitations)
  return Object.freeze(preview)
}

function blocked(reason: GitUnstageAllBlockReason): GitUnstageAllPreparationResult {
  return { status: "blocked", reason }
}

function blockedWithoutEffect(reason: GitUnstageAllBlockReason): GitUnstageAllExecutionResult {
  return { status: "blocked_without_effect", verification: "not_verified", reason }
}

function unknown(
  reason: Extract<GitUnstageAllExecutionResult, { status: "effect_unknown" }>["reason"],
): GitUnstageAllExecutionResult {
  return { status: "effect_unknown", verification: "not_verified", reason }
}

function verificationBlocked(
  reason: Extract<GitUnstageAllVerificationResult, { status: "blocked" }>["reason"],
): GitUnstageAllVerificationResult {
  return { status: "blocked", verification: "not_verified", reason }
}
