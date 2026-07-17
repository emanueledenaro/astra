import { operationEvents, type OperationEvent } from "./operation"
import {
  parseBoundedString,
  parseCanonicalTimestamp,
  parseDistinctStringArray,
  parseExactRecord,
  parseNonNegativeInteger,
  parseNormalizedJsonArray,
  parseNormalizedJsonObject,
  parsePositiveInteger,
  parsed,
  rejected,
  type NormalizedJsonObject,
  type OperationContractParseResult,
} from "./operation-contract-validation"

type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

export type OperationID = Brand<string, "OperationID">
export type AttemptID = Brand<string, "AttemptID">
export type OperationEventID = Brand<string, "OperationEventID">
export type DecisionID = Brand<string, "DecisionID">
export type CapabilityGrantID = Brand<string, "CapabilityGrantID">
export type ReceiptID = Brand<string, "ReceiptID">
export type EvidenceID = Brand<string, "EvidenceID">
export type VerificationPlanID = Brand<string, "VerificationPlanID">
export type CorrelationID = Brand<string, "CorrelationID">
export type AdmissionKey = Brand<string, "AdmissionKey">
export type IdempotencyKey = Brand<string, "IdempotencyKey">
export type ContentDigest = Brand<string, "ContentDigest">
export type DispatchRequestID = Brand<string, "DispatchRequestID">
export type ExecutorClaimID = Brand<string, "ExecutorClaimID">

export type UserActorRef = Readonly<{ kind: "user"; subject: string }>
export type SystemActorRef = Readonly<{ kind: "system"; subject: string; componentDigest: ContentDigest }>
export type AgentActorRef = Readonly<{ kind: "agent"; subject: string; sessionID: string }>
export type ActorRef = UserActorRef | SystemActorRef | AgentActorRef

export type OperationIntent = Readonly<{
  kind: string
  schemaVersion: number
  parameters: NormalizedJsonObject
}>

export type GitRepositoryBaseline = Readonly<{
  kind: "git"
  repositoryIdentity: string
  head: string
  indexTreeDigest: ContentDigest
  trackedWorktreeDigest: ContentDigest
  untrackedDigest: ContentDigest
}>

export type NonGitRepositoryBaseline = Readonly<{
  kind: "non_git"
  markerDigest: ContentDigest
}>

export type WorkspaceBaseline = Readonly<{
  kind: "workspace"
  locationID: string
  workspaceIdentity: Readonly<{ device: string; inode: string }>
  trustDigest: ContentDigest
  repository: GitRepositoryBaseline | NonGitRepositoryBaseline
  policyDigest: ContentDigest
  adapterDigest: ContentDigest
}>

export type RetryBudget = Readonly<{
  maxAttempts: number
  eligibleFailureClasses: ReadonlyArray<string>
  retrySafety:
    | Readonly<{ kind: "proof_of_no_effect_required" }>
    | Readonly<{ kind: "semantic_idempotency"; contractDigest: ContentDigest }>
  prohibitedWhen: ReadonlyArray<string>
}>

export type OperationEffectSpecification = Readonly<{
  effectClass: string
  targetDescriptors: ReadonlyArray<NormalizedJsonObject>
  partialEffect: "forbidden" | "reconciliation_required"
  completionCriteria: ReadonlyArray<string>
}>

export type OperationRisk = Readonly<{
  level: "low" | "medium" | "high" | "critical"
  classification: string
  rationaleDigest: ContentDigest
}>

export type OperationReversibility =
  | Readonly<{ kind: "reversible"; strategy: string }>
  | Readonly<{ kind: "compensatable"; recoveryIntentKind: string }>
  | Readonly<{ kind: "irreversible" }>

export type OperationVerificationPlan = Readonly<{
  verificationPlanID: VerificationPlanID
  verifier: Readonly<{ identity: string; version: string; digest: ContentDigest }>
  criteria: ReadonlyArray<
    Readonly<{
      criterionID: string
      expectedObservationDigest: ContentDigest
    }>
  >
}>

export type OperationAuthority = Readonly<{
  decisionID: DecisionID
  capabilityGrantID: CapabilityGrantID
  attemptID: AttemptID
  baselineDigest: ContentDigest
  expiresAt: string
}>

export type OperationDispatch = Readonly<{
  attemptID: AttemptID
  executor: string
  adapterDigest: ContentDigest
  idempotencyKey: IdempotencyKey
  capabilityGrantID: CapabilityGrantID
}>

export type DispatchRequest = Readonly<{
  dispatchRequestID: DispatchRequestID
  operationID: OperationID
  attemptID: AttemptID
  capabilityGrantID: CapabilityGrantID
  baselineDigest: ContentDigest
  executor: string
  adapterDigest: ContentDigest
  idempotencyKey: IdempotencyKey
  requestedAt: string
  authorizationExpiresAt: string
}>

export type ExecutorClaim = Readonly<{
  executorClaimID: ExecutorClaimID
  dispatchRequestID: DispatchRequestID
  operationID: OperationID
  attemptID: AttemptID
  executor: string
  fencingToken: number
  acceptedAt: string
  claimExpiresAt: string
}>

export type OperationReceipt = Readonly<{
  receiptID: ReceiptID
  operationID: OperationID
  attemptID: AttemptID
  adapter: Readonly<{ identity: string; version: string; digest: ContentDigest }>
  effectClass: string
  resources: ReadonlyArray<string>
  startedAt: string
  endedAt: string
  observation:
    | Readonly<{ kind: "effect_observed"; beforeDigest: ContentDigest | null; afterDigest: ContentDigest }>
    | Readonly<{ kind: "no_effect_proved"; proofDigest: ContentDigest }>
    | Readonly<{ kind: "effect_unknown"; observationDigest: ContentDigest }>
  output: Readonly<{ digest: ContentDigest; bytes: number; preview: string }>
}>

