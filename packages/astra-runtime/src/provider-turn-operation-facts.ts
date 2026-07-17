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
import {
  canonicalJson,
  deterministicUUID,
  digest,
  makeControlledWriteBaselineAuthority,
} from "./controlled-write-authority"

const authorizationLifetimeMilliseconds = 300_000

export const providerTurnPolicyDigest = digest("astra-policy:provider-turn-explicit-consent:v1")
export const providerTurnAdapterDigest = digest("astra-runtime:provider-turn:bounded-adapter-seam:v2")
export const providerTurnObserverDigest = digest("astra-observer:provider-turn-finish:v1")
export const providerTurnExecutor = "astra-executor:provider-turn"

export const providerTurnExecutionBoundaryLabel = "HOST EXECUTION — NO SANDBOX"

export type ProviderTurnPlan = Readonly<{
  operationID: string
  workspaceRoot: string
  sessionID: string
  messageID: string
  providerID: string
  modelID: string
  variant: string | null
  origin: string
  transportPolicy: "https_only" | "test_only_loopback_http"
  logicalPayload: Readonly<{ digest: string; bytes: number }>
  executionBoundary: "host_no_sandbox"
  createdAt: string
}>

export type ProviderTurnPreview = Readonly<{
  effectClass: "provider_turn"
  workspace: Readonly<{
    canonicalPath: string
    identity: Readonly<{ device: string; inode: string }>
  }>
  session: Readonly<{ sessionID: string; messageID: string }>
  provider: Readonly<{
    providerID: string
    modelID: string
    variant: string | null
    origin: string
    transportPolicy: ProviderTurnPlan["transportPolicy"]
  }>
  logicalPayload: Readonly<{ digest: ContentDigest; bytes: number }>
  executionBoundary: "host_no_sandbox"
  boundaryLabel: typeof providerTurnExecutionBoundaryLabel
}>

/** Metadata-only request for the non-production, untrusted adapter seam. */
export type UntrustedProviderTurnAdapterRequest = Readonly<{
  schemaVersion: 1
  operationID: string
  workspace: ProviderTurnPreview["workspace"] & Readonly<{ baselineDigest: ContentDigest }>
  session: ProviderTurnPreview["session"]
  provider: ProviderTurnPreview["provider"]
  expectedOrigin: string
  logicalPayload: ProviderTurnPreview["logicalPayload"]
  executionBoundary: "host_no_sandbox"
  capability: Readonly<{
    capabilityGrantID: string
    attemptID: string
    capabilityDigest: ContentDigest
    authorizationExpiresAt: string
  }>
}>

export type ProviderTurnOperationFactsInput = Readonly<{
  plan: ProviderTurnPlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
  recordingStartedAt: string
}>

/** Copies and freezes caller-owned facts before any asynchronous boundary. */
export function snapshotProviderTurnOperationFactsInput(
  source: ProviderTurnOperationFactsInput,
): ProviderTurnOperationFactsInput {
  const plan: ProviderTurnPlan = {
    operationID: requireString(source.plan.operationID),
    workspaceRoot: requireString(source.plan.workspaceRoot),
    sessionID: requireString(source.plan.sessionID),
    messageID: requireString(source.plan.messageID),
    providerID: requireString(source.plan.providerID),
    modelID: requireString(source.plan.modelID),
    variant: source.plan.variant === null ? null : requireString(source.plan.variant),
    origin: requireString(source.plan.origin),
    transportPolicy: source.plan.transportPolicy,
    logicalPayload: {
      digest: requireString(source.plan.logicalPayload.digest),
      bytes: source.plan.logicalPayload.bytes,
    },
    executionBoundary: source.plan.executionBoundary,
    createdAt: requireString(source.plan.createdAt),
  }
  const report: WorkspaceTrustReport = {
    root: requireString(source.report.root),
    identity: source.report.identity
      ? { device: requireString(source.report.identity.device), inode: requireString(source.report.identity.inode) }
      : null,
    securityDigest: source.report.securityDigest === null ? null : requireString(source.report.securityDigest),
    completeness: source.report.completeness,
    state: source.report.state,
    surfaces: source.report.surfaces.map((surface) => ({
      kind: requireString(surface.kind),
      path: requireString(surface.path),
      entryKind: surface.entryKind,
    })),
    blockers: source.report.blockers.map(requireString),
    scannedEntries: source.report.scannedEntries,
    scannedBytes: source.report.scannedBytes,
    limits: {
      maxEntries: source.report.limits.maxEntries,
      maxFileBytes: source.report.limits.maxFileBytes,
      maxTotalBytes: source.report.limits.maxTotalBytes,
      maxDurationMs: source.report.limits.maxDurationMs,
    },
  }
  const repositoryBaseline = source.repositoryBaseline
    ? deepClone(source.repositoryBaseline, "The provider repository baseline cannot be snapshotted")
    : undefined
  return deepFreeze({
    plan,
    report,
    ...(repositoryBaseline ? { repositoryBaseline } : {}),
    policyAskedAt: requireString(source.policyAskedAt),
    recordingStartedAt: requireString(source.recordingStartedAt),
  })
}

