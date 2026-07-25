import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, openSync } from "node:fs"
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join, resolve } from "node:path"
import {
  computeGitCommitInventoryDigest,
  computeGitCommitProposalDigest,
  gitCommitBoundaryLabel,
  gitCommitLimitations,
  parseGitCommitDecision,
  parseGitCommitInventory,
  parseGitCommitMessage,
  parseGitCommitObservation,
  parseGitCommitPreview,
  type GitCommitDecision,
  type GitCommitIdentity,
  type GitCommitHelperIdentity,
  type GitCommitIndexEntry,
  type GitCommitInventory,
  type GitCommitInventoryAuthority,
  type GitCommitObject,
  type GitCommitObservation,
  type GitCommitPreview,
  type GitCommitPreviewAuthority,
} from "@astra/domain/git-commit-mutation"
import {
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import { captureGitRepositoryBaseline, revalidateGitRepositoryBaseline } from "./baseline"

const authorizationLifetimeMs = 5 * 60 * 1_000
const scratchBase = "/private/tmp"
const nativeHelperPath = resolve(import.meta.dir, "../../../tools/astra-git-commit-native/build/astra-git-commit")
const commandLimits = {
  timeoutMs: 15_000,
  maxStdoutBytes: 16 * 1024 * 1024,
  maxStderrBytes: 16 * 1024,
} as const

export type GitCommitBlockReason =
  | "unsupported_platform"
  | "invalid_input"
  | "identity_required"
  | "detached_head"
  | "unborn_head"
  | "external_git_directory_unsupported"
  | "alternates_unsupported"
  | "promisor_unsupported"
  | "ref_storage_unsupported"
  | "packed_ref_unsupported"
  | "conflicts_present"
  | "submodule_unsupported"
  | "split_index_unsupported"
  | "index_lock_present"
  | "ref_lock_present"
  | "nothing_staged"
  | "index_unavailable"
  | "object_missing"
  | "baseline_stale"
  | "proposal_expired"
  | "proposal_consumed"
  | "durable_claim_unavailable"
  | "authority_expired"
  | "runtime_scratch_unavailable"
  | "native_helper_unavailable"

export type GitCommitPreparationResult =
  | Readonly<{
      status: "ready"
      baseline: GitRepositoryBaselineSnapshot
      inventory: GitCommitInventory
      preview: GitCommitPreview
    }>
  | Readonly<{ status: "blocked"; reason: GitCommitBlockReason }>

export type GitCommitExecutionResult =
  | Readonly<{ status: "denied_without_effect"; verification: "not_verified" }>
  | Readonly<{
      status: "blocked_without_effect"
      verification: "not_verified"
      reason: GitCommitBlockReason
    }>
  | Readonly<{
      status: "reconciliation_required"
      verification: "not_verified"
      reason:
        | "process_failed_after_claim"
        | "quarantine_state_unknown"
        | "orphan_objects_installed"
        | "ref_race_or_orphan_objects"
        | "ref_update_unknown"
        | "cleanup_failed"
        | "post_state_mismatch"
        | "authority_expired_after_effect"
    }>
  | Readonly<{ status: "effect_observed"; verification: "not_verified"; observation: GitCommitObservation }>

export type GitCommitVerificationResult =
  | Readonly<{
      status: "verified"
      verification: "independent_commit_bytes_and_repository_state"
      proposalDigest: `sha256:${string}`
      commitOID: string
      limitations: typeof gitCommitLimitations
    }>
  | Readonly<{
      status: "blocked" | "stale"
      verification: "not_verified"
      reason: "invalid_input" | "post_state_unavailable" | "post_state_mismatch" | "post_state_changed"
    }>

export type GitCommitDurableClaim = Readonly<{
  proposalDigest: `sha256:${string}`
  nonce: string
  expiresAt: string
  decision: "approved"
}>

export type GitCommitDurableClaimResult =
  | Readonly<{ status: "claimed"; effectExpiresAt: string }>
  | "already_claimed"
  | "unavailable"

export type GitCommitFaultPoint =
  | "after_claim_before_revalidation"
  | "after_quarantine_before_object_install"
  | "after_objects_installed_before_ref_cas"
  | "after_ref_cas_before_observation"

export type GitCommitInvocation = Readonly<{
  executablePath: string
  arguments: ReadonlyArray<string>
  environment: Readonly<Record<string, string>>
  stdin: Uint8Array | "ignore"
  limits: Readonly<{ timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }>
}>

export type GitCommitProcessObservation =
  | Readonly<{ started: false }>
  | Readonly<{
      started: true
      termination: "exited" | "timed_out" | "output_limit_exceeded"
      exitCode: number | null
      stdout: Uint8Array
      stderr: Uint8Array
    }>

export type GitCommitDependencies = Readonly<{
  platform: string
  gitPath: string
  environment: Readonly<Record<string, string | undefined>>
  nativeHelperPath: string
  runGit: (invocation: GitCommitInvocation) => Promise<GitCommitProcessObservation>
  revalidateBaseline: (
    workspaceRoot: string,
    baseline: GitRepositoryBaselineSnapshot,
  ) => ReturnType<typeof revalidateGitRepositoryBaseline>
  captureBaseline: (workspaceRoot: string) => ReturnType<typeof captureGitRepositoryBaseline>
  claimProposal: (claim: GitCommitDurableClaim) => Promise<GitCommitDurableClaimResult>
  injectFault?: (point: GitCommitFaultPoint) => Promise<void>
  now: () => number
}>

const productionDependencies: GitCommitDependencies = {
  platform: process.platform,
  gitPath: "/usr/bin/git",
  environment: process.env,
  nativeHelperPath,
  runGit,
  revalidateBaseline: revalidateGitRepositoryBaseline,
  captureBaseline: captureGitRepositoryBaseline,
  async claimProposal() {
    return "unavailable"
  },
  now: Date.now,
}

/** Read-only preparation. The child controls only the validated message; all
 * repository facts, identity, time, tree bytes and commit bytes are parent-owned. */
export async function prepareGitCommitLocal(
  workspaceRoot: string,
  expectedBaseline: GitRepositoryBaselineSnapshot,
  messageInput: unknown,
  parentEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
  dependencies: Partial<GitCommitDependencies> = {},
): Promise<GitCommitPreparationResult> {
  const deps = { ...productionDependencies, ...dependencies, environment: parentEnvironment }
  if (deps.platform !== "darwin") return blocked("unsupported_platform")
  const baseline = parseGitRepositoryBaselineSnapshot(expectedBaseline)
  const message = parseGitCommitMessage(messageInput)
  if (!baseline.ok || !message.ok || !Number.isFinite(now)) return blocked("invalid_input")
  if (baseline.value.root.canonicalPath !== resolve(workspaceRoot)) return blocked("invalid_input")
  if (baseline.value.gitDirectory.canonicalPath !== join(baseline.value.root.canonicalPath, ".git")) {
    return blocked("external_git_directory_unsupported")
  }
  if (baseline.value.commonDirectory.canonicalPath !== baseline.value.gitDirectory.canonicalPath) {
    return blocked("external_git_directory_unsupported")
  }
  if (baseline.value.head.kind === "unborn") return blocked("unborn_head")
  if (baseline.value.head.kind === "detached") return blocked("detached_head")
  const headRef = branchRef(baseline.value.head.symbolicRef)
  if (!headRef) return blocked("detached_head")
  const identity = parentIdentity(parentEnvironment)
  if (!identity) return blocked("identity_required")
  const helper = await inspectNativeHelper(deps.nativeHelperPath)
  if (!helper) return blocked("native_helper_unavailable")
  const current = await deps.revalidateBaseline(workspaceRoot, baseline.value).catch(() => null)
  if (!current || current.status !== "current") return blocked("baseline_stale")
  const locks = await blockingLock(workspaceRoot, headRef)
  if (locks === "index") return blocked("index_lock_present")
  if (locks === "ref") return blocked("ref_lock_present")
  if (await exists(join(workspaceRoot, ".git", "objects", "info", "alternates"))) {
    return blocked("alternates_unsupported")
  }
  if (await packedRefUnsupported(workspaceRoot, headRef)) return blocked("packed_ref_unsupported")

  const repository = await observeRepository(workspaceRoot, headRef, baseline.value.head.oid, deps)
  if (!repository.ok) return blocked(repository.reason)
  if (repository.treeOID === repository.headTreeOID) return blocked("nothing_staged")
  const timestamp = Math.floor(now / 1_000)
  const commitBytes = Buffer.from(
    `tree ${repository.treeOID}\nparent ${repository.headOID}\nauthor ${identity.name} <${identity.email}> ${timestamp} +0000\ncommitter ${identity.name} <${identity.email}> ${timestamp} +0000\n\n${message.value}`,
  )
  const commitOID = objectID(commitBytes, "commit", repository.objectFormat)
  const commitObject = objectRecord(commitOID, commitBytes)
  const authority = {
    schemaVersion: 1,
    workspaceRoot: baseline.value.root.canonicalPath,
    baselineSnapshotDigest: baseline.value.snapshotDigest,
    helper,
    objectFormat: repository.objectFormat,
    ref: repository.ref,
    expectedOldOID: repository.headOID,
    indexDigest: repository.indexDigest,
    worktreeDigest: baseline.value.worktree.digest,
    refsDigest: repository.refsDigest,
    otherRefsDigest: repository.otherRefsDigest,
    indexEntries: repository.indexEntries,
    identity,
    timestamp,
    timezone: "+0000",
    message: message.value,
    treeOID: repository.treeOID,
    commitOID,
    treeObjects: repository.treeObjects,
    commitObject,
    reflog: repository.reflog,
    reflogBefore: repository.reflogBefore,
  } as const satisfies GitCommitInventoryAuthority
  const inventory = { ...authority, inventoryDigest: computeGitCommitInventoryDigest(authority) }
  const parsedInventory = parseGitCommitInventory(inventory)
  if (!parsedInventory.ok) return blocked("invalid_input")
  const nonce = randomUUID()
  const createdAt = new Date(now).toISOString()
  const runtimeScratch = join(scratchBase, `astra-git-commit-${nonce}`)
  const objectOIDs = [...repository.treeObjects.map((object) => object.oid), commitOID]
  const repositoryWrites = [
    ...objectOIDs.map((oid) => `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`),
    `.git/${repository.ref}`,
    `.git/${repository.ref}.lock`,
    ...(repository.reflog === "existing_update" ? [`.git/logs/${repository.ref}`] : []),
  ].sort()
  const previewAuthority = {
    schemaVersion: 1,
    operation: "git_commit_local",
    boundary: "host_no_sandbox",
    boundaryLabel: gitCommitBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: baseline.value.root.canonicalPath,
    nonce,
    createdAt,
    expiresAt: new Date(now + authorizationLifetimeMs).toISOString(),
    runtimeScratch,
    baselineSnapshotDigest: baseline.value.snapshotDigest,
    inventoryDigest: inventory.inventoryDigest,
    helper,
    objectFormat: repository.objectFormat,
    branch: repository.ref.slice("refs/heads/".length),
    ref: repository.ref,
    expectedOldOID: repository.headOID,
    treeOID: repository.treeOID,
    commitOID,
    identity,
    timestamp,
    timezone: "+0000",
    message: message.value,
    treeObjects: repository.treeObjects.map(({ oid, byteLength, contentDigest }) => ({
      oid,
      byteLength,
      contentDigest,
    })),
    commitObject: { byteLength: commitObject.byteLength, contentDigest: commitObject.contentDigest },
    repositoryWrites,
    scratchWrites: [runtimeScratch],
    reflog: repository.reflog,
    hooks: "disabled",
    editor: "disabled",
    signing: "disabled",
    credentials: "disabled",
    network: "not_requested_host_unrestricted",
    authorizationConsumption: "durable_operation_kernel_claim_required",
    preserves: { index: "required", worktree: "required", otherRefs: "required" },
    limitations: gitCommitLimitations,
  } as const satisfies GitCommitPreviewAuthority
  const preview = {
    ...previewAuthority,
    proposalDigest: computeGitCommitProposalDigest(previewAuthority),
  }
  if (!parseGitCommitPreview(preview).ok) return blocked("invalid_input")
  return { status: "ready", baseline: baseline.value, inventory: parsedInventory.value, preview }
}

/** Executes one exact approved commit. The durable claim is accepted before
 * revalidation, scratch creation, object installation or ref mutation. */
export async function executeGitCommitLocal(
  input: Readonly<{
    preview: GitCommitPreview
    inventory: GitCommitInventory
    expectedBaseline: GitRepositoryBaselineSnapshot
    decision: GitCommitDecision
  }>,
  dependencies: Partial<GitCommitDependencies> = {},
): Promise<GitCommitExecutionResult> {
  const parsed = parseExecutionInput(input)
  if (!parsed.ok) return blockedWithoutEffect("invalid_input")
  if (parsed.decision.decision === "rejected") {
    return { status: "denied_without_effect", verification: "not_verified" }
  }
  const deps = { ...productionDependencies, ...dependencies }
  if (deps.platform !== "darwin") return blockedWithoutEffect("unsupported_platform")
  if (Date.now() > Date.parse(parsed.preview.expiresAt)) return blockedWithoutEffect("proposal_expired")
  const claim = await deps
    .claimProposal({
      proposalDigest: parsed.preview.proposalDigest,
      nonce: parsed.preview.nonce,
      expiresAt: parsed.preview.expiresAt,
      decision: "approved",
    })
    .catch(() => "unavailable" as const)
  if (claim === "already_claimed") return blockedWithoutEffect("proposal_consumed")
  if (claim === "unavailable") return blockedWithoutEffect("durable_claim_unavailable")
  if (!effectAuthorityCurrent(claim.effectExpiresAt, deps.now, commandLimits.timeoutMs)) {
    return blockedWithoutEffect("authority_expired")
  }

  let scratchCreated = false
  try {
    await deps.injectFault?.("after_claim_before_revalidation")
    const authority = await revalidateApprovedAuthority(parsed, deps)
    if (authority) return blockedWithoutEffect(authority)
    const scratch = await prepareScratch(parsed.preview.runtimeScratch)
    if (scratch === "cleanup_unknown") return reconciliation("cleanup_failed")
    if (scratch === "blocked") {
      return blockedWithoutEffect("runtime_scratch_unavailable")
    }
    scratchCreated = true
    const helperSnapshot = await snapshotNativeHelper(parsed.preview.runtimeScratch, parsed.inventory.helper)
    if (!helperSnapshot) return blockedWithoutEffect("native_helper_unavailable")
    const objects = [...parsed.inventory.treeObjects, parsed.inventory.commitObject]
    for (const object of objects) {
      if (!effectAuthorityCurrent(claim.effectExpiresAt, deps.now, commandLimits.timeoutMs)) {
        return reconciliation("authority_expired_after_effect")
      }
      const type = object.oid === parsed.inventory.commitOID ? "commit" : "tree"
      const hashed = await deps.runGit(
        invocation(
          deps.gitPath,
          parsed.preview,
          ["hash-object", "-t", type, "-w", "--stdin"],
          bytes(object),
          deps.environment,
          true,
        ),
      )
      if (successfulLine(hashed) !== object.oid) {
        return reconciliation("quarantine_state_unknown")
      }
    }
    await deps.injectFault?.("after_quarantine_before_object_install")
    await deps.injectFault?.("after_objects_installed_before_ref_cas")
    if (!effectAuthorityCurrent(claim.effectExpiresAt, deps.now, commandLimits.timeoutMs)) {
      return reconciliation("authority_expired_after_effect")
    }
    const published = await runNativePublisher(helperSnapshot, parsed.preview, objects)
    if (published.status === "no_effect") {
      if (!(await cleanupScratch(parsed.preview.runtimeScratch))) return reconciliation("cleanup_failed")
      scratchCreated = false
      return blockedWithoutEffect(published.detail === 5 || published.detail === 6 ? "baseline_stale" : "native_helper_unavailable")
    }
    if (published.status === "objects_installed") return reconciliation("ref_race_or_orphan_objects")
    if (published.status === "uncertain") return reconciliation("ref_update_unknown")
    if (published.status === "invalid") return reconciliation("process_failed_after_claim")
    await deps.injectFault?.("after_ref_cas_before_observation")
    const currentRef = await readRef(parsed.preview, deps)
    if (currentRef !== parsed.preview.commitOID) return reconciliation("post_state_mismatch")
    if (!(await cleanupScratch(parsed.preview.runtimeScratch))) return reconciliation("cleanup_failed")
    scratchCreated = false
    return {
      status: "effect_observed",
      verification: "not_verified",
      observation: {
        schemaVersion: 1,
        operation: "git_commit_local",
        status: "effect_observed",
        verification: "not_verified",
        proposalDigest: parsed.preview.proposalDigest,
        ref: parsed.preview.ref,
        beforeOID: parsed.preview.expectedOldOID,
        afterOID: parsed.preview.commitOID,
        objectOIDs: objects.map((object) => object.oid),
        limitations: gitCommitLimitations,
      },
    }
  } catch {
    if (scratchCreated) await cleanupScratch(parsed.preview.runtimeScratch).catch(() => false)
    return reconciliation("process_failed_after_claim")
  }
}

/** Independently re-observes exact object bytes, ref, index, worktree and all
 * non-target refs. A zero process exit is never sufficient for VERIFIED. */
export async function verifyGitCommitLocal(
  input: Readonly<{
    preview: GitCommitPreview
    inventory: GitCommitInventory
    expectedBaseline: GitRepositoryBaselineSnapshot
    observation: GitCommitObservation
  }>,
  dependencies: Partial<GitCommitDependencies> = {},
): Promise<GitCommitVerificationResult> {
  const preview = parseGitCommitPreview(input.preview)
  const inventory = parseGitCommitInventory(input.inventory)
  const baseline = parseGitRepositoryBaselineSnapshot(input.expectedBaseline)
  const observation = parseGitCommitObservation(input.observation)
  if (
    !preview.ok ||
    !inventory.ok ||
    !baseline.ok ||
    !observation.ok ||
    !bindingsMatch(preview.value, inventory.value, baseline.value) ||
    observation.value.proposalDigest !== preview.value.proposalDigest ||
    observation.value.ref !== preview.value.ref ||
    observation.value.beforeOID !== preview.value.expectedOldOID ||
    observation.value.afterOID !== preview.value.commitOID ||
    JSON.stringify(observation.value.objectOIDs) !==
      JSON.stringify([...inventory.value.treeObjects, inventory.value.commitObject].map((object) => object.oid)) ||
    JSON.stringify(observation.value.limitations) !== JSON.stringify(preview.value.limitations)
  ) {
    return verificationBlocked("invalid_input")
  }
  if (await exists(preview.value.runtimeScratch)) return verificationBlocked("post_state_mismatch")
  const deps = { ...productionDependencies, ...dependencies }
  const firstRef = await readRef(preview.value, deps)
  if (firstRef !== preview.value.commitOID) return verificationBlocked("post_state_mismatch")
  const objects = [...inventory.value.treeObjects, inventory.value.commitObject]
  for (const object of objects) {
    const type = object.oid === inventory.value.commitOID ? "commit" : "tree"
    const observed = await deps.runGit(
      invocation(
        deps.gitPath,
        preview.value,
        ["cat-file", type, object.oid],
        "ignore",
        deps.environment,
        false,
        object.byteLength,
      ),
    )
    if (!successfulBytes(observed, bytes(object))) return verificationBlocked("post_state_mismatch")
  }
  const index = await readFile(join(preview.value.workspaceRoot, ".git", "index")).catch(() => null)
  if (!index || digestBytes(index) !== inventory.value.indexDigest) return verificationBlocked("post_state_mismatch")
  const refs = await observeRefs(preview.value, deps)
  if (!refs || refs.otherRefsDigest !== inventory.value.otherRefsDigest) {
    return verificationBlocked("post_state_mismatch")
  }
  if (!(await verifyReflog(preview.value, inventory.value))) return verificationBlocked("post_state_mismatch")
  const post = await deps.captureBaseline(preview.value.workspaceRoot).catch(() => null)
  if (!post || post.status !== "complete") return verificationBlocked("post_state_unavailable")
  if (
    post.snapshot.root.device !== baseline.value.root.device ||
    post.snapshot.root.inode !== baseline.value.root.inode ||
    post.snapshot.gitDirectory.device !== baseline.value.gitDirectory.device ||
    post.snapshot.gitDirectory.inode !== baseline.value.gitDirectory.inode ||
    post.snapshot.index.digest !== baseline.value.index.digest ||
    post.snapshot.index.metadataDigest !== baseline.value.index.metadataDigest ||
    post.snapshot.worktree.digest !== baseline.value.worktree.digest ||
    post.snapshot.head.kind !== "symbolic" ||
    post.snapshot.head.symbolicRef !== preview.value.ref ||
    post.snapshot.head.oid !== preview.value.commitOID
  ) {
    return verificationBlocked("post_state_mismatch")
  }
  const finalRefs = await observeRefs(preview.value, deps)
  if (
    !finalRefs ||
    finalRefs.refsDigest !== refs.refsDigest ||
    finalRefs.otherRefsDigest !== refs.otherRefsDigest ||
    finalRefs.otherRefsDigest !== inventory.value.otherRefsDigest
  ) {
    return { status: "stale", verification: "not_verified", reason: "post_state_changed" }
  }
  const secondRef = await readRef(preview.value, deps)
  if (secondRef !== firstRef) return { status: "stale", verification: "not_verified", reason: "post_state_changed" }
  return {
    status: "verified",
    verification: "independent_commit_bytes_and_repository_state",
    proposalDigest: preview.value.proposalDigest,
    commitOID: preview.value.commitOID,
    limitations: gitCommitLimitations,
  }
}

function parseExecutionInput(
  input: Readonly<{
    preview: GitCommitPreview
    inventory: GitCommitInventory
    expectedBaseline: GitRepositoryBaselineSnapshot
    decision: GitCommitDecision
  }>,
) {
  const preview = parseGitCommitPreview(input.preview)
  const inventory = parseGitCommitInventory(input.inventory)
  const baseline = parseGitRepositoryBaselineSnapshot(input.expectedBaseline)
  const decision = parseGitCommitDecision(input.decision)
  if (
    !preview.ok ||
    !inventory.ok ||
    !baseline.ok ||
    !decision.ok ||
    !bindingsMatch(preview.value, inventory.value, baseline.value) ||
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

function bindingsMatch(
  preview: GitCommitPreview,
  inventory: GitCommitInventory,
  baseline: GitRepositoryBaselineSnapshot,
) {
  return (
    preview.inventoryDigest === inventory.inventoryDigest &&
    JSON.stringify(preview.helper) === JSON.stringify(inventory.helper) &&
    preview.baselineSnapshotDigest === baseline.snapshotDigest &&
    inventory.baselineSnapshotDigest === baseline.snapshotDigest &&
    preview.workspaceRoot === baseline.root.canonicalPath &&
    preview.ref === inventory.ref &&
    preview.expectedOldOID === inventory.expectedOldOID &&
    baseline.head.kind === "symbolic" &&
    baseline.head.symbolicRef === preview.ref &&
    baseline.head.oid === preview.expectedOldOID &&
    preview.objectFormat === inventory.objectFormat &&
    preview.treeOID === inventory.treeOID &&
    preview.commitOID === inventory.commitOID &&
    preview.message === inventory.message &&
    preview.timestamp === inventory.timestamp &&
    preview.timezone === inventory.timezone &&
    preview.reflog === inventory.reflog &&
    JSON.stringify(preview.identity) === JSON.stringify(inventory.identity) &&
    JSON.stringify(preview.treeObjects) ===
      JSON.stringify(
        inventory.treeObjects.map(({ oid, byteLength, contentDigest }) => ({ oid, byteLength, contentDigest })),
      ) &&
    JSON.stringify(preview.commitObject) ===
      JSON.stringify({
        byteLength: inventory.commitObject.byteLength,
        contentDigest: inventory.commitObject.contentDigest,
      }) &&
    exactInventoryObjects(inventory) &&
    JSON.stringify(preview.repositoryWrites) === JSON.stringify(expectedRepositoryWrites(preview, inventory))
  )
}

function exactInventoryObjects(inventory: GitCommitInventory) {
  const expectedTrees = buildTreeObjects(inventory.indexEntries, inventory.objectFormat)
  if (JSON.stringify(expectedTrees) !== JSON.stringify(inventory.treeObjects)) return false
  if (expectedTrees.at(-1)?.oid !== inventory.treeOID) return false
  const expectedCommit = Buffer.from(
    `tree ${inventory.treeOID}\nparent ${inventory.expectedOldOID}\nauthor ${inventory.identity.name} <${inventory.identity.email}> ${inventory.timestamp} ${inventory.timezone}\ncommitter ${inventory.identity.name} <${inventory.identity.email}> ${inventory.timestamp} ${inventory.timezone}\n\n${inventory.message}`,
  )
  return (
    objectID(expectedCommit, "commit", inventory.objectFormat) === inventory.commitOID &&
    Buffer.from(expectedCommit).equals(bytes(inventory.commitObject))
  )
}

function expectedRepositoryWrites(preview: GitCommitPreview, inventory: GitCommitInventory) {
  return [
    ...[...inventory.treeObjects, inventory.commitObject].map(
      (object) => `.git/objects/${object.oid.slice(0, 2)}/${object.oid.slice(2)}`,
    ),
    `.git/${preview.ref}`,
    `.git/${preview.ref}.lock`,
    ...(preview.reflog === "existing_update" ? [`.git/logs/${preview.ref}`] : []),
  ].sort()
}

async function revalidateApprovedAuthority(
  input: ReturnType<typeof parseExecutionInput> & { ok: true },
  dependencies: GitCommitDependencies,
): Promise<GitCommitBlockReason | null> {
  const current = await dependencies.revalidateBaseline(input.preview.workspaceRoot, input.baseline).catch(() => null)
  if (!current || current.status !== "current") return "baseline_stale"
  const lock = await blockingLock(input.preview.workspaceRoot, input.preview.ref)
  if (lock === "index") return "index_lock_present"
  if (lock === "ref") return "ref_lock_present"
  const index = await readFile(join(input.preview.workspaceRoot, ".git", "index")).catch(() => null)
  if (!index || digestBytes(index) !== input.inventory.indexDigest) return "baseline_stale"
  const ref = await readRef(input.preview, dependencies)
  if (ref !== input.preview.expectedOldOID) return "baseline_stale"
  const refs = await observeRefs(input.preview, dependencies)
  if (!refs || refs.otherRefsDigest !== input.inventory.otherRefsDigest) return "baseline_stale"
  if (!(await reflogStillCurrent(input.preview, input.inventory))) return "baseline_stale"
  return null
}

async function reflogStillCurrent(preview: GitCommitPreview, inventory: GitCommitInventory) {
  const current = await readFile(join(preview.workspaceRoot, ".git", "logs", preview.ref)).catch(() => null)
  if (inventory.reflogBefore.state === "absent") return current === null
  return (
    current !== null &&
    current.byteLength === inventory.reflogBefore.byteLength &&
    digestBytes(current) === inventory.reflogBefore.contentDigest
  )
}

async function verifyReflog(preview: GitCommitPreview, inventory: GitCommitInventory) {
  const current = await readFile(join(preview.workspaceRoot, ".git", "logs", preview.ref)).catch(() => null)
  if (inventory.reflogBefore.state === "absent") return current === null
  if (!current || current.byteLength <= inventory.reflogBefore.byteLength) return false
  const prefix = current.subarray(0, inventory.reflogBefore.byteLength)
  const suffix = current.subarray(inventory.reflogBefore.byteLength)
  const expected = Buffer.from(
    `${preview.expectedOldOID} ${preview.commitOID} ${preview.identity.name} <${preview.identity.email}> ${preview.timestamp} ${preview.timezone}\tastra: governed local commit\n`,
  )
  return digestBytes(prefix) === inventory.reflogBefore.contentDigest && Buffer.from(suffix).equals(expected)
}

async function observeRepository(
  workspaceRoot: string,
  expectedRef: `refs/heads/${string}`,
  expectedHead: string,
  dependencies: GitCommitDependencies,
): Promise<
  | Readonly<{
      ok: true
      ref: `refs/heads/${string}`
      headOID: string
      headTreeOID: string
      treeOID: string
      objectFormat: "sha1" | "sha256"
      indexDigest: `sha256:${string}`
      refsDigest: `sha256:${string}`
      otherRefsDigest: `sha256:${string}`
      indexEntries: ReadonlyArray<GitCommitIndexEntry>
      treeObjects: ReadonlyArray<GitCommitObject>
      reflog: "absent_no_create" | "existing_update"
      reflogBefore: GitCommitInventory["reflogBefore"]
    }>
  | Readonly<{ ok: false; reason: GitCommitBlockReason }>
> {
  const preview = minimalPreview(workspaceRoot, expectedRef)
  const symbolic = successfulLine(
    await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["symbolic-ref", "-q", "HEAD"],
        "ignore",
        dependencies.environment,
        false,
      ),
    ),
  )
  if (!symbolic) return { ok: false, reason: "detached_head" }
  if (symbolic !== expectedRef) return { ok: false, reason: "baseline_stale" }
  const headOID = successfulLine(
    await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["rev-parse", "--verify", "HEAD"],
        "ignore",
        dependencies.environment,
        false,
      ),
    ),
  )
  if (!headOID) return { ok: false, reason: "unborn_head" }
  if (headOID !== expectedHead) return { ok: false, reason: "baseline_stale" }
  const format = successfulLine(
    await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["rev-parse", "--show-object-format"],
        "ignore",
        dependencies.environment,
        false,
      ),
    ),
  )
  if (format !== "sha1" && format !== "sha256") return { ok: false, reason: "index_unavailable" }
  const config = await dependencies.runGit(
    invocation(
      dependencies.gitPath,
      preview,
      ["config", "--local", "--null", "--get-regexp", ".*"],
      "ignore",
      dependencies.environment,
      false,
    ),
  )
  const configText = optionalOutput(config)
  if (configText === null) return { ok: false, reason: "index_unavailable" }
  if (/(^|\0)(extensions\.partialclone|remote\.[^\0]+\.promisor)\n/iu.test(configText)) {
    return { ok: false, reason: "promisor_unsupported" }
  }
  if (/(^|\0)extensions\.refstorage\n/iu.test(configText)) return { ok: false, reason: "ref_storage_unsupported" }
  const sharedIndex = optionalLine(
    await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["rev-parse", "--shared-index-path"],
        "ignore",
        dependencies.environment,
        false,
      ),
    ),
  )
  if (sharedIndex === null) return { ok: false, reason: "index_unavailable" }
  if (sharedIndex.length > 0) return { ok: false, reason: "split_index_unsupported" }
  const indexOutput = await dependencies.runGit(
    invocation(
      dependencies.gitPath,
      preview,
      ["ls-files", "--full-name", "--stage", "-z", "--", ":(top)"],
      "ignore",
      dependencies.environment,
      false,
    ),
  )
  const rawIndex = successfulOutput(indexOutput)
  if (!rawIndex) return { ok: false, reason: "index_unavailable" }
  const parsed = parseIndex(rawIndex, format)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  for (const entry of parsed.entries) {
    const exists = await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["cat-file", "-e", `${entry.oid}^{blob}`],
        "ignore",
        dependencies.environment,
        false,
      ),
    )
    if (!successfulEmpty(exists)) return { ok: false, reason: "object_missing" }
  }
  const treeObjects = buildTreeObjects(parsed.entries, format)
  const treeOID = treeObjects.at(-1)!.oid
  const headTreeOID = successfulLine(
    await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["rev-parse", `${headOID}^{tree}`],
        "ignore",
        dependencies.environment,
        false,
      ),
    ),
  )
  if (!headTreeOID) return { ok: false, reason: "index_unavailable" }
  const indexBytes = await readFile(join(workspaceRoot, ".git", "index")).catch(() => null)
  if (!indexBytes) return { ok: false, reason: "index_unavailable" }
  const refs = await observeRefs(preview, dependencies)
  if (!refs) return { ok: false, reason: "index_unavailable" }
  const reflogBytes = await readFile(join(workspaceRoot, ".git", "logs", expectedRef)).catch(() => null)
  return {
    ok: true,
    ref: expectedRef,
    headOID,
    headTreeOID,
    treeOID,
    objectFormat: format,
    indexDigest: digestBytes(indexBytes),
    refsDigest: refs.refsDigest,
    otherRefsDigest: refs.otherRefsDigest,
    indexEntries: parsed.entries,
    treeObjects,
    reflog: reflogBytes ? "existing_update" : "absent_no_create",
    reflogBefore: reflogBytes
      ? { state: "existing", byteLength: reflogBytes.byteLength, contentDigest: digestBytes(reflogBytes) }
      : { state: "absent" },
  }
}

