import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, unlink } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  parseOperationEffectUncertainty,
  parseOperationReceipt,
  type ContentDigest,
  type OperationEffectUncertainty,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { OperationRecord } from "@astra/ledger"
import { revalidateGitRepositoryBaseline } from "@astra/git"
import { Effect } from "effect"
import { canonicalJson, digest } from "./controlled-write-authority"
import {
  makeSkillActivationOperationFacts,
  sameSkillActivationCapability,
  skillActivationAdapterDigest,
  skillActivationBoundaryLabel,
  skillActivationExecutor,
  type SkillActivationOperationFactsInput,
  type SkillActivationPreview,
} from "./skill-activation-operation-facts"
import { readExactWorkspaceSkill, type ExactSkillInstructions } from "./skill-inventory"
import { revalidateWorkspacePreflight } from "./workspace-preflight"
import {
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithCoordinatorReceiptSpool,
  runWithLedger,
  runWithReceiptSpool,
} from "./operation-storage"

const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 5_000

export type PrepareSkillActivationInput = SkillActivationOperationFactsInput &
  Readonly<{
    ledgerFilename: string
    spoolFilename: string
  }>

export type SkillActivationProposal = Readonly<{
  capability: ReturnType<typeof makeSkillActivationOperationFacts>["capability"]
  preview: SkillActivationPreview
  policyAskedAt: string
}>

export type SkillActivationConsent =
  | Readonly<{ decision: "approved"; decidedAt: string }>
  | Readonly<{ decision: "rejected"; decidedAt: string }>

export type DecideSkillActivationInput = PrepareSkillActivationInput &
  Readonly<{
    proposal: SkillActivationProposal
    consent: SkillActivationConsent
    privateRuntimeDirectory: string
  }>

export type RecoverSkillActivationInput = PrepareSkillActivationInput &
  Readonly<{
    proposal: SkillActivationProposal
    privateRuntimeDirectory: string
  }>

export type SkillActivationFaultPoint =
  | "after_effect_before_spool"
  | "after_spool_before_ledger"
  | "after_ledger_before_ack"

export type SkillActivationCoordinatorDependencies = Readonly<{
  now?: () => number
  injectFault?: (point: SkillActivationFaultPoint) => Promise<void>
}>

export type DurableSkillActivationResult = Readonly<{
  operationID: string
  state: "denied" | "completed" | "failed" | "reconciliation_required"
  status: "denied_without_effect" | "completed_observed_not_verified" | "failed_without_effect" | "effect_unknown"
  sequence: number
  lastCursor: number
  receiptID: string | null
  bundlePath: string | null
  boundaryLabel: typeof skillActivationBoundaryLabel
}>

export class SkillActivationCoordinationError extends Error {
  readonly _tag = "SkillActivationCoordinationError"

  constructor(
    readonly code: "invalid_input" | "state_unavailable" | "operation_in_progress",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

/** Persists admission and policy before the exact activation preview is displayed. */
export async function prepareSkillActivation(input: PrepareSkillActivationInput): Promise<SkillActivationProposal> {
  try {
    requireStateFiles(input)
    const facts = makeSkillActivationOperationFacts(input)
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
    if (!(await revalidateBaseline(input, facts.repositorySnapshotDigest))) {
      throw new SkillActivationCoordinationError("invalid_input", "The skill activation baseline is stale")
    }
    if (!(await readExactWorkspaceSkill(input.report.root, input.plan.candidate, input.plan.limits))) {
      throw new SkillActivationCoordinationError("invalid_input", "The selected skill changed before consent")
    }

    const results = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.appendBatch(facts.admissionCommands)
      }),
    )
    const snapshot = await readDurableSnapshot(input, facts)
    assertDurableBinding(snapshot, facts)
    if (snapshot.operation?.state !== "awaiting_approval") {
      throw new SkillActivationCoordinationError(
        "operation_in_progress",
        "The skill activation is not waiting for its original consent decision",
      )
    }
    if (!results.every((result) => result.kind === "appended" || result.kind === "replayed")) {
      throw new SkillActivationCoordinationError("state_unavailable", "The skill activation admission was not durable")
    }
    return deepFreeze({ capability: facts.capability, preview: facts.preview, policyAskedAt: input.policyAskedAt })
  } catch (cause) {
    if (cause instanceof SkillActivationCoordinationError) throw cause
    throw new SkillActivationCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The skill activation proposal could not be recorded",
      cause,
    )
  }
}