/**
 * Builds the non-secret, deterministic authority for one provider request.
 * Admission and policy events are intentionally separate from the later user
 * decision so the coordinator can persist them before displaying consent.
 */
export function makeProviderTurnOperationFacts(source: ProviderTurnOperationFactsInput) {
  const input = snapshotProviderTurnOperationFactsInput(source)
  requireInput(input)
  const operationID = requireOperationID(input.plan.operationID)
  const logicalPayloadDigest = requireContentDigest(input.plan.logicalPayload.digest)
  const baselineAuthority = makeControlledWriteBaselineAuthority(input.report, input.repositoryBaseline)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const correlationID = deterministicUUID(operationID, "correlation")
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const authorizationExpiresAt = new Date(
    Date.parse(input.policyAskedAt) + authorizationLifetimeMilliseconds,
  ).toISOString()
  const preview = deepFreeze({
    effectClass: "provider_turn",
    workspace: {
      canonicalPath: input.report.root,
      identity: { ...input.report.identity! },
    },
    session: {
      sessionID: input.plan.sessionID,
      messageID: input.plan.messageID,
    },
    provider: {
      providerID: input.plan.providerID,
      modelID: input.plan.modelID,
      variant: input.plan.variant,
      origin: input.plan.origin,
      transportPolicy: input.plan.transportPolicy,
    },
    logicalPayload: {
      digest: logicalPayloadDigest,
      bytes: input.plan.logicalPayload.bytes,
    },
    executionBoundary: input.plan.executionBoundary,
    boundaryLabel: providerTurnExecutionBoundaryLabel,
  } as const satisfies ProviderTurnPreview)
  const previewDigest = digest(canonicalJson(preview))
  const capabilityDigest = digest(
    canonicalJson({
      schemaVersion: 1,
      operationID,
      attemptID,
      capabilityGrantID,
      baselineDigest: baselineAuthority.baselineDigest,
      authorizationExpiresAt,
      preview,
    }),
  )
  const dispatchIdempotencyKey = digest(canonicalJson({ operationID, attemptID, capabilityDigest }))
  const resources = [
    `workspace:${input.report.root}`,
    `provider:${input.plan.providerID}/${input.plan.modelID}`,
    `network-origin:${input.plan.origin}`,
  ] as const
  const intent = {
    kind: "provider_turn",
    schemaVersion: 1,
    parameters: {
      sessionID: input.plan.sessionID,
      messageID: input.plan.messageID,
      providerID: input.plan.providerID,
      modelID: input.plan.modelID,
      variant: input.plan.variant,
      origin: input.plan.origin,
      transportPolicy: input.plan.transportPolicy,
      logicalPayload: preview.logicalPayload,
      executionBoundary: input.plan.executionBoundary,
    },
  } as const
  const baseline = {
    kind: "workspace",
    locationID: `local:${input.report.root}`,
    workspaceIdentity: { ...input.report.identity! },
    trustDigest: baselineAuthority.baselineDigest,
    repository: baselineAuthority.repository,
    policyDigest: providerTurnPolicyDigest,
    adapterDigest: providerTurnAdapterDigest,
  } as const
  const completionCriterion = "provider_finish_observed"
  const admittedPayload = {
    admissionKey: digest(canonicalJson({ actor, baseline, intent, resources })),
    intent,
    baseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed", "authority_expired", "capability_consumed"],
    },
    effectSpecification: {
      effectClass: "provider_turn",
      targetDescriptors: [
        { resource: resources[0], mode: "identity_guard" },
        { resource: resources[1], mode: "execute_once" },
        { resource: resources[2], mode: "send_logical_payload" },
      ],
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "medium",
      classification: "external_provider_data_disclosure",
      rationaleDigest: digest("one logical payload may be sent to the explicitly selected provider origin"),
    },
    reversibility: { kind: "irreversible" },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: "astra-observer:provider-finish", version: "1", digest: providerTurnObserverDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: logicalPayloadDigest }],
    },
  } as const
  const admissionKey = admittedPayload.admissionKey
  const adapterRequest = deepFreeze({
    schemaVersion: 1,
    operationID,
    workspace: {
      canonicalPath: preview.workspace.canonicalPath,
      identity: { ...preview.workspace.identity },
      baselineDigest: requireContentDigest(baselineAuthority.baselineDigest),
    },
    session: { ...preview.session },
    provider: { ...preview.provider },
    expectedOrigin: preview.provider.origin,
    logicalPayload: { ...preview.logicalPayload },
    executionBoundary: "host_no_sandbox",
    capability: {
      capabilityGrantID,
      attemptID,
      capabilityDigest,
      authorizationExpiresAt,
    },
  } as const satisfies UntrustedProviderTurnAdapterRequest)
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
          ruleID: "provider-turn-explicit-consent",
          policyDigest: providerTurnPolicyDigest,
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
  ] as const satisfies ReadonlyArray<AppendOperationEvent>

  function approvalCommands(decidedAt: string) {
    requireDecisionTimestamp(input.recordingStartedAt, authorizationExpiresAt, decidedAt)
    const dispatchRequest = requireDispatchRequest({
      dispatchRequestID,
      operationID,
      attemptID,
      capabilityGrantID,
      capabilityDigest,
      baselineDigest: baselineAuthority.baselineDigest,
      executor: providerTurnExecutor,
      adapterDigest: providerTurnAdapterDigest,
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
            capabilityDigest,
            attemptID,
            baselineDigest: baselineAuthority.baselineDigest,
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

  return {
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest,
    dispatchIdempotencyKey: String(dispatchIdempotencyKey),
    dispatchRequestID,
    executorClaimID,
    receiptID,
    correlationID,
    authorizationExpiresAt,
    baselineTrustDigest: requireContentDigest(baselineAuthority.baselineDigest),
    admissionKey,
    repositorySnapshotDigest: baselineAuthority.repositorySnapshotDigest
      ? requireContentDigest(baselineAuthority.repositorySnapshotDigest)
      : null,
    resources,
    preview,
    adapterRequest,
    previewDigest,
    eventIDs,
    admissionCommands,
    approvalCommands,
    rejectionCommand,
  }
}

function requireInput(input: ProviderTurnOperationFactsInput) {
  if (input.report.completeness !== "complete" || !input.report.identity || !input.report.securityDigest) {
    throw new TypeError("A complete preflight is required for a provider turn")
  }
  if (input.plan.workspaceRoot !== input.report.root) {
    throw new TypeError("The provider turn and preflight workspace do not match")
  }
  if (input.plan.executionBoundary !== "host_no_sandbox") {
    throw new TypeError("Provider turns must explicitly declare host execution without a sandbox")
  }
  requireBoundedIdentifier(input.plan.sessionID, "session ID")
  requireBoundedIdentifier(input.plan.messageID, "message ID")
  requireBoundedIdentifier(input.plan.providerID, "provider ID")
  requireBoundedIdentifier(input.plan.modelID, "model ID")
  if (input.plan.variant !== null) requireBoundedIdentifier(input.plan.variant, "model variant")
  requireCanonicalOrigin(input.plan.origin, input.plan.transportPolicy)
  requireContentDigest(input.plan.logicalPayload.digest)
  if (!Number.isSafeInteger(input.plan.logicalPayload.bytes) || input.plan.logicalPayload.bytes < 0) {
    throw new TypeError("The provider logical payload byte count is invalid")
  }
  const values = [input.plan.createdAt, input.policyAskedAt, input.recordingStartedAt]
  const times = values.map(requireCanonicalTimestamp).map(Date.parse)
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) {
    throw new TypeError("Provider turn observations must use a monotonic timeline")
  }
}

function requireCanonicalOrigin(input: string, transportPolicy: ProviderTurnPlan["transportPolicy"]) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError("The provider origin is invalid")
  }
  if (url.origin !== input || url.username !== "" || url.password !== "") {
    throw new TypeError("The provider origin must be canonical and contain no credentials")
  }
  if (transportPolicy === "https_only" && url.protocol === "https:") return
  if (transportPolicy === "test_only_loopback_http" && url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return
  }
  throw new TypeError("Provider origins require HTTPS; HTTP is reserved for explicit test-only loopback use")
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
}

