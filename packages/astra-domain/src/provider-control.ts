import { createHash } from "node:crypto"

export const providerHostExecutionBoundaryLabel = "HOST EXECUTION — NO SANDBOX" as const
export const providerNetworkExecutionBoundaryLabel = "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX" as const
export const providerObservedCompletionLabel = "COMPLETED — RESPONSE OBSERVED — NOT VERIFIED" as const
export const providerSkillInstructionTrustLabel = "UNTRUSTED INSTRUCTION DATA" as const
export const providerSkillInstructionAssuranceLabel = "OBSERVED NOT VERIFIED" as const
export const providerConversationRetentionLabel = "PARENT-OWNED DURABLE — VERIFIED ON LOAD" as const
export const providerControlRequestWireLimitBytes = 6 * 65_536 + 16_384
export const providerControlResponseWireLimitBytes = 6 * 1_048_576 + 262_144

export type ProviderControlModel = Readonly<{
  id: string
  name: string
  limits: Readonly<{ context: number; input?: number; output: number }>
}>

export type ProviderControlProvider = Readonly<{
  providerID: string
  providerName: string
  assurance: "CERTIFIED" | "COMPATIBLE — NOT VERIFIED"
  dispatchable: boolean
  credentialProfiles: ReadonlyArray<string>
  models: ReadonlyArray<ProviderControlModel>
}>

export type ProviderControlCatalog = Readonly<{
  providers: ReadonlyArray<ProviderControlProvider>
}>

export type ProviderTurnSelection =
  | Readonly<{
      providerID: "anthropic"
      credentialProfile: "anthropic-api-key"
      modelID: string
    }>
  | Readonly<{
      providerID: "openai"
      credentialProfile: "openai-api-key" | "openai-codex-oauth"
      modelID: string
    }>

export type ProviderConversationTranscriptTurn = Readonly<{
  providerID: string
  credentialProfile: "anthropic-api-key" | "openai-api-key" | "openai-codex-oauth"
  modelID: string
  userText: string
  assistantText: string
  finishReason: "stop" | "length" | "content_filter"
  assurance: "observed_not_verified"
}>

export type ProviderConversationTranscript = Readonly<{
  turns: ReadonlyArray<ProviderConversationTranscriptTurn>
  historyDigest: `sha256:${string}`
  totalBytes: number
  retention: typeof providerConversationRetentionLabel
}>

type ProviderControlRequestBase = Readonly<{
  schemaVersion: 1
  requestId: string
  sessionID: string
  token: string
}>

export type ProviderCatalogRequest = ProviderControlRequestBase & Readonly<{ method: "provider.catalog" }>

export type ProviderTurnPrepareRequest = ProviderControlRequestBase &
  Readonly<{
    method: "provider.turn.prepare"
    providerID: "anthropic" | "openai"
    credentialProfile: "anthropic-api-key" | "openai-api-key" | "openai-codex-oauth"
    modelID: string
    userText: string
  }>

export type ProviderTurnDecisionRequest = ProviderControlRequestBase &
  Readonly<{
    method: "provider.turn.decide"
    proposalID: string
    decision: "approve" | "reject"
  }>

export type ProviderControlRequest = ProviderCatalogRequest | ProviderTurnPrepareRequest | ProviderTurnDecisionRequest

export type ProviderCatalogResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "available"
      catalog: ProviderControlCatalog
      transcript: ProviderConversationTranscript
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "unavailable"
      reason: "catalog_unavailable" | "control_unavailable"
    }>

export type ProviderTurnPreview = Readonly<{
  proposalID: string
  operationID: string
  providerID: "anthropic" | "openai"
  modelID: string
  adapter: Readonly<{
    adapterID: string
    adapterDigest: string
    assurance: "CERTIFIED"
  }>
  destination: Readonly<{ method: "POST"; origin: string; path: string }>
  logicalPayload: Readonly<{
    digest: string
    bytes: number
    contextBindingDigest: string | null
  }>
  conversation: Readonly<{
    priorTurns: number
    historyBytes: number
    historyDigest: string
    retention: typeof providerConversationRetentionLabel
  }>
  providerCapabilityDigest: string
  skillContext: ProviderTurnSkillContext | null
  headerNames: ReadonlyArray<string>
  credential: Readonly<{
    profile: "anthropic-api-key" | "openai-api-key" | "openai-codex-oauth"
    accountFingerprint: string
    headerName: "x-api-key" | "authorization"
  }>
  expiresAt: string
  hostBoundaryLabel: typeof providerHostExecutionBoundaryLabel
  networkBoundaryLabel: typeof providerNetworkExecutionBoundaryLabel
  assurance: "NOT VERIFIED"
}>