export type OperationEvidence = Readonly<{
  evidenceID: EvidenceID
  operationID: OperationID
  receiptID: ReceiptID
  verificationPlanID: VerificationPlanID
  verifier: Readonly<{ identity: string; version: string; digest: ContentDigest }>
  snapshotDigest: ContentDigest
  observedAt: string
  criteria: ReadonlyArray<
    Readonly<{
      criterionID: string
      result: "passed" | "failed" | "unknown"
      observationDigest: ContentDigest
    }>
  >
  limitations: ReadonlyArray<string>
}>

export type OperationEventName = OperationEvent

export type OperationEventEnvelope = Readonly<{
  eventID: OperationEventID
  operationID: OperationID
  sequence: number
  name: OperationEventName
  schemaVersion: number
  recordedAt: string
  observedAt: string
  actor: ActorRef
  causationID: OperationEventID | null
  correlationID: CorrelationID
  attemptID: AttemptID | null
  payload: NormalizedJsonObject
  previousDigest: ContentDigest | null
  digest: ContentDigest
  redaction: "public" | "internal" | "sensitive_redacted"
  externalBlobDigest: ContentDigest | null
}>

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sha256Digest = /^sha256:[0-9a-f]{64}$/
const gitObjectID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

const retryFailureClasses = new Set(["transient_transport", "rate_limited", "temporary_unavailable"])
const retryProhibitions = new Set(["effect_unknown", "baseline_changed", "authority_expired", "capability_consumed"])

export function parseOperationID(input: unknown, path = "$"): OperationContractParseResult<OperationID> {
  return parseUUID<OperationID>(input, path)
}

export function parseAttemptID(input: unknown, path = "$"): OperationContractParseResult<AttemptID> {
  return parseUUID<AttemptID>(input, path)
}

export function parseCapabilityGrantID(input: unknown, path = "$"): OperationContractParseResult<CapabilityGrantID> {
  return parseUUID<CapabilityGrantID>(input, path)
}

export function parseContentDigest(input: unknown, path = "$"): OperationContractParseResult<ContentDigest> {
  return parseDigest<ContentDigest>(input, path)
}

export function parseAdmissionKey(input: unknown, path = "$"): OperationContractParseResult<AdmissionKey> {
  return parseDigest<AdmissionKey>(input, path)
}

export function parseDispatchRequestID(input: unknown, path = "$"): OperationContractParseResult<DispatchRequestID> {
  return parseUUID<DispatchRequestID>(input, path)
}

export function parseExecutorClaimID(input: unknown, path = "$"): OperationContractParseResult<ExecutorClaimID> {
  return parseUUID<ExecutorClaimID>(input, path)
}

export function parseOperationIdentity(
  input: unknown,
  path = "$",
): OperationContractParseResult<Readonly<{ operationID: OperationID; admissionKey: AdmissionKey }>> {
  const record = parseExactRecord(input, ["operationID", "admissionKey"], path)
  if (!record.ok) return record
  const operationID = parseOperationID(record.value.operationID, `${path}.operationID`)
  if (!operationID.ok) return operationID
  const admissionKey = parseAdmissionKey(record.value.admissionKey, `${path}.admissionKey`)
  if (!admissionKey.ok) return admissionKey
  return parsed({ operationID: operationID.value, admissionKey: admissionKey.value })
}

export function parseActorRef(input: unknown, path = "$"): OperationContractParseResult<ActorRef> {
  const base = parseExactRecord(input, ["kind", "subject", "componentDigest", "sessionID"], path)
  if (!base.ok) return base
  const kind = base.value.kind
  if (kind !== "user" && kind !== "system" && kind !== "agent") {
    return rejected(`${path}.kind`, "unsupported_actor_kind")
  }

  const expected =
    kind === "system"
      ? ["kind", "subject", "componentDigest"]
      : kind === "agent"
        ? ["kind", "subject", "sessionID"]
        : ["kind", "subject"]
  const record = parseExactRecord(input, expected, path)
  if (!record.ok) return record
  const subject = parseBoundedString(record.value.subject, `${path}.subject`, 512)
  if (!subject.ok) return subject
  if (kind === "user") return parsed({ kind, subject: subject.value })
  if (kind === "system") {
    const componentDigest = parseDigest<ContentDigest>(record.value.componentDigest, `${path}.componentDigest`)
    if (!componentDigest.ok) return componentDigest
    return parsed({ kind, subject: subject.value, componentDigest: componentDigest.value })
  }
  const sessionID = parseBoundedString(record.value.sessionID, `${path}.sessionID`, 512)
  if (!sessionID.ok) return sessionID
  return parsed({ kind, subject: subject.value, sessionID: sessionID.value })
}

export function parseOperationIntent(input: unknown, path = "$"): OperationContractParseResult<OperationIntent> {
  const record = parseExactRecord(input, ["kind", "schemaVersion", "parameters"], path)
  if (!record.ok) return record
  const kind = parseBoundedString(record.value.kind, `${path}.kind`, 128)
  if (!kind.ok) return kind
  const schemaVersion = parsePositiveInteger(record.value.schemaVersion, `${path}.schemaVersion`, 1_000)
  if (!schemaVersion.ok) return schemaVersion
  const parameters = parseNormalizedJsonObject(record.value.parameters, `${path}.parameters`)
  if (!parameters.ok) return parameters
  return parsed({ kind: kind.value, schemaVersion: schemaVersion.value, parameters: parameters.value })
}

