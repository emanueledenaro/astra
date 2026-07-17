import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  computeGitStageInventoryDigest,
  computeGitStageProposalDigest,
  gitStageBoundaryLabel,
  gitStageLimitations,
  parseGitStageDecision,
  parseGitStageInventory,
  parseGitStageObservation,
  parseGitStagePreview,
  type GitStageCandidate,
  type GitStageDecision,
  type GitStageInventory,
  type GitStageInventoryAuthority,
  type GitStageObservation,
  type GitStagePreview,
  type GitStagePreviewAuthority,
} from "../../astra-domain/src/git-stage-mutation"
import {
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import { captureGitRepositoryBaseline, revalidateGitRepositoryBaseline } from "./baseline"
import {
  defaultGitInspectionLimits,
  GitEphemeralCleanupError,
  prepareTrustedBinaries,
  runSandboxedGit,
  validatePreparedGit,
  type TrustedBinaries,
} from "./inspect"
import { parseGitIndexOutput, type ParsedGitIndexEntry } from "./parser"
import type { GitInspectionResult } from "./types"

const authorizationLifetimeMs = 5 * 60 * 1_000
const stageRuntimeBase = "/private/tmp"
const stageLimits = { timeoutMs: 5_000, maxStdoutBytes: 16 * 1024, maxStderrBytes: 16 * 1024 } as const

export type GitStageBlockReason =
  | "unsupported_platform"
  | "invalid_input"
  | "inventory_unavailable"
  | "inventory_stale"
  | "nothing_selected"
  | "too_many_candidates"
  | "unborn_head"
  | "conflicts_present"
  | "rename_unsupported"
  | "special_file_unsupported"
  | "transforming_attributes_unsupported"
  | "split_index_unsupported"
  | "index_lock_present"
  | "baseline_stale"
  | "baseline_unavailable"
  | "approved_index_changed"
  | "selected_content_changed"
  | "trusted_git_unavailable"
  | "trusted_git_changed"
  | "trusted_git_cleanup_failed"
  | "runtime_scratch_unavailable"
  | "proposal_expired"
  | "proposal_consumed"
  | "durable_claim_unavailable"

export type GitStageInventoryResult =
  | Readonly<{ status: "ready"; inventory: GitStageInventory }>
  | Readonly<{ status: "blocked"; reason: GitStageBlockReason }>

export type GitStagePreparationResult =
  | Readonly<{ status: "ready"; preview: GitStagePreview }>
  | Readonly<{ status: "blocked"; reason: GitStageBlockReason }>

export type GitStageExecutionResult =
  | Readonly<{ status: "denied_without_effect"; verification: "not_verified" }>
  | Readonly<{ status: "blocked_without_effect"; verification: "not_verified"; reason: GitStageBlockReason }>
  | Readonly<{
      status: "effect_unknown"
      verification: "not_verified"
      reason:
        | "process_failed"
        | "process_timed_out"
        | "process_output_limit_exceeded"
        | "process_output_unexpected"
        | "object_install_partial"
        | "index_install_unknown"
        | "post_state_unavailable"
        | "post_state_mismatch"
        | "trusted_git_cleanup_failed"
    }>
  | Readonly<{ status: "effect_observed"; verification: "not_verified"; observation: GitStageObservation }>

export type GitStageVerificationResult =
  | Readonly<{
      status: "verified"
      verification: "independent_selected_index_and_preservation"
      proposalDigest: `sha256:${string}`
      snapshotDigest: `sha256:${string}`
      limitations: typeof gitStageLimitations
    }>
  | Readonly<{ status: "stale"; verification: "not_verified"; reason: "post_state_changed" }>
  | Readonly<{
      status: "blocked"
      verification: "not_verified"
      reason: "invalid_input" | "post_state_unavailable" | "post_state_mismatch"
    }>

export type GitStageDurableClaim = Readonly<{
  proposalDigest: `sha256:${string}`
  nonce: string
  expiresAt: string
  decision: "approved"
}>

export type GitStageDurableClaimResult = "claimed" | "already_claimed" | "unavailable"

export type GitStageHostInvocation = Readonly<{
  executablePath: string
  arguments: ReadonlyArray<string>
  environment: Readonly<Record<string, string>>
  stdin: Uint8Array | "ignore"
  limits: Readonly<{ timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }>
}>

export type GitStageHostObservation =
  | Readonly<{ started: false }>
  | Readonly<{
      started: true
      termination: "exited" | "timed_out" | "output_limit_exceeded"
      exitCode: number | null
      stdout: Uint8Array
      stderr: Uint8Array
    }>

export type GitStageDependencies = Readonly<{
  platform: string
  revalidateBaseline: (
    workspaceRoot: string,
    baseline: GitRepositoryBaselineSnapshot,
  ) => ReturnType<typeof revalidateGitRepositoryBaseline>
  captureBaseline: (workspaceRoot: string) => ReturnType<typeof captureGitRepositoryBaseline>
  inspect: (workspaceRoot: string) => Promise<GitInspectionResult>
  prepareTrustedGit: (workspaceRoot: string) => Promise<TrustedBinaries | null>
  validateTrustedGit: (binaries: TrustedBinaries) => Promise<boolean>
  runHostGit: (invocation: GitStageHostInvocation) => Promise<GitStageHostObservation>
  claimProposal: (claim: GitStageDurableClaim) => Promise<GitStageDurableClaimResult>
  cleanupRuntimeScratch: (path: string) => Promise<boolean>
}>

const productionDependencies: GitStageDependencies = {
  platform: process.platform,
  revalidateBaseline: (root, baseline) => revalidateGitRepositoryBaseline(root, baseline),
  captureBaseline: captureGitRepositoryBaseline,
  async inspect(root) {
    const module = await import("./inspect")
    return module.inspectGitWorkspace(root)
  },
  prepareTrustedGit: (root) => prepareTrustedBinaries(root, defaultGitInspectionLimits, undefined, stageRuntimeBase),
  validateTrustedGit: (binaries) => validatePreparedGit(binaries, defaultGitInspectionLimits),
  runHostGit,
  async claimProposal() {
    return "unavailable"
  },
  cleanupRuntimeScratch: cleanupScratch,
}

/** Captures a parent-owned, bounded selection inventory. This belongs to the
 * already explicit read-only Git observation, never to proposal preparation. */
export async function captureGitStageInventory(
  workspaceRoot: string,
  expectedBaseline: GitRepositoryBaselineSnapshot,
  approvedInspection: Extract<GitInspectionResult, { status: "complete" }>,
): Promise<GitStageInventoryResult> {
  if (process.platform !== "darwin") return blocked("unsupported_platform")
  const baseline = parseGitRepositoryBaselineSnapshot(expectedBaseline)
  if (!baseline.ok || baseline.value.root.canonicalPath !== resolve(workspaceRoot)) return blocked("invalid_input")
  if (baseline.value.head.kind === "unborn") return blocked("unborn_head")
  if (!inspectionMatches(baseline.value, approvedInspection)) return blocked("inventory_stale")
  if (approvedInspection.conflicts.length > 0) return blocked("conflicts_present")
  const current = await revalidateGitRepositoryBaseline(workspaceRoot, baseline.value).catch(() => null)
  if (!current || current.status !== "current") return blocked("inventory_stale")

  const prepared = await prepareTrustedBinaries(
    workspaceRoot,
    defaultGitInspectionLimits,
    undefined,
    stageRuntimeBase,
  ).then(
    (binaries) => ({ binaries, cleanupUnknown: false }),
    (error) => ({ binaries: null, cleanupUnknown: error instanceof GitEphemeralCleanupError }),
  )
  if (prepared.cleanupUnknown) return blocked("trusted_git_cleanup_failed")
  if (!prepared.binaries) return blocked("trusted_git_unavailable")
  const binaries = prepared.binaries
  let result: GitStageInventoryResult = blocked("inventory_unavailable")
  try {
    const index = await runSandboxedGit({
      ...binaries,
      workspaceRoot,
      command: "index-assume-unchanged",
      limits: defaultGitInspectionLimits,
    })
    if (!index.ok) return blocked("inventory_unavailable")
    const parsedIndex = parseGitIndexOutput(index.stdout, expectedBaseline.limits.maxEntries, "assume-unchanged")
    if (
      !parsedIndex.ok ||
      parsedIndex.value.hasAssumeUnchanged ||
      parsedIndex.value.hasSkipWorktree ||
      parsedIndex.value.hasGitlink ||
      parsedIndex.value.oidLength === null
    ) {
      return blocked("inventory_unavailable")
    }
    const objectFormat = parsedIndex.value.oidLength === 40 ? "sha1" : "sha256"
    const candidates = await buildCandidates(workspaceRoot, approvedInspection, parsedIndex.value.entries, objectFormat)
    if (!candidates.ok) return blocked(candidates.reason)
    const candidateValues = candidates.value
    const authority = {
      schemaVersion: 1,
      workspaceRoot: baseline.value.root.canonicalPath,
      baselineSnapshotDigest: baseline.value.snapshotDigest,
      inspectionObservationDigest: approvedInspection.outputDigest,
      inspectionReportDigest: approvedInspection.reportDigest,
      objectFormat,
      indexEntries: parsedIndex.value.entries
        .filter((entry) => entry.stage === 0)
        .map(({ path, mode, oid }) => ({ path, mode, oid }))
        .sort(comparePath),
      candidates: candidateValues,
    } as const satisfies GitStageInventoryAuthority
    const inventory = { ...authority, inventoryDigest: computeGitStageInventoryDigest(authority) }
    result = parseGitStageInventory(inventory).ok
      ? { status: "ready", inventory: deepFreeze(inventory) }
      : blocked("inventory_unavailable")
  } finally {
    if (!(await binaries.cleanup().catch(() => false))) result = blocked("trusted_git_cleanup_failed")
  }
  if (result.status !== "ready") return result
  const final = await revalidateGitRepositoryBaseline(workspaceRoot, baseline.value).catch(() => null)
  return final?.status === "current" ? result : blocked("inventory_stale")
}

/** Pure proposal preparation. It performs no filesystem access, process, or write. */
export function prepareGitStageSelected(
  inventoryInput: GitStageInventory,
  candidateIDs: ReadonlyArray<string>,
  now = Date.now(),
): GitStagePreparationResult {
  const inventory = parseGitStageInventory(inventoryInput)
  if (!inventory.ok || !Number.isFinite(now)) return blocked("invalid_input")
  if (candidateIDs.length < 1) return blocked("nothing_selected")
  if (candidateIDs.length > 512 || new Set(candidateIDs).size !== candidateIDs.length)
    return blocked("too_many_candidates")
  const selected = inventory.value.candidates.filter((candidate) => candidateIDs.includes(candidate.candidateID))
  if (selected.length !== candidateIDs.length) return blocked("invalid_input")
  const orderedIDs = selected.map((candidate) => candidate.candidateID)
  const nonce = randomUUID()
  const createdAt = new Date(now).toISOString()
  const runtimeScratch = join(stageRuntimeBase, `astra-git-stage-${nonce}`)
  const repositoryWrites = [
    ...selected.flatMap((candidate) => (candidate.objectPath ? [candidate.objectPath] : [])),
    ".git/index",
    ".git/index.lock",
  ].sort()
  const authority = {
    schemaVersion: 1,
    operation: "git_stage_paths",
    boundary: "host_no_sandbox",
    boundaryLabel: gitStageBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: inventory.value.workspaceRoot,
    nonce,
    createdAt,
    expiresAt: new Date(now + authorizationLifetimeMs).toISOString(),
    runtimeScratch,
    inventoryDigest: inventory.value.inventoryDigest,
    baselineSnapshotDigest: inventory.value.baselineSnapshotDigest,
    selection: { kind: "selected", candidateIDs: orderedIDs },
    candidates: selected,
    repositoryWrites,
    scratchWrites: [runtimeScratch],
    authorizationConsumption: "durable_operation_kernel_claim_required",
    hooks: "disabled",
    filters: "raw_no_filters_transforming_attributes_blocked",
    network: "not_requested_host_unrestricted",
    preserves: { worktree: "required", head: "required", refs: "required", nonSelectedIndexEntries: "required" },
    limitations: gitStageLimitations,
  } as const satisfies GitStagePreviewAuthority
  const preview = { ...authority, proposalDigest: computeGitStageProposalDigest(authority) }
  return parseGitStagePreview(preview).ok ? { status: "ready", preview: deepFreeze(preview) } : blocked("invalid_input")
}

/** Executes exactly one approved selected-path stage Operation. */
export async function executeGitStageSelected(
  input: Readonly<{
    preview: GitStagePreview
    inventory: GitStageInventory
    expectedBaseline: GitRepositoryBaselineSnapshot
    decision: GitStageDecision
  }>,
  dependencies: GitStageDependencies = productionDependencies,
): Promise<GitStageExecutionResult> {
  const parsed = parseExecutionInput(input)
  if (!parsed.ok) return blockedWithoutEffect("invalid_input")
  if (parsed.decision.decision === "rejected") return { status: "denied_without_effect", verification: "not_verified" }
  if (dependencies.platform !== "darwin") return blockedWithoutEffect("unsupported_platform")
  if (Date.now() > Date.parse(parsed.preview.expiresAt)) return blockedWithoutEffect("proposal_expired")
  const claim = await dependencies
    .claimProposal({
      proposalDigest: parsed.preview.proposalDigest,
      nonce: parsed.preview.nonce,
      expiresAt: parsed.preview.expiresAt,
      decision: "approved",
    })
    .catch(() => "unavailable" as const)
  if (claim === "already_claimed") return blockedWithoutEffect("proposal_consumed")
  if (claim !== "claimed") return blockedWithoutEffect("durable_claim_unavailable")

  if (!(await safeRuntimeScratch(parsed.preview))) return blockedWithoutEffect("invalid_input")
  const current = await dependencies.revalidateBaseline(parsed.preview.workspaceRoot, parsed.baseline).catch(() => null)
  if (!current || current.status === "blocked") return blockedWithoutEffect("baseline_unavailable")
  if (current.status !== "current") return blockedWithoutEffect("baseline_stale")
  if (!(await indexLockAbsent(parsed.preview.workspaceRoot))) return blockedWithoutEffect("index_lock_present")
  if (!(await splitIndexAbsent(parsed.preview.workspaceRoot))) return blockedWithoutEffect("split_index_unsupported")
  if (!(await candidatesStillCurrent(parsed.preview))) return blockedWithoutEffect("selected_content_changed")

  const prepared = await dependencies.prepareTrustedGit(parsed.preview.workspaceRoot).then(
    (binaries) => ({ binaries, cleanupUnknown: false }),
    (error) => ({ binaries: null, cleanupUnknown: error instanceof GitEphemeralCleanupError }),
  )
  if (prepared.cleanupUnknown) return unknown("trusted_git_cleanup_failed")
  if (!prepared.binaries) return blockedWithoutEffect("trusted_git_unavailable")
  const binaries = prepared.binaries
  const result = await executeWithTrustedGit(parsed, binaries, dependencies).catch(() => unknown("process_failed"))
  return (await binaries.cleanup().catch(() => false)) ? result : unknown("trusted_git_cleanup_failed")
}

/** Executes through the production adapter after a durable coordinator has
 * supplied the one-shot proposal claim bridge. */
export function executeClaimedGitStageSelected(
  input: Parameters<typeof executeGitStageSelected>[0],
  claimProposal: GitStageDependencies["claimProposal"],
) {
  return executeGitStageSelected(input, { ...productionDependencies, claimProposal })
}

export async function verifyGitStageSelected(
  input: Readonly<{
    preview: GitStagePreview
    inventory: GitStageInventory
    expectedBaseline: GitRepositoryBaselineSnapshot
    observation: GitStageObservation
  }>,
  dependencies: GitStageDependencies = productionDependencies,
): Promise<GitStageVerificationResult> {
  const preview = parseGitStagePreview(input.preview)
  const inventory = parseGitStageInventory(input.inventory)
  const baseline = parseGitRepositoryBaselineSnapshot(input.expectedBaseline)
  const observation = parseGitStageObservation(input.observation)
  if (
    !preview.ok ||
    !inventory.ok ||
    !baseline.ok ||
    !observation.ok ||
    preview.value.inventoryDigest !== inventory.value.inventoryDigest ||
    !previewCandidatesMatchInventory(preview.value, inventory.value) ||
    observation.value.proposalDigest !== preview.value.proposalDigest ||
    observation.value.beforeSnapshotDigest !== baseline.value.snapshotDigest ||
    preview.value.baselineSnapshotDigest !== baseline.value.snapshotDigest
  ) {
    return verificationBlocked("invalid_input")
  }
  if (await pathExists(preview.value.runtimeScratch).catch(() => true))
    return verificationBlocked("post_state_mismatch")
  const observed = await captureStablePostState(preview.value.workspaceRoot, dependencies)
  if (!observed) {
    return verificationBlocked("post_state_unavailable")
  }
  const { post, inspection } = observed
  if (
    post.snapshot.snapshotDigest !== observation.value.afterSnapshotDigest ||
    post.snapshot.index.digest !== observation.value.afterIndexDigest ||
    post.snapshot.index.metadataDigest !== observation.value.afterIndexMetadataDigest
  ) {
    return { status: "stale", verification: "not_verified", reason: "post_state_changed" }
  }
  if (
    !preservationMatches(input.preview, baseline.value, post.snapshot) ||
    !(await candidatesStillCurrent(preview.value)) ||
    !inspectionMatchesExpectedIndex(inspection, input.inventory, input.preview)
  ) {
    return verificationBlocked("post_state_mismatch")
  }
  const prepared = await dependencies.prepareTrustedGit(preview.value.workspaceRoot).catch(() => null)
  if (!prepared) return verificationBlocked("post_state_unavailable")
  let exact = false
  let trusted = false
  let cleanupSucceeded = false
  try {
    trusted = await dependencies.validateTrustedGit(prepared)
    if (trusted) {
      const entries = await readRepositoryIndexEntries(prepared.gitPath, preview.value, inventory.value, dependencies)
      exact =
        entries !== null &&
        sameIndexEntries(entries, expectedIndexEntries(inventory.value, preview.value)) &&
        (await verifyRepositoryObjects(prepared.gitPath, preview.value, dependencies))
    }
  } finally {
    cleanupSucceeded = await prepared.cleanup().catch(() => false)
  }
  if (!cleanupSucceeded || !trusted) return verificationBlocked("post_state_unavailable")
  if (!exact) return verificationBlocked("post_state_mismatch")
  const finalObserved = await captureStablePostState(preview.value.workspaceRoot, dependencies)
  if (!finalObserved) return verificationBlocked("post_state_unavailable")
  if (finalObserved.post.snapshot.snapshotDigest !== post.snapshot.snapshotDigest) {
    return { status: "stale", verification: "not_verified", reason: "post_state_changed" }
  }
  if (
    !(await candidatesStillCurrent(preview.value)) ||
    !inspectionMatchesExpectedIndex(finalObserved.inspection, inventory.value, preview.value)
  ) {
    return verificationBlocked("post_state_mismatch")
  }
  return {
    status: "verified",
    verification: "independent_selected_index_and_preservation",
    proposalDigest: preview.value.proposalDigest,
    snapshotDigest: post.snapshot.snapshotDigest,
    limitations: gitStageLimitations,
  }
}

async function executeWithTrustedGit(
  input: ReturnType<typeof parseExecutionInput> & { ok: true },
  binaries: TrustedBinaries,
  dependencies: GitStageDependencies,
): Promise<GitStageExecutionResult> {
  if (!(await dependencies.validateTrustedGit(binaries))) return blockedWithoutEffect("trusted_git_changed")
  const approvedIndex = await inspectRegularFile(
    join(input.preview.workspaceRoot, ".git", "index"),
    input.baseline.limits.maxFileBytes,
  )
  if (!approvedIndex || approvedIndex.digest !== input.baseline.index.metadataDigest) {
    return blockedWithoutEffect("approved_index_changed")
  }
  const scratch = await prepareScratch(input.preview, approvedIndex)
  if (!scratch) return blockedWithoutEffect("runtime_scratch_unavailable")
  const result = await performPreparedStage(input, binaries, dependencies, approvedIndex, scratch.indexPath).catch(() =>
    unknown("process_failed"),
  )
  return (await dependencies.cleanupRuntimeScratch(input.preview.runtimeScratch))
    ? result
    : unknown("trusted_git_cleanup_failed")
}

async function performPreparedStage(
  input: ReturnType<typeof parseExecutionInput> & { ok: true },
  binaries: TrustedBinaries,
  dependencies: GitStageDependencies,
  approvedIndex: FileAuthority,
  scratchIndexPath: string,
): Promise<GitStageExecutionResult> {
  let installedObjects = 0
  for (const candidate of input.preview.candidates) {
    if (candidate.after.state === "object") {
      const content = await readStableRegular(
        join(input.preview.workspaceRoot, candidate.path),
        candidate.after.byteLength,
      )
      if (!content || digestBytes(content.bytes) !== candidate.after.contentDigest) {
        return blockedWithoutEffect("selected_content_changed")
      }
      const hashed = await dependencies.runHostGit(hashObjectInvocation(binaries.gitPath, input.preview, content.bytes))
      const observedOID = successfulLine(hashed)
      if (observedOID !== candidate.after.oid) return processFailure(hashed)
    }
    const updated = await dependencies.runHostGit(updateIndexInvocation(binaries.gitPath, input.preview, candidate))
    if (!successfulEmpty(updated)) return processFailure(updated)
  }
  const privateIndex = await readIndexEntries(binaries.gitPath, input.preview, input.inventory, dependencies)
  if (!privateIndex || !sameIndexEntries(privateIndex, expectedIndexEntries(input.inventory, input.preview))) {
    return unknown("post_state_mismatch")
  }
  for (const candidate of input.preview.candidates) {
    if (candidate.after.state !== "object") continue
    const installed = await installQuarantinedObject(input.preview, candidate.after.oid)
    if (!installed) return installedObjects > 0 ? unknown("object_install_partial") : unknown("post_state_mismatch")
    installedObjects++
  }
  if (!(await verifyRepositoryObjects(binaries.gitPath, input.preview, dependencies))) {
    return installedObjects > 0 ? unknown("object_install_partial") : unknown("post_state_mismatch")
  }
  if (!(await installPreparedIndex(input.preview, approvedIndex, scratchIndexPath)))
    return unknown("index_install_unknown")
  const observed = await captureStablePostState(input.preview.workspaceRoot, dependencies)
  if (!observed) return unknown("post_state_unavailable")
  const { post, inspection } = observed
  if (
    !preservationMatches(input.preview, input.baseline, post.snapshot) ||
    !(await candidatesStillCurrent(input.preview)) ||
    !inspectionMatchesExpectedIndex(inspection, input.inventory, input.preview)
  ) {
    return unknown("post_state_mismatch")
  }
  return {
    status: "effect_observed",
    verification: "not_verified",
    observation: {
      schemaVersion: 1,
      operation: "git_stage_paths",
      status: "effect_observed",
      verification: "not_verified",
      proposalDigest: input.preview.proposalDigest,
      beforeSnapshotDigest: input.baseline.snapshotDigest,
      afterSnapshotDigest: post.snapshot.snapshotDigest,
      afterIndexDigest: post.snapshot.index.digest,
      afterIndexMetadataDigest: post.snapshot.index.metadataDigest,
      objectOIDs: input.preview.candidates.flatMap((candidate) =>
        candidate.after.state === "object" ? [candidate.after.oid] : [],
      ),
      limitations: gitStageLimitations,
    },
  }
}

async function buildCandidates(
  workspaceRoot: string,
  inspection: Extract<GitInspectionResult, { status: "complete" }>,
  indexEntries: ReadonlyArray<ParsedGitIndexEntry>,
  objectFormat: "sha1" | "sha256",
): Promise<
  | Readonly<{ ok: true; value: ReadonlyArray<GitStageCandidate> }>
  | Readonly<{
      ok: false
      reason:
        | "too_many_candidates"
        | "transforming_attributes_unsupported"
        | "special_file_unsupported"
        | "inventory_unavailable"
        | "rename_unsupported"
    }>
> {
  const changed = new Map(inspection.diff.unstaged.map((entry) => [entry.path, entry]))
  const paths = [...new Set([...changed.keys(), ...inspection.untracked])].sort()
  if (paths.length > 512) return { ok: false, reason: "too_many_candidates" as const }
  const values: Array<GitStageCandidate> = []
  for (const path of paths) {
    if (await hasTransformingAttributes(workspaceRoot, path)) {
      return { ok: false, reason: "transforming_attributes_unsupported" as const }
    }
    const current = indexEntries.find((entry) => entry.stage === 0 && entry.path === path)
    const currentMode = current ? requireRegularMode(current.mode) : null
    if (current && !currentMode) return { ok: false, reason: "special_file_unsupported" as const }
    const before = current
      ? ({ state: "object", mode: currentMode!, oid: current.oid } as const)
      : ({ state: "absent" } as const)
    const absolute = join(workspaceRoot, path)
    const facts = await lstat(absolute).catch(() => null)
    if (!facts) {
      if (!current || !changed.has(path)) return { ok: false, reason: "inventory_unavailable" as const }
      values.push({
        candidateID: randomUUID(),
        path,
        action: "delete",
        before,
        after: { state: "absent" },
        objectPath: null,
      })
      continue
    }
    if (!facts.isFile() || facts.isSymbolicLink()) return { ok: false, reason: "special_file_unsupported" as const }
    const content = await readStableRegular(absolute, facts.size)
    if (!content) return { ok: false, reason: "inventory_unavailable" as const }
    const oid = gitObjectID(content.bytes, objectFormat)
    const mode = (facts.mode & 0o111) === 0 ? "100644" : "100755"
    values.push({
      candidateID: randomUUID(),
      path,
      action: "upsert",
      before,
      after: {
        state: "object",
        mode,
        oid,
        byteLength: content.bytes.byteLength,
        contentDigest: digestBytes(content.bytes),
      },
      objectPath: `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
    })
  }
  const deletes = new Set(
    values.flatMap((value) => (value.action === "delete" && value.before.state === "object" ? [value.before.oid] : [])),
  )
  if (values.some((value) => value.after.state === "object" && deletes.has(value.after.oid))) {
    return { ok: false, reason: "rename_unsupported" as const }
  }
  return { ok: true, value: values } as const
}

function parseExecutionInput(
  input: Readonly<{
    preview: GitStagePreview
    inventory: GitStageInventory
    expectedBaseline: GitRepositoryBaselineSnapshot
    decision: GitStageDecision
  }>,
) {
  const preview = parseGitStagePreview(input.preview)
  const inventory = parseGitStageInventory(input.inventory)
  const baseline = parseGitRepositoryBaselineSnapshot(input.expectedBaseline)
  const decision = parseGitStageDecision(input.decision)
  if (
    !preview.ok ||
    !inventory.ok ||
    !baseline.ok ||
    !decision.ok ||
    preview.value.inventoryDigest !== inventory.value.inventoryDigest ||
    !previewCandidatesMatchInventory(preview.value, inventory.value) ||
    preview.value.baselineSnapshotDigest !== baseline.value.snapshotDigest ||
    inventory.value.baselineSnapshotDigest !== baseline.value.snapshotDigest ||
    preview.value.workspaceRoot !== baseline.value.root.canonicalPath ||
    decision.value.proposalDigest !== preview.value.proposalDigest ||
    decision.value.nonce !== preview.value.nonce ||
    Date.parse(decision.value.decidedAt) < Date.parse(preview.value.createdAt) ||
    Date.parse(decision.value.decidedAt) > Date.parse(preview.value.expiresAt)
  ) {
    return { ok: false } as const
  }
  return {
    ok: true,
    preview: preview.value,
    inventory: inventory.value,
    baseline: baseline.value,
    decision: decision.value,
  } as const
}

function previewCandidatesMatchInventory(preview: GitStagePreview, inventory: GitStageInventory) {
  const byID = new Map(inventory.candidates.map((candidate) => [candidate.candidateID, candidate]))
  return preview.candidates.every((candidate, index) => {
    const expected = byID.get(preview.selection.candidateIDs[index] ?? "")
    return expected !== undefined && JSON.stringify(candidate) === JSON.stringify(expected)
  })
}

function inspectionMatches(
  baseline: GitRepositoryBaselineSnapshot,
  inspection: Extract<GitInspectionResult, { status: "complete" }>,
) {
  return (
    inspection.workspaceRoot === baseline.root.canonicalPath &&
    inspection.mode === "bounded_read_only" &&
    inspection.diff.observationDigest === inspection.outputDigest &&
    inspection.conflicts.length === 0
  )
}

function inspectionMatchesExpectedIndex(
  inspection: Extract<GitInspectionResult, { status: "complete" }>,
  inventory: GitStageInventory,
  preview: GitStagePreview,
) {
  const selected = new Map(preview.candidates.map((candidate) => [candidate.path, candidate]))
  for (const candidate of preview.candidates) {
    const staged = inspection.diff.staged.find((entry) => entry.path === candidate.path)
    if (candidate.after.state === "absent") {
      if (staged?.after.state !== "absent") return false
      continue
    }
    if (
      !staged ||
      staged.after.state !== "object" ||
      staged.after.oid !== candidate.after.oid ||
      staged.after.mode !== candidate.after.mode
    ) {
      return false
    }
  }
  return inventory.indexEntries.every((entry) => {
    if (selected.has(entry.path)) return true
    const changed = inspection.diff.staged.find((candidate) => candidate.path === entry.path)
    if (!changed) return true
    return changed.after.state === "object" && changed.after.oid === entry.oid && changed.after.mode === entry.mode
  })
}

function preservationMatches(
  preview: GitStagePreview,
  baseline: GitRepositoryBaselineSnapshot,
  post: GitRepositoryBaselineSnapshot,
) {
  return (
    post.root.canonicalPath === preview.workspaceRoot &&
    post.root.device === baseline.root.device &&
    post.root.inode === baseline.root.inode &&
    JSON.stringify(post.head) === JSON.stringify(baseline.head) &&
    worktreePreservationCompatible(preview, baseline, post) &&
    post.refs.digest === baseline.refs.digest
  )
}

function worktreePreservationCompatible(
  preview: GitStagePreview,
  baseline: GitRepositoryBaselineSnapshot,
  post: GitRepositoryBaselineSnapshot,
) {
  if (post.worktree.digest === baseline.worktree.digest) return true
  const deletions = preview.candidates.filter(
    (candidate) => candidate.before.state === "object" && candidate.after.state === "absent",
  ).length
  const additions = preview.candidates.filter(
    (candidate) => candidate.before.state === "absent" && candidate.after.state === "object",
  ).length
  return (
    deletions + additions > 0 &&
    post.worktree.trackedPaths === baseline.worktree.trackedPaths + additions - deletions &&
    post.worktree.untrackedPaths === baseline.worktree.untrackedPaths - additions &&
    post.worktree.contentEntries === baseline.worktree.contentEntries &&
    post.worktree.totalBytes === baseline.worktree.totalBytes
  )
}

async function captureStablePostState(workspaceRoot: string, dependencies: GitStageDependencies) {
  const before = await dependencies.captureBaseline(workspaceRoot).catch(() => null)
  if (!before || before.status !== "complete") return null
  const inspection = await dependencies.inspect(workspaceRoot).catch(() => null)
  if (!inspection || inspection.status !== "complete") return null
  const post = await dependencies.captureBaseline(workspaceRoot).catch(() => null)
  if (!post || post.status !== "complete" || before.snapshot.snapshotDigest !== post.snapshot.snapshotDigest)
    return null
  return { post, inspection } as const
}

function expectedIndexEntries(inventory: GitStageInventory, preview: GitStagePreview) {
  const entries = new Map(inventory.indexEntries.map((entry) => [entry.path, { ...entry }]))
  preview.candidates.forEach((candidate) => {
    if (candidate.after.state === "absent") entries.delete(candidate.path)
    else entries.set(candidate.path, { path: candidate.path, mode: candidate.after.mode, oid: candidate.after.oid })
  })
  return [...entries.values()].sort(comparePath)
}

async function readIndexEntries(
  gitPath: string,
  preview: GitStagePreview,
  inventory: GitStageInventory,
  dependencies: GitStageDependencies,
) {
  const result = await dependencies.runHostGit(
    indexInspectionInvocation(gitPath, preview, indexOutputLimit(inventory, preview)),
  )
  if (!result.started || result.termination !== "exited" || result.exitCode !== 0 || result.stderr.byteLength > 0)
    return null
  const parsed = parseGitIndexOutput(result.stdout, 25_000)
  if (!parsed.ok || parsed.value.hasAssumeUnchanged || parsed.value.hasSkipWorktree || parsed.value.hasGitlink)
    return null
  return parsed.value.entries
    .filter((entry) => entry.stage === 0)
    .map(({ path, mode, oid }) => ({ path, mode, oid }))
    .sort(comparePath)
}

async function readRepositoryIndexEntries(
  gitPath: string,
  preview: GitStagePreview,
  inventory: GitStageInventory,
  dependencies: GitStageDependencies,
) {
  const result = await dependencies.runHostGit(
    repositoryInvocation(
      gitPath,
      preview,
      ["ls-files", "--full-name", "--stage", "-v", "-z", "--", ":(top)"],
      "ignore",
      { ...stageLimits, maxStdoutBytes: indexOutputLimit(inventory, preview) },
    ),
  )
  if (!result.started || result.termination !== "exited" || result.exitCode !== 0 || result.stderr.byteLength > 0)
    return null
  const parsed = parseGitIndexOutput(result.stdout, 25_000)
  if (!parsed.ok || parsed.value.hasAssumeUnchanged || parsed.value.hasSkipWorktree || parsed.value.hasGitlink)
    return null
  return parsed.value.entries
    .filter((entry) => entry.stage === 0)
    .map(({ path, mode, oid }) => ({ path, mode, oid }))
    .sort(comparePath)
}

async function verifyRepositoryObjects(gitPath: string, preview: GitStagePreview, dependencies: GitStageDependencies) {
  for (const candidate of preview.candidates) {
    if (candidate.after.state !== "object") continue
    const result = await dependencies.runHostGit(
      repositoryInvocation(gitPath, preview, ["cat-file", "blob", candidate.after.oid], "ignore", {
        ...stageLimits,
        maxStdoutBytes: candidate.after.byteLength,
      }),
    )
    if (
      !result.started ||
      result.termination !== "exited" ||
      result.exitCode !== 0 ||
      result.stderr.byteLength > 0 ||
      result.stdout.byteLength !== candidate.after.byteLength ||
      digestBytes(result.stdout) !== candidate.after.contentDigest
    ) {
      return false
    }
  }
  return true
}

function hashObjectInvocation(gitPath: string, preview: GitStagePreview, bytes: Uint8Array): GitStageHostInvocation {
  return invocation(gitPath, preview, ["hash-object", "-w", "--no-filters", "--stdin"], bytes)
}

function updateIndexInvocation(
  gitPath: string,
  preview: GitStagePreview,
  candidate: GitStageCandidate,
): GitStageHostInvocation {
  const arguments_ =
    candidate.after.state === "absent"
      ? ["update-index", "--force-remove", "--", candidate.path]
      : ["update-index", "--add", "--cacheinfo", candidate.after.mode, candidate.after.oid, candidate.path]
  return invocation(gitPath, preview, arguments_, "ignore")
}

function indexInspectionInvocation(
  gitPath: string,
  preview: GitStagePreview,
  maxStdoutBytes: number,
): GitStageHostInvocation {
  const base = invocation(
    gitPath,
    preview,
    ["ls-files", "--full-name", "--stage", "-v", "-z", "--", ":(top)"],
    "ignore",
  )
  return { ...base, limits: { ...base.limits, maxStdoutBytes } }
}

function indexOutputLimit(inventory: GitStageInventory, preview: GitStagePreview) {
  return expectedIndexEntries(inventory, preview).reduce(
    (total, entry) => total + Buffer.byteLength(entry.path) + entry.oid.length + entry.mode.length + 32,
    1,
  )
}

function repositoryInvocation(
  gitPath: string,
  preview: GitStagePreview,
  command: ReadonlyArray<string>,
  stdin: Uint8Array | "ignore",
  limits: GitStageHostInvocation["limits"] = stageLimits,
): GitStageHostInvocation {
  const base = invocation(gitPath, preview, command, stdin)
  const {
    GIT_INDEX_FILE: _index,
    GIT_OBJECT_DIRECTORY: _objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _alternates,
    ...environment
  } = base.environment
  return { ...base, environment, limits }
}

function invocation(
  gitPath: string,
  preview: GitStagePreview,
  command: ReadonlyArray<string>,
  stdin: Uint8Array | "ignore",
): GitStageHostInvocation {
  return {
    executablePath: gitPath,
    arguments: [
      "--no-pager",
      "--no-lazy-fetch",
      "--no-optional-locks",
      "--no-replace-objects",
      `--git-dir=${join(preview.workspaceRoot, ".git")}`,
      `--work-tree=${preview.workspaceRoot}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.preloadIndex=false",
      "-c",
      "core.splitIndex=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "core.editor=true",
      "-c",
      "diff.external=",
      "-c",
      "filter.lfs.clean=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      ...command,
    ],
    environment: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_ADVICE: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      PATH: "/usr/bin:/bin",
      GIT_INDEX_FILE: join(preview.runtimeScratch, "index"),
      GIT_OBJECT_DIRECTORY: join(preview.runtimeScratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(preview.workspaceRoot, ".git", "objects"),
    },
    stdin,
    limits: stageLimits,
  }
}

async function runHostGit(invocation: GitStageHostInvocation): Promise<GitStageHostObservation> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([invocation.executablePath, ...invocation.arguments], {
      cwd: "/",
      env: { ...invocation.environment },
      stdin: invocation.stdin === "ignore" ? "ignore" : new Blob([Buffer.from(invocation.stdin)]),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch {
    return { started: false }
  }
  let timedOut = false
  let outputLimited = false
  const timeout = setTimeout(() => {
    timedOut = true
    kill(child)
  }, invocation.limits.timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(requireStream(child.stdout), invocation.limits.maxStdoutBytes, () => {
      outputLimited = true
      kill(child)
    }),
    readBounded(requireStream(child.stderr), invocation.limits.maxStderrBytes, () => {
      outputLimited = true
      kill(child)
    }),
  ])
  clearTimeout(timeout)
  return {
    started: true,
    termination: timedOut
      ? "timed_out"
      : outputLimited || !stdout.ok || !stderr.ok
        ? "output_limit_exceeded"
        : "exited",
    exitCode,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
  }
}

async function prepareScratch(preview: GitStagePreview, approvedIndex: FileAuthority) {
  try {
    await mkdir(preview.runtimeScratch, { mode: 0o700 })
    await chmod(preview.runtimeScratch, 0o700)
    const facts = await lstat(preview.runtimeScratch)
    if (
      !facts.isDirectory() ||
      facts.isSymbolicLink() ||
      facts.uid !== process.getuid?.() ||
      (facts.mode & 0o777) !== 0o700
    )
      return null
    await mkdir(join(preview.runtimeScratch, "objects"), { mode: 0o700 })
    const objectFacts = await lstat(join(preview.runtimeScratch, "objects"))
    if (!objectFacts.isDirectory() || objectFacts.isSymbolicLink() || objectFacts.uid !== process.getuid?.())
      return null
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
    return { indexPath }
  } catch {
    await cleanupScratch(preview.runtimeScratch)
    return null
  }
}

async function installQuarantinedObject(preview: GitStagePreview, oid: string) {
  const relative = join(oid.slice(0, 2), oid.slice(2))
  const source = join(preview.runtimeScratch, "objects", relative)
  const destination = join(preview.workspaceRoot, ".git", "objects", relative)
  const sourceFacts = await lstat(source).catch(() => null)
  if (!sourceFacts?.isFile() || sourceFacts.isSymbolicLink()) return false
  const existing = await lstat(destination).catch(() => null)
  if (existing) return existing.isFile() && !existing.isSymbolicLink()
  try {
    const directory = dirname(destination)
    await mkdir(directory, { mode: 0o755 })
    const directoryFacts = await lstat(directory)
    if (!directoryFacts.isDirectory() || directoryFacts.isSymbolicLink()) return false
    await link(source, destination)
    const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
    await handle.sync()
    await handle.close()
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    await directoryHandle.sync()
    await directoryHandle.close()
    return true
  } catch (error) {
    if (fileSystemCode(error) !== "EEXIST") return false
    const raced = await lstat(destination).catch(() => null)
    return raced?.isFile() === true && !raced.isSymbolicLink()
  }
}

type FileAuthority = Readonly<{
  device: string
  inode: string
  size: number
  digest: `sha256:${string}`
  bytes: Uint8Array
}>

async function inspectRegularFile(path: string, maximumBytes: number): Promise<FileAuthority | null> {
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    const size = Number(before.size)
    if (!before.isFile() || !Number.isSafeInteger(size) || size < 1 || size > maximumBytes) return null
    const bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      return null
    return { device: String(after.dev), inode: String(after.ino), size, digest: digestBytes(bytes), bytes }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function installPreparedIndex(preview: GitStagePreview, approved: FileAuthority, preparedPath: string) {
  const prepared = await inspectRegularFile(preparedPath, Math.max(approved.size * 2, 64 * 1024 * 1024))
  if (!prepared) return false
  const gitDirectory = join(preview.workspaceRoot, ".git")
  const indexPath = join(gitDirectory, "index")
  const lockPath = join(gitDirectory, "index.lock")
  let lock: FileHandle | null = null
  let ownsLock = false
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    ownsLock = true
    const current = await inspectRegularFile(indexPath, approved.size)
    if (
      !current ||
      current.digest !== approved.digest ||
      current.device !== approved.device ||
      current.inode !== approved.inode
    )
      return false
    await lock.writeFile(prepared.bytes)
    await lock.sync()
    await lock.close()
    lock = null
    await rename(lockPath, indexPath)
    ownsLock = false
    const directory = await open(gitDirectory, constants.O_RDONLY | constants.O_NOFOLLOW)
    await directory.sync()
    await directory.close()
    return true
  } catch {
    return false
  } finally {
    await lock?.close().catch(() => undefined)
    if (ownsLock) await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function candidatesStillCurrent(preview: GitStagePreview) {
  for (const candidate of preview.candidates) {
    if (await hasTransformingAttributes(preview.workspaceRoot, candidate.path)) return false
    const path = join(preview.workspaceRoot, candidate.path)
    if (candidate.after.state === "absent") {
      if (await pathExists(path)) return false
      continue
    }
    const content = await readStableRegular(path, candidate.after.byteLength)
    if (!content || digestBytes(content.bytes) !== candidate.after.contentDigest) return false
    const facts = await lstat(path).catch(() => null)
    const mode = facts && (facts.mode & 0o111) !== 0 ? "100755" : "100644"
    if (!facts?.isFile() || facts.isSymbolicLink() || mode !== candidate.after.mode) return false
  }
  return true
}

async function readStableRegular(path: string, expectedBytes: number) {
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || Number(before.size) !== expectedBytes || expectedBytes > 32 * 1024 * 1024) return null
    const bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      return null
    return { bytes }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function hasTransformingAttributes(workspaceRoot: string, relativePath: string) {
  const paths = [join(workspaceRoot, ".git", "info", "attributes")]
  const parts = relativePath.split("/")
  for (let index = 0; index < parts.length; index++)
    paths.push(join(workspaceRoot, ...parts.slice(0, index), ".gitattributes"))
  for (const path of paths) {
    const observed = await readAttributeFile(path)
    if (observed.state === "absent") continue
    if (observed.state === "unsafe") return true
    const bytes = observed.bytes
    const text = (() => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        return null
      }
    })()
    if (text === null) return true
    if (/(^|[\t ])(?:filter|working-tree-encoding|ident|text|eol)(?:[=\t ]|$)/imu.test(text)) return true
    if (/^\s*\[attr\]/imu.test(text)) return true
  }
  return false
}

async function readAttributeFile(
  path: string,
): Promise<
  Readonly<{ state: "absent" }> | Readonly<{ state: "unsafe" }> | Readonly<{ state: "bytes"; bytes: Uint8Array }>
> {
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(1024 * 1024)) return { state: "unsafe" }
    const bytes = new Uint8Array(await handle.readFile())
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return { state: "unsafe" }
    }
    return { state: "bytes", bytes }
  } catch (error) {
    return fileSystemCode(error) === "ENOENT" ? { state: "absent" } : { state: "unsafe" }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function splitIndexAbsent(workspaceRoot: string) {
  const config = await readFile(join(workspaceRoot, ".git", "config"), "utf8").catch(() => "")
  if (/^\s*splitIndex\s*=\s*(?:true|yes|on|1)\s*$/imu.test(config)) return false
  let directory: Awaited<ReturnType<typeof opendir>> | null = null
  try {
    directory = await opendir(join(workspaceRoot, ".git"))
    for await (const entry of directory) if (entry.name.toLowerCase().startsWith("sharedindex.")) return false
    return true
  } catch {
    return false
  }
}

async function indexLockAbsent(workspaceRoot: string) {
  return !(await pathExists(join(workspaceRoot, ".git", "index.lock")))
}

async function safeRuntimeScratch(preview: GitStagePreview) {
  const base = await realpath(stageRuntimeBase).catch(() => null)
  return base === stageRuntimeBase && preview.runtimeScratch === join(base, `astra-git-stage-${preview.nonce}`)
}

async function cleanupScratch(path: string) {
  try {
    const facts = await lstat(path)
    if (
      !facts.isDirectory() ||
      facts.isSymbolicLink() ||
      facts.uid !== process.getuid?.() ||
      (await realpath(path)) !== path
    )
      return false
    await rm(path, { recursive: true, force: true })
    return !(await pathExists(path))
  } catch (error) {
    return fileSystemCode(error) === "ENOENT"
  }
}

function successfulLine(result: GitStageHostObservation) {
  if (!result.started || result.termination !== "exited" || result.exitCode !== 0 || result.stderr.byteLength > 0)
    return null
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
    return /^([0-9a-f]{40}|[0-9a-f]{64})\n$/.exec(output)?.[1] ?? null
  } catch {
    return null
  }
}

