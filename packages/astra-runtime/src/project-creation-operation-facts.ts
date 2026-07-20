import {
  makeProjectCreationPreview,
  makeProjectCreationWorkspaceBaseline,
  parseProjectCreationDecision,
  parseProjectCreationDraft,
  parseProjectCreationPreview,
  parseProjectParentAuthority,
  type ProjectCreationDecision,
  type ProjectCreationDraft,
  type ProjectCreationPreview,
  type ProjectParentAuthority,
} from "@astra/domain/project-creation-control"
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

export const projectScaffoldPolicyDigest = digest("astra-policy:project-scaffold-explicit-consent:v1")
export const projectScaffoldAdapterDigest = digest("astra-executor:project-scaffold:rename-excl:v1")
export const projectScaffoldVerifierDigest = digest("astra-verifier:project-scaffold:exact-tree:v1")
export const projectScaffoldExecutor = "astra-executor:project-scaffold"
export const projectScaffoldVerifier = "astra-verifier:project-scaffold-exact-tree"

export type ProjectScaffoldOperationFactsInput = Readonly<{
  authority: ProjectParentAuthority
  draft: ProjectCreationDraft
  preview: ProjectCreationPreview
  decision: ProjectCreationDecision
  recordingStartedAt: string
}>

export function makeProjectScaffoldOperationFacts(input: ProjectScaffoldOperationFactsInput) {
  const authority = requireAuthority(input.authority)
  const draft = requireDraft(input.draft)
  const preview = requirePreview(input.preview)
  const decision = requireDecision(input.decision)
  const expected = makeProjectCreationPreview(authority, draft, preview.createdAt, preview.nonce, preview.expiresAt)
  const recorded = Date.parse(input.recordingStartedAt)
  if (
    canonicalJson(expected) !== canonicalJson(preview) ||
    decision.proposalDigest !== preview.proposalDigest ||
    decision.nonce !== preview.nonce ||
    Date.parse(decision.decidedAt) < Date.parse(preview.createdAt) ||
    Date.parse(decision.decidedAt) > Date.parse(preview.expiresAt) ||
    !Number.isFinite(recorded) ||
    new Date(recorded).toISOString() !== input.recordingStartedAt ||
    recorded < Date.parse(decision.decidedAt) ||
    recorded > Date.parse(preview.expiresAt)
  ) {
    throw new TypeError("Project authority, draft, preview, decision, and timeline do not bind exactly")
  }

  const operationID = requireOperationID(deterministicUUID(preview.proposalDigest, "operation:project-scaffold"))
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const correlationID = deterministicUUID(operationID, "correlation")
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const parentEnvelope = makeProjectCreationWorkspaceBaseline(authority, draft)
  const baseline = {
    ...parentEnvelope,
    policyDigest: projectScaffoldPolicyDigest,
    adapterDigest: projectScaffoldAdapterDigest,
  } as const
  const resources = [
    `project:${preview.targetPath}`,
    ...preview.files.map((file) => `project-file:${preview.targetPath}/${file.path}`),
  ]
  const intent = {
    kind: "project_scaffold",
    schemaVersion: 1,
    parameters: {
      boundary: preview.boundary,
      proposalDigest: preview.proposalDigest,
      targetPath: preview.targetPath,
      files: preview.files,
    },
  } as const
  const admissionKey = digest(canonicalJson({ actor, baseline, intent, resources }))
  const capabilityDigest = digest(
    canonicalJson({
      adapterDigest: projectScaffoldAdapterDigest,
      authorityDigest: authority.observationDigest,
      baselineTrustDigest: baseline.trustDigest,
      expiresAt: preview.expiresAt,
      operationID,
      proposalDigest: preview.proposalDigest,
      resources,
    }),
  )
  const completionCriterion = "exact_project_tree"
  const expectedTreeDigest = digest(
    canonicalJson({
      directories: expectedDirectories(preview.files.map((file) => file.path)),
      files: preview.files,
      targetPath: preview.targetPath,
    }),
  )
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
      effectClass: "project_scaffold_create",
      targetDescriptors: resources.map((resource, index) => ({
        resource,
        mode: index === 0 ? "atomic_create_only_directory" : "create_only_file",
      })),
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "medium",
      classification: "bounded_host_project_scaffold",
      rationaleDigest: digest("bounded create-only project scaffold on host without sandbox"),
    },
    reversibility: {
      kind: "reversible",
      strategy: "remove the exact created tree only through a separate approved Operation",
    },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: projectScaffoldVerifier, version: "1", digest: projectScaffoldVerifierDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: expectedTreeDigest }],
    },
  } as const
  const dispatchRequest = requireDispatchRequest({
    dispatchRequestID,
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest,
    baselineDigest: baseline.trustDigest,
    executor: projectScaffoldExecutor,
    adapterDigest: projectScaffoldAdapterDigest,
    idempotencyKey: digest(canonicalJson({ operationID, attemptID, proposalDigest: preview.proposalDigest })),
    requestedAt: input.recordingStartedAt,
    authorizationExpiresAt: preview.expiresAt,
  })
  const eventIDs = {
    admitted: deterministicUUID(operationID, "event:admitted"),
    policy: deterministicUUID(operationID, "event:policy-ask"),
    approval: deterministicUUID(operationID, "event:approval-granted"),
    dispatch: deterministicUUID(operationID, "event:dispatch-requested"),
    claim: deterministicUUID(operationID, "event:executor-accepted"),
    receipt: deterministicUUID(operationID, "event:receipt"),
    uncertainty: deterministicUUID(operationID, "event:uncertainty"),
    verificationStarted: deterministicUUID(operationID, "event:verification-started"),
    verificationTerminal: deterministicUUID(operationID, "event:verification-terminal"),
  } as const
  const commands = decision.decision === "approved"
    ? ([
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
              ruleID: "project-scaffold-explicit-consent",
              policyDigest: projectScaffoldPolicyDigest,
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
        {
          expectedState: "awaiting_approval",
          expectedSequence: 2,
          event: eventDraft({
            operationID,
            eventID: eventIDs.approval,
            name: "approval.granted",
            payload: {
              decisionID,
              capabilityGrantID,
              capabilityDigest,
              attemptID,
              baselineDigest: baseline.trustDigest,
              expiresAt: preview.expiresAt,
            },
            recordedAt: input.recordingStartedAt,
            observedAt: decision.decidedAt,
            actor,
            causationID: eventIDs.policy,
            correlationID,
            attemptID,
          }),
        },
        {
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
            causationID: eventIDs.approval,
            correlationID,
            attemptID,
          }),
        },
      ] as const satisfies ReadonlyArray<AppendOperationEvent>)
    : ([] as const)

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
    authority,
    draft,
    preview,
    decision,
    baseline,
    baselineTrustDigest: baseline.trustDigest,
    capabilityDigest,
    expectedTreeDigest,
    resources,
    eventIDs,
    commands,
  })
}