export function parseWorkspaceBaseline(input: unknown, path = "$"): OperationContractParseResult<WorkspaceBaseline> {
  const record = parseExactRecord(
    input,
    ["kind", "locationID", "workspaceIdentity", "trustDigest", "repository", "policyDigest", "adapterDigest"],
    path,
  )
  if (!record.ok) return record
  if (record.value.kind !== "workspace") return rejected(`${path}.kind`, "unsupported_baseline_kind")
  const locationID = parseBoundedString(record.value.locationID, `${path}.locationID`, 1_024)
  if (!locationID.ok) return locationID
  const workspaceIdentity = parseWorkspaceIdentity(record.value.workspaceIdentity, `${path}.workspaceIdentity`)
  if (!workspaceIdentity.ok) return workspaceIdentity
  const trustDigest = parseDigest<ContentDigest>(record.value.trustDigest, `${path}.trustDigest`)
  if (!trustDigest.ok) return trustDigest
  const repository = parseRepositoryBaseline(record.value.repository, `${path}.repository`)
  if (!repository.ok) return repository
  const policyDigest = parseDigest<ContentDigest>(record.value.policyDigest, `${path}.policyDigest`)
  if (!policyDigest.ok) return policyDigest
  const adapterDigest = parseDigest<ContentDigest>(record.value.adapterDigest, `${path}.adapterDigest`)
  if (!adapterDigest.ok) return adapterDigest
  return parsed({
    kind: "workspace",
    locationID: locationID.value,
    workspaceIdentity: workspaceIdentity.value,
    trustDigest: trustDigest.value,
    repository: repository.value,
    policyDigest: policyDigest.value,
    adapterDigest: adapterDigest.value,
  })
}

export function parseRetryBudget(input: unknown, path = "$"): OperationContractParseResult<RetryBudget> {
  const record = parseExactRecord(
    input,
    ["maxAttempts", "eligibleFailureClasses", "retrySafety", "prohibitedWhen"],
    path,
  )
  if (!record.ok) return record
  const maxAttempts = parsePositiveInteger(record.value.maxAttempts, `${path}.maxAttempts`, 32)
  if (!maxAttempts.ok) return maxAttempts
  const eligibleFailureClasses = parseDistinctStringArray(
    record.value.eligibleFailureClasses,
    `${path}.eligibleFailureClasses`,
    retryFailureClasses,
  )
  if (!eligibleFailureClasses.ok) return eligibleFailureClasses
  const prohibitedWhen = parseDistinctStringArray(
    record.value.prohibitedWhen,
    `${path}.prohibitedWhen`,
    retryProhibitions,
  )
  if (!prohibitedWhen.ok) return prohibitedWhen
  const retrySafety = parseRetrySafety(record.value.retrySafety, `${path}.retrySafety`)
  if (!retrySafety.ok) return retrySafety
  return parsed({
    maxAttempts: maxAttempts.value,
    eligibleFailureClasses: eligibleFailureClasses.value,
    retrySafety: retrySafety.value,
    prohibitedWhen: prohibitedWhen.value,
  })
}

export function parseOperationEffectSpecification(
  input: unknown,
  path = "$",
): OperationContractParseResult<OperationEffectSpecification> {
  const record = parseExactRecord(
    input,
    ["effectClass", "targetDescriptors", "partialEffect", "completionCriteria"],
    path,
  )
  if (!record.ok) return record
  const effectClass = parseBoundedString(record.value.effectClass, `${path}.effectClass`, 128)
  if (!effectClass.ok) return effectClass
  const targetValues = parseNormalizedJsonArray(record.value.targetDescriptors, `${path}.targetDescriptors`)
  if (!targetValues.ok) return targetValues
  if (targetValues.value.length === 0) return rejected(`${path}.targetDescriptors`, "expected_non_empty_array")
  const targetDescriptors: Array<NormalizedJsonObject> = []
  for (const [index, target] of targetValues.value.entries()) {
    const parsedTarget = parseNormalizedJsonObject(target, `${path}.targetDescriptors[${index}]`)
    if (!parsedTarget.ok) return parsedTarget
    targetDescriptors.push(parsedTarget.value)
  }
  if (record.value.partialEffect !== "forbidden" && record.value.partialEffect !== "reconciliation_required") {
    return rejected(`${path}.partialEffect`, "unsupported_partial_effect_policy")
  }
  const completionCriteria = parseDistinctStringArray(
    record.value.completionCriteria,
    `${path}.completionCriteria`,
    undefined,
    true,
  )
  if (!completionCriteria.ok) return completionCriteria
  return parsed({
    effectClass: effectClass.value,
    targetDescriptors,
    partialEffect: record.value.partialEffect,
    completionCriteria: completionCriteria.value,
  })
}

export function parseOperationResources(
  input: unknown,
  path = "$",
): OperationContractParseResult<ReadonlyArray<string>> {
  return parseDistinctStringArray(input, path, undefined, true)
}

export function parseOperationRisk(input: unknown, path = "$"): OperationContractParseResult<OperationRisk> {
  const record = parseExactRecord(input, ["level", "classification", "rationaleDigest"], path)
  if (!record.ok) return record
  if (
    record.value.level !== "low" &&
    record.value.level !== "medium" &&
    record.value.level !== "high" &&
    record.value.level !== "critical"
  ) {
    return rejected(`${path}.level`, "unsupported_risk_level")
  }
  const classification = parseBoundedString(record.value.classification, `${path}.classification`, 256)
  if (!classification.ok) return classification
  const rationaleDigest = parseDigest<ContentDigest>(record.value.rationaleDigest, `${path}.rationaleDigest`)
  if (!rationaleDigest.ok) return rationaleDigest
  return parsed({
    level: record.value.level,
    classification: classification.value,
    rationaleDigest: rationaleDigest.value,
  })
}

