import {
  parseGitStageDecision,
  parseGitStageInventory,
  parseGitStagePreview,
  type GitStageDecision,
  type GitStageInventory,
  type GitStagePreview,
} from "../../astra-domain/src/git-stage-mutation"
import {
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseDispatchRequest,
  parseDispatchRequestID,
  parseExecutorClaimID,
  parseOperationID,
  parseReceiptID,
  type ActorRef,
  type OperationID,
} from "@astra/domain/operation-contract"
import type { AppendOperationEvent, OperationEventDraft } from "@astra/ledger"
import { canonicalJson, deterministicUUID, digest } from "./controlled-write-authority"

export const gitStagePolicyDigest = digest("astra-policy:git-stage-paths-explicit-consent:v1")
export const gitStageAdapterDigest = digest("astra-git:stage-selected:atomic-index-transaction:v1")
export const gitStageVerifierDigest = digest("astra-git:stage-selected:independent-post-state:v1")
export const gitStageExecutor = "astra-executor:git-stage-paths"
export const gitStageVerifier = "astra-verifier:git-stage-paths-post-state"

export type GitStageOperationFactsInput = Readonly<{
  preview: GitStagePreview
  inventory: GitStageInventory
  expectedBaseline: GitRepositoryBaselineSnapshot
  decision: GitStageDecision
  recordingStartedAt: string
}>

/**
 * Builds the immutable authority bundle shared by admission, dispatch,
 * recovery, receipt ingestion, and independent verification.
 */