function successfulEmpty(result: GitStageHostObservation) {
  return (
    result.started &&
    result.termination === "exited" &&
    result.exitCode === 0 &&
    result.stdout.byteLength === 0 &&
    result.stderr.byteLength === 0
  )
}

function processFailure(result: GitStageHostObservation): GitStageExecutionResult {
  if (!result.started) return blockedWithoutEffect("trusted_git_unavailable")
  if (result.termination === "timed_out") return unknown("process_timed_out")
  if (result.termination === "output_limit_exceeded") return unknown("process_output_limit_exceeded")
  if (result.exitCode === 0) return unknown("process_output_unexpected")
  return unknown("process_failed")
}

function gitObjectID(bytes: Uint8Array, format: "sha1" | "sha256") {
  const hash = createHash(format)
  hash.update(`blob ${bytes.byteLength}\0`)
  hash.update(bytes)
  return hash.digest("hex")
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function requireRegularMode(mode: string): "100644" | "100755" | null {
  return mode === "100644" || mode === "100755" ? mode : null
}

function sameIndexEntries(
  left: ReadonlyArray<{ path: string; mode: string; oid: string }>,
  right: ReadonlyArray<{ path: string; mode: string; oid: string }>,
) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.path === right[index]?.path && entry.mode === right[index]?.mode && entry.oid === right[index]?.oid,
    )
  )
}