function buildTreeObjects(entries: ReadonlyArray<GitCommitIndexEntry>, format: "sha1" | "sha256") {
  const root: TreeNode = { files: new Map(), directories: new Map() }
  for (const entry of entries) {
    const segments = entry.path.split("/")
    const name = segments.at(-1)!
    const parent = segments.slice(0, -1).reduce((node, segment) => {
      const current = node.directories.get(segment) ?? { files: new Map(), directories: new Map() }
      node.directories.set(segment, current)
      return current
    }, root)
    parent.files.set(name, entry)
  }
  const objects: Array<GitCommitObject> = []
  const encode = (node: TreeNode): string => {
    const values = [
      ...[...node.files].map(([name, entry]) => ({ name, sortName: name, mode: entry.mode, oid: entry.oid })),
      ...[...node.directories].map(([name, directory]) => ({
        name,
        sortName: `${name}/`,
        mode: "40000" as const,
        oid: encode(directory),
      })),
    ].sort((left, right) => Buffer.from(left.sortName).compare(Buffer.from(right.sortName)))
    const content = Buffer.concat(
      values.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, "hex")]),
    )
    const oid = objectID(content, "tree", format)
    objects.push(objectRecord(oid, content))
    return oid
  }
  encode(root)
  return objects
}

type TreeNode = {
  files: Map<string, GitCommitIndexEntry>
  directories: Map<string, TreeNode>
}