export function makeGitStageOperationFacts(input: GitStageOperationFactsInput) {
  const preview = requirePreview(input.preview)
  const inventory = requireInventory(input.inventory)
  const operationID = requireOperationID(deterministicUUID(preview.proposalDigest, "operation:git-stage-paths"))
  const baseline = requireBaseline(input.expectedBaseline)
  const decision = requireDecision(input.decision)
  requireBindings(preview, inventory, baseline, decision, input.recordingStartedAt)

  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const correlationID = deterministicUUID(operationID, "correlation")
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const repository = {
    kind: "git",
    schemaVersion: 1,
    snapshotDigest: baseline.snapshotDigest,
    observationDigest: baseline.observer.observationDigest,
    root: baseline.root,
    head: baseline.head,
    verification: baseline.verification,
  } as const
  const baselineTrustDigest = digest(
    canonicalJson({
      baselineSnapshotDigest: baseline.snapshotDigest,
      previewProposalDigest: preview.proposalDigest,
      workspaceIdentity: { device: baseline.root.device, inode: baseline.root.inode },
    }),
  )
  const workspaceBaseline = {
    kind: "workspace",
    locationID: `local:${preview.workspaceRoot}`,
    workspaceIdentity: { device: baseline.root.device, inode: baseline.root.inode },
    trustDigest: baselineTrustDigest,
    repository,
    policyDigest: gitStagePolicyDigest,
    adapterDigest: gitStageAdapterDigest,
  } as const
  const resources = [...preview.repositoryWrites]
  const intent = {
    kind: "git_stage_paths",
    schemaVersion: 1,
    parameters: {
      boundary: preview.boundary,
      proposalDigest: preview.proposalDigest,
      candidateIDs: preview.selection.candidateIDs,
      inventoryDigest: preview.inventoryDigest,
    },
  } as const
  const admissionKey = digest(canonicalJson({ actor, baseline: workspaceBaseline, intent, resources }))
  const capabilityDigest = digest(
    canonicalJson({
      adapterDigest: gitStageAdapterDigest,
      baselineSnapshotDigest: baseline.snapshotDigest,
      expiresAt: preview.expiresAt,
      nonce: preview.nonce,
      operationID,
      proposalDigest: preview.proposalDigest,
      resources,
    }),
  )
  const completionCriterion = "independent_git_index_post_state"
  const expectedVerificationDigest = digest(
    canonicalJson({
      criterion: completionCriterion,
      operation: "git_stage_paths",
      proposalDigest: preview.proposalDigest,
    }),
  )
  const admittedPayload = {
    admissionKey,
    intent,
    baseline: workspaceBaseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed", "capability_consumed"],
    },
    effectSpecification: {
      effectClass: "git_index_mutation",
      targetDescriptors: preview.repositoryWrites.map((resource) => ({
        mode: resource.endsWith("/index.lock") ? "exclusive_lock" : "install_exact",
        resource,
      })),
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "medium",
      classification: "bounded_git_index_mutation",
      rationaleDigest: digest("stage-selected changes the Git index while preserving worktree, HEAD, and refs"),
    },
    reversibility: {
      kind: "reversible",
      strategy: "restore the prior index through a separately previewed and approved Git Operation",
    },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: gitStageVerifier, version: "1", digest: gitStageVerifierDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: expectedVerificationDigest }],
    },
  } as const
  const dispatchRequest = requireDispatchRequest({
    dispatchRequestID,
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest,
    baselineDigest: baselineTrustDigest,
    executor: gitStageExecutor,
    adapterDigest: gitStageAdapterDigest,
    idempotencyKey: digest(
      canonicalJson({
        attemptID,
        operationID,
        proposalDigest: preview.proposalDigest,
        effect: admittedPayload.effectSpecification,
      }),
    ),
    requestedAt: input.recordingStartedAt,
    authorizationExpiresAt: preview.expiresAt,
  })
  const eventIDs = {
    admitted: deterministicUUID(operationID, "event:admitted"),
    policy: deterministicUUID(operationID, "event:policy-ask"),
    decision: deterministicUUID(operationID, `event:approval-${decision.decision}`),
    dispatch: deterministicUUID(operationID, "event:dispatch-requested"),
    claim: deterministicUUID(operationID, "event:executor-accepted"),
    receipt: deterministicUUID(operationID, "event:receipt"),
    uncertainty: deterministicUUID(operationID, "event:uncertainty"),
    verificationStarted: deterministicUUID(operationID, "event:verification-started"),
    verificationTerminal: deterministicUUID(operationID, "event:verification-terminal"),
  } as const
  const commands = [
    {
      expectedState: null,
      expectedSequence: 0,
      event: eventDraft({
        operationID,
        eventID: eventIDs.admitted,
        name: "operation.admitted",
        payload: admittedPayload,
        recordedAt: input.recordingStartedAt,
        observedAt: preview.createdAt,
        actor,
        causationID: null,
        correlationID,
        attemptID: null,
      }),
    },
    {
      expectedState: "proposed",
      expectedSequence: 1,
      event: eventDraft({
        operationID,
        eventID: eventIDs.policy,
        name: "policy.ask",
        payload: {
          decisionID,
          ruleID: "git-stage-paths-explicit-consent",
          policyDigest: gitStagePolicyDigest,
          previewDigest: preview.proposalDigest,
          capabilityDigest,
          approverClass: "workspace-user",
          expiresAt: preview.expiresAt,
        },
        recordedAt: input.recordingStartedAt,
        observedAt: preview.createdAt,
        actor,
        causationID: null,
        correlationID,
        attemptID: null,
      }),
    },
    decision.decision === "approved"
      ? {
          expectedState: "awaiting_approval",
          expectedSequence: 2,
          event: eventDraft({
            operationID,
            eventID: eventIDs.decision,
            name: "approval.granted",
            payload: {
              decisionID,
              capabilityGrantID,
              capabilityDigest,
              attemptID,
              baselineDigest: baselineTrustDigest,
              expiresAt: preview.expiresAt,
            },
            recordedAt: input.recordingStartedAt,
            observedAt: decision.decidedAt,
            actor,
            causationID: eventIDs.policy,
            correlationID,
            attemptID,
          }),
        }
      : {
          expectedState: "awaiting_approval",
          expectedSequence: 2,
          event: eventDraft({
            operationID,
            eventID: eventIDs.decision,
            name: "approval.rejected",
            payload: { decisionID, reasonCode: "user_rejected" },
            recordedAt: input.recordingStartedAt,
            observedAt: decision.decidedAt,
            actor,
            causationID: eventIDs.policy,
            correlationID,
            attemptID: null,
          }),
        },
  ] as const satisfies ReadonlyArray<AppendOperationEvent>
  const dispatchCommand = {
    expectedState: "authorized",
    expectedSequence: 3,
    event: eventDraft({
      operationID,
      eventID: eventIDs.dispatch,
      name: "dispatch.requested",
      payload: dispatchRequest,
      recordedAt: input.recordingStartedAt,
      observedAt: input.recordingStartedAt,
      actor,
      causationID: eventIDs.decision,
      correlationID,
      attemptID,
    }),
  } as const satisfies AppendOperationEvent
  const durableCommands: ReadonlyArray<AppendOperationEvent> =
    decision.decision === "approved" ? [...commands, dispatchCommand] : commands

  return deepFreeze({
    operationID,
    decisionID,
    verificationPlanID,
    correlationID,
    attemptID,
    capabilityGrantID,
    dispatchRequestID,
    executorClaimID,
    receiptID,
    evidenceID: deterministicUUID(operationID, "evidence:1"),
    uncertaintyID: deterministicUUID(operationID, "uncertainty:1"),
    preview,
    inventory,
    baseline,
    decision,
    baselineTrustDigest,
    capabilityDigest,
    expectedVerificationDigest,
    resources,
    eventIDs,
    commands: durableCommands,
  })
}