function comparePath(left: { path: string }, right: { path: string }) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

async function pathExists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onLimit: () => void) {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) return { ok: true, bytes: Buffer.concat(chunks, length) } as const
    chunks.push(next.value)
    length += next.value.byteLength
    if (length > limit) {
      onLimit()
      return { ok: false, bytes: Buffer.concat(chunks, length).subarray(0, limit) } as const
    }
  }
}

function kill(child: ReturnType<typeof Bun.spawn>) {
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

function requireStream(input: number | ReadableStream<Uint8Array> | undefined) {
  if (!(input instanceof ReadableStream)) throw new Error("Git pipe unavailable")
  return input
}

function fileSystemCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null
}

function blocked(reason: GitStageBlockReason): GitStageInventoryResult & GitStagePreparationResult {
  return { status: "blocked", reason }
}

function blockedWithoutEffect(reason: GitStageBlockReason): GitStageExecutionResult {
  return { status: "blocked_without_effect", verification: "not_verified", reason }
}

function unknown(
  reason: Extract<GitStageExecutionResult, { status: "effect_unknown" }>["reason"],
): GitStageExecutionResult {
  return { status: "effect_unknown", verification: "not_verified", reason }
}

function verificationBlocked(
  reason: Extract<GitStageVerificationResult, { status: "blocked" }>["reason"],
): GitStageVerificationResult {
  return { status: "blocked", verification: "not_verified", reason }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
