import { randomUUID } from "node:crypto"
import type { McpActivationProposal } from "@astra/domain/mcp-activation"
import {
  createMcpActivationSessionGate,
  executeMcpActivation,
  McpActivationCoordinationError,
  proposeMcpActivation,
  type DurableMcpActivationResult,
  type McpActivationAdapter,
  type McpActivationSessionGate,
} from "@astra/runtime/mcp-activation-coordinator"
import type { ParentPrivateMcpCandidate, ParentPrivateMcpRegistry } from "@astra/runtime/extension-inventory-operation"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type McpActivationPrepareResult =
  | Readonly<{ status: "awaiting_approval"; requestID: string; proposal: McpActivationProposal }>
  | Readonly<{ status: "blocked"; requestID: string; reason: "activate_once_required" | "candidate_unknown" | "candidate_stale" | "candidate_ineligible" | "proposal_unavailable" | "control_limit_reached" }>

export type McpActivationDecisionResult =
  | DurableMcpActivationResult
  | Readonly<{ status: "blocked"; requestID: string; reason: "proposal_unknown" | "proposal_consumed" | "invalid_decision" | "execution_unavailable" | "server_limit_reached" }>
  | Readonly<{ status: "reconciliation_required"; requestID: string; operationID: string; reason: "durable_state_unavailable" }>

export type McpActivationStopResult = Readonly<{
  status: "stop_requested" | "blocked"
  requestID: string
  proposalID: string
  reason?: "activation_unknown" | "activation_not_active"
}>

export type AstraMcpActivationControl = Readonly<{
  prepare: (requestID: string, candidateID: string) => Promise<McpActivationPrepareResult>
  decide: (requestID: string, proposalID: string, decision: "approve" | "reject", onActive?: (active: Readonly<{ operationID: string; catalogCount: number; leaseExpiresAt: string }>) => void) => Promise<McpActivationDecisionResult>
  stop: (requestID: string, proposalID: string) => Promise<McpActivationStopResult>
  close: () => Promise<void>
}>

export type AstraMcpActivationControlDependencies = Readonly<{
  registry: ParentPrivateMcpRegistry
  adapter: McpActivationAdapter
  ledgerFilename: string
  spoolFilename: string
  now?: () => number
  operationID?: () => string
  sessionGate?: McpActivationSessionGate
  propose?: typeof proposeMcpActivation
  execute?: typeof executeMcpActivation
}>

const maximumPreparedOperations = 8

