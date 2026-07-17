import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseDispatchRequestID,
  parseDispatchRequest,
  parseExecutorClaimID,
  parseOperationID,
  type ActorRef,
  type AttemptID,
  type OperationID,
} from "@astra/domain/operation-contract"
import type { OperationEvent } from "@astra/domain/operation"
import type { AppendOperationEvent, OperationEventDraft } from "../src"

export const operationID = requireOperationID("0196e4cb-5d80-7b1d-8fb2-263b81670431")
export const secondOperationID = requireOperationID("0196e4cb-5d80-7b1d-8fb2-263b81670441")
export const admissionKey = `sha256:${"a".repeat(64)}`
export const contentDigest = requireContentDigest(`sha256:${"d".repeat(64)}`)
export const policyDigest = `sha256:${"e".repeat(64)}`
export const previewDigest = `sha256:${"f".repeat(64)}`
export const correlationID = "0196e4cb-5d80-7b1d-8fb2-263b81670439"
export const decisionID = "0196e4cb-5d80-7b1d-8fb2-263b81670434"
export const secondAdmissionKey = `sha256:${"c".repeat(64)}`
export const verificationPlanID = "0196e4cb-5d80-7b1d-8fb2-263b81670438"
export const attemptID = requireAttemptID("0196e4cb-5d80-7b1d-8fb2-263b81670432")
export const secondAttemptID = requireAttemptID("0196e4cb-5d80-7b1d-8fb2-263b81670472")
export const capabilityGrantID = requireCapabilityGrantID("0196e4cb-5d80-7b1d-8fb2-263b81670435")
export const capabilityDigest = requireContentDigest(`sha256:${"8".repeat(64)}`)
export const dispatchRequestID = requireDispatchRequestID("0196e4cb-5d80-7b1d-8fb2-263b81670440")
export const executorClaimID = requireExecutorClaimID("0196e4cb-5d80-7b1d-8fb2-263b81670442")
export const secondExecutorClaimID = requireExecutorClaimID("0196e4cb-5d80-7b1d-8fb2-263b81670443")
export const alternateContentDigest = requireContentDigest(`sha256:${"9".repeat(64)}`)
export const secondDecisionID = "0196e4cb-5d80-7b1d-8fb2-263b81670474"
export const idempotencyKey = `sha256:${"b".repeat(64)}`
export const receiptVerificationContext = {
  schemaVersion: 2,
  admittedBaselineDigest: contentDigest,
  admittedRepositorySnapshotDigest: contentDigest,
  postEffectWorkspaceDigest: contentDigest,
  postEffectRepositorySnapshotDigest: contentDigest,
  workspaceIdentity: { device: "16777233", inode: "42" },
  targetIdentity: { device: "16777233", inode: "43" },
  preflightLimits: { maxEntries: 128, maxFileBytes: 65536, maxTotalBytes: 262144, maxDurationMs: 1000 },
  activationGuard: "allowed",
} as const

const actor: ActorRef = { kind: "user", subject: "user:emanuele" }

export const admittedPayload = {
  admissionKey,
  intent: {
    kind: "controlled_write",
    schemaVersion: 1,
    parameters: {
      target: "marker.txt",
      expected: { bytes: 5, contentDigest },
    },
  },
  baseline: {
    kind: "workspace",
    locationID: "local:fixture",
    workspaceIdentity: { device: "16777233", inode: "42" },
    trustDigest: contentDigest,
    repository: {
      kind: "git",
      schemaVersion: 1,
      snapshotDigest: contentDigest,
      observationDigest: contentDigest,
      root: { canonicalPath: "/fixture", device: "16777233", inode: "42" },
      head: { kind: "symbolic", symbolicRef: "refs/heads/main", oid: "453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d" },
      verification: "not_verified",
    },
    policyDigest,
    adapterDigest: contentDigest,
  },
  retryBudget: {
    maxAttempts: 1,
    eligibleFailureClasses: [],
    retrySafety: { kind: "proof_of_no_effect_required" },
    prohibitedWhen: ["effect_unknown", "baseline_changed"],
  },
  effectSpecification: {
    effectClass: "workspace_write",
    targetDescriptors: [{ resource: "workspace:marker.txt", mode: "create_only" }],
    partialEffect: "forbidden",
    completionCriteria: ["marker_created_with_exact_bytes"],
  },
  resources: ["workspace:marker.txt"],
  risk: {
    level: "low",
    classification: "bounded_create_only",
    rationaleDigest: contentDigest,
  },
  reversibility: {
    kind: "compensatable",
    recoveryIntentKind: "controlled_delete",
  },
  verificationPlan: {
    verificationPlanID,
    verifier: { identity: "workspace-marker", version: "1", digest: contentDigest },
    criteria: [{ criterionID: "marker_exact_bytes", expectedObservationDigest: contentDigest }],
  },
} as const