export type ProviderTurnSkillContext = Readonly<{
  kind: "activated_skill"
  activationOperationID: string
  activationCapabilityDigest: string
  name: string
  provenance: "workspace_opencode"
  instructionsDigest: string
  trust: typeof providerSkillInstructionTrustLabel
  resourceDiscovery: "none"
  assurance: typeof providerSkillInstructionAssuranceLabel
  disclosure: "included_in_provider_request"
}>

/** Computes the non-secret binding shown before provider consent. */
export function computeProviderSkillContextBindingDigest(input: ProviderTurnSkillContext): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        kind: input.kind,
        activationOperationID: input.activationOperationID,
        activationCapabilityDigest: input.activationCapabilityDigest,
        name: input.name,
        provenance: input.provenance,
        instructionsDigest: input.instructionsDigest,
        trust: input.trust,
        resourceDiscovery: input.resourceDiscovery,
        assurance: input.assurance,
      }),
    )
    .digest("hex")}`
}

export type ProviderTurnPrepareResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "prepared"
      preview: ProviderTurnPreview
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      status: "blocked"
      reason:
        | "read_only"
        | "catalog_unavailable"
        | "provider_rejected"
        | "credential_profile_rejected"
        | "credential_unavailable"
        | "model_rejected"
        | "input_rejected"
        | "control_busy"
        | "control_limit_reached"
        | "conversation_limit_reached"
        | "workspace_stale"
        | "skill_context_unavailable"
        | "control_unavailable"
    }>

export type ProviderTurnProgress = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  operationID: string
  status:
    | "recording_authority"
    | "authority_claimed"
    | "network_dispatch"
    | "response_observed_not_verified"
    | "receipt_acknowledged"
}>

export type ProviderTurnDecisionResult =
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      operationID: string
      status: "denied_without_effect"
      receiptID: null
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      operationID: string
      status: "response_observed_not_verified"
      receiptID: string
      completionLabel: typeof providerObservedCompletionLabel
      response: Readonly<{
        assistantText: string
        assistantTextDigest: string
        assistantTextBytes: number
        finishReason: "stop" | "length" | "content_filter"
      }>
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      operationID: string
      status: "reconciliation_required"
      receiptID: string | null
      reason: "effect_unknown" | "client_disconnected_after_approval"
    }>
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "blocked"
      reason:
        | "proposal_unknown"
        | "proposal_expired"
        | "proposal_replayed"
        | "credential_unavailable"
        | "control_busy"
        | "control_failed"
    }>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
const digestPattern = /^sha256:[0-9a-f]{64}$/u
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

function certifiedProviderProfiles(providerID: string): ReadonlyArray<string> | null {
  if (providerID === "anthropic") return ["anthropic-api-key"]
  if (providerID === "openai") return ["openai-api-key", "openai-codex-oauth"]
  return null
}

function certifiedSelection(providerID: unknown, credentialProfile: unknown): boolean {
  if (typeof providerID !== "string" || typeof credentialProfile !== "string") return false
  return certifiedProviderProfiles(providerID)?.includes(credentialProfile) === true
}

function exactStringArray(input: ReadonlyArray<unknown>, expected: ReadonlyArray<string>) {
  return input.length === expected.length && input.every((value, index) => value === expected[index])
}

export function parseProviderControlRequest(input: unknown): ProviderControlRequest | null {
  const base = plainRecord(input)
  if (!base || base.schemaVersion !== 1 || !uuid(base.requestId) || !uuid(base.sessionID) || !token(base.token)) {
    return null
  }
  if (base.method === "provider.catalog") {
    if (!exactKeys(base, ["schemaVersion", "method", "requestId", "sessionID", "token"])) return null
    return base as ProviderCatalogRequest
  }
  if (base.method === "provider.turn.prepare") {
    if (
      !exactKeys(base, [
        "schemaVersion",
        "method",
        "requestId",
        "sessionID",
        "token",
        "providerID",
        "credentialProfile",
        "modelID",
        "userText",
      ]) ||
      !certifiedSelection(base.providerID, base.credentialProfile) ||
      typeof base.modelID !== "string" ||
      !modelPattern.test(base.modelID) ||
      typeof base.userText !== "string" ||
      base.userText.trim().length === 0 ||
      Buffer.byteLength(base.userText, "utf8") > 65_536
    ) {
      return null
    }
    return base as ProviderTurnPrepareRequest
  }
  if (base.method !== "provider.turn.decide") return null
  if (
    !exactKeys(base, ["schemaVersion", "method", "requestId", "sessionID", "token", "proposalID", "decision"]) ||
    !uuid(base.proposalID) ||
    (base.decision !== "approve" && base.decision !== "reject")
  ) {
    return null
  }
  return base as ProviderTurnDecisionRequest
}

export function parseProviderCatalogResult(input: unknown): ProviderCatalogResult | null {
  const record = plainRecord(input)
  if (!record || record.schemaVersion !== 1 || !uuid(record.requestId)) return null
  if (record.status === "unavailable") {
    if (!exactKeys(record, ["schemaVersion", "requestId", "status", "reason"])) return null
    if (record.reason !== "catalog_unavailable" && record.reason !== "control_unavailable") return null
    return record as ProviderCatalogResult
  }
  if (
    record.status !== "available" ||
    !exactKeys(record, ["schemaVersion", "requestId", "status", "catalog", "transcript"])
  ) {
    return null
  }
  const catalog = parseCatalog(record.catalog)
  const transcript = parseTranscript(record.transcript)
  return catalog && transcript ? ({ ...record, catalog, transcript } as ProviderCatalogResult) : null
}

export function parseProviderTurnPrepareResult(input: unknown): ProviderTurnPrepareResult | null {
  const record = plainRecord(input)
  if (!record || record.schemaVersion !== 1 || !uuid(record.requestId)) return null
  if (record.status === "blocked") {
    if (!exactKeys(record, ["schemaVersion", "requestId", "status", "reason"])) return null
    return prepareBlockReasons.has(String(record.reason)) ? (record as ProviderTurnPrepareResult) : null
  }
  if (record.status !== "prepared" || !exactKeys(record, ["schemaVersion", "requestId", "status", "preview"])) {
    return null
  }
  const preview = parsePreview(record.preview)
  return preview ? ({ ...record, preview } as ProviderTurnPrepareResult) : null
}

export function parseProviderTurnProgress(input: unknown): ProviderTurnProgress | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, ["schemaVersion", "requestId", "proposalID", "operationID", "status"]) ||
    record.schemaVersion !== 1 ||
    !uuid(record.requestId) ||
    !uuid(record.proposalID) ||
    !uuid(record.operationID) ||
    !progressStatuses.has(String(record.status))
  ) {
    return null
  }
  return record as ProviderTurnProgress
}

export function parseProviderTurnDecisionResult(input: unknown): ProviderTurnDecisionResult | null {
  const record = plainRecord(input)
  if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !uuid(record.proposalID)) return null
  if (record.status === "blocked") {
    if (!exactKeys(record, ["schemaVersion", "requestId", "proposalID", "status", "reason"])) return null
    return decisionBlockReasons.has(String(record.reason)) ? (record as ProviderTurnDecisionResult) : null
  }
  if (!uuid(record.operationID)) return null
  if (record.status === "denied_without_effect") {
    if (!exactKeys(record, ["schemaVersion", "requestId", "proposalID", "operationID", "status", "receiptID"])) {
      return null
    }
    return record.receiptID === null ? (record as ProviderTurnDecisionResult) : null
  }
  if (record.status === "reconciliation_required") {
    if (
      !exactKeys(record, [
        "schemaVersion",
        "requestId",
        "proposalID",
        "operationID",
        "status",
        "receiptID",
        "reason",
      ]) ||
      (record.receiptID !== null && !uuid(record.receiptID)) ||
      (record.reason !== "effect_unknown" && record.reason !== "client_disconnected_after_approval")
    ) {
      return null
    }
    return record as ProviderTurnDecisionResult
  }
  if (
    record.status !== "response_observed_not_verified" ||
    !exactKeys(record, [
      "schemaVersion",
      "requestId",
      "proposalID",
      "operationID",
      "status",
      "receiptID",
      "completionLabel",
      "response",
    ]) ||
    !uuid(record.receiptID) ||
    record.completionLabel !== providerObservedCompletionLabel
  ) {
    return null
  }
  const response = parseResponse(record.response)
  return response ? ({ ...record, response } as ProviderTurnDecisionResult) : null
}

function parseCatalog(input: unknown): ProviderControlCatalog | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, ["providers"]) ||
    !Array.isArray(record.providers) ||
    record.providers.length < 1 ||
    record.providers.length > 64
  ) {
    return null
  }
  const providers = record.providers.map(parseProvider)
  if (providers.some((provider) => provider === null)) return null
  const typed = providers as ProviderControlProvider[]
  if (new Set(typed.map((provider) => provider.providerID)).size !== typed.length) return null
  return { providers: typed }
}

function parseTranscript(input: unknown): ProviderConversationTranscript | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, ["turns", "historyDigest", "totalBytes", "retention"]) ||
    !Array.isArray(record.turns) ||
    record.turns.length > 64 ||
    !digest(record.historyDigest) ||
    !nonNegative(record.totalBytes) ||
    record.totalBytes > 65_536 ||
    record.retention !== providerConversationRetentionLabel
  ) {
    return null
  }
  const turns = record.turns.map(parseTranscriptTurn)
  if (turns.some((turn) => turn === null)) return null
  const typed = turns as ProviderConversationTranscriptTurn[]
  const totalBytes = typed.reduce(
    (total, turn) => total + Buffer.byteLength(turn.userText, "utf8") + Buffer.byteLength(turn.assistantText, "utf8"),
    0,
  )
  if (totalBytes !== record.totalBytes || (typed.length === 0) !== (totalBytes === 0)) {
    return null
  }
  return {
    turns: typed,
    historyDigest: record.historyDigest,
    totalBytes,
    retention: providerConversationRetentionLabel,
  }
}

function parseTranscriptTurn(input: unknown): ProviderConversationTranscriptTurn | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, [
      "providerID",
      "credentialProfile",
      "modelID",
      "userText",
      "assistantText",
      "finishReason",
      "assurance",
    ]) ||
    typeof record.providerID !== "string" ||
    !modelPattern.test(record.providerID) ||
    (record.credentialProfile !== "anthropic-api-key" &&
      record.credentialProfile !== "openai-api-key" &&
      record.credentialProfile !== "openai-codex-oauth") ||
    typeof record.modelID !== "string" ||
    !modelPattern.test(record.modelID) ||
    typeof record.userText !== "string" ||
    Buffer.byteLength(record.userText, "utf8") < 1 ||
    typeof record.assistantText !== "string" ||
    Buffer.byteLength(record.assistantText, "utf8") < 1 ||
    (record.finishReason !== "stop" && record.finishReason !== "length" && record.finishReason !== "content_filter") ||
    record.assurance !== "observed_not_verified"
  ) {
    return null
  }
  return record as ProviderConversationTranscriptTurn
}

function parseProvider(input: unknown): ProviderControlProvider | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, ["providerID", "providerName", "assurance", "dispatchable", "credentialProfiles", "models"]) ||
    typeof record.providerID !== "string" ||
    !modelPattern.test(record.providerID) ||
    !display(record.providerName) ||
    !Array.isArray(record.credentialProfiles) ||
    !Array.isArray(record.models) ||
    record.models.length < 1 ||
    record.models.length > 256
  ) {
    return null
  }
  const certifiedProfiles = certifiedProviderProfiles(record.providerID)
  if (record.assurance === "CERTIFIED") {
    if (
      record.dispatchable !== true ||
      !certifiedProfiles ||
      !exactStringArray(record.credentialProfiles, certifiedProfiles)
    ) {
      return null
    }
  } else if (
    record.assurance !== "COMPATIBLE — NOT VERIFIED" ||
    record.dispatchable !== false ||
    record.credentialProfiles.length !== 0 ||
    certifiedProfiles !== null
  ) {
    return null
  }
  const models = record.models.map(parseModel)
  if (models.some((model) => model === null)) return null
  const typed = models as ProviderControlModel[]
  if (typed.some((model, index) => index > 0 && model.id <= typed[index - 1]!.id)) return null
  return {
    providerID: record.providerID,
    providerName: record.providerName,
    assurance: record.assurance,
    dispatchable: record.dispatchable,
    credentialProfiles: [...record.credentialProfiles],
    models: typed,
  }
}

function parseModel(input: unknown): ProviderControlModel | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, ["id", "name", "limits"]) ||
    typeof record.id !== "string" ||
    !modelPattern.test(record.id) ||
    !display(record.name)
  ) {
    return null
  }
  const limits = plainRecord(record.limits)
  if (!limits || !exactOptionalInputLimitKeys(limits) || !positive(limits.context) || !positive(limits.output)) {
    return null
  }
  const inputLimit = limits.input
  if (inputLimit !== undefined && !positive(inputLimit)) return null
  return {
    id: record.id,
    name: record.name,
    limits: {
      context: limits.context,
      ...(inputLimit === undefined ? {} : { input: inputLimit }),
      output: limits.output,
    },
  }
}

function parsePreview(input: unknown): ProviderTurnPreview | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, [
      "proposalID",
      "operationID",
      "providerID",
      "modelID",
      "adapter",
      "destination",
      "logicalPayload",
      "conversation",
      "providerCapabilityDigest",
      "skillContext",
      "headerNames",
      "credential",
      "expiresAt",
      "hostBoundaryLabel",
      "networkBoundaryLabel",
      "assurance",
    ]) ||
    !uuid(record.proposalID) ||
    !uuid(record.operationID) ||
    (record.providerID !== "anthropic" && record.providerID !== "openai") ||
    typeof record.modelID !== "string" ||
    !modelPattern.test(record.modelID) ||
    record.hostBoundaryLabel !== providerHostExecutionBoundaryLabel ||
    record.networkBoundaryLabel !== providerNetworkExecutionBoundaryLabel ||
    record.assurance !== "NOT VERIFIED" ||
    !timestamp(record.expiresAt)
  ) {
    return null
  }
  const destination = plainRecord(record.destination)
  const adapter = plainRecord(record.adapter)
  const payload = plainRecord(record.logicalPayload)
  const conversation = plainRecord(record.conversation)
  const credential = plainRecord(record.credential)
  const headerNames = Array.isArray(record.headerNames) ? record.headerNames : null
  const skillContext = record.skillContext === null ? null : parseSkillContext(record.skillContext)
  const profile = credential?.profile
  const binding = providerPreviewBinding(record.providerID, profile)
  if (
    !binding ||
    !adapter ||
    !exactKeys(adapter, ["adapterID", "adapterDigest", "assurance"]) ||
    adapter.adapterID !== binding.adapterID ||
    !digest(adapter.adapterDigest) ||
    adapter.assurance !== "CERTIFIED" ||
    !destination ||
    !exactKeys(destination, ["method", "origin", "path"]) ||
    destination.method !== "POST" ||
    destination.origin !== binding.origin ||
    destination.path !== binding.path ||
    !payload ||
    !exactKeys(payload, ["digest", "bytes", "contextBindingDigest"]) ||
    !digest(payload.digest) ||
    !positive(payload.bytes) ||
    (payload.contextBindingDigest !== null && !digest(payload.contextBindingDigest)) ||
    !conversation ||
    !exactKeys(conversation, ["priorTurns", "historyBytes", "historyDigest", "retention"]) ||
    !nonNegative(conversation.priorTurns) ||
    !nonNegative(conversation.historyBytes) ||
    (conversation.priorTurns === 0) !== (conversation.historyBytes === 0) ||
    !digest(conversation.historyDigest) ||
    conversation.retention !== providerConversationRetentionLabel ||
    !digest(record.providerCapabilityDigest) ||
    (record.skillContext !== null && !skillContext) ||
    (skillContext === null && payload.contextBindingDigest !== null) ||
    (skillContext !== null &&
      payload.contextBindingDigest !== computeProviderSkillContextBindingDigest(skillContext)) ||
    !headerNames ||
    headerNames.some((name) => typeof name !== "string") ||
    !binding.headerNames.some((expected) => exactStringArray(headerNames, expected)) ||
    !credential ||
    !exactKeys(credential, ["profile", "accountFingerprint", "headerName"]) ||
    typeof credential.accountFingerprint !== "string" ||
    !digestPattern.test(credential.accountFingerprint) ||
    credential.headerName !== binding.headerName ||
    (record.providerID === "openai" && skillContext !== null)
  ) {
    return null
  }
  return record as ProviderTurnPreview
}

function providerPreviewBinding(providerID: unknown, profile: unknown) {
  if (providerID === "anthropic" && profile === "anthropic-api-key") {
    return {
      adapterID: "anthropic.messages.api-key.v1",
      origin: "https://api.anthropic.com",
      path: "/v1/messages",
      headerName: "x-api-key",
      headerNames: [["anthropic-version", "content-type", "x-api-key"]],
    } as const
  }
  if (providerID === "openai" && profile === "openai-api-key") {
    return {
      adapterID: "openai.responses.api-key.v1",
      origin: "https://api.openai.com",
      path: "/v1/responses",
      headerName: "authorization",
      headerNames: [["accept", "authorization", "content-type", "originator", "session-id", "user-agent"]],
    } as const
  }
  if (providerID === "openai" && profile === "openai-codex-oauth") {
    return {
      adapterID: "openai.responses.codex-oauth.v1",
      origin: "https://chatgpt.com",
      path: "/backend-api/codex/responses",
      headerName: "authorization",
      headerNames: [
        ["accept", "authorization", "content-type", "originator", "session-id", "user-agent"],
        [
          "accept",
          "authorization",
          "chatgpt-account-id",
          "content-type",
          "originator",
          "session-id",
          "user-agent",
        ],
      ],
    } as const
  }
  return null
}

function parseSkillContext(input: unknown): ProviderTurnSkillContext | null {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, [
      "kind",
      "activationOperationID",
      "activationCapabilityDigest",
      "name",
      "provenance",
      "instructionsDigest",
      "trust",
      "resourceDiscovery",
      "assurance",
      "disclosure",
    ]) ||
    record.kind !== "activated_skill" ||
    !uuid(record.activationOperationID) ||
    !digest(record.activationCapabilityDigest) ||
    !display(record.name) ||
    record.provenance !== "workspace_opencode" ||
    !digest(record.instructionsDigest) ||
    record.trust !== providerSkillInstructionTrustLabel ||
    record.resourceDiscovery !== "none" ||
    record.assurance !== providerSkillInstructionAssuranceLabel ||
    record.disclosure !== "included_in_provider_request"
  ) {
    return null
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Exact runtime validation is the DTO boundary.
  return record as ProviderTurnSkillContext
}

function parseResponse(input: unknown) {
  const record = plainRecord(input)
  if (
    !record ||
    !exactKeys(record, ["assistantText", "assistantTextDigest", "assistantTextBytes", "finishReason"]) ||
    typeof record.assistantText !== "string" ||
    record.assistantText.length === 0 ||
    Buffer.byteLength(record.assistantText, "utf8") !== record.assistantTextBytes ||
    !positive(record.assistantTextBytes) ||
    record.assistantTextBytes > 1_048_576 ||
    !digest(record.assistantTextDigest) ||
    (record.finishReason !== "stop" && record.finishReason !== "length" && record.finishReason !== "content_filter")
  ) {
    return null
  }
  return record as Extract<ProviderTurnDecisionResult, { status: "response_observed_not_verified" }>["response"]
}

const prepareBlockReasons = new Set([
  "read_only",
  "catalog_unavailable",
  "provider_rejected",
  "credential_profile_rejected",
  "credential_unavailable",
  "model_rejected",
  "input_rejected",
  "control_busy",
  "control_limit_reached",
  "conversation_limit_reached",
  "workspace_stale",
  "skill_context_unavailable",
  "control_unavailable",
])
const decisionBlockReasons = new Set([
  "proposal_unknown",
  "proposal_expired",
  "proposal_replayed",
  "credential_unavailable",
  "control_busy",
  "control_failed",
])
const progressStatuses = new Set([
  "recording_authority",
  "authority_claimed",
  "network_dispatch",
  "response_observed_not_verified",
  "receipt_acknowledged",
])

function plainRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null ? (input as Record<string, unknown>) : null
}

function exactKeys(input: Record<string, unknown>, keys: ReadonlyArray<string>) {
  const actual = Reflect.ownKeys(input)
  return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key))
}

function exactOptionalInputLimitKeys(input: Record<string, unknown>) {
  return exactKeys(input, ["context", "output"]) || exactKeys(input, ["context", "input", "output"])
}

function uuid(input: unknown): input is string {
  return typeof input === "string" && uuidPattern.test(input)
}

function token(input: unknown): input is string {
  return typeof input === "string" && tokenPattern.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}

function timestamp(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input
}

function positive(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
}

function nonNegative(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
}

function display(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(input)
}
