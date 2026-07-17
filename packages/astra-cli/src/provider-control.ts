import { randomUUID } from "node:crypto"
import {
  providerHostExecutionBoundaryLabel,
  providerNetworkExecutionBoundaryLabel,
  providerObservedCompletionLabel,
  type ProviderControlCatalog,
  type ProviderTurnDecisionResult,
  type ProviderTurnPrepareResult,
  type ProviderTurnPreview,
  type ProviderTurnProgress,
} from "@astra/domain/provider-control"
import {
  buildAnthropicOneTurnRequest,
  createAnthropicCatalogAuthority,
  parseAnthropicOneTurnResponse,
  sealValidatedAnthropicModelCatalog,
  type AnthropicCatalogAuthority,
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
  executeProviderTurnWithTrustedObservedTransport,
  type TrustedObservedProviderCompletion,
  type TrustedObservedProviderRawResponse,
  type TrustedProviderWireValues,
} from "@astra/runtime/provider-turn-transport"
import type { AstraWorkspaceSessionResult } from "./workspace-session"
import type {
  ParentProviderCredentialBroker,
  ProviderCredentialGrant,
} from "./provider-credential-broker"
import type { ProviderCatalogResult } from "./provider-catalog"

const maximumPreparedOperations = 4
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
}>

export type AstraProviderControl = Readonly<{
  catalog: () => Readonly<{ status: "available"; catalog: ProviderControlCatalog }> | Readonly<{
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
  execute?: typeof executeProviderTurnWithTrustedObservedTransport
  createCatalogAuthority?: () => AnthropicCatalogAuthority
  now?: () => number
  randomUUID?: () => string
}>

/** Parent-only owner for one in-memory, one-turn Anthropic proposal. */
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

    const validatedCatalog = validatedModelCatalog(catalogAuthority, result)
    const request = buildRequest(catalogAuthority, validatedCatalog, modelID, userText)
    if (!request) return blockedPrepare("input_rejected")
    const credential = await dependencies.credentialBroker.issueForSession(sessionID)
    if (!credential.ok) return blockedPrepare("credential_unavailable")

    const proposalID = uuid()
    const operationID = uuid()
    const createdAt = new Date(now()).toISOString()
    const facts = operationFacts(session, state, request, credential.grant, operationID, uuid(), modelID, createdAt)
    const preview: ProviderTurnPreview = Object.freeze({
      proposalID,
      operationID,
      providerID: "anthropic",
      modelID,
      destination: request.destination,
      logicalPayload: { digest: request.evidence.requestDigest, bytes: request.evidence.requestBytes },
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
    pending = { proposalID, operationID, facts, request, grant: credential.grant, preview }
    prepared += 1
    return { status: "prepared", preview }
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
    if (now() >= proposal.grant.expiresAt) return blockedDecision(proposalID, "proposal_expired")

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
            return decision
          },
          onNetworkDispatch: () => progress("network_dispatch"),
        },
      )
      if (result.status === "response_observed_not_verified" && result.response && result.receiptID) {
        if (!responseObserved) return reconciliation(proposal, result.receiptID)
        progress("receipt_acknowledged")
      }
      return mapDecisionResult(proposal, result)
    } catch {
      if (decision === "approve") return reconciliation(proposal, null)
      return blockedDecision(proposalID, "control_failed")
    } finally {
      deciding = false
    }
  }

  return Object.freeze({ catalog, prepare, decide })
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

function buildRequest(
  authority: AnthropicCatalogAuthority,
  catalog: ValidatedAnthropicModelCatalog,
  modelID: string,
  userText: string,
) {
  try {
    return buildAnthropicOneTurnRequest({
      catalogAuthority: authority,
      catalog,
      modelID,
      userText,
      maxTokens,
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
      logicalPayload: { digest: request.evidence.requestDigest, bytes: request.evidence.requestBytes },
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
  return (
    runtime.workspace.canonicalPath === proposal.facts.report.root &&
    runtime.session.sessionID === proposal.grant.sessionID &&
    runtime.provider.providerID === "anthropic" &&
    runtime.provider.modelID === proposal.preview.modelID &&
    runtime.provider.origin === proposal.preview.destination.origin &&
    runtime.wireRequest.path === proposal.preview.destination.path &&
    runtime.logicalPayload.digest === proposal.preview.logicalPayload.digest &&
    runtime.logicalPayload.bytes === proposal.preview.logicalPayload.bytes &&
    runtime.credential.accountFingerprint === proposal.preview.credential.accountFingerprint
  )
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
