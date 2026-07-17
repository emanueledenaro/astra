import { parseOperationID, type ActorRef, type OperationID } from "@astra/domain/operation-contract"
import type { OperationEvent } from "@astra/domain/operation"
import type { AppendOperationEvent, OperationEventDraft } from "../src"

export const operationID = requireOperationID("0196e4cb-5d80-7b1d-8fb2-263b81670431")
export const secondOperationID = requireOperationID("0196e4cb-5d80-7b1d-8fb2-263b81670441")
export const admissionKey = `sha256:${"a".repeat(64)}`
export const contentDigest = `sha256:${"d".repeat(64)}`
export const policyDigest = `sha256:${"e".repeat(64)}`
export const previewDigest = `sha256:${"f".repeat(64)}`
export const correlationID = "0196e4cb-5d80-7b1d-8fb2-263b81670439"
export const decisionID = "0196e4cb-5d80-7b1d-8fb2-263b81670434"
export const secondAdmissionKey = `sha256:${"c".repeat(64)}`
export const verificationPlanID = "0196e4cb-5d80-7b1d-8fb2-263b81670438"

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
      repositoryIdentity: "repo:fixture",
      head: "453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d",
      indexTreeDigest: contentDigest,
      trackedWorktreeDigest: contentDigest,
      untrackedDigest: contentDigest,
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
}): OperationEventDraft {
  return {
    eventID: input.eventID,
    operationID: input.operationID ?? operationID,
    name: input.name,
    schemaVersion: 1,
    recordedAt: input.recordedAt ?? "2026-07-17T10:00:00.000Z",
    observedAt: "2026-07-17T09:59:59.000Z",
    actor,
    causationID: null,
    correlationID,
    attemptID: null,
    payload: input.payload,
    redaction: "internal",
    externalBlobDigest: null,
  }
}

export function eventIDs(index: number): string {
  return `0196e4cb-5d80-7b1d-8fb2-263b816704${index.toString().padStart(2, "0")}`
}

function requireOperationID(value: string) {
  const result = parseOperationID(value)
  if (!result.ok) throw new Error(`Invalid test operation ID: ${value}`)
  return result.value
}