export function parseOperationReversibility(
  input: unknown,
  path = "$",
): OperationContractParseResult<OperationReversibility> {
  const broad = parseExactRecord(input, ["kind", "strategy", "recoveryIntentKind"], path)
  if (!broad.ok) return broad
  if (broad.value.kind === "irreversible") {
    const exact = parseExactRecord(input, ["kind"], path)
    return exact.ok ? parsed({ kind: "irreversible" }) : exact
  }
  if (broad.value.kind === "reversible") {
    const exact = parseExactRecord(input, ["kind", "strategy"], path)
    if (!exact.ok) return exact
    const strategy = parseBoundedString(exact.value.strategy, `${path}.strategy`, 256)
    return strategy.ok ? parsed({ kind: "reversible", strategy: strategy.value }) : strategy
  }
  if (broad.value.kind === "compensatable") {
    const exact = parseExactRecord(input, ["kind", "recoveryIntentKind"], path)
    if (!exact.ok) return exact
    const recoveryIntentKind = parseBoundedString(exact.value.recoveryIntentKind, `${path}.recoveryIntentKind`, 256)
    return recoveryIntentKind.ok
      ? parsed({ kind: "compensatable", recoveryIntentKind: recoveryIntentKind.value })
      : recoveryIntentKind
  }
  return rejected(`${path}.kind`, "unsupported_reversibility_kind")
}

export function parseOperationVerificationPlan(
  input: unknown,
  path = "$",
): OperationContractParseResult<OperationVerificationPlan> {
  const record = parseExactRecord(input, ["verificationPlanID", "verifier", "criteria"], path)
  if (!record.ok) return record
  const verificationPlanID = parseUUID<VerificationPlanID>(
    record.value.verificationPlanID,
    `${path}.verificationPlanID`,
  )
  if (!verificationPlanID.ok) return verificationPlanID
  const verifier = parseAdapter(record.value.verifier, `${path}.verifier`)
  if (!verifier.ok) return verifier
  const criteriaValues = parseNormalizedJsonArray(record.value.criteria, `${path}.criteria`)
  if (!criteriaValues.ok) return criteriaValues
  if (criteriaValues.value.length === 0) return rejected(`${path}.criteria`, "expected_non_empty_array")
  const criteria: Array<OperationVerificationPlan["criteria"][number]> = []
  const seen = new Set<string>()
  for (const [index, item] of criteriaValues.value.entries()) {
    const itemPath = `${path}.criteria[${index}]`
    const criterion = parseExactRecord(item, ["criterionID", "expectedObservationDigest"], itemPath)
    if (!criterion.ok) return criterion
    const criterionID = parseBoundedString(criterion.value.criterionID, `${itemPath}.criterionID`, 256)
    if (!criterionID.ok) return criterionID
    if (seen.has(criterionID.value)) return rejected(`${itemPath}.criterionID`, "duplicate_value")
    const expectedObservationDigest = parseDigest<ContentDigest>(
      criterion.value.expectedObservationDigest,
      `${itemPath}.expectedObservationDigest`,
    )
    if (!expectedObservationDigest.ok) return expectedObservationDigest
    seen.add(criterionID.value)
    criteria.push({ criterionID: criterionID.value, expectedObservationDigest: expectedObservationDigest.value })
  }
  return parsed({ verificationPlanID: verificationPlanID.value, verifier: verifier.value, criteria })
}

export function parseOperationAuthority(input: unknown, path = "$"): OperationContractParseResult<OperationAuthority> {
  const record = parseExactRecord(
    input,
    ["decisionID", "capabilityGrantID", "attemptID", "baselineDigest", "expiresAt"],
    path,
  )
  if (!record.ok) return record
  const decisionID = parseUUID<DecisionID>(record.value.decisionID, `${path}.decisionID`)
  if (!decisionID.ok) return decisionID
  const capabilityGrantID = parseUUID<CapabilityGrantID>(record.value.capabilityGrantID, `${path}.capabilityGrantID`)
  if (!capabilityGrantID.ok) return capabilityGrantID
  const attemptID = parseUUID<AttemptID>(record.value.attemptID, `${path}.attemptID`)
  if (!attemptID.ok) return attemptID
  const baselineDigest = parseDigest<ContentDigest>(record.value.baselineDigest, `${path}.baselineDigest`)
  if (!baselineDigest.ok) return baselineDigest
  const expiresAt = parseCanonicalTimestamp(record.value.expiresAt, `${path}.expiresAt`)
  if (!expiresAt.ok) return expiresAt
  return parsed({
    decisionID: decisionID.value,
    capabilityGrantID: capabilityGrantID.value,
    attemptID: attemptID.value,
    baselineDigest: baselineDigest.value,
    expiresAt: expiresAt.value,
  })
}

export function parseOperationDispatch(input: unknown, path = "$"): OperationContractParseResult<OperationDispatch> {
  const record = parseExactRecord(
    input,
    ["attemptID", "executor", "adapterDigest", "idempotencyKey", "capabilityGrantID"],
    path,
  )
  if (!record.ok) return record
  const attemptID = parseUUID<AttemptID>(record.value.attemptID, `${path}.attemptID`)
  if (!attemptID.ok) return attemptID
  const executor = parseBoundedString(record.value.executor, `${path}.executor`, 512)
  if (!executor.ok) return executor
  const adapterDigest = parseDigest<ContentDigest>(record.value.adapterDigest, `${path}.adapterDigest`)
  if (!adapterDigest.ok) return adapterDigest
  const idempotencyKey = parseDigest<IdempotencyKey>(record.value.idempotencyKey, `${path}.idempotencyKey`)
  if (!idempotencyKey.ok) return idempotencyKey
  const capabilityGrantID = parseUUID<CapabilityGrantID>(record.value.capabilityGrantID, `${path}.capabilityGrantID`)
  if (!capabilityGrantID.ok) return capabilityGrantID
  return parsed({
    attemptID: attemptID.value,
    executor: executor.value,
    adapterDigest: adapterDigest.value,
    idempotencyKey: idempotencyKey.value,
    capabilityGrantID: capabilityGrantID.value,
  })
}

