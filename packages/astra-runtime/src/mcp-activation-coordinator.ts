import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import {
  computeMcpActivationCapabilityDigest,
  isAllowedMcpActivationEndpoint,
  mcpActivationBoundaryLabel,
  mcpActivationLeaseMilliseconds,
  mcpActivationNetworkLabel,
  mcpActivationRequestBudget,
  parseMcpActivationProposal,
  type McpActivationProposal,
} from "@astra/domain/mcp-activation"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseDispatchRequest,
  parseDispatchRequestID,
  parseExecutorClaimID,
  parseOperationEffectUncertainty,
  parseOperationID,
  parseOperationReceipt,
  parseReceiptID,
  type ActorRef,
  type ContentDigest,
  type OperationEffectUncertainty,
  type OperationID,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { AppendOperationEvent, OperationEventDraft, OperationRecord } from "@astra/ledger"
import { Effect } from "effect"
import type { ParentPrivateMcpCandidate } from "./extension-inventory-operation"
import { canonicalJson, deterministicUUID, digest, makeControlledWriteBaselineAuthority } from "./controlled-write-authority"
import {
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithCoordinatorReceiptSpool,
  runWithLedger,
  runWithReceiptSpool,
} from "./operation-storage"

const minimumEffectLeaseMilliseconds = 5_000
const maximumSourceBytes = 256 * 1024
const policyDigest = digest("astra-policy:mcp-activation-explicit-consent:v1")
const adapterDigest = digest("astra-runtime:mcp-controlled-remote-session:v1")
const observerDigest = digest("astra-observer:mcp-catalog-and-close:v1")
const executor = "astra-executor:mcp-controlled-remote-session"

export type { ParentPrivateMcpCandidate } from "./extension-inventory-operation"

export type McpActivationTrustedSession = Readonly<{
  mode: "activate-once"
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
}>

export type ProposeMcpActivationInput = Readonly<{
  operationID: string
  policyAskedAt: string
  session: McpActivationTrustedSession
  candidate: ParentPrivateMcpCandidate
}>

export type McpActivationConsent =
  | Readonly<{ decision: "approved"; decidedAt: string }>
  | Readonly<{ decision: "rejected"; decidedAt: string; reason?: "user_rejected" }>

export type ExecuteMcpActivationInput = ProposeMcpActivationInput &
  Readonly<{
    proposal: McpActivationProposal
    consent: McpActivationConsent
    recordingStartedAt: string
    ledgerFilename: string
    spoolFilename: string
  }>

export type ObservedMcpCatalogEntry = Readonly<{
  name: string
  description: string | null
  inputSchemaDigest: ContentDigest
}>

export type McpActivationAdapter = Readonly<{
  descriptor: "astra-opencode:controlled-remote-mcp:v1"
  connect: (input: Readonly<{ endpoint: string; leaseExpiresAt: string; signal: AbortSignal }>) => Promise<
    Readonly<{
      protocolVersion: string
      server: Readonly<{ name: string; version: string }>
      catalog: ReadonlyArray<ObservedMcpCatalogEntry>
      instructionsWithheld: true
      close: () => Promise<void>
    }>
  >
}>

export type McpActivationSessionGate = Readonly<{
  acquire: (operationID: string) => boolean
  release: (operationID: string) => void
  quarantine: (operationID: string) => void
}>

export type McpActivationDependencies = Readonly<{
  sessionGate: McpActivationSessionGate
  adapter: McpActivationAdapter
  awaitStop: (active: Readonly<{ operationID: string; catalogCount: number; leaseExpiresAt: string }>) => Promise<
    "explicit" | "session_close"
  >
  now?: () => number
  onClaimPersisted?: () => void
  onSourceRevalidated?: () => void
  onActive?: (active: Readonly<{ operationID: string; catalogCount: number; leaseExpiresAt: string }>) => void
  abortSignal?: AbortSignal
}>

export type DurableMcpActivationResult = Readonly<{
  operationID: string
  state: "denied" | "completed" | "failed" | "reconciliation_required"
  status:
    | "denied_without_effect"
    | "completed_observed_not_verified"
    | "candidate_stale"
    | "effect_unknown"
  sequence: number
  lastCursor: number
  receiptID: string | null
  catalogCount: number | null
  boundaryLabel: typeof mcpActivationBoundaryLabel
  networkLabel: typeof mcpActivationNetworkLabel
}>