function parseIndex(
  output: Uint8Array,
  format: "sha1" | "sha256",
):
  | Readonly<{ ok: true; entries: ReadonlyArray<GitCommitIndexEntry> }>
  | Readonly<{ ok: false; reason: "conflicts_present" | "submodule_unsupported" | "index_unavailable" }> {
  const entries: Array<GitCommitIndexEntry> = []
  const bytes = Buffer.from(output)
  let cursor = 0
  while (cursor < bytes.length) {
    const end = bytes.indexOf(0, cursor)
    if (end < 0) return { ok: false, reason: "index_unavailable" }
    const tab = bytes.indexOf(0x09, cursor)
    if (tab < 0 || tab > end) return { ok: false, reason: "index_unavailable" }
    const header = bytes
      .subarray(cursor, tab)
      .toString("ascii")
      .match(/^([0-7]{6}) ([0-9a-f]+) ([0-3])$/u)
    if (!header) return { ok: false, reason: "index_unavailable" }
    if (header[3] !== "0") return { ok: false, reason: "conflicts_present" }
    if (header[1] === "160000") return { ok: false, reason: "submodule_unsupported" }
    if (header[1] !== "100644" && header[1] !== "100755") return { ok: false, reason: "index_unavailable" }
    if (!new RegExp(`^[0-9a-f]{${format === "sha1" ? 40 : 64}}$`, "u").test(header[2]!)) {
      return { ok: false, reason: "index_unavailable" }
    }
    const pathBytes = bytes.subarray(tab + 1, end)
    const path = decodeUTF8(pathBytes)
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")
    ) {
      return { ok: false, reason: "index_unavailable" }
    }
    entries.push({ mode: header[1], oid: header[2]!, path })
    cursor = end + 1
  }
  if (entries.length === 0 || entries.length > 25_000) return { ok: false, reason: "index_unavailable" }
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    return { ok: false, reason: "index_unavailable" }
  }
  return { ok: true, entries }
}