/** Applies one explicit decision; exact retries never expose the skill twice. */
export async function decideSkillActivation(
  input: DecideSkillActivationInput,
  dependencies: SkillActivationCoordinatorDependencies = {},
): Promise<DurableSkillActivationResult> {
  try {
    requireStateFiles(input)
    const facts = makeSkillActivationOperationFacts(input)
    assertProposal(input.proposal, facts, input.policyAskedAt)
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
    if (await fileExists(input.spoolFilename)) {
      await ingestPendingReceipt(input, facts, new Date(currentTime(dependencies)).toISOString())
    }
    const before = await readDurableSnapshot(input, facts)
    assertDurableBinding(before, facts)
    if (!before.operation) throw new SkillActivationCoordinationError("invalid_input", "No prepared activation exists")
    if (terminal(before.operation.state)) return durableResult(before.operation, before.dispatch?.receipt ?? null, input)
    if (before.operation.state !== "awaiting_approval") {
      throw new SkillActivationCoordinationError(
        "operation_in_progress",
        "The skill activation already passed its consent boundary",
      )
    }

    if (input.consent.decision === "rejected") {
      const denied = await runWithLedger(input.ledgerFilename, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          return yield* ledger.append(facts.rejectionCommand(input.consent.decidedAt))
        }),
      )
      return durableResult(denied.operation, null, input)
    }

    const claimStartedAt = currentTime(dependencies)
    const claimed = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          yield* ledger.appendBatch(facts.approvalCommands(input.consent.decidedAt))
          return yield* ledger.claimDispatch({
            dispatchRequestID: facts.dispatchRequestID,
            operationID: facts.operationID,
            attemptID: facts.attemptID,
            executor: skillActivationExecutor,
            capabilityDigest: facts.capability.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            claimExpiresAt: new Date(
              Math.min(claimStartedAt + claimLeaseMilliseconds, Date.parse(facts.authorizationExpiresAt) - 1),
            ).toISOString(),
            event: {
              eventID: facts.eventIDs.claim,
              schemaVersion: 1,
              actor: {
                kind: "system",
                subject: skillActivationExecutor,
                componentDigest: skillActivationAdapterDigest,
              },
              correlationID: facts.correlationID,
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
        }),
      () => new Date(claimStartedAt).toISOString(),
    )
    if (claimed.kind === "replayed") {
      return recoverSkillActivation(input, dependencies.now ? { now: dependencies.now } : {})
    }

    const startedAt = new Date(currentTime(dependencies)).toISOString()
    const exact = await readExactWorkspaceSkill(input.report.root, input.plan.candidate, input.plan.limits)
    const baselineCurrent = await revalidateBaseline(input, facts.repositorySnapshotDigest)
    const authority =
      exact && baselineCurrent
        ? await runWithCoordinatorLedger(
            input.ledgerFilename,
            (ledger) =>
              Effect.gen(function* () {
                yield* ledger.initialize()
                return yield* ledger.validateEffectAuthority({
                  operationID: facts.operationID,
                  dispatchRequestID: facts.dispatchRequestID,
                  attemptID: facts.attemptID,
                  capabilityGrantID: facts.capabilityGrantID,
                  capabilityDigest: facts.capability.capabilityDigest,
                  executorClaimID: facts.executorClaimID,
                  fencingToken: claimed.claim.fencingToken,
                  executor: skillActivationExecutor,
                  adapterDigest: skillActivationAdapterDigest,
                  baselineDigest: facts.baselineTrustDigest,
                  minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
                })
              }),
          )
        : null
    const observation =
      exact && baselineCurrent && authority?.allowed
        ? await writePrivateBundle(input, facts, exact)
        : ({
            status: "failed_without_effect",
            reason: !exact
              ? "skill_identity_changed"
              : !baselineCurrent
                ? "workspace_baseline_changed"
                : `effect_authority_${rejectedAuthorityReason(authority)}`,
          } as const)
    await dependencies.injectFault?.("after_effect_before_spool")
    const endedAt = new Date(currentTime(dependencies)).toISOString()
    const receipt = makeReceipt(input, facts, claimed.claim.fencingToken, startedAt, endedAt, observation)
    await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(receipt)
      }),
    )
    await dependencies.injectFault?.("after_spool_before_ledger")
    const ingested = await ingestReceipt(input, facts, receipt, endedAt)
    await dependencies.injectFault?.("after_ledger_before_ack")
    await acknowledgeReceipt(input.spoolFilename, receipt, ingested.event.eventID, ingested.event.digest)
    return durableResult(ingested.operation, receipt, input)
  } catch (cause) {
    if (cause instanceof SkillActivationCoordinationError) throw cause
    throw new SkillActivationCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The skill activation could not complete its durable path",
      cause,
    )
  }
}