export class McpActivationCoordinationError extends Error {
  readonly _tag = "McpActivationCoordinationError"

  constructor(
    readonly code:
      | "invalid_input"
      | "candidate_ineligible"
      | "server_limit_reached"
      | "state_unavailable"
      | "recovery_unavailable",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

export function createMcpActivationSessionGate(): McpActivationSessionGate {
  let owner: string | null = null
  let quarantined = false
  return Object.freeze({
    acquire(operationID: string) {
      if (quarantined || (owner !== null && owner !== operationID)) return false
      owner = operationID
      return true
    },
    release(operationID: string) {
      if (!quarantined && owner === operationID) owner = null
    },
    quarantine(operationID: string) {
      if (owner === operationID) quarantined = true
    },
  })
}

/** Builds the complete public preview without reading the source or using DNS. */
export function proposeMcpActivation(input: ProposeMcpActivationInput): McpActivationProposal {
  requireProposalInput(input)
  const endpoint = eligibleEndpoint(input.candidate)
  const withoutDigest = {
    schemaVersion: 1,
    operationID: input.operationID,
    policyAskedAt: input.policyAskedAt,
    authorizationExpiresAt: new Date(Date.parse(input.policyAskedAt) + mcpActivationLeaseMilliseconds).toISOString(),
    leaseExpiresAt: new Date(Date.parse(input.policyAskedAt) + mcpActivationLeaseMilliseconds).toISOString(),
    session: { mode: "activate-once", trust: "trusted_once" },
    candidate: {
      candidateID: input.candidate.candidateID,
      displayName: `MCP candidate ${input.candidate.candidateID.slice(7, 15)}`,
      sourcePath: input.candidate.sourcePath,
      transport: "streamable_http",
      endpoint,
    },
    boundary: "host_no_sandbox",
    boundaryLabel: mcpActivationBoundaryLabel,
    networkLabel: mcpActivationNetworkLabel,
    requestBudget: mcpActivationRequestBudget,
    guarantees: {
      credentials: "none",
      workspaceRootShared: "none",
      redirects: "forbidden",
      retries: "none",
      reconnect: "none",
      proxyEnvironment: "ignored",
      instructions: "untrusted_withheld",
      prompts: "not_loaded",
      resources: "not_loaded",
      toolInvocation: "forbidden",
      catalog: "bounded_observed_not_verified",
      sourceRevalidation: "device_inode_digest_after_claim",
      stop: "explicit_or_lease_or_session_close",
    },
  } as const
  const proposal = Object.freeze({
    ...withoutDigest,
    capabilityDigest: computeMcpActivationCapabilityDigest(withoutDigest),
  })
  const parsed = parseMcpActivationProposal(proposal)
  if (!parsed.ok) throw new McpActivationCoordinationError("invalid_input", "The MCP activation proposal is invalid")
  return parsed.value
}

/** Executes one no-retry MCP lease after a durable claim. */
export async function executeMcpActivation(
  unsafeInput: ExecuteMcpActivationInput,
  dependencies: McpActivationDependencies,
): Promise<DurableMcpActivationResult> {
  let acquiredOperationID: string | null = null
  let claimPersisted = false
  try {
    const input = deepFreeze(structuredClone(unsafeInput))
    const facts = makeFacts(input)
    await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    if (input.consent.decision === "rejected") return recordDenied(input, facts)

    if (await exists(input.ledgerFilename)) {
      const existing = await readSnapshot(input, facts)
      if (existing.operation) return recoverMcpActivation(input, facts)
    }
    if (dependencies.adapter.descriptor !== "astra-opencode:controlled-remote-mcp:v1") {
      throw new McpActivationCoordinationError("invalid_input", "The controlled MCP adapter identity is invalid")
    }
    if (!dependencies.sessionGate.acquire(facts.operationID)) {
      throw new McpActivationCoordinationError("server_limit_reached", "Only one MCP may be active in this session")
    }
    acquiredOperationID = facts.operationID

    const now = dependencies.now ?? Date.now
    const claimStartedAt = now()
    const claimed = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          yield* ledger.appendBatch(facts.commands)
          return yield* ledger.claimDispatch({
            dispatchRequestID: facts.dispatchRequestID,
            operationID: facts.operationID,
            attemptID: facts.attemptID,
            executor,
            capabilityDigest: facts.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            claimExpiresAt: new Date(Math.min(Date.parse(facts.leaseExpiresAt), Date.parse(facts.authorizationExpiresAt)) - 1).toISOString(),
            event: {
              eventID: facts.eventIDs.claim,
              schemaVersion: 1,
              actor: { kind: "system", subject: executor, componentDigest: adapterDigest },
              correlationID: facts.correlationID,
              redaction: "sensitive_redacted",
              externalBlobDigest: null,
            },
          })
        }),
      () => new Date(claimStartedAt).toISOString(),
    )
    if (claimed.kind !== "claimed") return recoverMcpActivation(input, facts)
    claimPersisted = true
    notify(dependencies.onClaimPersisted)