export function parseDispatchRequest(input: unknown, path = "$"): OperationContractParseResult<DispatchRequest> {
  const record = parseExactRecord(
    input,
    [
      "dispatchRequestID",
      "operationID",
      "attemptID",
      "capabilityGrantID",
      "baselineDigest",
      "executor",
      "adapterDigest",
      "idempotencyKey",
      "requestedAt",
      "authorizationExpiresAt",
    ],
    path,
  )
  if (!record.ok) return record
  const dispatchRequestID = parseDispatchRequestID(record.value.dispatchRequestID, `${path}.dispatchRequestID`)
  if (!dispatchRequestID.ok) return dispatchRequestID
  const operationID = parseOperationID(record.value.operationID, `${path}.operationID`)
  if (!operationID.ok) return operationID
  const attemptID = parseUUID<AttemptID>(record.value.attemptID, `${path}.attemptID`)
  if (!attemptID.ok) return attemptID
  const capabilityGrantID = parseUUID<CapabilityGrantID>(record.value.capabilityGrantID, `${path}.capabilityGrantID`)
  if (!capabilityGrantID.ok) return capabilityGrantID
  const baselineDigest = parseDigest<ContentDigest>(record.value.baselineDigest, `${path}.baselineDigest`)
  if (!baselineDigest.ok) return baselineDigest
  const executor = parseBoundedString(record.value.executor, `${path}.executor`, 512)
  if (!executor.ok) return executor
  const adapterDigest = parseDigest<ContentDigest>(record.value.adapterDigest, `${path}.adapterDigest`)
  if (!adapterDigest.ok) return adapterDigest
  const idempotencyKey = parseDigest<IdempotencyKey>(record.value.idempotencyKey, `${path}.idempotencyKey`)
  if (!idempotencyKey.ok) return idempotencyKey
  const requestedAt = parseCanonicalTimestamp(record.value.requestedAt, `${path}.requestedAt`)
  if (!requestedAt.ok) return requestedAt
  const authorizationExpiresAt = parseCanonicalTimestamp(
    record.value.authorizationExpiresAt,
    `${path}.authorizationExpiresAt`,
  )
  if (!authorizationExpiresAt.ok) return authorizationExpiresAt
  if (Date.parse(authorizationExpiresAt.value) <= Date.parse(requestedAt.value)) {
    return rejected(`${path}.authorizationExpiresAt`, "not_after_requested_at")
  }
  return parsed({
    dispatchRequestID: dispatchRequestID.value,
    operationID: operationID.value,
    attemptID: attemptID.value,
    capabilityGrantID: capabilityGrantID.value,
    baselineDigest: baselineDigest.value,
    executor: executor.value,
    adapterDigest: adapterDigest.value,
    idempotencyKey: idempotencyKey.value,
    requestedAt: requestedAt.value,
    authorizationExpiresAt: authorizationExpiresAt.value,
  })
}

export function parseExecutorClaim(input: unknown, path = "$"): OperationContractParseResult<ExecutorClaim> {
  const record = parseExactRecord(
    input,
    [
      "executorClaimID",
      "dispatchRequestID",
      "operationID",
      "attemptID",
      "executor",
      "fencingToken",
      "acceptedAt",
      "claimExpiresAt",
    ],
    path,
  )
  if (!record.ok) return record
  const executorClaimID = parseExecutorClaimID(record.value.executorClaimID, `${path}.executorClaimID`)
  if (!executorClaimID.ok) return executorClaimID
  const dispatchRequestID = parseDispatchRequestID(record.value.dispatchRequestID, `${path}.dispatchRequestID`)
  if (!dispatchRequestID.ok) return dispatchRequestID
  const operationID = parseOperationID(record.value.operationID, `${path}.operationID`)
  if (!operationID.ok) return operationID
  const attemptID = parseUUID<AttemptID>(record.value.attemptID, `${path}.attemptID`)
  if (!attemptID.ok) return attemptID
  const executor = parseBoundedString(record.value.executor, `${path}.executor`, 512)
  if (!executor.ok) return executor
  const fencingToken = parsePositiveInteger(record.value.fencingToken, `${path}.fencingToken`)
  if (!fencingToken.ok) return fencingToken
  const acceptedAt = parseCanonicalTimestamp(record.value.acceptedAt, `${path}.acceptedAt`)
  if (!acceptedAt.ok) return acceptedAt
  const claimExpiresAt = parseCanonicalTimestamp(record.value.claimExpiresAt, `${path}.claimExpiresAt`)
  if (!claimExpiresAt.ok) return claimExpiresAt
  if (Date.parse(claimExpiresAt.value) <= Date.parse(acceptedAt.value)) {
    return rejected(`${path}.claimExpiresAt`, "not_after_accepted_at")
  }
  return parsed({
    executorClaimID: executorClaimID.value,
    dispatchRequestID: dispatchRequestID.value,
    operationID: operationID.value,
    attemptID: attemptID.value,
    executor: executor.value,
    fencingToken: fencingToken.value,
    acceptedAt: acceptedAt.value,
    claimExpiresAt: claimExpiresAt.value,
  })
}

