import { randomUUID } from "node:crypto"
import {
  computeProviderSkillContextBindingDigest,
  providerConversationRetentionLabel,
  providerHostExecutionBoundaryLabel,
  providerNetworkExecutionBoundaryLabel,
  providerObservedCompletionLabel,
  providerSkillInstructionAssuranceLabel,
  providerSkillInstructionTrustLabel,
  type ProviderControlCatalog,
  type ProviderConversationTranscript,
  type ProviderTurnSkillContext,
  type ProviderTurnDecisionResult,
  type ProviderTurnPrepareResult,
  type ProviderTurnPreview,
  type ProviderTurnProgress,
} from "@astra/domain/provider-control"
import type { AstraProviderConversation, AstraProviderConversationTurn } from "@astra/domain/work-session"
import {
  anthropicOneTurnMaximumConversationBytes,
  anthropicOneTurnMaximumConversationTurns,
  buildAnthropicOneTurnRequest,
  createAnthropicCatalogAuthority,
  parseAnthropicOneTurnResponse,
  sealValidatedAnthropicModelCatalog,
  type AnthropicCatalogAuthority,
  type AnthropicConversationTurn,
  type AnthropicOneTurnRequest,
} from "@astra/runtime/anthropic-one-turn"
import {
  buildOpenAIResponsesOneTurnRequest,
  parseOpenAIResponsesOneTurnResponse,
  type OpenAIResponsesOneTurnRequest,
} from "@astra/runtime/openai-responses-one-turn"
import {
  providerTurnPublicDnsPolicyDigest,
  providerTurnResolverImplementationDigest,
  providerTurnTransportImplementationDigest,
} from "@astra/runtime/provider-turn-network-policy"
import type { DurableProviderTurnResult, ExecuteProviderTurnInput } from "@astra/runtime/provider-turn-coordinator"
import { makeProviderTurnOperationFacts } from "@astra/runtime/provider-turn-operation-facts"
import {
  resolveCertifiedProviderAdapter,
  type CertifiedProviderAdapter,
} from "@astra/runtime/provider-adapter-registry"
import {
  executeProviderTurnWithTrustedObservedTransport,
  type TrustedObservedProviderCompletion,
  type TrustedObservedProviderRawResponse,
  type TrustedProviderWireValues,
} from "@astra/runtime/provider-turn-transport"
import type { AstraWorkspaceSessionResult } from "./workspace-session"
import type { ParentProviderCredentialBroker, ProviderCredentialGrant } from "./provider-credential-broker"
import type { ProviderCatalogResult } from "./provider-catalog"
import type {
  AstraSkillActivationControl,
  PromptSkillBundleTakeResult,
  TrustedPromptSkillBundle,
} from "./skill-activation-control"
import type { ParentProviderConversationHistory } from "./provider-conversation-history"

const maximumPreparedOperations = 16
const requestTimeoutMilliseconds = 30_000
const maximumResponseBytes = 1_048_576
const maxTokens = 1_024

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>
type StripEnvelope<Input> = Input extends unknown ? Omit<Input, "schemaVersion" | "requestId"> : never
type PublicPrepareResult = StripEnvelope<ProviderTurnPrepareResult>
type PublicDecisionResult = StripEnvelope<ProviderTurnDecisionResult>
type PublicProgress = Omit<ProviderTurnProgress, "schemaVersion" | "requestId">

type PendingTurn = Readonly<{
  proposalID: string
  operationID: string
  facts: ExecuteProviderTurnInput
  request: ProviderWireRequest
  adapter: CertifiedProviderAdapter
  parseResponse: (response: TrustedObservedProviderRawResponse) => TrustedObservedProviderCompletion
  grant: ProviderCredentialGrant
  preview: ProviderTurnPreview
  skillBundle: TrustedPromptSkillBundle | null
  userText: string
  priorHistoryDigest: `sha256:${string}`
}>

type ProviderWireRequest = AnthropicOneTurnRequest | OpenAIResponsesOneTurnRequest

export type AstraProviderControl = Readonly<{
  catalog: () => Promise<
    | Readonly<{
        status: "available"
        catalog: ProviderControlCatalog
        transcript: ProviderConversationTranscript
      }>
    | Readonly<{
        status: "unavailable"
        reason: "catalog_unavailable"
      }>
  >
  prepare: {
    (modelID: string, userText: string): Promise<PublicPrepareResult>
    (providerID: string, credentialProfile: string, modelID: string, userText: string): Promise<PublicPrepareResult>
  }
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    onProgress: (progress: PublicProgress) => void,
  ) => Promise<PublicDecisionResult>
}>