    const authority = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          return yield* ledger.validateEffectAuthority({
            operationID: facts.operationID,
            dispatchRequestID: facts.dispatchRequestID,
            attemptID: facts.attemptID,
            capabilityGrantID: facts.capabilityGrantID,
            capabilityDigest: facts.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            fencingToken: claimed.claim.fencingToken,
            executor,
            adapterDigest,
            baselineDigest: facts.baselineTrustDigest,
            minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
          })
        }),
      () => new Date(now()).toISOString(),
    )
    if (!authority.allowed) {
      dependencies.sessionGate.quarantine(facts.operationID)
      return recordUncertainty(input, facts, claimed.claim.fencingToken, new Date(now()).toISOString())
    }

    const sourceCurrent = validateCandidateSource(facts.report.root, input.candidate)
    notify(dependencies.onSourceRevalidated)
    if (!sourceCurrent) {
      dependencies.sessionGate.release(facts.operationID)
      return recordReceipt(
        input,
        facts,
        claimed.claim.fencingToken,
        new Date(now()).toISOString(),
        new Date(now()).toISOString(),
        { kind: "candidate_stale" },
      )
    }

    let active: Awaited<ReturnType<McpActivationAdapter["connect"]>>
    const startedAt = new Date(now()).toISOString()
    try {
      active = validateActive(
        await connectBounded(
          dependencies.adapter,
          { endpoint: facts.proposal.candidate.endpoint, leaseExpiresAt: facts.leaseExpiresAt },
          Math.max(1, Date.parse(facts.leaseExpiresAt) - now()),
          dependencies.abortSignal,
        ),
      )
    } catch {
      dependencies.sessionGate.quarantine(facts.operationID)
      return recordReceipt(
        input,
        facts,
        claimed.claim.fencingToken,
        startedAt,
        new Date(now()).toISOString(),
        { kind: "effect_unknown" },
      )
    }
    if (dependencies.abortSignal?.aborted) {
      try {
        await closeBounded(active.close, Math.min(5_000, Math.max(1, Date.parse(facts.leaseExpiresAt) - now())))
      } catch {
        dependencies.sessionGate.quarantine(facts.operationID)
        return recordReceipt(
          input,
          facts,
          claimed.claim.fencingToken,
          startedAt,
          new Date(now()).toISOString(),
          { kind: "effect_unknown" },
        )
      }
      dependencies.sessionGate.release(facts.operationID)
      return recordReceipt(input, facts, claimed.claim.fencingToken, startedAt, new Date(now()).toISOString(), {
        kind: "closed_observed",
        catalog: active.catalog,
        protocolVersion: active.protocolVersion,
        server: active.server,
      })
    }
    const activeView = Object.freeze({
      operationID: facts.operationID,
      catalogCount: active.catalog.length,
      leaseExpiresAt: facts.leaseExpiresAt,
    })
    notifyActive(dependencies.onActive, activeView)
    const remaining = Math.max(0, Date.parse(facts.leaseExpiresAt) - now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const lease = new Promise<"lease_expired">((resolveLease) => {
      timer = setTimeout(() => resolveLease("lease_expired"), remaining)
      timer.unref?.()
    })
    await Promise.race([
      Promise.resolve()
        .then(() => dependencies.awaitStop(activeView))
        .catch(() => "session_close" as const),
      lease,
    ])
    if (timer) clearTimeout(timer)
    try {
      await closeBounded(active.close, Math.min(5_000, Math.max(1, Date.parse(facts.leaseExpiresAt) - now())))
    } catch {
      dependencies.sessionGate.quarantine(facts.operationID)
      return recordReceipt(
        input,
        facts,
        claimed.claim.fencingToken,
        startedAt,
        new Date(now()).toISOString(),
        { kind: "effect_unknown" },
      )
    }
    dependencies.sessionGate.release(facts.operationID)
    return recordReceipt(input, facts, claimed.claim.fencingToken, startedAt, new Date(now()).toISOString(), {
      kind: "closed_observed",
      catalog: active.catalog,
      protocolVersion: active.protocolVersion,
      server: active.server,
    })
  } catch (cause) {
    if (acquiredOperationID) {
      if (claimPersisted) dependencies.sessionGate.quarantine(acquiredOperationID)
      else dependencies.sessionGate.release(acquiredOperationID)
    }
    if (cause instanceof McpActivationCoordinationError) throw cause
    throw new McpActivationCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The MCP activation could not complete its durable path",
      cause,
    )
  }
}