async function observeRefs(
  preview: Pick<GitCommitPreview, "workspaceRoot" | "ref">,
  dependencies: GitCommitDependencies,
) {
  const result = await dependencies.runGit(
    invocation(dependencies.gitPath, preview, ["show-ref"], "ignore", dependencies.environment, false),
  )
  const output = successfulOutput(result)
  if (!output) return null
  const text = decodeUTF8(output)
  if (text === null) return null
  const refs = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^\x00-\x20]+)$/u)
      return match ? { oid: match[1]!, ref: match[2]! } : null
    })
  if (refs.some((ref) => ref === null)) return null
  const values = refs.filter((ref): ref is { oid: string; ref: string } => ref !== null)
  const canonical = values
    .sort((left, right) => left.ref.localeCompare(right.ref))
    .map((ref) => `${ref.oid} ${ref.ref}\n`)
    .join("")
  const other = values
    .filter((ref) => ref.ref !== preview.ref)
    .map((ref) => `${ref.oid} ${ref.ref}\n`)
    .join("")
  return { refsDigest: digestText(canonical), otherRefsDigest: digestText(other) }
}

async function readRef(preview: Pick<GitCommitPreview, "workspaceRoot" | "ref">, dependencies: GitCommitDependencies) {
  return successfulLine(
    await dependencies.runGit(
      invocation(
        dependencies.gitPath,
        preview,
        ["rev-parse", "--verify", preview.ref],
        "ignore",
        dependencies.environment,
        false,
      ),
    ),
  )
}