export type AstraProviderControlDependencies = Readonly<{
  readCatalog: () => ProviderCatalogResult
  credentialBroker: ParentProviderCredentialBroker
  conversationHistory: ParentProviderConversationHistory
  skillBundleSource?: Pick<AstraSkillActivationControl, "takePromptBundle">
  execute?: typeof executeProviderTurnWithTrustedObservedTransport
  createCatalogAuthority?: () => AnthropicCatalogAuthority
  now?: () => number
  randomUUID?: () => string
}>

/** Parent-only owner for one consent-bound certified provider proposal backed by durable history. */
export function createAstraProviderControl(
  session: OpenedWorkspace,
  sessionID: string,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraProviderControlDependencies,
): AstraProviderControl {
  const now = dependencies.now ?? Date.now
  const uuid = dependencies.randomUUID ?? randomUUID
  const execute = dependencies.execute ?? executeProviderTurnWithTrustedObservedTransport
  const catalogAuthority = (dependencies.createCatalogAuthority ?? createAnthropicCatalogAuthority)()
  const consumed = new Set<string>()
  let pending: PendingTurn | undefined
  let availableSkill: TrustedPromptSkillBundle | undefined
  let prepared = 0
  let deciding = false

  const catalog = async () => {
    const result = dependencies.readCatalog()
    if (!result.ok)
      return {
        status: "unavailable" as const,
        reason: "catalog_unavailable" as const,
      }
    const conversation = await dependencies.conversationHistory.load().catch(() => null)
    if (!conversation)
      return {
        status: "unavailable" as const,
        reason: "catalog_unavailable" as const,
      }
    return {
      status: "available" as const,
      catalog: publicCatalog(result.catalog),
      transcript: publicTranscript(conversation),
    }
  }

  async function prepare(modelID: string, userText: string): Promise<PublicPrepareResult>
  async function prepare(
    providerID: string,
    credentialProfile: string,
    modelID: string,
    userText: string,
  ): Promise<PublicPrepareResult>
  async function prepare(
    providerIDOrModelID: string,
    credentialProfileOrUserText: string,
    selectedModelID?: string,
    selectedUserText?: string,
  ): Promise<PublicPrepareResult> {
    const legacyAnthropic = selectedModelID === undefined && selectedUserText === undefined
    const providerID = legacyAnthropic ? "anthropic" : providerIDOrModelID
    const credentialProfile = legacyAnthropic ? "anthropic-api-key" : credentialProfileOrUserText
    const modelID = legacyAnthropic ? providerIDOrModelID : selectedModelID!
    const userText = legacyAnthropic ? credentialProfileOrUserText : selectedUserText!
    if (session.mode !== "activate-once") return blockedPrepare("read_only")
    if (deciding || pending) return blockedPrepare("control_busy")
    if (prepared >= maximumPreparedOperations) return blockedPrepare("control_limit_reached")
    const result = dependencies.readCatalog()
    if (!result.ok) return blockedPrepare("catalog_unavailable")
    const provider = result.catalog.providers.find((candidate) => candidate.providerID === providerID)
    if (!provider?.dispatchable || provider.assurance !== "CERTIFIED") return blockedPrepare("provider_rejected")
    if (!provider.credentialProfiles.some((profile) => profile === credentialProfile)) {
      return blockedPrepare("credential_profile_rejected")
    }
    if (!provider.models.some((model) => model.id === modelID)) return blockedPrepare("model_rejected")
    const adapter = resolveCertifiedProviderAdapter(providerID, credentialProfile)
    if (!adapter) return blockedPrepare("provider_rejected")
    const durableConversation = await dependencies.conversationHistory.load().catch(() => null)
    if (!durableConversation) return blockedPrepare("control_unavailable")
    const conversation: ReadonlyArray<AnthropicConversationTurn> = durableConversation.turns.map((turn) => ({
      userText: turn.userText,
      assistantText: turn.assistantText,
    }))
    const historyBytes = durableConversation.totalBytes
    if (
      conversation.length >= anthropicOneTurnMaximumConversationTurns ||
      historyBytes + Buffer.byteLength(userText, "utf8") > anthropicOneTurnMaximumConversationBytes
    ) {
      return blockedPrepare("conversation_limit_reached")
    }

    const skill = await takeAvailableSkill(dependencies.skillBundleSource, availableSkill)
    if (skill.status === "blocked") return blockedPrepare("skill_context_unavailable")
    if (skill.status === "taken") availableSkill = skill.bundle
    const skillBundle = skill.status === "taken" ? skill.bundle : (availableSkill ?? null)
    if (skillBundle && !skillBundleMatchesSession(skillBundle, sessionID, session.report.root)) {
      availableSkill = undefined
      return blockedPrepare("skill_context_unavailable")
    }
    if (skillBundle && providerID !== "anthropic") return blockedPrepare("skill_context_unavailable")
    const preparedRequest = buildRequest(
      adapter,
      catalogAuthority,
      result,
      modelID,
      userText,
      skillBundle,
      [...conversation],
      sessionID,
    )
    if (!preparedRequest) return blockedPrepare("input_rejected")
    const credential = await dependencies.credentialBroker.issueForSession(sessionID, { providerID, credentialProfile })
    if (!credential.ok) return blockedPrepare("credential_unavailable")
    if (!grantMatchesAdapter(credential.grant, adapter)) {
      revokeCredential(dependencies.credentialBroker, credential.grant)
      return blockedPrepare("credential_unavailable")
    }
    const request = preparedRequest.request

    try {
      const proposalID = uuid()
      const operationID = uuid()
      const createdAt = new Date(now()).toISOString()
      const facts = operationFacts(
        session,
        state,
        request,
        credential.grant,
        operationID,
        uuid(),
        modelID,
        adapter,
        durableConversation.historyDigest,
        createdAt,
      )
      const skillContext = skillBundle ? publicSkillContext(skillBundle) : null
      const contextBindingDigest = skillContext ? computeProviderSkillContextBindingDigest(skillContext) : null
      if (preparedRequest.contextBindingDigest !== contextBindingDigest) {
        revokeCredential(dependencies.credentialBroker, credential.grant)
        return blockedPrepare("input_rejected")
      }
      const providerCapabilityDigest = makeProviderTurnOperationFacts(facts).capabilityDigest
      const preview: ProviderTurnPreview = Object.freeze({
        proposalID,
        operationID,
        providerID: adapter.providerID,
        modelID,
        adapter: {
          adapterID: adapter.adapterID,
          adapterDigest: adapter.adapterDigest,
          assurance: "CERTIFIED" as const,
        },
        destination: request.destination,
        logicalPayload: {
          digest: request.evidence.requestDigest,
          bytes: request.evidence.requestBytes,
          contextBindingDigest,
        },
        conversation: {
          priorTurns: conversation.length,
          historyBytes,
          historyDigest: durableConversation.historyDigest,
          retention: providerConversationRetentionLabel,
        },
        providerCapabilityDigest,
        skillContext,
        headerNames: [...facts.plan.wireRequest.headerNames],
        credential: {
          profile: adapter.credentialProfile,
          accountFingerprint: credential.grant.accountFingerprint,
          headerName: adapter.credential.headerName,
        },
        expiresAt: new Date(credential.grant.expiresAt).toISOString(),
        hostBoundaryLabel: providerHostExecutionBoundaryLabel,
        networkBoundaryLabel: providerNetworkExecutionBoundaryLabel,
        assurance: "NOT VERIFIED",
      })
      pending = {
        proposalID,
        operationID,
        facts,
        request,
        adapter,
        parseResponse: preparedRequest.parseResponse,
        grant: credential.grant,
        preview,
        skillBundle,
        userText,
        priorHistoryDigest: durableConversation.historyDigest,
      }
      if (skillBundle) availableSkill = undefined
      prepared += 1
      return { status: "prepared", preview }
    } catch (cause) {
      revokeCredential(dependencies.credentialBroker, credential.grant)
      throw cause
    }
  }

  const decide = async (
    proposalID: string,
    decision: "approve" | "reject",
    onProgress: (progress: PublicProgress) => void,
  ): Promise<PublicDecisionResult> => {
    if (deciding) return blockedDecision(proposalID, "control_busy")
    if (consumed.has(proposalID)) return blockedDecision(proposalID, "proposal_replayed")
    if (!pending || pending.proposalID !== proposalID) return blockedDecision(proposalID, "proposal_unknown")
    const proposal = pending
    pending = undefined
    consumed.add(proposalID)
    if (now() >= proposal.grant.expiresAt) {
      revokeCredential(dependencies.credentialBroker, proposal.grant)
      prepared -= 1
      availableSkill = releaseSkillBundle(availableSkill, proposal.skillBundle)
      return blockedDecision(proposalID, "proposal_expired")
    }

    deciding = true
    const progress = (status: PublicProgress["status"]) =>
      onProgress({ proposalID, operationID: proposal.operationID, status })
    progress("recording_authority")
    let responseObserved = false
    try {
      const result = await execute(
        proposal.facts,
        async () => {
          progress("authority_claimed")
          const credential = dependencies.credentialBroker.takeForParentTransport({
            credentialHandle: proposal.grant.credentialHandle,
            sessionID: proposal.grant.sessionID,
          })
          if (!credential.ok) throw new Error("Parent provider credential is unavailable")
          if (!transportCredentialMatchesAdapter(credential.credential, proposal.grant, proposal.adapter)) {
            throw new Error("Parent provider credential binding changed")
          }
          return {
            body: proposal.request.privateWireBody,
            headers: [...proposal.request.headers, ...(credential.credential.additionalHeaders ?? [])].toSorted(
              ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
            ),
            credential: {
              handle: proposal.grant.credentialHandle,
              accountFingerprint: credential.credential.accountFingerprint,
              value: credential.credential.headerValue,
            },
          } satisfies TrustedProviderWireValues
        },
        (response) => {
          const parsed = proposal.parseResponse(response)
          responseObserved = true
          progress("response_observed_not_verified")
          return parsed
        },
        {
          mode: "production_https",
          requestApproval: async (runtimePreview) => {
            if (!previewMatches(proposal, runtimePreview)) throw new Error("Provider preview binding changed")
            const currentConversation = await dependencies.conversationHistory.load()
            if (currentConversation.historyDigest !== proposal.priorHistoryDigest) {
              throw new Error("Provider conversation changed after consent preview")
            }
            return decision
          },
          onNetworkDispatch: () => progress("network_dispatch"),
        },
      )
      if (result.status === "response_observed_not_verified" && result.response && result.receiptID) {
        if (!responseObserved) return reconciliation(proposal, result.receiptID)
        const operation = makeProviderTurnOperationFacts(proposal.facts)
        const turn: AstraProviderConversationTurn = {
          turnID: proposal.facts.plan.messageID,
          operationID: proposal.operationID,
          receiptID: result.receiptID,
          providerID: proposal.facts.plan.providerID,
          modelID: proposal.facts.plan.modelID,
          adapterDigest: providerHistoryDigest(proposal.adapter.adapterDigest),
          credentialProfile: proposal.adapter.credentialProfile,
          accountFingerprint: providerHistoryDigest(proposal.grant.accountFingerprint),
          destination: proposal.request.destination,
          contextDigest: preparedContextDigest(proposal.request) ?? fixedProviderContextDigest,
          requestBodyDigest: proposal.request.evidence.requestDigest,
          requestBytes: proposal.request.evidence.requestBytes,
          workspaceBaselineDigest: providerHistoryDigest(operation.baselineTrustDigest),
          gitBaselineDigest: operation.repositorySnapshotDigest
            ? providerHistoryDigest(operation.repositorySnapshotDigest)
            : null,
          userText: proposal.userText,
          assistantText: result.response.assistantText,
          assistantTextDigest: providerHistoryDigest(result.response.assistantTextDigest),
          assistantTextBytes: result.response.assistantTextBytes,
          finishReason: result.response.finishReason,
          assurance: "observed_not_verified",
        }
        const persisted = await dependencies.conversationHistory
          .append(proposal.priorHistoryDigest, turn, new Date(now()).toISOString())
          .catch(() => null)
        if (
          !persisted ||
          persisted.turns.at(-1)?.turnID !== turn.turnID ||
          persisted.historyDigest === proposal.priorHistoryDigest
        ) {
          return reconciliation(proposal, result.receiptID)
        }
        progress("receipt_acknowledged")
      }
      if (result.status === "denied_without_effect") prepared -= 1
      if (decision === "reject" && result.status === "denied_without_effect") {
        availableSkill = releaseSkillBundle(availableSkill, proposal.skillBundle)
      }
      if (decision === "approve" && result.status === "denied_without_effect") {
        return reconciliation(proposal, result.receiptID)
      }
      return mapDecisionResult(proposal, result)
    } catch {
      if (decision === "approve") return reconciliation(proposal, null)
      prepared -= 1
      return blockedDecision(proposalID, "control_failed")
    } finally {
      revokeCredential(dependencies.credentialBroker, proposal.grant)
      deciding = false
    }
  }

  return Object.freeze({ catalog, prepare, decide })
}