function connectBounded(
  adapter: McpActivationAdapter,
  input: Readonly<{ endpoint: string; leaseExpiresAt: string }>,
  timeoutMilliseconds: number,
  externalSignal?: AbortSignal,
) {
  const controller = new AbortController()
  return new Promise<Awaited<ReturnType<McpActivationAdapter["connect"]>>>((resolveConnect, rejectConnect) => {
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      externalSignal?.removeEventListener("abort", fail)
      controller.abort()
      rejectConnect(new Error("The controlled MCP connection deadline elapsed"))
    }
    const timer = setTimeout(fail, timeoutMilliseconds)
    timer.unref?.()
    if (externalSignal?.aborted) {
      fail()
      return
    }
    externalSignal?.addEventListener("abort", fail, { once: true })
    void Promise.resolve().then(() => adapter.connect({ ...input, signal: controller.signal })).then(
      (active) => {
        if (settled) {
          void active.close().catch(() => undefined)
          return
        }
        settled = true
        clearTimeout(timer)
        externalSignal?.removeEventListener("abort", fail)
        resolveConnect(active)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        externalSignal?.removeEventListener("abort", fail)
        rejectConnect(new Error("The controlled MCP connection failed"))
      },
    )
  })
}

function closeBounded(close: () => Promise<void>, timeoutMilliseconds: number) {
  return new Promise<void>((resolveClose, rejectClose) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      rejectClose(new Error("The controlled MCP close deadline elapsed"))
    }, timeoutMilliseconds)
    timer.unref?.()
    void close().then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveClose()
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectClose(new Error("The controlled MCP close failed"))
      },
    )
  })
}

function notify(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {}
}

function notifyActive(
  callback: McpActivationDependencies["onActive"],
  active: Readonly<{ operationID: string; catalogCount: number; leaseExpiresAt: string }>,
) {
  try {
    callback?.(active)
  } catch {}
}

/** Recovers durable state without source reads, DNS, network, or reconnect. */
export async function recoverMcpActivation(
  input: ExecuteMcpActivationInput,
  suppliedFacts?: ReturnType<typeof makeFacts>,
): Promise<DurableMcpActivationResult> {
  const facts = suppliedFacts ?? makeFacts(deepFreeze(structuredClone(input)))
  await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
  if (await exists(input.spoolFilename)) await ingestPendingReceipt(input, facts)
  const snapshot = await readSnapshot(input, facts)
  if (!snapshot.operation || !snapshot.dispatch) {
    throw new McpActivationCoordinationError("recovery_unavailable", "No durable MCP activation exists")
  }
  requireRecoveryBinding(snapshot.dispatch, facts)
  if (
    snapshot.operation.state === "denied" ||
    snapshot.operation.state === "completed" ||
    snapshot.operation.state === "failed" ||
    snapshot.operation.state === "reconciliation_required"
  ) {
    return durableResult(snapshot.operation, snapshot.dispatch.receipt, null)
  }
  if (!snapshot.dispatch.claim) {
    throw new McpActivationCoordinationError("recovery_unavailable", "The MCP activation was never claimed")
  }
  return recordUncertainty(input, facts, snapshot.dispatch.claim.fencingToken, new Date().toISOString())
}

function eligibleEndpoint(candidate: ParentPrivateMcpCandidate) {
  const config = candidate.config
  if (
    config.type !== "remote" ||
    !isAllowedMcpActivationEndpoint(config.url) ||
    (config.headers && Object.keys(config.headers).length > 0) ||
    (config.oauth !== undefined && config.oauth !== false)
  ) {
    throw new McpActivationCoordinationError(
      "candidate_ineligible",
      "The first controlled MCP slice accepts only credential-free Streamable HTTP remotes",
    )
  }
  return config.url
}