/** Keeps raw MCP configuration, endpoint and lifecycle authority in the parent. */
export function createAstraMcpActivationControl(
  session: OpenedWorkspace,
  dependencies: AstraMcpActivationControlDependencies,
): AstraMcpActivationControl {
  const proposals = new Map<string, { requestID: string; proposal: McpActivationProposal; candidate: ParentPrivateMcpCandidate; consumed: boolean }>()
  const now = dependencies.now ?? Date.now
  const makeOperationID = dependencies.operationID ?? randomUUID
  const propose = dependencies.propose ?? proposeMcpActivation
  const execute = dependencies.execute ?? executeMcpActivation
  const sessionGate = dependencies.sessionGate ?? createMcpActivationSessionGate()
  const activations = new Map<string, { active: boolean; stop: (reason: "explicit" | "session_close") => void; abort: AbortController; settled: Promise<unknown> }>()
  let closed = false

  return Object.freeze({
    async prepare(requestID, candidateID) {
      if (closed || !validRequestID(requestID)) return blockedPrepare(requestID, "proposal_unavailable")
      if (session.mode !== "activate-once") return blockedPrepare(requestID, "activate_once_required")
      const resolved = dependencies.registry.resolve(candidateID)
      if (resolved.status !== "resolved") return blockedPrepare(requestID, resolved.status)
      const preparedAt = now()
      for (const [operationID, prepared] of proposals) {
        if (Date.parse(prepared.proposal.authorizationExpiresAt) <= preparedAt) proposals.delete(operationID)
      }
      if (proposals.size >= maximumPreparedOperations) return blockedPrepare(requestID, "control_limit_reached")
      try {
        const operationID = makeOperationID()
        const proposal = propose({
          operationID,
          policyAskedAt: new Date(preparedAt).toISOString(),
          session: session.repositoryBaseline
            ? { mode: "activate-once", report: session.report, repositoryBaseline: session.repositoryBaseline }
            : { mode: "activate-once", report: session.report },
          candidate: resolved.candidate,
        })
        proposals.set(operationID, { requestID, proposal, candidate: resolved.candidate, consumed: false })
        return Object.freeze({ status: "awaiting_approval", requestID, proposal })
      } catch (cause) {
        return blockedPrepare(requestID, cause instanceof McpActivationCoordinationError && cause.code === "candidate_ineligible" ? "candidate_ineligible" : "proposal_unavailable")
      }
    },

    async decide(requestID, proposalID, decision, onActive) {
      if (!validRequestID(requestID) || (decision !== "approve" && decision !== "reject")) return blockedDecision(requestID, "invalid_decision")
      const prepared = proposals.get(proposalID)
      if (!prepared || prepared.requestID !== requestID) return blockedDecision(requestID, "proposal_unknown")
      if (prepared.consumed) return blockedDecision(requestID, "proposal_consumed")
      prepared.consumed = true
      let releaseStop: ((reason: "explicit" | "session_close") => void) | undefined
      const stop = new Promise<"explicit" | "session_close">((resolveStop) => {
        releaseStop = resolveStop
      })
      const abort = new AbortController()
      const input = {
        operationID: proposalID,
        policyAskedAt: prepared.proposal.policyAskedAt,
        session: session.repositoryBaseline
          ? { mode: "activate-once" as const, report: session.report, repositoryBaseline: session.repositoryBaseline }
          : { mode: "activate-once" as const, report: session.report },
        candidate: prepared.candidate,
        proposal: prepared.proposal,
        consent: decision === "approve"
          ? { decision: "approved" as const, decidedAt: new Date(now()).toISOString() }
          : { decision: "rejected" as const, decidedAt: new Date(now()).toISOString(), reason: "user_rejected" as const },
        recordingStartedAt: new Date(now()).toISOString(),
        ledgerFilename: dependencies.ledgerFilename,
        spoolFilename: dependencies.spoolFilename,
      }
      const operation = Promise.resolve().then(() => execute(input, {
          sessionGate,
          adapter: dependencies.adapter,
          awaitStop: () => stop,
          abortSignal: abort.signal,
          now,
          onActive(value) {
            if (!releaseStop) return
            activations.set(proposalID, { active: true, stop: releaseStop, abort, settled: operation })
            onActive?.(value)
          },
        }))
      if (decision === "approve" && releaseStop) activations.set(proposalID, { active: false, stop: releaseStop, abort, settled: operation })
      try {
        return await operation
      } catch (cause) {
        if (cause instanceof McpActivationCoordinationError && cause.code === "server_limit_reached") return blockedDecision(requestID, "server_limit_reached")
        if (cause instanceof McpActivationCoordinationError && cause.code !== "invalid_input") return Object.freeze({ status: "reconciliation_required", requestID, operationID: proposalID, reason: "durable_state_unavailable" })
        return blockedDecision(requestID, "execution_unavailable")
      } finally {
        proposals.delete(proposalID)
        activations.delete(proposalID)
      }
    },

    async stop(requestID, proposalID) {
      const activation = activations.get(proposalID)
      if (!activation) return Object.freeze({ status: "blocked", requestID, proposalID, reason: "activation_unknown" })
      if (activation.active) activation.stop("explicit")
      else activation.abort.abort()
      return Object.freeze({ status: "stop_requested", requestID, proposalID })
    },

    async close() {
      if (closed) return
      closed = true
      for (const activation of activations.values()) {
        if (activation.active) activation.stop("session_close")
        else activation.abort.abort()
      }
      if (activations.size === 0) return
      await Promise.race([
        Promise.allSettled([...activations.values()].map((activation) => activation.settled)),
        boundedDelay(5_000),
      ])
    },
  })
}

function validRequestID(input: unknown) {
  return typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)
}

function blockedPrepare(requestID: string, reason: Extract<McpActivationPrepareResult, { status: "blocked" }>["reason"]) {
  return Object.freeze({ status: "blocked", requestID, reason } as const)
}

function blockedDecision(requestID: string, reason: Extract<McpActivationDecisionResult, { status: "blocked" }>["reason"]) {
  return Object.freeze({ status: "blocked", requestID, reason } as const)
}

function boundedDelay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds)
    timer.unref?.()
  })
}