/** Reconciles a durable claim or pending receipt without activating the skill again. */
export async function recoverSkillActivation(
  input: RecoverSkillActivationInput,
  dependencies: Pick<SkillActivationCoordinatorDependencies, "now"> = {},
): Promise<DurableSkillActivationResult> {
  try {
    requireStateFiles(input)
    const facts = makeSkillActivationOperationFacts(input)
    assertProposal(input.proposal, facts, input.policyAskedAt)
    await prepareOperationStateFiles(input.report.root, input.ledgerFilename, input.spoolFilename)
    const now = currentTime(dependencies)
    if (await fileExists(input.spoolFilename)) {
      await ingestPendingReceipt(input, facts, new Date(now).toISOString())
    }
    const snapshot = await readDurableSnapshot(input, facts)
    assertDurableBinding(snapshot, facts)
    const operation = snapshot.operation
    if (!operation) throw new SkillActivationCoordinationError("invalid_input", "No prepared activation exists")
    if (terminal(operation.state)) {
      const observation = await observeRecoveryBundle(input, facts)
      return durableResult(operation, snapshot.dispatch?.receipt ?? null, input, observation.path)
    }
    if (!snapshot.dispatch) {
      throw new SkillActivationCoordinationError(
        "operation_in_progress",
        "The skill activation is waiting for its original consent decision",
      )
    }
    if (snapshot.dispatch.recoveryStatus === "claimed_no_receipt") {
      if (now < Date.parse(snapshot.dispatch.claim!.claimExpiresAt)) {
        throw new SkillActivationCoordinationError(
          "operation_in_progress",
          "The one-shot skill activation claim is still active and will not be retried",
        )
      }
      const observation = await observeRecoveryBundle(input, facts)
      return recordUncertainty(
        input,
        facts,
        snapshot.dispatch.claim!.fencingToken,
        observation,
        new Date(now).toISOString(),
      )
    }
    if (snapshot.dispatch.recoveryStatus === "claim_uncertain") {
      const observation = await observeRecoveryBundle(input, facts)
      return durableResult(operation, null, input, observation.path)
    }
    throw new SkillActivationCoordinationError(
      "state_unavailable",
      "The unclaimed activation dispatch cannot be retried automatically",
    )
  } catch (cause) {
    if (cause instanceof SkillActivationCoordinationError) throw cause
    throw new SkillActivationCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The skill activation could not be recovered without reactivating it",
      cause,
    )
  }
}

/** Removes only the exact session bundle created by one capability. */
export async function cleanupSkillActivationBundle(input: Readonly<{
  workspaceRoot: string
  privateRuntimeDirectory: string
  sessionID: string
  capabilityGrantID: string
}>) {
  const root = await requirePrivateRuntimeDirectory(input.workspaceRoot, input.privateRuntimeDirectory)
  requireUUID(input.sessionID)
  requireUUID(input.capabilityGrantID)
  const path = bundlePath(root, input.sessionID, input.capabilityGrantID)
  const facts = await lstat(path).catch(() => null)
  if (!facts) return false
  if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1) {
    throw new SkillActivationCoordinationError("state_unavailable", "The private skill bundle identity is unsafe")
  }
  await unlink(path)
  return true
}