function makeFacts(input: ExecuteMcpActivationInput) {
  requireProposalInput(input)
  const parsed = parseMcpActivationProposal(input.proposal)
  if (!parsed.ok) throw new TypeError("The MCP activation proposal is invalid")
  const expected = proposeMcpActivation(input)
  if (canonicalJson(expected) !== canonicalJson(parsed.value)) throw new TypeError("The MCP preview authority changed")
  requireTimeline(input, expected.authorizationExpiresAt)
  const report = deepFreeze(structuredClone(input.session.report))
  const baselineAuthority = makeControlledWriteBaselineAuthority(report, input.session.repositoryBaseline)
  const operationID = requireOperationID(input.operationID)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const correlationID = deterministicUUID(operationID, "correlation")
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const resources = [
    `workspace:mcp-config#${input.candidate.candidateID}`,
    `network:mcp-endpoint#${digest(expected.candidate.endpoint)}`,
  ] as const
  const baseline = {
    kind: "workspace",
    locationID: `local:${report.root}`,
    workspaceIdentity: report.identity!,
    trustDigest: baselineAuthority.baselineDigest,
    repository: baselineAuthority.repository,
    policyDigest,
    adapterDigest,
  } as const
  const intent = {
    kind: "mcp_activation",
    schemaVersion: 1,
    parameters: {
      candidateID: input.candidate.candidateID,
      endpointDigest: digest(expected.candidate.endpoint),
      requestBudgetDigest: digest(canonicalJson(expected.requestBudget)),
      leaseExpiresAt: expected.leaseExpiresAt,
    },
  } as const
  const completionCriterion = "mcp_closed_after_bounded_catalog_observation"
  const admittedPayload = {
    admissionKey: digest(canonicalJson({ actor, baseline, intent, resources })),
    intent,
    baseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed", "capability_consumed"],
    },
    effectSpecification: {
      effectClass: "provider_turn",
      targetDescriptors: [{ resource: resources[1], mode: "exact_destination_bounded_mcp_lease" }],
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "high",
      classification: "host_network_mcp_no_sandbox",
      rationaleDigest: digest("credential-free exact-destination MCP catalog lease without tool invocation"),
    },
    reversibility: { kind: "compensatable", recoveryIntentKind: "close_remote_mcp_session" },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: "mcp-close-and-catalog-observer", version: "1", digest: observerDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: expected.capabilityDigest }],
    },
  } as const
  const dispatchRequest = requireDispatchRequest({
    dispatchRequestID,
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest: expected.capabilityDigest,
    baselineDigest: baselineAuthority.baselineDigest,
    executor,
    adapterDigest,
    idempotencyKey: digest(canonicalJson({ operationID, capabilityDigest: expected.capabilityDigest })),
    requestedAt: input.recordingStartedAt,
    authorizationExpiresAt: expected.authorizationExpiresAt,
  })
  const eventIDs = {
    admitted: deterministicUUID(operationID, "event:admitted"),
    policy: deterministicUUID(operationID, "event:policy-ask"),
    decision: deterministicUUID(operationID, `event:approval-${input.consent.decision}`),
    dispatch: deterministicUUID(operationID, "event:dispatch-requested"),
    claim: deterministicUUID(operationID, "event:executor-accepted"),
    receipt: deterministicUUID(operationID, "event:receipt"),
    uncertainty: deterministicUUID(operationID, "event:uncertainty"),
  }
  const common = [
    command(null, 0, event(operationID, eventIDs.admitted, "operation.admitted", admittedPayload, input.recordingStartedAt, input.policyAskedAt, actor, correlationID)),
    command(
      "proposed",
      1,
      event(
        operationID,
        eventIDs.policy,
        "policy.ask",
        {
          decisionID,
          ruleID: "mcp-activation-explicit-consent",
          policyDigest,
          previewDigest: digest(canonicalJson(expected)),
          capabilityDigest: expected.capabilityDigest,
          approverClass: "workspace-user",
          expiresAt: expected.authorizationExpiresAt,
        },
        input.recordingStartedAt,
        input.policyAskedAt,
        actor,
        correlationID,
      ),
    ),
  ] as const
  const decision = command(
    "awaiting_approval",
    2,
    event(
      operationID,
      eventIDs.decision,
      input.consent.decision === "approved" ? "approval.granted" : "approval.rejected",
      input.consent.decision === "approved"
        ? {
            decisionID,
            capabilityGrantID,
            capabilityDigest: expected.capabilityDigest,
            attemptID,
            baselineDigest: baselineAuthority.baselineDigest,
            expiresAt: expected.authorizationExpiresAt,
          }
        : { decisionID, reasonCode: input.consent.reason ?? "user_rejected" },
      input.recordingStartedAt,
      input.consent.decidedAt,
      actor,
      correlationID,
      eventIDs.policy,
      input.consent.decision === "approved" ? attemptID : null,
    ),
  )
  const dispatch = command(
    "authorized",
    3,
    event(
      operationID,
      eventIDs.dispatch,
      "dispatch.requested",
      dispatchRequest,
      input.recordingStartedAt,
      input.recordingStartedAt,
      actor,
      correlationID,
      eventIDs.decision,
      attemptID,
    ),
  )
  return {
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest: expected.capabilityDigest,
    dispatchRequestID,
    executorClaimID,
    receiptID,
    correlationID,
    baselineTrustDigest: requireContentDigest(baselineAuthority.baselineDigest),
    authorizationExpiresAt: expected.authorizationExpiresAt,
    leaseExpiresAt: expected.leaseExpiresAt,
    proposal: expected,
    report,
    resources,
    eventIDs,
    commands: input.consent.decision === "approved" ? [...common, decision, dispatch] : [...common, decision],
  }
}