function invocation(
  gitPath: string,
  preview: Pick<GitCommitPreview, "workspaceRoot"> &
    Partial<Pick<GitCommitPreview, "runtimeScratch" | "identity" | "timestamp" | "timezone">>,
  command: ReadonlyArray<string>,
  stdin: Uint8Array | "ignore",
  environment: Readonly<Record<string, string | undefined>>,
  quarantine: boolean,
  maxStdoutBytes = commandLimits.maxStdoutBytes,
): GitCommitInvocation {
  // Git receives a closed environment; caller variables are deliberately not inherited.
  void environment
  const repository = join(preview.workspaceRoot, ".git")
  const runtimeScratch = preview.runtimeScratch
  if (quarantine && !runtimeScratch) throw new TypeError("Quarantine scratch authority is missing")
  const quarantineEnvironment = quarantineVariables(quarantine, runtimeScratch)
  return {
    executablePath: gitPath,
    arguments: [
      "--no-pager",
      "--no-lazy-fetch",
      "--no-optional-locks",
      "--no-replace-objects",
      `--git-dir=${repository}`,
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
      "core.logAllRefUpdates=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "core.editor=true",
      "-c",
      "sequence.editor=true",
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
      GIT_SEQUENCE_EDITOR: "true",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      PATH: "/usr/bin:/bin",
      ...gitIdentityEnvironment(preview),
      ...quarantineEnvironment,
    },
    stdin,
    limits: { ...commandLimits, maxStdoutBytes },
  }
}