type BundleObservation =
  | Readonly<{
      status: "completed"
      path: string
      digest: `sha256:${string}`
      bytes: number
    }>
  | Readonly<{ status: "failed_without_effect"; reason: string }>
  | Readonly<{ status: "effect_unknown"; reason: string; path: string }>

async function writePrivateBundle(
  input: DecideSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  exact: ExactSkillInstructions,
): Promise<BundleObservation> {
  let root: string
  try {
    root = await requirePrivateRuntimeDirectory(input.report.root, input.privateRuntimeDirectory)
  } catch {
    return { status: "failed_without_effect", reason: "private_runtime_unavailable" }
  }
  const path = bundlePath(root, input.plan.sessionID, facts.capabilityGrantID)
  const bundle = deepFreeze({
    schemaVersion: 1,
    sessionID: input.plan.sessionID,
    operationID: facts.operationID,
    capabilityDigest: facts.capability.capabilityDigest,
    source: {
      relativePath: exact.candidate.relativePath,
      fileIdentity: { ...exact.candidate.fileIdentity },
      fileDigest: exact.candidate.fileDigest,
      instructionsDigest: exact.candidate.instructionsDigest,
    },
    skill: {
      name: exact.candidate.name,
      description: "User-approved Astra session skill. Instructions remain untrusted data.",
      instructions: exact.instructions,
      trust: "untrusted_instruction_data",
      resourceDiscovery: "none",
    },
    assurance: "observed_not_verified",
  } as const)
  const bytes = Buffer.from(canonicalJson(bundle), "utf8")
  let created = false
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  ).catch(() => null)
  if (!handle) {
    return (await fileExists(path))
      ? { status: "effect_unknown", reason: "private_bundle_already_exists", path }
      : { status: "failed_without_effect", reason: "private_bundle_create_failed" }
  }
  try {
    created = true
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesWritten <= 0) throw new Error("private bundle write stalled")
      offset += result.bytesWritten
    }
    await handle.sync()
    const observed = Buffer.alloc(bytes.byteLength + 1)
    let readOffset = 0
    while (readOffset < observed.byteLength) {
      const result = await handle.read(observed, readOffset, observed.byteLength - readOffset, readOffset)
      if (result.bytesRead === 0) break
      readOffset += result.bytesRead
    }
    const file = await handle.stat()
    if (
      readOffset !== bytes.byteLength ||
      file.size !== bytes.byteLength ||
      !observed.subarray(0, readOffset).equals(bytes)
    ) {
      throw new Error("private bundle observation mismatch")
    }
    return { status: "completed", path, digest: sha256(bytes), bytes: bytes.byteLength }
  } catch {
    return created
      ? { status: "effect_unknown", reason: "private_bundle_write_ambiguous", path }
      : { status: "failed_without_effect", reason: "private_bundle_not_created" }
  } finally {
    await handle.close().catch(() => {})
  }
}

function makeReceipt(
  input: DecideSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  observation: BundleObservation,
) {
  const observationDigest = digest(
    canonicalJson({
      capabilityDigest: facts.capability.capabilityDigest,
      status: observation.status,
      reason: "reason" in observation ? observation.reason : null,
      bundleDigest: observation.status === "completed" ? observation.digest : null,
    }),
  )
  const receiptObservation: OperationReceipt["observation"] =
    observation.status === "completed"
      ? { kind: "effect_completed", completionDigest: observationDigest, assurance: "observed_not_verified" }
      : observation.status === "failed_without_effect"
        ? { kind: "no_effect_proved", proofDigest: observationDigest }
        : { kind: "effect_unknown", observationDigest }
  const verificationContext: OperationReceipt["verificationContext"] =
    observation.status === "completed"
      ? {
          schemaVersion: 3,
          admittedBaselineDigest: facts.baselineTrustDigest,
          workspaceIdentity: input.report.identity!,
          executionBoundary: "host_no_sandbox",
          observationDigest,
          limitations: [
            "exact private bundle bytes were observed",
            "skill instructions remain untrusted data",
            "instruction semantics were not verified",
            "resource files were not discovered or activated",
          ],
        }
      : legacyContext(input, facts)
  const preview =
    observation.status === "completed"
      ? "COMPLETED — SKILL CONTENT OBSERVED — NOT VERIFIED"
      : observation.status === "failed_without_effect"
        ? `NO EFFECT — ${observation.reason}`
        : `EFFECT UNKNOWN — ${observation.reason}`
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capability.capabilityDigest,
    fencingToken,
    adapter: { identity: skillActivationExecutor, version: "1", digest: skillActivationAdapterDigest },
    effectClass: "skill_instruction_activation",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation: receiptObservation,
    verificationContext,
    output: {
      digest: observation.status === "completed" ? observation.digest : observationDigest,
      bytes: observation.status === "completed" ? observation.bytes : 0,
      preview,
    },
  })
}