const fixedProviderContextDigest = `sha256:${Bun.CryptoHasher.hash(
  "sha256",
  "astra-provider-context:fixed-system:v1",
  "hex",
)}` as const

function providerHistoryDigest(input: string): `sha256:${string}` {
  if (!isProviderHistoryDigest(input)) throw new Error("Provider evidence digest is invalid")
  return input
}

function isProviderHistoryDigest(input: string): input is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(input)
}

function revokeCredential(broker: ParentProviderCredentialBroker, grant: ProviderCredentialGrant) {
  broker.revoke({
    credentialHandle: grant.credentialHandle,
    sessionID: grant.sessionID,
  })
}

function grantMatchesAdapter(grant: ProviderCredentialGrant, adapter: CertifiedProviderAdapter) {
  const profile =
    grant.credentialProfile ??
    (grant.providerID === "anthropic" && grant.headerName === "x-api-key" ? "anthropic-api-key" : null)
  if (
    grant.providerID !== adapter.providerID ||
    profile !== adapter.credentialProfile ||
    grant.headerName !== adapter.credential.headerName
  ) {
    return false
  }
  if (adapter.providerID === "anthropic") return (grant.additionalHeaderNames ?? []).length === 0
  if (!grant.additionalHeaderNames) return false
  const allowed = adapter.credential.accountHeaderName ? [adapter.credential.accountHeaderName] : []
  return (
    grant.additionalHeaderNames.every((name) => (allowed as ReadonlyArray<string>).includes(name)) &&
    new Set(grant.additionalHeaderNames).size === grant.additionalHeaderNames.length
  )
}

