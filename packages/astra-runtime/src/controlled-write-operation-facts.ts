import { type GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
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
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { AppendOperationEvent, OperationEventDraft } from "@astra/ledger"
import type { ControlledWritePlan } from "./controlled-write-plan"
import {
  validateControlledWriteCapabilityProposal,
  type ControlledWriteCapabilityProposal,
} from "./controlled-write-capability"
import {
  canonicalJson,
  deterministicUUID,
  digest,
  makeControlledWriteBaselineAuthority,
} from "./controlled-write-authority"

export {
  canonicalJson,
  deterministicUUID,
  digest,
  makeControlledWriteBaselineAuthority,
} from "./controlled-write-authority"

export const controlledWritePolicyDigest = digest("astra-policy:controlled-write-explicit-consent:v1")
export const controlledWriteAdapterDigest = digest("astra-runtime:controlled-write:bounded-host-process:v1")
export const controlledWriteVerifierDigest = digest("astra-verify:exact-file-readback:v1")
export const controlledWriteExecutor = "astra-executor:bounded-host-controlled-write"
export const controlledWriteVerifier = "astra-verifier:exact-file-readback"

export type ApprovedControlledWriteFactsInput = Readonly<{
  plan: ControlledWritePlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  capabilityProposal: ControlledWriteCapabilityProposal
  policyAskedAt: string
  approvalGrantedAt: string
  recordingStartedAt: string
}>

export function makeApprovedControlledWriteFacts(input: ApprovedControlledWriteFactsInput) {
  const plan = input.plan
  const report = input.report
  if (report.completeness !== "complete" || !report.identity || !report.securityDigest) {
    throw new TypeError("A complete preflight is required for a controlled write Operation")
  }
  if (plan.workspaceRoot !== report.root) throw new TypeError("The plan and preflight workspace do not match")
  requireMonotonicTimeline(input)

  const repositoryAuthority = makeControlledWriteBaselineAuthority(report, input.repositoryBaseline)
  const capability = validateControlledWriteCapabilityProposal(input, input.capabilityProposal)

  const operationID = requireOperationID(plan.operationId)
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const correlationID = deterministicUUID(operationID, "correlation")
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const evidenceID = deterministicUUID(operationID, "evidence:1")
  const uncertaintyID = deterministicUUID(operationID, "uncertainty:1")
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const intent = {
    kind: "controlled_write",
    schemaVersion: 1,
    parameters: {
      expected: { bytes: Buffer.byteLength(plan.content), contentDigest: plan.contentDigest },
      target: plan.relativePath,
    },
  } as const
  const baseline = {
    kind: "workspace",
    locationID: `local:${report.root}`,
    workspaceIdentity: report.identity,
    trustDigest: repositoryAuthority.baselineDigest,
    repository: repositoryAuthority.repository,
    policyDigest: controlledWritePolicyDigest,
    adapterDigest: controlledWriteAdapterDigest,
  } as const
  const resources = [`workspace:${plan.relativePath}`] as const
  const admissionKey = digest(canonicalJson({ actor, baseline, intent, resources }))
  const completionCriterion = "marker_exact_bytes"
  const admittedPayload = {
    admissionKey,
    intent,
    baseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed", "capability_consumed"],
    },
    effectSpecification: {
      effectClass: "workspace_write",
      targetDescriptors: [{ resource: resources[0], mode: "create_only" }],
      partialEffect: "forbidden",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "low",
      classification: "bounded_create_only",
      rationaleDigest: digest("bounded create-only write; existing targets are never overwritten"),
    },
    reversibility: {
      kind: "reversible",
      strategy: "delete_created_file_only_if_exact_digest_matches",
    },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: controlledWriteVerifier, version: "1", digest: controlledWriteVerifierDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: plan.contentDigest }],
    },
  } as const
  const previewDigest = digest(
    canonicalJson({ bytes: Buffer.byteLength(plan.content), digest: plan.contentDigest, target: plan.relativePath }),
  )
  const authorizationExpiresAt = capability.manifest.grant.expiresAt
  const capabilityDigest = capability.capabilityDigest
  const dispatchRequest = requireDispatchRequest({
    dispatchRequestID,
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest,
    baselineDigest: repositoryAuthority.baselineDigest,
    executor: controlledWriteExecutor,
    adapterDigest: controlledWriteAdapterDigest,
    idempotencyKey: digest(canonicalJson({ operationID, attemptID, effect: admittedPayload.effectSpecification })),
    requestedAt: input.recordingStartedAt,
    authorizationExpiresAt,
  })
  const admittedEventID = deterministicUUID(operationID, "event:admitted")
  const policyEventID = deterministicUUID(operationID, "event:policy-ask")
  const approvalEventID = deterministicUUID(operationID, "event:approval-granted")
  const dispatchEventID = deterministicUUID(operationID, "event:dispatch-requested")

  return {
    operationID,
    decisionID,
    verificationPlanID,
    correlationID,
    attemptID,
    capabilityGrantID,
    dispatchRequestID,
    executorClaimID,
    receiptID,
    evidenceID,
    uncertaintyID,
    authorizationExpiresAt,
    capability,
    capabilityProposal: input.capabilityProposal,
    capabilityDigest,
    baselineTrustDigest: repositoryAuthority.baselineDigest,
    repositorySnapshotDigest: repositoryAuthority.repositorySnapshotDigest,
    resources,
    eventIDs: {
      admitted: admittedEventID,
      policy: policyEventID,
      approval: approvalEventID,
      dispatch: dispatchEventID,
      claim: deterministicUUID(operationID, "event:executor-accepted"),
      receipt: deterministicUUID(operationID, "event:receipt"),
      uncertainty: deterministicUUID(operationID, "event:uncertainty"),
      verificationStarted: deterministicUUID(operationID, "event:verification-started"),
      verificationTerminal: deterministicUUID(operationID, "event:verification-terminal"),
    },
    commands: [
      {
        expectedState: null,
        expectedSequence: 0,
        event: eventDraft({
          operationID,
          eventID: admittedEventID,
          name: "operation.admitted",
          payload: admittedPayload,
          recordedAt: input.recordingStartedAt,
          observedAt: plan.createdAt,
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
          eventID: policyEventID,
          name: "policy.ask",
          payload: {
            decisionID,
            ruleID: "controlled-write-explicit-consent",
            policyDigest: controlledWritePolicyDigest,
            previewDigest,
            capabilityDigest,
            approverClass: "workspace-user",
            expiresAt: authorizationExpiresAt,
          },
          recordedAt: input.recordingStartedAt,
          observedAt: input.policyAskedAt,
          actor,
          causationID: null,
          correlationID,
          attemptID: null,
        }),
      },
      {
        expectedState: "awaiting_approval",
        expectedSequence: 2,
        event: eventDraft({
          operationID,
          eventID: approvalEventID,
          name: "approval.granted",
          payload: {
            decisionID,
            capabilityGrantID,
            capabilityDigest,
            attemptID,
            baselineDigest: repositoryAuthority.baselineDigest,
            expiresAt: authorizationExpiresAt,
          },
          recordedAt: input.recordingStartedAt,
          observedAt: input.approvalGrantedAt,
          actor,
          causationID: policyEventID,
          correlationID,
          attemptID,
        }),
      },
      {
        expectedState: "authorized",
        expectedSequence: 3,
        event: eventDraft({
          operationID,
          eventID: dispatchEventID,
          name: "dispatch.requested",
          payload: dispatchRequest,
          recordedAt: input.recordingStartedAt,
          observedAt: input.recordingStartedAt,
          actor,
          causationID: approvalEventID,
          correlationID,
          attemptID,
        }),
      },
    ] as const satisfies ReadonlyArray<AppendOperationEvent>,
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
  return {
    ...input,
    schemaVersion: 1,
    redaction: "internal",
    externalBlobDigest: null,
  }
}