function legacyContext(
  input: DecideSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
): OperationReceipt["verificationContext"] {
  if (facts.repositorySnapshotDigest) {
    return {
      schemaVersion: 2,
      admittedBaselineDigest: facts.baselineTrustDigest,
      admittedRepositorySnapshotDigest: facts.repositorySnapshotDigest,
      postEffectWorkspaceDigest: null,
      postEffectRepositorySnapshotDigest: null,
      workspaceIdentity: input.report.identity!,
      targetIdentity: null,
      preflightLimits: input.report.limits,
      activationGuard: "blocked",
    }
  }
  return {
    admittedBaselineDigest: facts.baselineTrustDigest,
    postEffectWorkspaceDigest: null,
    workspaceIdentity: input.report.identity!,
    targetIdentity: null,
    preflightLimits: input.report.limits,
    activationGuard: "blocked",
  }
}

async function ingestPendingReceipt(
  input: RecoverSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  trustedAt: string,
) {
  const entry = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.get(facts.receiptID)
    }),
  )
  if (!entry || entry.acknowledgement) return
  if (
    entry.receipt.operationID !== facts.operationID ||
    entry.receipt.receiptID !== facts.receiptID ||
    entry.receipt.capabilityDigest !== facts.capability.capabilityDigest
  ) {
    throw new SkillActivationCoordinationError("invalid_input", "A pending receipt has different activation facts")
  }
  const ingested = await ingestReceipt(input, facts, entry.receipt, trustedAt)
  await acknowledgeReceipt(input.spoolFilename, entry.receipt, ingested.event.eventID, ingested.event.digest)
}

function ingestReceipt(
  input: RecoverSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  receipt: OperationReceipt,
  trustedAt: string,
) {
  return runWithCoordinatorLedger(
    input.ledgerFilename,
    (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.ingestReceipt({
          receipt,
          event: {
            eventID: facts.eventIDs.receipt,
            schemaVersion: 1,
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    () => trustedAt,
  )
}

async function acknowledgeReceipt(
  spoolFilename: string,
  receipt: OperationReceipt,
  ledgerEventID: string,
  ledgerEventDigest: string,
) {
  await runWithCoordinatorReceiptSpool(spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      yield* spool.acknowledgeIngestedReceipt({ receiptID: receipt.receiptID, ledgerEventID, ledgerEventDigest })
    }),
  )
}

async function readDurableSnapshot(
  input: PrepareSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const operation = yield* ledger.getOperation(facts.operationID)
      return {
        operation,
        dispatch: yield* ledger.getDispatchSnapshot(facts.dispatchRequestID),
        events: operation ? yield* ledger.readEvents(facts.operationID, { limit: 20 }) : [],
      }
    }),
  )
}