function transportCredentialMatchesAdapter(
  credential: Extract<ReturnType<ParentProviderCredentialBroker["takeForParentTransport"]>, { ok: true }>["credential"],
  grant: ProviderCredentialGrant,
  adapter: CertifiedProviderAdapter,
) {
  const profile =
    credential.credentialProfile ??
    (credential.providerID === "anthropic" && credential.headerName === "x-api-key" ? "anthropic-api-key" : null)
  const names = (credential.additionalHeaders ?? []).map(([name]) => name)
  return (
    credential.providerID === adapter.providerID &&
    profile === adapter.credentialProfile &&
    credential.headerName === adapter.credential.headerName &&
    credential.accountFingerprint === grant.accountFingerprint &&
    names.length === (grant.additionalHeaderNames ?? []).length &&
    names.every((name, index) => name === grant.additionalHeaderNames?.[index])
  )
}

function preparedContextDigest(request: ProviderWireRequest) {
  return "skillContextBindingDigest" in request.evidence ? request.evidence.skillContextBindingDigest : null
}

function validatedModelCatalog(
  authority: AnthropicCatalogAuthority,
  result: Extract<ProviderCatalogResult, { ok: true }>,
) {
  const catalog = result.catalog.providers.find((provider) => provider.providerID === "anthropic")
  if (!catalog) throw new Error("The certified Anthropic catalog is unavailable")
  return sealValidatedAnthropicModelCatalog(authority, {
    modelIDs: catalog.models.map((model) => model.id),
    validationSourceDigest: catalog.provenance.providerContentDigest,
  })
}