function requireBoundedIdentifier(input: string, name: string) {
  if (input.length < 1 || input.length > 256 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new TypeError(`The provider turn ${name} is invalid`)
  }
}

function requireDecisionTimestamp(notBefore: string, expiresAt: string | null, input: string) {
  const value = Date.parse(requireCanonicalTimestamp(input))
  if (value < Date.parse(notBefore) || (expiresAt !== null && value >= Date.parse(expiresAt))) {
    throw new TypeError("The provider turn decision is outside its authority window")
  }
}

function requireCanonicalTimestamp(input: string) {
  const milliseconds = Date.parse(input)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw new TypeError("Provider turn times must be canonical UTC timestamps")
  }
  return input
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

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The provider turn Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The provider turn attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The provider turn capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The provider turn dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The provider turn claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The provider turn receipt ID is invalid")
  return parsed.value
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The provider turn digest is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError(`The provider turn dispatch request is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireString(input: unknown): string {
  if (typeof input !== "string") throw new TypeError("Provider turn facts contain a non-string value")
  return input
}

function deepClone<T>(input: T, message: string): T {
  try {
    return structuredClone(input)
  } catch {
    throw new TypeError(message)
  }
}

function deepFreeze<T>(input: T): T {
  if ((typeof input !== "object" && typeof input !== "function") || input === null || Object.isFrozen(input)) {
    return input
  }
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}
