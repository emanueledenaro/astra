import {
  computeSkillActivationCapabilityDigest,
  parseSkillActivationCapability,
  type SkillActivationCapability,
} from "@astra/domain/extension-capability"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseDispatchRequest,
  parseDispatchRequestID,
  parseExecutorClaimID,
  parseOperationID,
  parseReceiptID,
  type ActorRef,
  type ContentDigest,
  type OperationID,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { AppendOperationEvent, OperationEventDraft } from "@astra/ledger"
import { canonicalJson, deterministicUUID, digest, makeControlledWriteBaselineAuthority } from "./controlled-write-authority"
import type { SkillInventoryCandidate, SkillInventoryLimits } from "./skill-inventory"

const authorizationLifetimeMilliseconds = 300_000

export const skillActivationPolicyDigest = digest("astra-policy:skill-activation-explicit-consent:v1")
export const skillActivationAdapterDigest = digest("astra-runtime:skill-activation:private-session-bundle:v1")
export const skillActivationObserverDigest = digest("astra-observer:skill-activation-bundle:v1")
export const skillActivationExecutor = "astra-executor:skill-activation"
export const skillActivationBoundaryLabel = "HOST EXECUTION — NO SANDBOX"

export type SkillActivationPlan = Readonly<{
  operationID: string
  sessionID: string
  workspaceMode: "read-only" | "activate-once"
  candidate: SkillInventoryCandidate
  limits: SkillInventoryLimits
  createdAt: string
}>

export type SkillActivationPreview = Readonly<{
  effectClass: "skill_instruction_activation"
  workspace: Readonly<{
    canonicalPath: string
    identity: Readonly<{ device: string; inode: string }>
  }>
  session: Readonly<{ sessionID: string; lifetime: "astra_session" }>
  skill: Readonly<{
    name: string
    relativePath: string
    fileDigest: ContentDigest
    instructionsDigest: ContentDigest
    fileBytes: number
    instructionsBytes: number
    trust: "untrusted_instruction_data"
  }>
  effects: Readonly<{
    workspaceRead: string
    workspaceWrite: "none"
    runtimeWrite: "private_session_skill_bundle"
    resourceDiscovery: "none"
    process: "none"
    network: "none"
  }>
  boundaryLabel: typeof skillActivationBoundaryLabel
  assurance: "observed_not_verified"
}>

export type SkillActivationOperationFactsInput = Readonly<{
  plan: SkillActivationPlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
  recordingStartedAt: string
}>