function buildRequest(
  adapter: CertifiedProviderAdapter,
  authority: AnthropicCatalogAuthority,
  catalogResult: Extract<ProviderCatalogResult, { ok: true }>,
  modelID: string,
  userText: string,
  skillBundle: TrustedPromptSkillBundle | null,
  conversationTurns: ReadonlyArray<AnthropicConversationTurn>,
  sessionID: string,
) {
  try {
    if (adapter.providerID === "anthropic") {
      const catalog = validatedModelCatalog(authority, catalogResult)
      const request = buildAnthropicOneTurnRequest({
        catalogAuthority: authority,
        catalog,
        modelID,
        userText,
        maxTokens,
        conversationTurns,
        ...(skillBundle
          ? {
              skillContext: {
                activationOperationID: skillBundle.operationID,
                activationCapabilityDigest: skillBundle.capabilityDigest,
                name: skillBundle.skill.name,
                provenance: skillBundle.source.provenance,
                instructions: skillBundle.skill.instructions,
                instructionsDigest: skillBundle.source.instructionsDigest,
                trust: skillBundle.skill.trust,
                resourceDiscovery: skillBundle.skill.resourceDiscovery,
                assurance: skillBundle.assurance,
              },
            }
          : {}),
      })
      return {
        request,
        contextBindingDigest: request.evidence.skillContextBindingDigest,
        parseResponse: parseAnthropicOneTurnResponse,
      }
    }
    const request = buildOpenAIResponsesOneTurnRequest({
      adapter,
      modelID,
      userText,
      maxOutputTokens: maxTokens,
      sessionID,
      userAgent: `astra/local (${process.platform}; ${process.arch})`,
      conversationTurns,
    })
    return {
      request,
      contextBindingDigest: null,
      parseResponse: parseOpenAIResponsesOneTurnResponse,
    }
  } catch {
    return undefined
  }
}