async function recordDenied(input: ExecuteMcpActivationInput, facts: ReturnType<typeof makeFacts>) {
  const operation = await runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const results = yield* ledger.appendBatch(facts.commands)
      return results.at(-1)?.operation ?? null
    }),
  )
  if (!operation || operation.state !== "denied") throw new Error("The MCP denial was not recorded")
  return durableResult(operation, null, null)
}

async function recordReceipt(
  input: ExecuteMcpActivationInput,
  facts: ReturnType<typeof makeFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  observation:
    | Readonly<{ kind: "candidate_stale" }>
    | Readonly<{ kind: "effect_unknown" }>
    | Readonly<{
        kind: "closed_observed"
        catalog: ReadonlyArray<ObservedMcpCatalogEntry>
        protocolVersion: string
        server: Readonly<{ name: string; version: string }>
      }>,
) {
  const observationDigest = digest(canonicalJson(observation))
  const receipt = requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: executor, version: "1", digest: adapterDigest },
    effectClass: "provider_turn",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation:
      observation.kind === "candidate_stale"
        ? { kind: "no_effect_proved", proofDigest: observationDigest }
        : observation.kind === "effect_unknown"
          ? { kind: "effect_unknown", observationDigest }
          : { kind: "effect_completed", completionDigest: observationDigest, assurance: "observed_not_verified" },
    verificationContext:
      observation.kind === "closed_observed"
        ? {
            schemaVersion: 3,
            admittedBaselineDigest: facts.baselineTrustDigest,
            workspaceIdentity: facts.report.identity!,
            executionBoundary: "host_no_sandbox",
            observationDigest,
            limitations: [
              "remote MCP exchange and close were observed but not independently verified",
              "tools were listed but never made invocable",
              "server instructions were withheld",
              "host network execution was not sandboxed",
            ],
          }
        : {
            admittedBaselineDigest: facts.baselineTrustDigest,
            postEffectWorkspaceDigest: null,
            workspaceIdentity: facts.report.identity!,
            targetIdentity: null,
            preflightLimits: facts.report.limits,
            activationGuard: "allowed",
          },
    output: {
      digest: observationDigest,
      bytes: 0,
      preview:
        observation.kind === "candidate_stale"
          ? "CANDIDATE STALE — NO MCP NETWORK EFFECT"
          : observation.kind === "effect_unknown"
            ? "MCP EFFECT UNKNOWN — RECONCILIATION REQUIRED"
            : `MCP CLOSED — ${observation.catalog.length} TOOLS OBSERVED, NOT VERIFIED`,
    },
  })
  await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      yield* spool.put(receipt)
    }),
  )
  const ingested = await ingestReceipt(input, facts, receipt)
  await acknowledgeReceipt(input.spoolFilename, receipt, ingested.event.eventID, ingested.event.digest)
  return durableResult(ingested.operation, receipt, observation.kind === "closed_observed" ? observation.catalog.length : null)
}