function assertDurableBinding(
  snapshot: Awaited<ReturnType<typeof readDurableSnapshot>>,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
) {
  const operation = snapshot.operation
  const admitted = snapshot.events.find((event) => event.name === "operation.admitted")
  const policy = snapshot.events.find((event) => event.name === "policy.ask")
  if (!operation || !admitted || !policy) throw divergentOperation()
  if (
    operation.operationID !== facts.operationID ||
    operation.admissionKey !== facts.admissionKey ||
    operation.baselineTrustDigest !== facts.baselineTrustDigest ||
    operation.baselineAdapterDigest !== skillActivationAdapterDigest ||
    admitted.eventID !== facts.eventIDs.admitted ||
    canonicalJson(admitted.payload) !== canonicalJson(facts.admissionCommands[0].event.payload) ||
    policy.eventID !== facts.eventIDs.policy ||
    canonicalJson(policy.payload) !== canonicalJson(facts.admissionCommands[1].event.payload) ||
    (operation.attemptID !== null && operation.attemptID !== facts.attemptID) ||
    (operation.capabilityGrantID !== null && operation.capabilityGrantID !== facts.capabilityGrantID) ||
    (operation.capabilityDigest !== null && operation.capabilityDigest !== facts.capability.capabilityDigest)
  ) {
    throw divergentOperation()
  }
  const dispatch = snapshot.dispatch
  if (!dispatch) return
  if (
    dispatch.request.operationID !== facts.operationID ||
    dispatch.request.attemptID !== facts.attemptID ||
    dispatch.request.capabilityGrantID !== facts.capabilityGrantID ||
    dispatch.request.capabilityDigest !== facts.capability.capabilityDigest ||
    dispatch.request.baselineDigest !== facts.baselineTrustDigest ||
    dispatch.request.executor !== skillActivationExecutor ||
    dispatch.request.adapterDigest !== skillActivationAdapterDigest ||
    dispatch.request.idempotencyKey !== facts.dispatchIdempotencyKey
  ) {
    throw divergentOperation()
  }
  if (
    dispatch.receipt &&
    (dispatch.receipt.effectClass !== "skill_instruction_activation" ||
      dispatch.receipt.capabilityDigest !== facts.capability.capabilityDigest)
  ) {
    throw divergentOperation()
  }
}

function assertProposal(
  proposal: SkillActivationProposal,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  policyAskedAt: string,
) {
  if (
    proposal.policyAskedAt !== policyAskedAt ||
    !sameSkillActivationCapability(proposal.capability, facts.capability) ||
    canonicalJson(proposal.preview) !== canonicalJson(facts.preview)
  ) {
    throw new SkillActivationCoordinationError("invalid_input", "The decision does not match the displayed preview")
  }
}

async function revalidateBaseline(
  input: Readonly<{ report: WorkspaceTrustReport; repositoryBaseline?: GitRepositoryBaselineSnapshot }>,
  repositorySnapshotDigest: string | null,
) {
  const preflight = await revalidateWorkspacePreflight(input.report)
  if (!preflight.matched) return false
  if (!input.report.surfaces.some((surface) => surface.kind === "git_metadata")) return true
  if (!input.repositoryBaseline || input.repositoryBaseline.snapshotDigest !== repositorySnapshotDigest) return false
  const current = await revalidateGitRepositoryBaseline(input.report.root, input.repositoryBaseline)
  return (
    current.status === "current" &&
    current.expectedSnapshotDigest === input.repositoryBaseline.snapshotDigest &&
    current.currentSnapshotDigest === input.repositoryBaseline.snapshotDigest
  )
}

async function requirePrivateRuntimeDirectory(workspaceRoot: string, input: string) {
  const root = resolve(input)
  const [facts, canonical, workspace] = await Promise.all([
    lstat(root),
    realpath(root),
    realpath(workspaceRoot),
  ])
  const owner = process.getuid?.()
  if (
    owner === undefined ||
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    facts.uid !== owner ||
    (facts.mode & 0o077) !== 0 ||
    within(workspace, canonical)
  ) {
    throw new SkillActivationCoordinationError("state_unavailable", "The private runtime directory is unsafe")
  }
  return canonical
}

function durableResult(
  operation: OperationRecord,
  receipt: OperationReceipt | null,
  input: RecoverSkillActivationInput,
  recoveredBundlePath: string | null = null,
): DurableSkillActivationResult {
  if (!terminal(operation.state)) {
    throw new SkillActivationCoordinationError("operation_in_progress", "The activation has not reached terminal state")
  }
  const state = operation.state
  return {
    operationID: operation.operationID,
    state,
    status:
      state === "denied"
        ? "denied_without_effect"
        : state === "completed"
          ? "completed_observed_not_verified"
          : state === "failed"
            ? "failed_without_effect"
            : "effect_unknown",
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    bundlePath:
      state === "completed"
        ? bundlePath(resolve(input.privateRuntimeDirectory), input.plan.sessionID, operation.capabilityGrantID!)
        : state === "reconciliation_required"
          ? recoveredBundlePath
          : null,
    boundaryLabel: skillActivationBoundaryLabel,
  }
}