export function parseOperationReceipt(input: unknown, path = "$"): OperationContractParseResult<OperationReceipt> {
  const record = parseExactRecord(
    input,
    [
      "receiptID",
      "operationID",
      "attemptID",
      "adapter",
      "effectClass",
      "resources",
      "startedAt",
      "endedAt",
      "observation",
      "output",
    ],
    path,
  )
  if (!record.ok) return record
  const receiptID = parseUUID<ReceiptID>(record.value.receiptID, `${path}.receiptID`)
  if (!receiptID.ok) return receiptID
  const operationID = parseOperationID(record.value.operationID, `${path}.operationID`)
  if (!operationID.ok) return operationID
  const attemptID = parseUUID<AttemptID>(record.value.attemptID, `${path}.attemptID`)
  if (!attemptID.ok) return attemptID
  const adapter = parseAdapter(record.value.adapter, `${path}.adapter`)
  if (!adapter.ok) return adapter
  const effectClass = parseBoundedString(record.value.effectClass, `${path}.effectClass`, 128)
  if (!effectClass.ok) return effectClass
  const resources = parseDistinctStringArray(record.value.resources, `${path}.resources`, undefined, true)
  if (!resources.ok) return resources
  const startedAt = parseCanonicalTimestamp(record.value.startedAt, `${path}.startedAt`)
  if (!startedAt.ok) return startedAt
  const endedAt = parseCanonicalTimestamp(record.value.endedAt, `${path}.endedAt`)
  if (!endedAt.ok) return endedAt
  if (Date.parse(endedAt.value) < Date.parse(startedAt.value)) return rejected(`${path}.endedAt`, "precedes_started_at")
  const observation = parseReceiptObservation(record.value.observation, `${path}.observation`)
  if (!observation.ok) return observation
  const output = parseReceiptOutput(record.value.output, `${path}.output`)
  if (!output.ok) return output
  return parsed({
    receiptID: receiptID.value,
    operationID: operationID.value,
    attemptID: attemptID.value,
    adapter: adapter.value,
    effectClass: effectClass.value,
    resources: resources.value,
    startedAt: startedAt.value,
    endedAt: endedAt.value,
    observation: observation.value,
    output: output.value,
  })
}

export function parseOperationEvidence(input: unknown, path = "$"): OperationContractParseResult<OperationEvidence> {
  const record = parseExactRecord(
    input,
    [
      "evidenceID",
      "operationID",
      "receiptID",
      "verificationPlanID",
      "verifier",
      "snapshotDigest",
      "observedAt",
      "criteria",
      "limitations",
    ],
    path,
  )
  if (!record.ok) return record
  const evidenceID = parseUUID<EvidenceID>(record.value.evidenceID, `${path}.evidenceID`)
  if (!evidenceID.ok) return evidenceID
  const operationID = parseOperationID(record.value.operationID, `${path}.operationID`)
  if (!operationID.ok) return operationID
  const receiptID = parseUUID<ReceiptID>(record.value.receiptID, `${path}.receiptID`)
  if (!receiptID.ok) return receiptID
  const verificationPlanID = parseUUID<VerificationPlanID>(
    record.value.verificationPlanID,
    `${path}.verificationPlanID`,
  )
  if (!verificationPlanID.ok) return verificationPlanID
  const verifier = parseAdapter(record.value.verifier, `${path}.verifier`)
  if (!verifier.ok) return verifier
  const snapshotDigest = parseDigest<ContentDigest>(record.value.snapshotDigest, `${path}.snapshotDigest`)
  if (!snapshotDigest.ok) return snapshotDigest
  const observedAt = parseCanonicalTimestamp(record.value.observedAt, `${path}.observedAt`)
  if (!observedAt.ok) return observedAt
  const criteria = parseEvidenceCriteria(record.value.criteria, `${path}.criteria`)
  if (!criteria.ok) return criteria
  const limitations = parseDistinctStringArray(record.value.limitations, `${path}.limitations`)
  if (!limitations.ok) return limitations
  return parsed({
    evidenceID: evidenceID.value,
    operationID: operationID.value,
    receiptID: receiptID.value,
    verificationPlanID: verificationPlanID.value,
    verifier: verifier.value,
    snapshotDigest: snapshotDigest.value,
    observedAt: observedAt.value,
    criteria: criteria.value,
    limitations: limitations.value,
  })
}

export function parseOperationEventEnvelope(
  input: unknown,
  path = "$",
): OperationContractParseResult<OperationEventEnvelope> {
  const record = parseExactRecord(
    input,
    [
      "eventID",
      "operationID",
      "sequence",
      "name",
      "schemaVersion",
      "recordedAt",
      "observedAt",
      "actor",
      "causationID",
      "correlationID",
      "attemptID",
      "payload",
      "previousDigest",
      "digest",
      "redaction",
      "externalBlobDigest",
    ],
    path,
  )
  if (!record.ok) return record
  const eventID = parseUUID<OperationEventID>(record.value.eventID, `${path}.eventID`)
  if (!eventID.ok) return eventID
  const operationID = parseOperationID(record.value.operationID, `${path}.operationID`)
  if (!operationID.ok) return operationID
  const sequence = parsePositiveInteger(record.value.sequence, `${path}.sequence`)
  if (!sequence.ok) return sequence
  if (!isOperationEventName(record.value.name)) {
    return rejected(`${path}.name`, "unknown_operation_event")
  }
  const schemaVersion = parsePositiveInteger(record.value.schemaVersion, `${path}.schemaVersion`, 1_000)
  if (!schemaVersion.ok) return schemaVersion
  const recordedAt = parseCanonicalTimestamp(record.value.recordedAt, `${path}.recordedAt`)
  if (!recordedAt.ok) return recordedAt
  const observedAt = parseCanonicalTimestamp(record.value.observedAt, `${path}.observedAt`)
  if (!observedAt.ok) return observedAt
  const actor = parseActorRef(record.value.actor, `${path}.actor`)
  if (!actor.ok) return actor
  const causationID = parseNullableUUID<OperationEventID>(record.value.causationID, `${path}.causationID`)
  if (!causationID.ok) return causationID
  const correlationID = parseUUID<CorrelationID>(record.value.correlationID, `${path}.correlationID`)
  if (!correlationID.ok) return correlationID
  const attemptID = parseNullableUUID<AttemptID>(record.value.attemptID, `${path}.attemptID`)
  if (!attemptID.ok) return attemptID
  const payload = parseNormalizedJsonObject(record.value.payload, `${path}.payload`)
  if (!payload.ok) return payload
  const previousDigest = parseNullableDigest(record.value.previousDigest, `${path}.previousDigest`)
  if (!previousDigest.ok) return previousDigest
  const digest = parseDigest<ContentDigest>(record.value.digest, `${path}.digest`)
  if (!digest.ok) return digest
  if (
    record.value.redaction !== "public" &&
    record.value.redaction !== "internal" &&
    record.value.redaction !== "sensitive_redacted"
  ) {
    return rejected(`${path}.redaction`, "unsupported_redaction_class")
  }
  const externalBlobDigest = parseNullableDigest(record.value.externalBlobDigest, `${path}.externalBlobDigest`)
  if (!externalBlobDigest.ok) return externalBlobDigest
  return parsed({
    eventID: eventID.value,
    operationID: operationID.value,
    sequence: sequence.value,
    name: record.value.name,
    schemaVersion: schemaVersion.value,
    recordedAt: recordedAt.value,
    observedAt: observedAt.value,
    actor: actor.value,
    causationID: causationID.value,
    correlationID: correlationID.value,
    attemptID: attemptID.value,
    payload: payload.value,
    previousDigest: previousDigest.value,
    digest: digest.value,
    redaction: record.value.redaction,
    externalBlobDigest: externalBlobDigest.value,
  })
}