async function recordUncertainty(
  input: ExecuteMcpActivationInput,
  facts: ReturnType<typeof makeFacts>,
  fencingToken: number,
  observedAt: string,
) {
  const uncertainty = requireUncertainty({
    uncertaintyID: deterministicUUID(facts.operationID, "uncertainty:1"),
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    reason: "claimed_without_receipt",
    observedAt,
    targetObservation: { state: "unavailable", digest: digest("mcp-session-close-or-network-state-unknown") },
  })
  const recorded = await runWithCoordinatorLedger(
    input.ledgerFilename,
    (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.recordClaimUncertainty({
          uncertainty,
          event: {
            eventID: facts.eventIDs.uncertainty,
            schemaVersion: 1,
            actor: { kind: "system", subject: "astra-coordinator:mcp-recovery", componentDigest: adapterDigest },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    () => observedAt,
  )
  return durableResult(recorded.operation, null, null)
}

async function readSnapshot(input: ExecuteMcpActivationInput, facts: ReturnType<typeof makeFacts>) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return {
        operation: yield* ledger.getOperation(facts.operationID),
        dispatch: yield* ledger.getDispatchSnapshot(facts.dispatchRequestID),
      }
    }),
  )
}

async function ingestReceipt(input: ExecuteMcpActivationInput, facts: ReturnType<typeof makeFacts>, receipt: OperationReceipt) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.ingestReceipt({
        receipt,
        event: {
          eventID: facts.eventIDs.receipt,
          schemaVersion: 1,
          correlationID: facts.correlationID,
          redaction: "sensitive_redacted",
          externalBlobDigest: null,
        },
      })
    }),
  )
}

async function ingestPendingReceipt(input: ExecuteMcpActivationInput, facts: ReturnType<typeof makeFacts>) {
  const entry = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.get(facts.receiptID)
    }),
  )
  if (!entry || entry.acknowledgement) return
  const ingested = await ingestReceipt(input, facts, entry.receipt)
  await acknowledgeReceipt(input.spoolFilename, entry.receipt, ingested.event.eventID, ingested.event.digest)
}

async function acknowledgeReceipt(spoolFilename: string, receipt: OperationReceipt, eventID: string, eventDigest: string) {
  await runWithCoordinatorReceiptSpool(spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      yield* spool.acknowledgeIngestedReceipt({ receiptID: receipt.receiptID, ledgerEventID: eventID, ledgerEventDigest: eventDigest })
    }),
  )
}

function validateCandidateSource(workspace: string, candidate: ParentPrivateMcpCandidate) {
  if (isAbsolute(candidate.sourcePath) || candidate.sourcePath.split("/").includes("..")) return false
  const filename = resolve(workspace, candidate.sourcePath)
  let descriptor: number | undefined
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const facts = fstatSync(descriptor)
    if (
      !facts.isFile() ||
      facts.nlink !== 1 ||
      String(facts.dev) !== candidate.sourceDevice ||
      String(facts.ino) !== candidate.sourceInode ||
      facts.size > maximumSourceBytes
    ) return false
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(32 * 1024)
    let offset = 0
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, offset)
      if (bytes === 0) break
      offset += bytes
      if (offset > maximumSourceBytes) return false
      hash.update(buffer.subarray(0, bytes))
    }
    return `sha256:${hash.digest("hex")}` === candidate.sourceDigest
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function validateActive(input: Awaited<ReturnType<McpActivationAdapter["connect"]>>) {
  if (
    input.instructionsWithheld !== true ||
    !safeText(input.protocolVersion, 64) ||
    !safeText(input.server.name, 128) ||
    !safeText(input.server.version, 128) ||
    input.catalog.length > 64 ||
    input.catalog.some(
      (entry) =>
        !safeText(entry.name, 128) ||
        (entry.description !== null && !safeText(entry.description, 1_024)) ||
        !parseContentDigest(entry.inputSchemaDigest).ok,
    )
  ) throw new TypeError("The MCP adapter observation is invalid")
  return input
}