function operationFacts(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  request: ProviderWireRequest,
  grant: ProviderCredentialGrant,
  operationID: string,
  messageID: string,
  modelID: string,
  adapter: CertifiedProviderAdapter,
  historyDigest: `sha256:${string}`,
  createdAt: string,
): ExecuteProviderTurnInput {
  return {
    ledgerFilename: state.ledgerFilename,
    spoolFilename: state.spoolFilename,
    plan: {
      operationID,
      workspaceRoot: session.report.root,
      sessionID: grant.sessionID,
      messageID,
      providerID: adapter.providerID,
      modelID,
      variant: null,
      adapter: {
        adapterID: adapter.adapterID,
        adapterDigest: adapter.adapterDigest,
      },
      origin: request.destination.origin,
      transportPolicy: "https_only",
      networkPolicy: {
        mode: "https_public_pinned",
        hostname: new URL(request.destination.origin).hostname,
        port: Number(new URL(request.destination.origin).port || 443),
        dnsPolicyDigest: providerTurnPublicDnsPolicyDigest,
        resolverImplementationDigest: providerTurnResolverImplementationDigest,
        transportImplementationDigest: providerTurnTransportImplementationDigest,
      },
      credential: {
        profile: adapter.credentialProfile,
        handle: grant.credentialHandle,
        accountFingerprint: grant.accountFingerprint,
        headerName: grant.headerName,
      },
      wireRequest: {
        method: "POST",
        path: request.destination.path,
        headerNames: [
          ...request.headers.map(([name]) => name),
          ...(grant.additionalHeaderNames ?? []),
          grant.headerName,
        ].toSorted(),
        timeoutMilliseconds: requestTimeoutMilliseconds,
        maximumResponseBytes,
      },
      logicalPayload: {
        digest: request.evidence.requestDigest,
        bytes: request.evidence.requestBytes,
        contextBindingDigest: preparedContextDigest(request),
        historyDigest,
      },
      executionBoundary: "network_egress_host_no_sandbox",
      createdAt,
    },
    report: session.report,
    ...(session.repositoryBaseline ? { repositoryBaseline: session.repositoryBaseline } : {}),
    policyAskedAt: createdAt,
    recordingStartedAt: createdAt,
  }
}

function mapDecisionResult(proposal: PendingTurn, result: DurableProviderTurnResult): PublicDecisionResult {
  if (result.status === "denied_without_effect") {
    return {
      proposalID: proposal.proposalID,
      operationID: proposal.operationID,
      status: "denied_without_effect",
      receiptID: null,
    }
  }
  if (result.status === "response_observed_not_verified" && result.response && result.receiptID) {
    return {
      proposalID: proposal.proposalID,
      operationID: proposal.operationID,
      status: "response_observed_not_verified",
      receiptID: result.receiptID,
      completionLabel: providerObservedCompletionLabel,
      response: result.response,
    }
  }
  return reconciliation(proposal, result.receiptID)
}

function reconciliation(proposal: PendingTurn, receiptID: string | null): PublicDecisionResult {
  return {
    proposalID: proposal.proposalID,
    operationID: proposal.operationID,
    status: "reconciliation_required",
    receiptID,
    reason: "effect_unknown",
  }
}

