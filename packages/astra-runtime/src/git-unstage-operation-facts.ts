import {
  parseGitUnstageAllDecision,
  parseGitUnstageAllPreview,
  type GitUnstageAllDecision,
  type GitUnstageAllPreview,
} from "@astra/domain/git-control-mutation"
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

export const gitUnstagePolicyDigest = digest("astra-policy:git-unstage-all-explicit-consent:v1")
export const gitUnstageAdapterDigest = digest("astra-git:unstage-all:atomic-index-transaction:v1")
export const gitUnstageVerifierDigest = digest("astra-git:unstage-all:independent-post-state:v1")
export const gitUnstageExecutor = "astra-executor:git-unstage-all"
export const gitUnstageVerifier = "astra-verifier:git-unstage-all-post-state"

export type GitUnstageOperationFactsInput = Readonly<{
  preview: GitUnstageAllPreview
  expectedBaseline: GitRepositoryBaselineSnapshot
  decision: GitUnstageAllDecision
  recordingStartedAt: string
}>

/**
 * Builds the immutable authority bundle shared by admission, dispatch,
 * recovery, receipt ingestion, and independent verification.
 */
export function makeGitUnstageOperationFacts(input: GitUnstageOperationFactsInput) {
  const preview = requirePreview(input.preview)
  const operationID = requireOperationID(deterministicUUID(preview.proposalDigest, "operation:git-unstage-all"))
  const baseline = requireBaseline(input.expectedBaseline)
  const decision = requireDecision(input.decision)
  requireBindings(preview, baseline, decision, input.recordingStartedAt)

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
      workspaceIdentity: preview.baseline.rootIdentity,
    }),
  )
  const workspaceBaseline = {
    kind: "workspace",
    locationID: `local:${preview.workspaceRoot}`,
    workspaceIdentity: preview.baseline.rootIdentity,
    trustDigest: baselineTrustDigest,
    repository,
    policyDigest: gitUnstagePolicyDigest,
    adapterDigest: gitUnstageAdapterDigest,
  } as const
  const resources = [`git-index:${preview.workspaceRoot}`] as const
  const intent = {
    kind: "git_unstage_all",
    schemaVersion: 1,
    parameters: {
      boundary: preview.boundary,
      proposalDigest: preview.proposalDigest,
      stagedCount: preview.stagedCount,
    },
  } as const
  const admissionKey = digest(canonicalJson({ actor, baseline: workspaceBaseline, intent, resources }))
  const capabilityDigest = digest(
    canonicalJson({
      adapterDigest: gitUnstageAdapterDigest,
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
      operation: "git_unstage_all",
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
      targetDescriptors: [
        { mode: "replace_atomically", resource: ".git/index" },
        { mode: "exclusive_lock", resource: ".git/index.lock" },
      ],
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "medium",
      classification: "bounded_git_index_mutation",
      rationaleDigest: digest("unstage-all changes the Git index while preserving worktree, HEAD, and refs"),
    },
    reversibility: {
      kind: "reversible",
      strategy: "restage through a separately previewed and approved Git Operation",
    },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: gitUnstageVerifier, version: "1", digest: gitUnstageVerifierDigest },
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
    executor: gitUnstageExecutor,
    adapterDigest: gitUnstageAdapterDigest,
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
          ruleID: "git-unstage-all-explicit-consent",
          policyDigest: gitUnstagePolicyDigest,
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
  preview: GitUnstageAllPreview,
  baseline: GitRepositoryBaselineSnapshot,
  decision: GitUnstageAllDecision,
  recordingStartedAt: string,
) {
  const recorded = Date.parse(recordingStartedAt)
  if (
    decision.proposalDigest !== preview.proposalDigest ||
    decision.nonce !== preview.nonce ||
    preview.workspaceRoot !== baseline.root.canonicalPath ||
    preview.baseline.snapshotDigest !== baseline.snapshotDigest ||
    preview.baseline.rootIdentity.device !== baseline.root.device ||
    preview.baseline.rootIdentity.inode !== baseline.root.inode ||
    preview.baseline.gitIdentity.device !== baseline.gitDirectory.device ||
    preview.baseline.gitIdentity.inode !== baseline.gitDirectory.inode ||
    preview.baseline.indexDigest !== baseline.index.digest ||
    preview.baseline.indexMetadataDigest !== baseline.index.metadataDigest ||
    preview.baseline.refsDigest !== baseline.refs.digest ||
    preview.baseline.worktreeDigest !== baseline.worktree.digest ||
    canonicalJson(preview.baseline.head) !== canonicalJson(baseline.head) ||
    !Number.isFinite(recorded) ||
    new Date(recorded).toISOString() !== recordingStartedAt ||
    Date.parse(decision.decidedAt) < Date.parse(preview.createdAt) ||
    Date.parse(decision.decidedAt) > Date.parse(preview.expiresAt) ||
    recorded < Date.parse(decision.decidedAt) ||
    recorded > Date.parse(preview.expiresAt)
  ) {
    throw new TypeError("Git unstage preview, baseline, decision, and timeline do not bind exactly")
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
  const parsed = parseGitUnstageAllPreview(input)
  if (!parsed.ok) throw new TypeError(`The Git unstage preview is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireBaseline(input: unknown) {
  const parsed = parseGitRepositoryBaselineSnapshot(input)
  if (!parsed.ok) throw new TypeError(`The Git repository baseline is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireDecision(input: unknown) {
  const parsed = parseGitUnstageAllDecision(input)
  if (!parsed.ok) throw new TypeError(`The Git unstage decision is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The Git unstage Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The Git unstage attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The Git unstage capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The Git unstage dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The Git unstage claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The Git unstage receipt ID is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError(`The Git unstage dispatch request is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function deepFreeze<Value>(input: Value): Value {
  if (input === null || typeof input !== "object" || Object.isFrozen(input)) return input
  Object.values(input).forEach(deepFreeze)
  return Object.freeze(input)
}