export function makeSkillActivationOperationFacts(source: SkillActivationOperationFactsInput) {
  const input = snapshotInput(source)
  requireInput(input)
  const operationID = requireOperationID(input.plan.operationID)
  const baseline = makeControlledWriteBaselineAuthority(input.report, input.repositoryBaseline)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const uncertaintyID = deterministicUUID(operationID, "uncertainty:1")
  const correlationID = deterministicUUID(operationID, "correlation")
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const authorizationExpiresAt = new Date(
    Date.parse(input.policyAskedAt) + authorizationLifetimeMilliseconds,
  ).toISOString()
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const candidate = input.plan.candidate
  const manifest = {
    schemaVersion: 1,
    kind: "skill_instruction_activation",
    grant: {
      capabilityGrantID,
      operationID,
      attemptID,
      baselineDigest: requireContentDigest(baseline.baselineDigest),
      expiresAt: authorizationExpiresAt,
    },
    session: { sessionID: input.plan.sessionID, lifetime: "astra_session" },
    workspace: {
      canonicalPath: input.report.root,
      device: input.report.identity!.device,
      inode: input.report.identity!.inode,
      securityDigest: requireContentDigest(input.report.securityDigest!),
    },
    skill: {
      source: "workspace_opencode",
      name: candidate.name,
      relativePath: candidate.relativePath,
      fileIdentity: { ...candidate.fileIdentity },
      fileDigest: requireContentDigest(candidate.fileDigest),
      fileBytes: candidate.fileBytes,
      instructionsDigest: requireContentDigest(candidate.instructionsDigest),
      instructionsBytes: candidate.instructionsBytes,
      descriptionDigest: requireContentDigest(candidate.descriptionDigest),
    },
    exposure: {
      systemPrompt: "fixed_safe_description",
      toolResult: "approved_content_only",
      resourceDiscovery: "none",
      trust: "untrusted_instruction_data",
    },
    authority: {
      workspaceRead: candidate.relativePath,
      workspaceWrite: "none",
      runtimeWrite: "private_session_skill_bundle",
      process: "none",
      shell: "none",
      network: "none",
      plugins: "none",
      mcp: "none",
    },
    limits: { ...input.plan.limits },
  } as const
  const parsedCapability = parseSkillActivationCapability({
    manifest,
    capabilityDigest: computeSkillActivationCapabilityDigest(manifest),
  })
  if (!parsedCapability.ok) throw new TypeError("The skill activation capability is invalid")
  const capability = parsedCapability.value
  const preview = deepFreeze({
    effectClass: "skill_instruction_activation",
    workspace: {
      canonicalPath: input.report.root,
      identity: { ...input.report.identity! },
    },
    session: { sessionID: input.plan.sessionID, lifetime: "astra_session" },
    skill: {
      name: candidate.name,
      relativePath: candidate.relativePath,
      fileDigest: requireContentDigest(candidate.fileDigest),
      instructionsDigest: requireContentDigest(candidate.instructionsDigest),
      fileBytes: candidate.fileBytes,
      instructionsBytes: candidate.instructionsBytes,
      trust: "untrusted_instruction_data",
    },
    effects: {
      workspaceRead: candidate.relativePath,
      workspaceWrite: "none",
      runtimeWrite: "private_session_skill_bundle",
      resourceDiscovery: "none",
      process: "none",
      network: "none",
    },
    boundaryLabel: skillActivationBoundaryLabel,
    assurance: "observed_not_verified",
  } as const satisfies SkillActivationPreview)
  const previewDigest = digest(canonicalJson({ capability, preview }))
  const dispatchIdempotencyKey = digest(
    canonicalJson({ operationID, attemptID, capabilityDigest: capability.capabilityDigest }),
  )
  const resources = [
    `workspace:${input.report.root}`,
    `skill:${candidate.relativePath}`,
    `astra-session:${input.plan.sessionID}`,
  ] as const
  const intent = {
    kind: "skill_instruction_activation",
    schemaVersion: 1,
    parameters: {
      sessionID: input.plan.sessionID,
      workspaceMode: input.plan.workspaceMode,
      skill: {
        name: candidate.name,
        relativePath: candidate.relativePath,
        fileDigest: candidate.fileDigest,
        instructionsDigest: candidate.instructionsDigest,
      },
      exposure: manifest.exposure,
    },
  } as const
  const workspaceBaseline = {
    kind: "workspace",
    locationID: `local:${input.report.root}`,
    workspaceIdentity: { ...input.report.identity! },
    trustDigest: baseline.baselineDigest,
    repository: baseline.repository,
    policyDigest: skillActivationPolicyDigest,
    adapterDigest: skillActivationAdapterDigest,
  } as const
  const completionCriterion = "private_session_skill_bundle_observed"
  const admittedPayload = {
    admissionKey: digest(canonicalJson({ actor, baseline: workspaceBaseline, intent, resources })),
    intent,
    baseline: workspaceBaseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed", "authority_expired", "capability_consumed"],
    },
    effectSpecification: {
      effectClass: "skill_instruction_activation",
      targetDescriptors: [
        { resource: resources[0], mode: "identity_guard" },
        { resource: resources[1], mode: "read_exact_file_once" },
        { resource: resources[2], mode: "create_private_bundle_once" },
      ],
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "medium",
      classification: "untrusted_instruction_injection",
      rationaleDigest: digest("approved skill text may influence the model but cannot grant effect authority"),
    },
    reversibility: { kind: "reversible", strategy: "remove_private_session_bundle_or_end_session" },
    verificationPlan: {
      verificationPlanID,
      verifier: {
        identity: "astra-observer:skill-activation-bundle",
        version: "1",
        digest: skillActivationObserverDigest,
      },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: capability.capabilityDigest }],
    },
  } as const
  const eventIDs = {
    admitted: deterministicUUID(operationID, "event:admitted"),
    policy: deterministicUUID(operationID, "event:policy-ask"),
    approved: deterministicUUID(operationID, "event:approval-approved"),
    rejected: deterministicUUID(operationID, "event:approval-rejected"),
    dispatch: deterministicUUID(operationID, "event:dispatch-requested"),
    claim: deterministicUUID(operationID, "event:executor-accepted"),
    receipt: deterministicUUID(operationID, "event:receipt"),
    uncertainty: deterministicUUID(operationID, "event:uncertainty"),
  } as const
  const admissionCommands = [
    {
      expectedState: null,
      expectedSequence: 0,
      event: eventDraft({
        operationID,
        eventID: eventIDs.admitted,
        name: "operation.admitted",
        payload: admittedPayload,
        recordedAt: input.recordingStartedAt,
        observedAt: input.plan.createdAt,
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
          ruleID: "skill-activation-explicit-consent",
          policyDigest: skillActivationPolicyDigest,
          previewDigest,
          capabilityDigest: capability.capabilityDigest,
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
  ] as const satisfies ReadonlyArray<AppendOperationEvent>

  function approvalCommands(decidedAt: string) {
    requireDecisionTimestamp(input.recordingStartedAt, authorizationExpiresAt, decidedAt)
    const dispatchRequest = requireDispatchRequest({
      dispatchRequestID,
      operationID,
      attemptID,
      capabilityGrantID,
      capabilityDigest: capability.capabilityDigest,
      baselineDigest: baseline.baselineDigest,
      executor: skillActivationExecutor,
      adapterDigest: skillActivationAdapterDigest,
      idempotencyKey: dispatchIdempotencyKey,
      requestedAt: decidedAt,
      authorizationExpiresAt,
    })
    return [
      {
        expectedState: "awaiting_approval",
        expectedSequence: 2,
        event: eventDraft({
          operationID,
          eventID: eventIDs.approved,
          name: "approval.granted",
          payload: {
            decisionID,
            capabilityGrantID,
            capabilityDigest: capability.capabilityDigest,
            attemptID,
            baselineDigest: baseline.baselineDigest,
            expiresAt: authorizationExpiresAt,
          },
          recordedAt: decidedAt,
          observedAt: decidedAt,
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
          recordedAt: decidedAt,
          observedAt: decidedAt,
          actor,
          causationID: eventIDs.approved,
          correlationID,
          attemptID,
        }),
      },
    ] as const satisfies ReadonlyArray<AppendOperationEvent>
  }

  function rejectionCommand(decidedAt: string): AppendOperationEvent {
    requireDecisionTimestamp(input.recordingStartedAt, null, decidedAt)
    return {
      expectedState: "awaiting_approval",
      expectedSequence: 2,
      event: eventDraft({
        operationID,
        eventID: eventIDs.rejected,
        name: "approval.rejected",
        payload: { decisionID, reasonCode: "user_rejected" },
        recordedAt: decidedAt,
        observedAt: decidedAt,
        actor,
        causationID: eventIDs.policy,
        correlationID,
        attemptID: null,
      }),
    }
  }

  return deepFreeze({
    operationID,
    attemptID,
    capabilityGrantID,
    dispatchRequestID,
    executorClaimID,
    receiptID,
    uncertaintyID,
    correlationID,
    authorizationExpiresAt,
    baselineTrustDigest: requireContentDigest(baseline.baselineDigest),
    repositorySnapshotDigest: baseline.repositorySnapshotDigest
      ? requireContentDigest(baseline.repositorySnapshotDigest)
      : null,
    admissionKey: admittedPayload.admissionKey,
    dispatchIdempotencyKey: String(dispatchIdempotencyKey),
    resources,
    capability,
    preview,
    previewDigest,
    eventIDs,
    admissionCommands,
    approvalCommands,
    rejectionCommand,
  })
}

function snapshotInput(source: SkillActivationOperationFactsInput): SkillActivationOperationFactsInput {
  try {
    return deepFreeze(structuredClone(source))
  } catch {
    throw new TypeError("Skill activation facts cannot be snapshotted")
  }
}

function requireInput(input: SkillActivationOperationFactsInput) {
  if (input.plan.workspaceMode !== "activate-once") throw new TypeError("Read-only workspaces cannot activate skills")
  if (input.report.completeness !== "complete" || !input.report.identity || !input.report.securityDigest) {
    throw new TypeError("A complete workspace preflight is required for skill activation")
  }
  requireOperationID(input.plan.operationID)
  requireUUID(input.plan.sessionID, "session ID")
  const times = [input.plan.createdAt, input.policyAskedAt, input.recordingStartedAt]
    .map(requireCanonicalTimestamp)
    .map(Date.parse)
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) {
    throw new TypeError("Skill activation observations must use a monotonic timeline")
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

function requireDecisionTimestamp(notBefore: string, expiresAt: string | null, input: string) {
  const time = Date.parse(requireCanonicalTimestamp(input))
  if (time < Date.parse(notBefore) || (expiresAt !== null && time >= Date.parse(expiresAt))) {
    throw new TypeError("The skill activation decision is outside its authority window")
  }
}

function requireCanonicalTimestamp(input: string) {
  const time = Date.parse(input)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== input) {
    throw new TypeError("Skill activation times must be canonical UTC timestamps")
  }
  return input
}

function requireUUID(input: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input)) {
    throw new TypeError(`The skill activation ${label} is invalid`)
  }
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The skill activation Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The skill activation attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The skill activation capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The skill activation dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The skill activation claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The skill activation receipt ID is invalid")
  return parsed.value
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The skill activation digest is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError("The skill activation dispatch is invalid")
  return parsed.value
}

function deepFreeze<T>(input: T): T {
  if ((typeof input !== "object" && typeof input !== "function") || input === null || Object.isFrozen(input)) {
    return input
  }
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}

export function sameSkillActivationCapability(left: SkillActivationCapability, right: SkillActivationCapability) {
  return canonicalJson(left) === canonicalJson(right)
}