function requireMonotonicTimeline(input: ApprovedControlledWriteFactsInput) {
  const times = [input.plan.createdAt, input.policyAskedAt, input.approvalGrantedAt, input.recordingStartedAt].map(
    (value) => ({ value, milliseconds: Date.parse(value) }),
  )
  if (
    times.some(
      ({ value, milliseconds }) => !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value,
    ) ||
    times.some((time, index) => {
      const previous = times.at(index - 1)
      return index > 0 && previous !== undefined && time.milliseconds < previous.milliseconds
    })
  ) {
    throw new TypeError("Controlled write observations must be canonical, monotonic UTC timestamps")
  }
}

function requireOperationID(value: string) {
  const result = parseOperationID(value)
  if (!result.ok) throw new TypeError("The controlled write Operation ID is invalid")
  return result.value
}

function requireAttemptID(value: string) {
  const result = parseAttemptID(value)
  if (!result.ok) throw new TypeError("The controlled write attempt ID is invalid")
  return result.value
}

function requireCapabilityGrantID(value: string) {
  const result = parseCapabilityGrantID(value)
  if (!result.ok) throw new TypeError("The controlled write capability ID is invalid")
  return result.value
}

function requireDispatchRequestID(value: string) {
  const result = parseDispatchRequestID(value)
  if (!result.ok) throw new TypeError("The controlled write dispatch ID is invalid")
  return result.value
}

function requireExecutorClaimID(value: string) {
  const result = parseExecutorClaimID(value)
  if (!result.ok) throw new TypeError("The controlled write claim ID is invalid")
  return result.value
}

function requireReceiptID(value: string) {
  const result = parseReceiptID(value)
  if (!result.ok) throw new TypeError("The controlled write receipt ID is invalid")
  return result.value
}

function requireDispatchRequest(value: unknown) {
  const result = parseDispatchRequest(value)
  if (!result.ok) throw new TypeError(`The controlled write dispatch request is invalid at ${result.issue.path}`)
  return result.value
}
