import {
  parseAdmissionKey,
  parseDispatchRequest,
  parseExecutorClaim,
  parseOperationAuthority,
  parseOperationEffectUncertainty,
  parseOperationEffectSpecification,
  parseOperationEvidence,
  parseOperationIntent,
  parseOperationReceipt,
  parseOperationResources,
  parseOperationReversibility,
  parseOperationRisk,
  parseOperationVerificationPlan,
  parseOperationVerificationStart,
  parseRetryBudget,
  parseWorkspaceBaseline,
  type OperationEventEnvelope,
  type DispatchRequest,
  type ExecutorClaim,
  type OperationAuthority,
  type OperationEffectUncertainty,
  type OperationEvidence,
  type OperationReceipt,
  type OperationVerificationPlan,
  type OperationVerificationStart,
} from "@astra/domain/operation-contract"
import type { OperationEvent } from "@astra/domain/operation"
import { OperationEventValidationError } from "./error"

type NormalizedJsonObject = OperationEventEnvelope["payload"]

export type ParsedLifecyclePayload = Readonly<{
  payload: NormalizedJsonObject
  admissionKey: string | null
  decisionID: string | null
  capabilityDigest: string | null
  authority: OperationAuthority | null
  dispatchRequest: DispatchRequest | null
  executorClaim: ExecutorClaim | null
  receipt: OperationReceipt | null
  uncertainty: OperationEffectUncertainty | null
  verificationStart: OperationVerificationStart | null
  evidence: OperationEvidence | null
  verificationPlan: OperationVerificationPlan | null
  effectClass: string | null
  resources: ReadonlyArray<string> | null
  baselineTrustDigest: string | null
  baselineAdapterDigest: string | null
}>

export function parseLifecyclePayload(name: OperationEvent, payload: NormalizedJsonObject): ParsedLifecyclePayload {
  if (name === "operation.admitted") return parseAdmittedPayload(payload)
  if (name === "policy.ask") return parsePolicyAskPayload(payload)
  if (name === "approval.rejected") return parseApprovalRejectedPayload(payload)
  if (name === "approval.granted") return parseApprovalGrantedPayload(payload)
  if (name === "dispatch.requested") return parseDispatchRequestedPayload(payload)
  if (name === "executor.accepted") return parseExecutorAcceptedPayload(payload)
  if (name === "effect.unknown" && "uncertaintyID" in payload) return parseUncertaintyPayload(payload)
  if (
    name === "effect.completed" ||
    name === "effect.observed" ||
    name === "execution.failed_without_effect" ||
    name === "effect.unknown"
  ) {
    return parseReceiptPayload(name, payload)
  }
  if (name === "verification.started") return parseVerificationStartedPayload(payload)
  if (name === "verification.passed" || name === "verification.failed" || name === "verification.unknown") {
    return parseVerificationEvidencePayload(name, payload)
  }
  throw new OperationEventValidationError(
    `Event ${name} is not supported by the first durable ledger increment`,
    "$.name",
    "unsupported_lifecycle_event",
  )
}

function parseAdmittedPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  requireExactFields(payload, [
    "admissionKey",
    "intent",
    "baseline",
    "retryBudget",
    "effectSpecification",
    "resources",
    "risk",
    "reversibility",
    "verificationPlan",
  ])
  const parsedAdmissionKey = requireParsed(parseAdmissionKey(payload.admissionKey), "$.payload.admissionKey")
  const intent = requireParsed(parseOperationIntent(payload.intent), "$.payload.intent")
  const baseline = requireParsed(parseWorkspaceBaseline(payload.baseline), "$.payload.baseline")
  const retryBudget = requireParsed(parseRetryBudget(payload.retryBudget), "$.payload.retryBudget")
  const effectSpecification = requireParsed(
    parseOperationEffectSpecification(payload.effectSpecification),
    "$.payload.effectSpecification",
  )
  const resources = requireParsed(parseOperationResources(payload.resources), "$.payload.resources")
  const risk = requireParsed(parseOperationRisk(payload.risk), "$.payload.risk")
  const reversibility = requireParsed(parseOperationReversibility(payload.reversibility), "$.payload.reversibility")
  const verificationPlan = requireParsed(
    parseOperationVerificationPlan(payload.verificationPlan),
    "$.payload.verificationPlan",
  )
  return {
    admissionKey: parsedAdmissionKey,
    decisionID: null,
    capabilityDigest: null,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan,
    effectClass: effectSpecification.effectClass,
    resources,
    baselineTrustDigest: baseline.trustDigest,
    baselineAdapterDigest: baseline.adapterDigest,
    payload: {
      admissionKey: parsedAdmissionKey,
      intent,
      baseline,
      effectSpecification,
      retryBudget,
      resources,
      reversibility,
      risk,
      verificationPlan,
    } as NormalizedJsonObject,
  }
}

function parsePolicyAskPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  requireExactFields(payload, [
    "decisionID",
    "ruleID",
    "policyDigest",
    "previewDigest",
    "capabilityDigest",
    "approverClass",
    "expiresAt",
  ])
  const capabilityDigest = requireDigest(payload.capabilityDigest, "$.payload.capabilityDigest")
  return {
    admissionKey: null,
    decisionID: requireCanonicalUUID(payload.decisionID, "$.payload.decisionID"),
    capabilityDigest,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: {
      approverClass: requireBoundedString(payload.approverClass, "$.payload.approverClass"),
      decisionID: requireCanonicalUUID(payload.decisionID, "$.payload.decisionID"),
      expiresAt: requireCanonicalTimestamp(payload.expiresAt, "$.payload.expiresAt"),
      policyDigest: requireDigest(payload.policyDigest, "$.payload.policyDigest"),
      previewDigest: requireDigest(payload.previewDigest, "$.payload.previewDigest"),
      capabilityDigest,
      ruleID: requireBoundedString(payload.ruleID, "$.payload.ruleID"),
    },
  }
}

function parseApprovalRejectedPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  requireExactFields(payload, ["decisionID", "reasonCode"])
  return {
    admissionKey: null,
    decisionID: requireCanonicalUUID(payload.decisionID, "$.payload.decisionID"),
    capabilityDigest: null,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: {
      decisionID: requireCanonicalUUID(payload.decisionID, "$.payload.decisionID"),
      reasonCode: requireBoundedString(payload.reasonCode, "$.payload.reasonCode"),
    },
  }
}

function parseApprovalGrantedPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  const authority = requireParsed(parseOperationAuthority(payload), "$.payload")
  return {
    admissionKey: null,
    decisionID: authority.decisionID,
    capabilityDigest: authority.capabilityDigest,
    authority,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: authority,
  }
}

function parseDispatchRequestedPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  const dispatchRequest = requireParsed(parseDispatchRequest(payload), "$.payload")
  return {
    admissionKey: null,
    decisionID: null,
    capabilityDigest: dispatchRequest.capabilityDigest,
    authority: null,
    dispatchRequest,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: dispatchRequest,
  }
}

function parseExecutorAcceptedPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  const executorClaim = requireParsed(parseExecutorClaim(payload), "$.payload")
  return {
    admissionKey: null,
    decisionID: null,
    capabilityDigest: executorClaim.capabilityDigest,
    authority: null,
    dispatchRequest: null,
    executorClaim,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: executorClaim,
  }
}

function parseReceiptPayload(name: OperationEvent, payload: NormalizedJsonObject): ParsedLifecyclePayload {
  const receipt = requireParsed(parseOperationReceipt(payload), "$.payload")
  const expectedName =
    receipt.observation.kind === "effect_completed"
      ? "effect.completed"
      : receipt.observation.kind === "effect_observed"
        ? "effect.observed"
        : receipt.observation.kind === "no_effect_proved"
          ? "execution.failed_without_effect"
          : "effect.unknown"
  if (name !== expectedName) {
    throw new OperationEventValidationError(
      "Receipt observation does not match its lifecycle event",
      "$.payload.observation.kind",
      "receipt_outcome_mismatch",
    )
  }
  return {
    admissionKey: null,
    decisionID: null,
    capabilityDigest: receipt.capabilityDigest,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt,
    uncertainty: null,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: receipt,
  }
}

function parseUncertaintyPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  const uncertainty = requireParsed(parseOperationEffectUncertainty(payload), "$.payload")
  return {
    admissionKey: null,
    decisionID: null,
    capabilityDigest: uncertainty.capabilityDigest,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty,
    verificationStart: null,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: uncertainty,
  }
}

function parseVerificationStartedPayload(payload: NormalizedJsonObject): ParsedLifecyclePayload {
  const verificationStart = requireParsed(parseOperationVerificationStart(payload), "$.payload")
  return {
    admissionKey: null,
    decisionID: null,
    capabilityDigest: null,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart,
    evidence: null,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: verificationStart,
  }
}

function parseVerificationEvidencePayload(
  name: "verification.passed" | "verification.failed" | "verification.unknown",
  payload: NormalizedJsonObject,
): ParsedLifecyclePayload {
  const evidence = requireParsed(parseOperationEvidence(payload), "$.payload")
  const expectedName = evidence.criteria.every((criterion) => criterion.result === "passed")
    ? "verification.passed"
    : evidence.criteria.some((criterion) => criterion.result === "failed")
      ? "verification.failed"
      : "verification.unknown"
  if (name !== expectedName) {
    throw new OperationEventValidationError(
      "Verification evidence does not match its lifecycle event",
      "$.payload.criteria",
      "verification_outcome_mismatch",
    )
  }
  return {
    admissionKey: null,
    decisionID: null,
    capabilityDigest: null,
    authority: null,
    dispatchRequest: null,
    executorClaim: null,
    receipt: null,
    uncertainty: null,
    verificationStart: null,
    evidence,
    verificationPlan: null,
    effectClass: null,
    resources: null,
    baselineTrustDigest: null,
    baselineAdapterDigest: null,
    payload: evidence,
  }
}

function requireExactFields(payload: NormalizedJsonObject, expectedFields: ReadonlyArray<string>) {
  const expected = new Set(expectedFields)
  const unexpected = Object.keys(payload).find((field) => !expected.has(field))
  if (unexpected) {
    throw new OperationEventValidationError(
      `Unexpected lifecycle payload field ${unexpected}`,
      `$.payload.${unexpected}`,
      "unexpected_field",
    )
  }
  const missing = expectedFields.find((field) => !(field in payload))
  if (missing) {
    throw new OperationEventValidationError(
      `Missing lifecycle payload field ${missing}`,
      `$.payload.${missing}`,
      "missing_field",
    )
  }
}

function requireParsed<Value>(
  result:
    | Readonly<{ ok: true; value: Value }>
    | Readonly<{ ok: false; issue: Readonly<{ path: string; reason: string }> }>,
  path: string,
): Value {
  if (result.ok) return result.value
  const issuePath = result.issue.path === "$" ? path : `${path}${result.issue.path.slice(1)}`
  throw new OperationEventValidationError(`Invalid lifecycle payload at ${issuePath}`, issuePath, result.issue.reason)
}

function requireCanonicalUUID(value: unknown, path: string): string {
  if (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    return value
  }
  throw new OperationEventValidationError(`Invalid UUID at ${path}`, path, "expected_canonical_uuid")
}

function requireDigest(value: unknown, path: string): string {
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)) return value
  throw new OperationEventValidationError(`Invalid digest at ${path}`, path, "expected_sha256_digest")
}

function requireCanonicalTimestamp(value: unknown, path: string): string {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
  ) {
    return value
  }
  throw new OperationEventValidationError(`Invalid timestamp at ${path}`, path, "expected_canonical_timestamp")
}

function requireBoundedString(value: unknown, path: string): string {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/\p{C}/u.test(value)
  ) {
    return value
  }
  throw new OperationEventValidationError(`Invalid string at ${path}`, path, "expected_bounded_non_empty_string")
}