function parseUUID<Value extends string>(input: unknown, path: string): OperationContractParseResult<Value> {
  if (typeof input !== "string" || !canonicalUuid.test(input)) return rejected(path, "expected_canonical_uuid")
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Runtime validation is the brand boundary.
  return parsed(input as Value)
}

function parseNullableUUID<Value extends string>(
  input: unknown,
  path: string,
): OperationContractParseResult<Value | null> {
  return input === null ? parsed(null) : parseUUID<Value>(input, path)
}

function parseDigest<Value extends string>(input: unknown, path: string): OperationContractParseResult<Value> {
  if (typeof input !== "string" || !sha256Digest.test(input)) return rejected(path, "expected_sha256_digest")
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Runtime validation is the brand boundary.
  return parsed(input as Value)
}

function isOperationEventName(input: unknown): input is OperationEventName {
  return typeof input === "string" && operationEvents.some((event) => event === input)
}

function parseNullableDigest(input: unknown, path: string): OperationContractParseResult<ContentDigest | null> {
  return input === null ? parsed(null) : parseDigest<ContentDigest>(input, path)
}

function parseWorkspaceIdentity(
  input: unknown,
  path: string,
): OperationContractParseResult<Readonly<{ device: string; inode: string }>> {
  const record = parseExactRecord(input, ["device", "inode"], path)
  if (!record.ok) return record
  const device = parseBoundedString(record.value.device, `${path}.device`, 128)
  if (!device.ok) return device
  const inode = parseBoundedString(record.value.inode, `${path}.inode`, 128)
  if (!inode.ok) return inode
  return parsed({ device: device.value, inode: inode.value })
}

function parseRepositoryBaseline(
  input: unknown,
  path: string,
): OperationContractParseResult<GitRepositoryBaseline | NonGitRepositoryBaseline> {
  const kindRecord = parseExactRecord(
    input,
    [
      "kind",
      "repositoryIdentity",
      "head",
      "indexTreeDigest",
      "trackedWorktreeDigest",
      "untrackedDigest",
      "markerDigest",
    ],
    path,
  )
  if (!kindRecord.ok) return kindRecord
  if (kindRecord.value.kind === "non_git") {
    const record = parseExactRecord(input, ["kind", "markerDigest"], path)
    if (!record.ok) return record
    const markerDigest = parseDigest<ContentDigest>(record.value.markerDigest, `${path}.markerDigest`)
    if (!markerDigest.ok) return markerDigest
    return parsed({ kind: "non_git", markerDigest: markerDigest.value })
  }
  if (kindRecord.value.kind !== "git") return rejected(`${path}.kind`, "unsupported_repository_kind")
  const record = parseExactRecord(
    input,
    ["kind", "repositoryIdentity", "head", "indexTreeDigest", "trackedWorktreeDigest", "untrackedDigest"],
    path,
  )
  if (!record.ok) return record
  const repositoryIdentity = parseBoundedString(record.value.repositoryIdentity, `${path}.repositoryIdentity`, 1_024)
  if (!repositoryIdentity.ok) return repositoryIdentity
  if (typeof record.value.head !== "string" || !gitObjectID.test(record.value.head)) {
    return rejected(`${path}.head`, "expected_git_object_id")
  }
  const indexTreeDigest = parseDigest<ContentDigest>(record.value.indexTreeDigest, `${path}.indexTreeDigest`)
  if (!indexTreeDigest.ok) return indexTreeDigest
  const trackedWorktreeDigest = parseDigest<ContentDigest>(
    record.value.trackedWorktreeDigest,
    `${path}.trackedWorktreeDigest`,
  )
  if (!trackedWorktreeDigest.ok) return trackedWorktreeDigest
  const untrackedDigest = parseDigest<ContentDigest>(record.value.untrackedDigest, `${path}.untrackedDigest`)
  if (!untrackedDigest.ok) return untrackedDigest
  return parsed({
    kind: "git",
    repositoryIdentity: repositoryIdentity.value,
    head: record.value.head,
    indexTreeDigest: indexTreeDigest.value,
    trackedWorktreeDigest: trackedWorktreeDigest.value,
    untrackedDigest: untrackedDigest.value,
  })
}

