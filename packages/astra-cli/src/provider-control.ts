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
  type ProviderTurnSkillContext,
  type ProviderTurnDecisionResult,
  type ProviderTurnPrepareResult,
  type ProviderTurnPreview,
  type ProviderTurnProgress,
} from "@astra/domain/provider-control"
import type { AstraProviderConversationTurn } from "@astra/domain/work-session"
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
  type ValidatedAnthropicModelCatalog,
} from "@astra/runtime/anthropic-one-turn"
import {
  providerTurnPublicDnsPolicyDigest,
  providerTurnResolverImplementationDigest,
  providerTurnTransportImplementationDigest,
} from "@astra/runtime/provider-turn-network-policy"
import type { DurableProviderTurnResult, ExecuteProviderTurnInput } from "@astra/runtime/provider-turn-coordinator"
import {
  makeProviderTurnOperationFacts,
  providerTurnAdapterDigest,
} from "@astra/runtime/provider-turn-operation-facts"
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
  request: AnthropicOneTurnRequest
  grant: ProviderCredentialGrant
  preview: ProviderTurnPreview
  skillBundle: TrustedPromptSkillBundle | null
  userText: string
  priorHistoryDigest: `sha256:${string}`
}>

export type AstraProviderControl = Readonly<{
  catalog: () =>
    | Readonly<{ status: "available"; catalog: ProviderControlCatalog }>
    | Readonly<{
        status: "unavailable"
        reason: "catalog_unavailable"
      }>
  prepare: (modelID: string, userText: string) => Promise<PublicPrepareResult>
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

/** Parent-only owner for one consent-bound Anthropic proposal backed by durable history. */
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

  const catalog = () => {
    const result = dependencies.readCatalog()
    if (!result.ok) return { status: "unavailable" as const, reason: "catalog_unavailable" as const }
    return { status: "available" as const, catalog: publicCatalog(result.catalog) }
  }

  const prepare = async (modelID: string, userText: string): Promise<PublicPrepareResult> => {
    if (session.mode !== "activate-once") return blockedPrepare("read_only")
    if (deciding || pending) return blockedPrepare("control_busy")
    if (prepared >= maximumPreparedOperations) return blockedPrepare("control_limit_reached")
    const result = dependencies.readCatalog()
    if (!result.ok) return blockedPrepare("catalog_unavailable")
    if (!result.catalog.models.some((model) => model.id === modelID)) return blockedPrepare("model_rejected")
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

    const validatedCatalog = validatedModelCatalog(catalogAuthority, result)
    const skill = await takeAvailableSkill(dependencies.skillBundleSource, availableSkill)
    if (skill.status === "blocked") return blockedPrepare("skill_context_unavailable")
    if (skill.status === "taken") availableSkill = skill.bundle
    const skillBundle = skill.status === "taken" ? skill.bundle : (availableSkill ?? null)
    if (skillBundle && !skillBundleMatchesSession(skillBundle, sessionID, session.report.root)) {
      availableSkill = undefined
      return blockedPrepare("skill_context_unavailable")
    }
    const request = buildRequest(catalogAuthority, validatedCatalog, modelID, userText, skillBundle, [...conversation])
    if (!request) return blockedPrepare("input_rejected")
    const credential = await dependencies.credentialBroker.issueForSession(sessionID)
    if (!credential.ok) return blockedPrepare("credential_unavailable")

    try {
      const proposalID = uuid()
      const operationID = uuid()
      const createdAt = new Date(now()).toISOString()
      const facts = operationFacts(session, state, request, credential.grant, operationID, uuid(), modelID, createdAt)
      const skillContext = skillBundle ? publicSkillContext(skillBundle) : null
      const contextBindingDigest = skillContext ? computeProviderSkillContextBindingDigest(skillContext) : null
      if (request.evidence.skillContextBindingDigest !== contextBindingDigest) {
        revokeCredential(dependencies.credentialBroker, credential.grant)
        return blockedPrepare("input_rejected")
      }
      const providerCapabilityDigest = makeProviderTurnOperationFacts(facts).capabilityDigest
      const preview: ProviderTurnPreview = Object.freeze({
        proposalID,
        operationID,
        providerID: "anthropic",
        modelID,
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
          accountFingerprint: credential.grant.accountFingerprint,
          headerName: "x-api-key" as const,
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
          return {
            body: proposal.request.privateWireBody,
            headers: proposal.request.headers,
            credential: {
              handle: proposal.grant.credentialHandle,
              accountFingerprint: credential.credential.accountFingerprint,
              value: credential.credential.headerValue,
            },
          } satisfies TrustedProviderWireValues
        },
        (response) => {
          const parsed = parseTrustedResponse(response)
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
          adapterDigest: providerHistoryDigest(providerTurnAdapterDigest),
          credentialProfile: "anthropic-api-key",
          accountFingerprint: providerHistoryDigest(proposal.grant.accountFingerprint),
          destination: proposal.request.destination,
          contextDigest: proposal.request.evidence.skillContextBindingDigest ?? fixedProviderContextDigest,
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
  if (!/^sha256:[0-9a-f]{64}$/u.test(input)) throw new Error("Provider evidence digest is invalid")
  return input as `sha256:${string}`
}

function revokeCredential(broker: ParentProviderCredentialBroker, grant: ProviderCredentialGrant) {
  broker.revoke({ credentialHandle: grant.credentialHandle, sessionID: grant.sessionID })
}

function validatedModelCatalog(
  authority: AnthropicCatalogAuthority,
  result: Extract<ProviderCatalogResult, { ok: true }>,
) {
  const catalog = publicCatalog(result.catalog)
  return sealValidatedAnthropicModelCatalog(authority, {
    modelIDs: catalog.models.map((model) => model.id),
    validationSourceDigest: result.catalog.provenance.providerContentDigest,
  })
}

function conversationHistoryBytes(turns: ReadonlyArray<AnthropicConversationTurn>) {
  return turns.reduce(
    (bytes, turn) => bytes + Buffer.byteLength(turn.userText, "utf8") + Buffer.byteLength(turn.assistantText, "utf8"),
    0,
  )
}

function buildRequest(
  authority: AnthropicCatalogAuthority,
  catalog: ValidatedAnthropicModelCatalog,
  modelID: string,
  userText: string,
  skillBundle: TrustedPromptSkillBundle | null,
  conversationTurns: ReadonlyArray<AnthropicConversationTurn>,
) {
  try {
    return buildAnthropicOneTurnRequest({
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
  } catch {
    return undefined
  }
}

function operationFacts(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  request: AnthropicOneTurnRequest,
  grant: ProviderCredentialGrant,
  operationID: string,
  messageID: string,
  modelID: string,
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
      providerID: "anthropic",
      modelID,
      variant: null,
      origin: request.destination.origin,
      transportPolicy: "https_only",
      networkPolicy: {
        mode: "https_public_pinned",
        hostname: "api.anthropic.com",
        port: 443,
        dnsPolicyDigest: providerTurnPublicDnsPolicyDigest,
        resolverImplementationDigest: providerTurnResolverImplementationDigest,
        transportImplementationDigest: providerTurnTransportImplementationDigest,
      },
      credential: {
        handle: grant.credentialHandle,
        accountFingerprint: grant.accountFingerprint,
        headerName: grant.headerName,
      },
      wireRequest: {
        method: "POST",
        path: request.destination.path,
        headerNames: ["anthropic-version", "content-type", "x-api-key"],
        timeoutMilliseconds: requestTimeoutMilliseconds,
        maximumResponseBytes,
      },
      logicalPayload: {
        digest: request.evidence.requestDigest,
        bytes: request.evidence.requestBytes,
        contextBindingDigest: request.evidence.skillContextBindingDigest,
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

function parseTrustedResponse(response: TrustedObservedProviderRawResponse): TrustedObservedProviderCompletion {
  return parseAnthropicOneTurnResponse(response)
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
    runtime.provider.providerID === "anthropic" &&
    runtime.provider.modelID === proposal.preview.modelID &&
    runtime.provider.origin === proposal.preview.destination.origin &&
    runtime.wireRequest.path === proposal.preview.destination.path &&
    runtime.logicalPayload.digest === proposal.preview.logicalPayload.digest &&
    runtime.logicalPayload.bytes === proposal.preview.logicalPayload.bytes &&
    runtime.logicalPayload.contextBindingDigest === proposal.preview.logicalPayload.contextBindingDigest &&
    proposal.preview.logicalPayload.contextBindingDigest === expectedContextBinding &&
    proposal.request.evidence.skillContextBindingDigest === expectedContextBinding &&
    facts.capabilityDigest === proposal.preview.providerCapabilityDigest &&
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
    providerID: "anthropic",
    providerName: input.providerName,
    models: input.models.map((model) => ({
      id: model.id,
      name: model.name,
      limits: { ...model.limits },
    })),
  }
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