export function appendCommand(input: {
  readonly operationID?: OperationID
  readonly eventID: string
  readonly name: OperationEvent
  readonly payload: Readonly<Record<string, unknown>>
  readonly expectedState: AppendOperationEvent["expectedState"]
  readonly expectedSequence: number
  readonly recordedAt?: string
  readonly attemptID?: AttemptID | null
  readonly causationID?: string | null
  readonly observedAt?: string
}): AppendOperationEvent {
  return {
    expectedState: input.expectedState,
    expectedSequence: input.expectedSequence,
    event: eventDraft(input),
  }
}

function eventDraft(input: {
  readonly operationID?: OperationID
  readonly eventID: string
  readonly name: OperationEvent
  readonly payload: Readonly<Record<string, unknown>>
  readonly recordedAt?: string
  readonly attemptID?: AttemptID | null
  readonly causationID?: string | null
  readonly observedAt?: string
}): OperationEventDraft {
  return {
    eventID: input.eventID,
    operationID: input.operationID ?? operationID,
    name: input.name,
    schemaVersion: 1,
    recordedAt: input.recordedAt ?? "2026-07-17T10:00:00.000Z",
    observedAt: input.observedAt ?? "2026-07-17T09:59:59.000Z",
    actor,
    causationID: input.causationID ?? null,
    correlationID,
    attemptID: input.attemptID ?? null,
    payload: input.payload,
    redaction: "internal",
    externalBlobDigest: null,
  }
}

export const dispatchRequest = requireDispatchRequest({
  dispatchRequestID,
  operationID,
  attemptID,
  capabilityGrantID,
  capabilityDigest,
  baselineDigest: contentDigest,
  executor: "astra-executor:local",
  adapterDigest: contentDigest,
  idempotencyKey,
  requestedAt: "2026-07-17T10:00:03.000Z",
  authorizationExpiresAt: "2026-07-17T10:05:00.000Z",
})

export const authorizedLifecycle = [
  appendCommand({
    eventID: eventIDs(61),
    name: "operation.admitted",
    payload: admittedPayload,
    expectedState: null,
    expectedSequence: 0,
  }),
  appendCommand({
    eventID: eventIDs(62),
    name: "policy.ask",
    payload: {
      decisionID,
      ruleID: "controlled-write-explicit-consent",
      policyDigest,
      previewDigest,
      capabilityDigest,
      approverClass: "workspace-user",
      expiresAt: "2026-07-17T10:05:00.000Z",
    },
    expectedState: "proposed",
    expectedSequence: 1,
    recordedAt: "2026-07-17T10:00:01.000Z",
  }),
  appendCommand({
    eventID: eventIDs(63),
    name: "approval.granted",
    payload: {
      decisionID,
      capabilityGrantID,
      capabilityDigest,
      attemptID,
      baselineDigest: contentDigest,
      expiresAt: "2026-07-17T10:05:00.000Z",
    },
    expectedState: "awaiting_approval",
    expectedSequence: 2,
    recordedAt: "2026-07-17T10:00:02.000Z",
    attemptID,
    causationID: eventIDs(62),
  }),
  appendCommand({
    eventID: eventIDs(64),
    name: "dispatch.requested",
    payload: dispatchRequest,
    expectedState: "authorized",
    expectedSequence: 3,
    recordedAt: dispatchRequest.requestedAt,
    attemptID,
    causationID: eventIDs(63),
    observedAt: dispatchRequest.requestedAt,
  }),
] as const

export function eventIDs(index: number): string {
  return `0196e4cb-5d80-7b1d-8fb2-263b816704${index.toString().padStart(2, "0")}`
}

function requireOperationID(value: string) {
  const result = parseOperationID(value)
  if (!result.ok) throw new Error(`Invalid test operation ID: ${value}`)
  return result.value
}

function requireAttemptID(value: string) {
  const result = parseAttemptID(value)
  if (!result.ok) throw new Error(`Invalid test attempt ID: ${value}`)
  return result.value
}

function requireDispatchRequestID(value: string) {
  const result = parseDispatchRequestID(value)
  if (!result.ok) throw new Error(`Invalid test dispatch request ID: ${value}`)
  return result.value
}

function requireExecutorClaimID(value: string) {
  const result = parseExecutorClaimID(value)
  if (!result.ok) throw new Error(`Invalid test executor claim ID: ${value}`)
  return result.value
}

function requireDispatchRequest(value: unknown) {
  const result = parseDispatchRequest(value)
  if (!result.ok) throw new Error(`Invalid dispatch request: ${result.issue.path}`)
  return result.value
}

function requireCapabilityGrantID(value: string) {
  const result = parseCapabilityGrantID(value)
  if (!result.ok) throw new Error(`Invalid capability grant ID: ${value}`)
  return result.value
}

function requireContentDigest(value: string) {
  const result = parseContentDigest(value)
  if (!result.ok) throw new Error(`Invalid content digest: ${value}`)
  return result.value
}