async function runGit(invocation_: GitCommitInvocation): Promise<GitCommitProcessObservation> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([invocation_.executablePath, ...invocation_.arguments], {
      cwd: "/",
      env: { ...invocation_.environment },
      stdin: invocation_.stdin === "ignore" ? "ignore" : new Blob([Buffer.from(invocation_.stdin)]),
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
    child.kill("SIGKILL")
  }, invocation_.limits.timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(requireStream(child.stdout), invocation_.limits.maxStdoutBytes, () => {
      outputLimited = true
      child.kill("SIGKILL")
    }),
    readBounded(requireStream(child.stderr), invocation_.limits.maxStderrBytes, () => {
      outputLimited = true
      child.kill("SIGKILL")
    }),
  ])
  clearTimeout(timeout)
  return {
    started: true,
    termination:
      timedOut || outputLimited || !stdout.ok || !stderr.ok
        ? timedOut
          ? "timed_out"
          : "output_limit_exceeded"
        : "exited",
    exitCode,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  exceeded: () => void,
): Promise<Readonly<{ ok: boolean; bytes: Uint8Array }>> {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > limit) {
      exceeded()
      return { ok: false, bytes: Buffer.concat(chunks) }
    }
    chunks.push(next.value)
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}

function requireStream(stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> {
  if (stream instanceof ReadableStream) return stream
  throw new TypeError("Git process pipe was unavailable")
}

async function prepareScratch(path: string) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch {
    return "blocked" as const
  }
  try {
    await chmod(path, 0o700)
    const facts = await lstat(path)
    if (
      !facts.isDirectory() ||
      facts.isSymbolicLink() ||
      facts.uid !== process.getuid?.() ||
      (facts.mode & 0o777) !== 0o700
    ) {
      return (await cleanupScratch(path)) ? ("blocked" as const) : ("cleanup_unknown" as const)
    }
    await mkdir(join(path, "objects"), { mode: 0o700 })
    const objects = await lstat(join(path, "objects"))
    if (!objects.isDirectory() || objects.isSymbolicLink() || objects.uid !== process.getuid?.()) {
      return (await cleanupScratch(path)) ? ("blocked" as const) : ("cleanup_unknown" as const)
    }
    return "ready" as const
  } catch {
    return (await cleanupScratch(path)) ? ("blocked" as const) : ("cleanup_unknown" as const)
  }
}