function expectedDirectories(paths: ReadonlyArray<string>) {
  const directories = new Set<string>()
  paths.forEach((path) => {
    const segments = path.split("/")
    segments.slice(0, -1).forEach((_segment, index) => directories.add(segments.slice(0, index + 1).join("/")))
  })
  return [...directories].sort()
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

function requireAuthority(input: unknown) {
  const parsed = parseProjectParentAuthority(input)
  if (!parsed.ok) throw new TypeError(`The project parent authority is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireDraft(input: unknown) {
  const parsed = parseProjectCreationDraft(input)
  if (!parsed.ok) throw new TypeError(`The project draft is invalid: ${parsed.reason}`)
  return parsed.value
}

function requirePreview(input: unknown) {
  const parsed = parseProjectCreationPreview(input)
  if (!parsed.ok) throw new TypeError(`The project preview is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireDecision(input: unknown) {
  const parsed = parseProjectCreationDecision(input)
  if (!parsed.ok) throw new TypeError(`The project decision is invalid: ${parsed.reason}`)
  return parsed.value
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The project Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The project attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The project capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The project dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The project claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The project receipt ID is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError(`The project dispatch request is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function deepFreeze<Value>(input: Value): Value {
  if (input === null || typeof input !== "object" || Object.isFrozen(input)) return input
  Object.values(input).forEach(deepFreeze)
  return Object.freeze(input)
}