function requireBindings(
  preview: GitStagePreview,
  inventory: GitStageInventory,
  baseline: GitRepositoryBaselineSnapshot,
  decision: GitStageDecision,
  recordingStartedAt: string,
) {
  const recorded = Date.parse(recordingStartedAt)
  const selected = inventory.candidates.filter((candidate) =>
    preview.selection.candidateIDs.includes(candidate.candidateID),
  )
  if (
    decision.proposalDigest !== preview.proposalDigest ||
    decision.nonce !== preview.nonce ||
    preview.workspaceRoot !== baseline.root.canonicalPath ||
    preview.baselineSnapshotDigest !== baseline.snapshotDigest ||
    preview.inventoryDigest !== inventory.inventoryDigest ||
    inventory.workspaceRoot !== preview.workspaceRoot ||
    inventory.baselineSnapshotDigest !== baseline.snapshotDigest ||
    selected.length !== preview.selection.candidateIDs.length ||
    canonicalJson(selected) !== canonicalJson(preview.candidates) ||
    !Number.isFinite(recorded) ||
    new Date(recorded).toISOString() !== recordingStartedAt ||
    Date.parse(decision.decidedAt) < Date.parse(preview.createdAt) ||
    Date.parse(decision.decidedAt) > Date.parse(preview.expiresAt) ||
    recorded < Date.parse(decision.decidedAt) ||
    recorded > Date.parse(preview.expiresAt)
  ) {
    throw new TypeError("Git stage preview, inventory, baseline, decision, and timeline do not bind exactly")
  }
}

function eventDraft(input: {
  operationID: OperationID
  eventID: string
  name: OperationEventDraft["name"]
  payload: Readonly<Record<string, unknown>>
  recordedAt: string
  observedAt: string
  actor: ActorRef
  causationID: string | null
  correlationID: string
  attemptID: string | null
}): OperationEventDraft {
  return { ...input, schemaVersion: 1, redaction: "internal", externalBlobDigest: null }
}

function requirePreview(input: unknown) {
  const parsed = parseGitStagePreview(input)
  if (!parsed.ok) throw new TypeError(`The Git stage preview is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireInventory(input: unknown) {
  const parsed = parseGitStageInventory(input)
  if (!parsed.ok) throw new TypeError(`The Git stage inventory is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireBaseline(input: unknown) {
  const parsed = parseGitRepositoryBaselineSnapshot(input)
  if (!parsed.ok) throw new TypeError(`The Git repository baseline is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireDecision(input: unknown) {
  const parsed = parseGitStageDecision(input)
  if (!parsed.ok) throw new TypeError(`The Git stage decision is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The Git stage Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The Git stage attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The Git stage capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The Git stage dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The Git stage claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The Git stage receipt ID is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError(`The Git stage dispatch request is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function deepFreeze<Value>(input: Value): Value {
  if (input === null || typeof input !== "object" || Object.isFrozen(input)) return input
  Object.values(input).forEach(deepFreeze)
  return Object.freeze(input)
}