async function inspectNativeHelper(path: string): Promise<GitCommitHelperIdentity | null> {
  const canonicalPath = await realpath(path).catch(() => null)
  if (!canonicalPath || canonicalPath !== resolve(path)) return null
  const before = await lstat(path, { bigint: true }).catch(() => null)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(16 * 1024 * 1024) ||
    (before.mode & 0o111n) === 0n ||
    (before.mode & 0o022n) !== 0n
  ) {
    return null
  }
  const content = await readFile(path).catch(() => null)
  const after = await lstat(path, { bigint: true }).catch(() => null)
  if (
    !content ||
    !after?.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    BigInt(content.byteLength) !== before.size
  ) {
    return null
  }
  return {
    canonicalPath,
    device: before.dev.toString(),
    inode: before.ino.toString(),
    byteLength: content.byteLength,
    contentDigest: digestBytes(content),
  }
}

async function snapshotNativeHelper(scratch: string, expected: GitCommitHelperIdentity) {
  const observed = await inspectNativeHelper(expected.canonicalPath)
  if (!observed || JSON.stringify(observed) !== JSON.stringify(expected)) return null
  const content = await readFile(expected.canonicalPath).catch(() => null)
  if (!content || content.byteLength !== expected.byteLength || digestBytes(content) !== expected.contentDigest) return null
  const destination = join(scratch, "astra-git-commit")
  await writeFile(destination, content, { flag: "wx", mode: 0o500 }).catch(() => null)
  await chmod(destination, 0o500).catch(() => null)
  const snapshot = await lstat(destination).catch(() => null)
  if (!snapshot?.isFile() || snapshot.isSymbolicLink() || snapshot.size !== expected.byteLength) return null
  const exact = await readFile(destination).catch(() => null)
  if (!exact || digestBytes(exact) !== expected.contentDigest) return null
  return destination
}

type NativePublisherResult =
  | Readonly<{ status: "no_effect" | "objects_installed" | "uncertain"; detail: number }>
  | Readonly<{ status: "ref_updated"; detail: 0 }>
  | Readonly<{ status: "invalid" }>

async function runNativePublisher(
  helper: string,
  preview: GitCommitPreview,
  objects: ReadonlyArray<GitCommitObject>,
): Promise<NativePublisherResult> {
  const gitDirectory = join(preview.workspaceRoot, ".git")
  const paths = [
    gitDirectory,
    join(gitDirectory, "objects"),
    join(gitDirectory, "refs", "heads"),
    preview.reflog === "existing_update" ? join(gitDirectory, "logs", "refs", "heads") : gitDirectory,
    join(preview.runtimeScratch, "objects"),
  ]
  const descriptors: Array<number> = []
  try {
    for (const path of paths) {
      descriptors.push(openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
    }
  } catch {
    for (const descriptor of descriptors) closeSync(descriptor)
    return { status: "invalid" }
  }
  const request = nativeRequest(preview, objects)
  return new Promise((complete) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(helper, [], {
        cwd: "/",
        env: {},
        detached: true,
        stdio: ["pipe", "pipe", "pipe", ...descriptors],
      })
    } catch {
      for (const descriptor of descriptors) closeSync(descriptor)
      complete({ status: "invalid" })
      return
    }
    for (const descriptor of descriptors) closeSync(descriptor)
    const stdout: Array<Buffer> = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let invalid = false
    const timeout = setTimeout(() => {
      invalid = true
      child.kill("SIGKILL")
    }, commandLimits.timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > 128) {
        invalid = true
        child.kill("SIGKILL")
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > commandLimits.maxStderrBytes) {
        invalid = true
        child.kill("SIGKILL")
      }
    })
    child.on("error", () => {
      invalid = true
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      complete(invalid || code !== 0 ? { status: "invalid" } : parseNativeResponse(Buffer.concat(stdout), preview))
    })
    child.stdin?.end(request)
  })
}

function nativeRequest(preview: GitCommitPreview, objects: ReadonlyArray<GitCommitObject>) {
  const branch = Buffer.from(preview.branch)
  const actor =
    preview.reflog === "existing_update"
      ? Buffer.from(`${preview.identity.name} <${preview.identity.email}> ${preview.timestamp} ${preview.timezone}`)
      : Buffer.alloc(0)
  const message = preview.reflog === "existing_update" ? Buffer.from("astra: governed local commit") : Buffer.alloc(0)
  const oids = objects.map((object) => Buffer.from(object.oid, "hex"))
  const header = Buffer.alloc(22)
  header.write("ASTRGC01")
  header.writeUInt16BE(1, 8)
  header.writeUInt16BE(preview.reflog === "existing_update" ? 1 : 0, 10)
  header[12] = preview.objectFormat === "sha1" ? 1 : 2
  header.writeUInt16BE(objects.length, 14)
  header.writeUInt16BE(branch.byteLength, 16)
  header.writeUInt16BE(actor.byteLength, 18)
  header.writeUInt16BE(message.byteLength, 20)
  return Buffer.concat([
    header,
    Buffer.from(preview.expectedOldOID, "hex"),
    Buffer.from(preview.commitOID, "hex"),
    branch,
    actor,
    message,
    ...oids,
  ])
}

function parseNativeResponse(output: Buffer, preview: GitCommitPreview): NativePublisherResult {
  const oidLength = preview.objectFormat === "sha1" ? 20 : 32
  if (
    output.byteLength !== 14 + oidLength ||
    output.subarray(0, 8).toString("ascii") !== "ASTRGR01" ||
    output.readUInt16BE(8) !== 1 ||
    output[12] !== (preview.objectFormat === "sha1" ? 1 : 2) ||
    output[13] !== oidLength ||
    output.subarray(14).toString("hex") !== preview.commitOID
  ) {
    return { status: "invalid" }
  }
  const detail = output[11] ?? 255
  if (output[10] === 0) return { status: "no_effect", detail }
  if (output[10] === 1) return { status: "objects_installed", detail }
  if (output[10] === 2 && detail === 0) return { status: "ref_updated", detail: 0 }
  if (output[10] === 3) return { status: "uncertain", detail }
  return { status: "invalid" }
}