function terminal(state: string): state is DurableSkillActivationResult["state"] {
  return state === "denied" || state === "completed" || state === "failed" || state === "reconciliation_required"
}

function bundlePath(root: string, sessionID: string, capabilityGrantID: string) {
  return join(root, `approved-skill-${sessionID}-${capabilityGrantID}.json`)
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError("The skill activation receipt is invalid")
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError("The skill activation uncertainty is invalid")
  return parsed.value
}

type RecoveryBundleObservation = Readonly<{
  state: "absent" | "present" | "unavailable"
  digest: ContentDigest
  path: string | null
}>

async function observeRecoveryBundle(
  input: RecoverSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
): Promise<RecoveryBundleObservation> {
  let root: string
  try {
    root = await requirePrivateRuntimeDirectory(input.report.root, input.privateRuntimeDirectory)
  } catch {
    return recoveryObservation("unavailable", facts, null, null)
  }
  const path = bundlePath(root, input.plan.sessionID, facts.capabilityGrantID)
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
      return recoveryObservation("unavailable", facts, null, file)
    }
    return recoveryObservation("present", facts, path, file)
  } catch (cause) {
    return isNodeError(cause, "ENOENT")
      ? recoveryObservation("absent", facts, null, null)
      : recoveryObservation("unavailable", facts, null, null)
  }
}

function recoveryObservation(
  state: RecoveryBundleObservation["state"],
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  path: string | null,
  file: Awaited<ReturnType<typeof lstat>> | null,
): RecoveryBundleObservation {
  return {
    state,
    digest: digest(
      canonicalJson({
        capabilityDigest: facts.capability.capabilityDigest,
        state,
        file: file
          ? { device: String(file.dev), inode: String(file.ino), size: Number(file.size), links: file.nlink }
          : null,
      }),
    ),
    path,
  }
}

async function recordUncertainty(
  input: RecoverSkillActivationInput,
  facts: ReturnType<typeof makeSkillActivationOperationFacts>,
  fencingToken: number,
  observation: RecoveryBundleObservation,
  observedAt: string,
) {
  const uncertainty = requireUncertainty({
    uncertaintyID: facts.uncertaintyID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capability.capabilityDigest,
    fencingToken,
    reason: "claimed_without_receipt",
    observedAt,
    targetObservation: { state: observation.state, digest: observation.digest },
  })
  const recorded = await runWithCoordinatorLedger(
    input.ledgerFilename,
    (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.recordClaimUncertainty({
          uncertainty,
          event: {
            eventID: facts.eventIDs.uncertainty,
            schemaVersion: 1,
            actor: {
              kind: "system",
              subject: "astra-coordinator:skill-activation-recovery",
              componentDigest: skillActivationAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    () => observedAt,
  )
  return durableResult(recorded.operation, null, input, observation.path)
}

function currentTime(dependencies: Pick<SkillActivationCoordinatorDependencies, "now">) {
  const value = dependencies.now?.() ?? Date.now()
  if (!Number.isFinite(value)) throw new TypeError("The skill activation clock is invalid")
  return value
}

function rejectedAuthorityReason(authority: Readonly<{ allowed: boolean; reason?: string }> | null) {
  if (!authority || authority.allowed || !authority.reason) return "unavailable"
  return authority.reason
}

function requireStateFiles(input: Pick<PrepareSkillActivationInput, "ledgerFilename" | "spoolFilename">) {
  if (!isAbsolute(input.ledgerFilename) || !isAbsolute(input.spoolFilename)) {
    throw new TypeError("Skill activation state files must be absolute paths")
  }
}

function requireUUID(input: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)) {
    throw new SkillActivationCoordinationError("invalid_input", "The session bundle identifier is invalid")
  }
}

function divergentOperation() {
  return new SkillActivationCoordinationError(
    "invalid_input",
    "The Operation ID is already bound to different skill activation facts",
  )
}

function within(root: string, candidate: string) {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

async function fileExists(path: string) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}

function sha256(input: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function deepFreeze<T>(input: T): T {
  if ((typeof input !== "object" && typeof input !== "function") || input === null || Object.isFrozen(input)) {
    return input
  }
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}