function parseRetrySafety(input: unknown, path: string): OperationContractParseResult<RetryBudget["retrySafety"]> {
  const broad = parseExactRecord(input, ["kind", "contractDigest"], path)
  if (!broad.ok) return broad
  if (broad.value.kind === "proof_of_no_effect_required") {
    const exact = parseExactRecord(input, ["kind"], path)
    if (!exact.ok) return exact
    return parsed({ kind: "proof_of_no_effect_required" })
  }
  if (broad.value.kind !== "semantic_idempotency") return rejected(`${path}.kind`, "unsupported_retry_safety")
  const exact = parseExactRecord(input, ["kind", "contractDigest"], path)
  if (!exact.ok) return exact
  const contractDigest = parseDigest<ContentDigest>(exact.value.contractDigest, `${path}.contractDigest`)
  if (!contractDigest.ok) return contractDigest
  return parsed({ kind: "semantic_idempotency", contractDigest: contractDigest.value })
}

function parseAdapter(
  input: unknown,
  path: string,
): OperationContractParseResult<Readonly<{ identity: string; version: string; digest: ContentDigest }>> {
  const record = parseExactRecord(input, ["identity", "version", "digest"], path)
  if (!record.ok) return record
  const identity = parseBoundedString(record.value.identity, `${path}.identity`, 512)
  if (!identity.ok) return identity
  const version = parseBoundedString(record.value.version, `${path}.version`, 128)
  if (!version.ok) return version
  const digest = parseDigest<ContentDigest>(record.value.digest, `${path}.digest`)
  if (!digest.ok) return digest
  return parsed({ identity: identity.value, version: version.value, digest: digest.value })
}

function parseReceiptObservation(
  input: unknown,
  path: string,
): OperationContractParseResult<OperationReceipt["observation"]> {
  const broad = parseExactRecord(
    input,
    ["kind", "beforeDigest", "afterDigest", "proofDigest", "observationDigest"],
    path,
  )
  if (!broad.ok) return broad
  if (broad.value.kind === "effect_observed") {
    const record = parseExactRecord(input, ["kind", "beforeDigest", "afterDigest"], path)
    if (!record.ok) return record
    const beforeDigest = parseNullableDigest(record.value.beforeDigest, `${path}.beforeDigest`)
    if (!beforeDigest.ok) return beforeDigest
    const afterDigest = parseDigest<ContentDigest>(record.value.afterDigest, `${path}.afterDigest`)
    if (!afterDigest.ok) return afterDigest
    return parsed({ kind: "effect_observed", beforeDigest: beforeDigest.value, afterDigest: afterDigest.value })
  }
  if (broad.value.kind === "no_effect_proved") {
    const record = parseExactRecord(input, ["kind", "proofDigest"], path)
    if (!record.ok) return record
    const proofDigest = parseDigest<ContentDigest>(record.value.proofDigest, `${path}.proofDigest`)
    if (!proofDigest.ok) return proofDigest
    return parsed({ kind: "no_effect_proved", proofDigest: proofDigest.value })
  }
  if (broad.value.kind === "effect_unknown") {
    const record = parseExactRecord(input, ["kind", "observationDigest"], path)
    if (!record.ok) return record
    const observationDigest = parseDigest<ContentDigest>(record.value.observationDigest, `${path}.observationDigest`)
    if (!observationDigest.ok) return observationDigest
    return parsed({ kind: "effect_unknown", observationDigest: observationDigest.value })
  }
  return rejected(`${path}.kind`, "unsupported_receipt_observation")
}

function parseReceiptOutput(input: unknown, path: string): OperationContractParseResult<OperationReceipt["output"]> {
  const record = parseExactRecord(input, ["digest", "bytes", "preview"], path)
  if (!record.ok) return record
  const digest = parseDigest<ContentDigest>(record.value.digest, `${path}.digest`)
  if (!digest.ok) return digest
  const bytes = parseNonNegativeInteger(record.value.bytes, `${path}.bytes`)
  if (!bytes.ok) return bytes
  if (typeof record.value.preview !== "string" || record.value.preview.length > 4_096) {
    return rejected(`${path}.preview`, "expected_bounded_string")
  }
  return parsed({ digest: digest.value, bytes: bytes.value, preview: record.value.preview })
}

function parseEvidenceCriteria(
  input: unknown,
  path: string,
): OperationContractParseResult<OperationEvidence["criteria"]> {
  if (!Array.isArray(input) || input.length === 0) return rejected(path, "expected_non_empty_array")
  if (input.length > 256) return rejected(path, "array_limit_exceeded")
  const criteria: Array<OperationEvidence["criteria"][number]> = []
  const seen = new Set<string>()
  for (const [index, item] of input.entries()) {
    const itemPath = `${path}[${index}]`
    const record = parseExactRecord(item, ["criterionID", "result", "observationDigest"], itemPath)
    if (!record.ok) return record
    const criterionID = parseBoundedString(record.value.criterionID, `${itemPath}.criterionID`, 256)
    if (!criterionID.ok) return criterionID
    if (seen.has(criterionID.value)) return rejected(`${itemPath}.criterionID`, "duplicate_value")
    if (record.value.result !== "passed" && record.value.result !== "failed" && record.value.result !== "unknown") {
      return rejected(`${itemPath}.result`, "unsupported_criterion_result")
    }
    const observationDigest = parseDigest<ContentDigest>(
      record.value.observationDigest,
      `${itemPath}.observationDigest`,
    )
    if (!observationDigest.ok) return observationDigest
    seen.add(criterionID.value)
    criteria.push({
      criterionID: criterionID.value,
      result: record.value.result,
      observationDigest: observationDigest.value,
    })
  }
  return parsed(criteria)
}