async function cleanupScratch(path: string) {
  try {
    await rm(path, { recursive: true, force: true })
    return !(await exists(path))
  } catch {
    return false
  }
}

async function blockingLock(workspaceRoot: string, ref: string) {
  if (await exists(join(workspaceRoot, ".git", "index.lock"))) return "index" as const
  const refLocks = [
    join(workspaceRoot, ".git", `${ref}.lock`),
    join(workspaceRoot, ".git", "packed-refs.lock"),
    join(workspaceRoot, ".git", "HEAD.lock"),
  ]
  return (await Promise.all(refLocks.map(exists))).some(Boolean) ? ("ref" as const) : null
}

/** The native helper compare-and-swaps the loose ref file only, so a branch
 * whose current value lives in packed-refs (for example after `git gc` or
 * `git pack-refs`) must block at prepare time instead of orphaning objects. */
async function packedRefUnsupported(workspaceRoot: string, ref: `refs/heads/${string}`) {
  if (!(await exists(join(workspaceRoot, ".git", ref)))) return true
  const packed = await readFile(join(workspaceRoot, ".git", "packed-refs"), "utf8").catch(() => null)
  if (packed === null) return false
  return packed.split("\n").some((line) => line.endsWith(` ${ref}`))
}

async function exists(path: string) {
  return (await lstat(path).catch(() => null)) !== null
}

function parentIdentity(environment: Readonly<Record<string, string | undefined>>): GitCommitIdentity | null {
  const name = environment.ASTRA_GIT_AUTHOR_NAME
  const email = environment.ASTRA_GIT_AUTHOR_EMAIL
  if (!name || !email || name.trim() !== name || email.trim() !== email || !email.includes("@")) return null
  if (Buffer.byteLength(name) > 256 || Buffer.byteLength(email) > 256 || /[\x00-\x1f\x7f<>]/u.test(name + email))
    return null
  return { name, email }
}

function branchRef(input: string): `refs/heads/${string}` | null {
  const prefix = "refs/heads/"
  if (!input.startsWith(prefix) || input.length === prefix.length) return null
  return `${prefix}${input.slice(prefix.length)}`
}

function effectAuthorityCurrent(effectExpiresAt: string, now: () => number, minimumRemainingMs: number) {
  const expiresAt = Date.parse(effectExpiresAt)
  return Number.isFinite(expiresAt) && expiresAt - now() >= minimumRemainingMs
}

function requireScratch(input: string | undefined) {
  if (!input) throw new TypeError("Quarantine scratch authority is missing")
  return input
}

function quarantineVariables(
  quarantine: boolean,
  runtimeScratch: string | undefined,
): Readonly<Record<string, string>> {
  if (!quarantine) return {}
  return {
    GIT_OBJECT_DIRECTORY: join(requireScratch(runtimeScratch), "objects"),
  } satisfies Readonly<Record<string, string>>
}

function gitIdentityEnvironment(
  preview: Partial<Pick<GitCommitPreview, "identity" | "timestamp" | "timezone">>,
): Readonly<Record<string, string>> {
  if (!preview.identity || !preview.timestamp || !preview.timezone) return {}
  return {
    GIT_AUTHOR_NAME: preview.identity.name,
    GIT_AUTHOR_EMAIL: preview.identity.email,
    GIT_AUTHOR_DATE: `@${preview.timestamp} ${preview.timezone}`,
    GIT_COMMITTER_NAME: preview.identity.name,
    GIT_COMMITTER_EMAIL: preview.identity.email,
    GIT_COMMITTER_DATE: `@${preview.timestamp} ${preview.timezone}`,
  }
}

function minimalPreview(workspaceRoot: string, ref: `refs/heads/${string}`) {
  return { workspaceRoot, ref } as Pick<GitCommitPreview, "workspaceRoot" | "ref">
}

function objectRecord(oid: string, content: Uint8Array): GitCommitObject {
  return {
    oid,
    byteLength: content.byteLength,
    contentDigest: digestBytes(content),
    contentBase64: Buffer.from(content).toString("base64"),
  }
}

function objectID(content: Uint8Array, type: "tree" | "commit", format: "sha1" | "sha256") {
  return createHash(format).update(`${type} ${content.byteLength}\0`).update(content).digest("hex")
}

function bytes(object: GitCommitObject) {
  return Buffer.from(object.contentBase64, "base64")
}

function successfulOutput(observation: GitCommitProcessObservation) {
  return observation.started &&
    observation.termination === "exited" &&
    observation.exitCode === 0 &&
    observation.stderr.byteLength === 0
    ? observation.stdout
    : null
}

function successfulLine(observation: GitCommitProcessObservation) {
  const output = successfulOutput(observation)
  if (!output) return null
  const text = decodeUTF8(output)
  if (text === null || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null
  return text.slice(0, -1)
}

function optionalOutput(observation: GitCommitProcessObservation) {
  if (!observation.started || observation.termination !== "exited" || observation.stderr.byteLength > 0) return null
  if (observation.exitCode !== 0 && observation.exitCode !== 1) return null
  return decodeUTF8(observation.stdout)
}

function optionalLine(observation: GitCommitProcessObservation) {
  const output = optionalOutput(observation)
  if (output === null) return null
  if (output === "") return ""
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n")) return null
  return output.slice(0, -1)
}

function successfulEmpty(observation: GitCommitProcessObservation) {
  const output = successfulOutput(observation)
  return output !== null && output.byteLength === 0
}

function successfulBytes(observation: GitCommitProcessObservation, expected: Uint8Array) {
  const output = successfulOutput(observation)
  return output !== null && Buffer.from(output).equals(Buffer.from(expected))
}

function decodeUTF8(input: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input)
  } catch {
    return null
  }
}

function digestBytes(input: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function digestText(input: string): `sha256:${string}` {
  return digestBytes(Buffer.from(input))
}

function blocked(reason: GitCommitBlockReason): GitCommitPreparationResult {
  return { status: "blocked", reason }
}

function blockedWithoutEffect(reason: GitCommitBlockReason): GitCommitExecutionResult {
  return { status: "blocked_without_effect", verification: "not_verified", reason }
}

function reconciliation(
  reason: Extract<GitCommitExecutionResult, { status: "reconciliation_required" }>["reason"],
): GitCommitExecutionResult {
  return { status: "reconciliation_required", verification: "not_verified", reason }
}

function verificationBlocked(
  reason: Extract<GitCommitVerificationResult, { status: "blocked" | "stale" }>["reason"],
): GitCommitVerificationResult {
  return { status: "blocked", verification: "not_verified", reason }
}