function durableResult(operation: OperationRecord, receipt: OperationReceipt | null, catalogCount: number | null): DurableMcpActivationResult {
  if (!["denied", "completed", "failed", "reconciliation_required"].includes(operation.state)) {
    throw new McpActivationCoordinationError("recovery_unavailable", "The MCP Operation is not terminal")
  }
  return Object.freeze({
    operationID: operation.operationID,
    state: operation.state as DurableMcpActivationResult["state"],
    status:
      operation.state === "denied"
        ? "denied_without_effect"
        : operation.state === "completed"
          ? "completed_observed_not_verified"
          : operation.state === "failed"
            ? "candidate_stale"
            : "effect_unknown",
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    catalogCount,
    boundaryLabel: mcpActivationBoundaryLabel,
    networkLabel: mcpActivationNetworkLabel,
  })
}

function requireProposalInput(input: ProposeMcpActivationInput) {
  const operationID = parseOperationID(input.operationID)
  if (!operationID.ok || !canonicalTimestamp(input.policyAskedAt)) throw new TypeError("Invalid MCP proposal identity")
  const report = input.session.report
  if (
    input.session.mode !== "activate-once" ||
    report.completeness !== "complete" ||
    !report.identity ||
    !report.securityDigest ||
    !parseContentDigest(input.candidate.candidateID).ok ||
    !parseContentDigest(input.candidate.sourceDigest).ok ||
    !parseContentDigest(input.candidate.configBindingDigest).ok ||
    resolve(input.candidate.sourcePath).startsWith("/") && isAbsolute(input.candidate.sourcePath)
  ) throw new TypeError("MCP activation requires a complete one-shot trusted session")
}

function requireTimeline(input: ExecuteMcpActivationInput, expiresAt: string) {
  if (
    !canonicalTimestamp(input.consent.decidedAt) ||
    !canonicalTimestamp(input.recordingStartedAt) ||
    Date.parse(input.consent.decidedAt) < Date.parse(input.policyAskedAt) ||
    Date.parse(input.consent.decidedAt) >= Date.parse(expiresAt) ||
    Date.parse(input.recordingStartedAt) < Date.parse(input.consent.decidedAt)
  ) throw new TypeError("The MCP activation timeline is invalid")
}

function requireRecoveryBinding(dispatch: NonNullable<Awaited<ReturnType<typeof readSnapshot>>["dispatch"]>, facts: ReturnType<typeof makeFacts>) {
  if (
    dispatch.request.operationID !== facts.operationID ||
    dispatch.request.capabilityDigest !== facts.capabilityDigest ||
    dispatch.request.executor !== executor ||
    dispatch.request.adapterDigest !== adapterDigest
  ) throw new McpActivationCoordinationError("invalid_input", "The durable MCP authority differs")
}

function event(
  operationID: OperationID,
  eventID: string,
  name: OperationEventDraft["name"],
  payload: Readonly<Record<string, unknown>>,
  recordedAt: string,
  observedAt: string,
  actor: ActorRef,
  correlationID: string,
  causationID: string | null = null,
  attemptID: string | null = null,
): OperationEventDraft {
  return {
    eventID,
    operationID,
    schemaVersion: 1,
    name,
    recordedAt,
    observedAt,
    actor,
    causationID,
    correlationID,
    attemptID,
    redaction: "sensitive_redacted",
    payload,
    externalBlobDigest: null,
  }
}

function command(expectedState: AppendOperationEvent["expectedState"], expectedSequence: number, draft: OperationEventDraft): AppendOperationEvent {
  return { expectedState, expectedSequence, event: draft }
}

function safeText(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.length > 0 && Buffer.byteLength(input) <= maximum && !/[\p{Cc}\p{Cf}]/u.test(input)
}

function canonicalTimestamp(input: string) {
  return Number.isFinite(Date.parse(input)) && new Date(Date.parse(input)).toISOString() === input
}

async function exists(filename: string) {
  return Bun.file(filename).exists()
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("Invalid Operation ID")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("Invalid attempt ID")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("Invalid capability grant ID")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("Invalid dispatch request ID")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("Invalid claim ID")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("Invalid receipt ID")
  return parsed.value
}

function requireContentDigest(input: string) {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("Invalid digest")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError("Invalid dispatch request")
  return parsed.value
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`Invalid MCP receipt: ${parsed.issue.reason}`)
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError("Invalid uncertainty")
  return parsed.value
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object") {
    Object.freeze(input)
    for (const value of Object.values(input)) deepFreeze(value)
  }
  return input
}