function previewMatches(
  proposal: PendingTurn,
  runtime: Parameters<Parameters<typeof executeProviderTurnWithTrustedObservedTransport>[3]["requestApproval"]>[0],
) {
  const facts = makeProviderTurnOperationFacts(proposal.facts)
  const expectedContextBinding = proposal.preview.skillContext
    ? computeProviderSkillContextBindingDigest(proposal.preview.skillContext)
    : null
  return (
    runtime.workspace.canonicalPath === proposal.facts.report.root &&
    runtime.session.sessionID === proposal.grant.sessionID &&
    runtime.provider.providerID === proposal.adapter.providerID &&
    runtime.provider.modelID === proposal.preview.modelID &&
    runtime.provider.adapterID === proposal.preview.adapter.adapterID &&
    runtime.provider.adapterDigest === proposal.preview.adapter.adapterDigest &&
    runtime.provider.origin === proposal.preview.destination.origin &&
    runtime.wireRequest.path === proposal.preview.destination.path &&
    runtime.logicalPayload.digest === proposal.preview.logicalPayload.digest &&
    runtime.logicalPayload.bytes === proposal.preview.logicalPayload.bytes &&
    runtime.logicalPayload.contextBindingDigest === proposal.preview.logicalPayload.contextBindingDigest &&
    runtime.logicalPayload.historyDigest === proposal.preview.conversation.historyDigest &&
    proposal.preview.logicalPayload.contextBindingDigest === expectedContextBinding &&
    preparedContextDigest(proposal.request) === expectedContextBinding &&
    facts.capabilityDigest === proposal.preview.providerCapabilityDigest &&
    runtime.credential.profile === proposal.preview.credential.profile &&
    runtime.credential.accountFingerprint === proposal.preview.credential.accountFingerprint
  )
}

async function takeAvailableSkill(
  source: Pick<AstraSkillActivationControl, "takePromptBundle"> | undefined,
  available: TrustedPromptSkillBundle | undefined,
): Promise<PromptSkillBundleTakeResult> {
  if (available) return { status: "taken", bundle: available }
  if (!source) return { status: "none" }
  return source.takePromptBundle().catch(() => ({ status: "blocked", reason: "bundle_unavailable" }))
}

function releaseSkillBundle(
  available: TrustedPromptSkillBundle | undefined,
  reserved: TrustedPromptSkillBundle | null,
) {
  return available ?? reserved ?? undefined
}

function skillBundleMatchesSession(bundle: TrustedPromptSkillBundle, sessionID: string, workspaceRoot: string) {
  return bundle.session.sessionID === sessionID && bundle.session.workspaceRoot === workspaceRoot
}

function publicSkillContext(bundle: TrustedPromptSkillBundle): ProviderTurnSkillContext {
  return Object.freeze({
    kind: "activated_skill",
    activationOperationID: bundle.operationID,
    activationCapabilityDigest: bundle.capabilityDigest,
    name: bundle.skill.name,
    provenance: bundle.source.provenance,
    instructionsDigest: bundle.source.instructionsDigest,
    trust: providerSkillInstructionTrustLabel,
    resourceDiscovery: "none",
    assurance: providerSkillInstructionAssuranceLabel,
    disclosure: "included_in_provider_request",
  })
}

function publicCatalog(input: Extract<ProviderCatalogResult, { ok: true }>["catalog"]): ProviderControlCatalog {
  return {
    providers: input.providers.map((provider) => ({
      providerID: provider.providerID,
      providerName: provider.providerName,
      assurance: provider.assurance,
      dispatchable: provider.dispatchable,
      credentialProfiles: [...provider.credentialProfiles],
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        limits: { ...model.limits },
      })),
    })),
  }
}

function publicTranscript(input: AstraProviderConversation): ProviderConversationTranscript {
  return Object.freeze({
    turns: Object.freeze(
      input.turns.map((turn) =>
        Object.freeze({
          providerID: turn.providerID,
          modelID: turn.modelID,
          userText: turn.userText,
          assistantText: turn.assistantText,
          finishReason: turn.finishReason,
          assurance: "observed_not_verified" as const,
        }),
      ),
    ),
    historyDigest: input.historyDigest,
    totalBytes: input.totalBytes,
    retention: providerConversationRetentionLabel,
  })
}

function blockedPrepare(reason: Extract<PublicPrepareResult, { status: "blocked" }>["reason"]): PublicPrepareResult {
  return { status: "blocked", reason }
}

function blockedDecision(
  proposalID: string,
  reason: Extract<PublicDecisionResult, { status: "blocked" }>["reason"],
): PublicDecisionResult {
  return { proposalID, status: "blocked", reason }
}
