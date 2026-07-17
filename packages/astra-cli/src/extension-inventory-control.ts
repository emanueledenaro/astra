import { randomUUID } from "node:crypto"
import type { ExtensionInventoryHelperIdentity, ExtensionInventoryProposal } from "@astra/domain/extension-inventory-operation"
import {
  executeExtensionInventory,
  proposeExtensionInventory,
  ExtensionInventoryCoordinationError,
  type DurableExtensionInventoryResult,
  type ExecuteExtensionInventoryInput,
  type ParentPrivateMcpRegistry,
} from "@astra/runtime/extension-inventory-operation"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type ExtensionInventoryPrepareResult =
  | Readonly<{
      status: "awaiting_approval"
      requestID: string
      proposal: ExtensionInventoryProposal
    }>
  | Readonly<{
      status: "blocked"
      requestID: string
      reason: "activate_once_required" | "control_limit_reached" | "proposal_unavailable"
    }>
export type ExtensionInventoryDecisionResult =
  | DurableExtensionInventoryResult
  | Readonly<{
      status: "blocked"
      requestID: string
      reason: "proposal_unknown" | "proposal_consumed" | "invalid_decision" | "execution_unavailable"
    }>
  | Readonly<{
      status: "reconciliation_required"
      requestID: string
      operationID: string
      reason: "durable_state_unavailable"
    }>

export type AstraExtensionInventoryControl = Readonly<{
  prepare: (requestID: string) => Promise<ExtensionInventoryPrepareResult>
  decide: (
    requestID: string,
    operationID: string,
    decision: "approve" | "reject",
  ) => Promise<ExtensionInventoryDecisionResult>
}>

export type AstraExtensionInventoryControlDependencies = Readonly<{
  helper: ExtensionInventoryHelperIdentity
  ledgerFilename: string
  spoolFilename: string
  now?: () => number
  operationID?: () => string
  propose?: typeof proposeExtensionInventory
  execute?: typeof executeExtensionInventory
  mcpRegistry?: ParentPrivateMcpRegistry
}>

const maximumPreparedOperations = 8

/**
 * Creates an inert session-local control. Construction performs no helper
 * inspection, workspace read, process start, extension load, or MCP startup.
 */
export function createAstraExtensionInventoryControl(
  session: OpenedWorkspace,
  dependencies: AstraExtensionInventoryControlDependencies,
): AstraExtensionInventoryControl {
  const proposals = new Map<
    string,
    Readonly<{ requestID: string; proposal: ExtensionInventoryProposal; consumed: boolean }>
  >()
  const now = dependencies.now ?? Date.now
  const makeOperationID = dependencies.operationID ?? randomUUID
  const propose = dependencies.propose ?? proposeExtensionInventory
  const execute = dependencies.execute ?? executeExtensionInventory

  return Object.freeze({
    async prepare(requestID) {
      if (!validRequestID(requestID)) return blockedPrepare(requestID, "proposal_unavailable")
      if (session.mode !== "activate-once") return blockedPrepare(requestID, "activate_once_required")
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
            ? {
                mode: "activate-once",
                report: session.report,
                repositoryBaseline: session.repositoryBaseline,
              }
            : { mode: "activate-once", report: session.report },
          helper: dependencies.helper,
        })
        proposals.set(operationID, Object.freeze({ requestID, proposal, consumed: false }))
        return Object.freeze({ status: "awaiting_approval", requestID, proposal })
      } catch {
        return blockedPrepare(requestID, "proposal_unavailable")
      }
    },

    async decide(requestID, operationID, decision) {
      if (!validRequestID(requestID) || (decision !== "approve" && decision !== "reject")) {
        return blockedDecision(requestID, "invalid_decision")
      }
      const prepared = proposals.get(operationID)
      if (!prepared || prepared.requestID !== requestID) return blockedDecision(requestID, "proposal_unknown")
      if (prepared.consumed) return blockedDecision(requestID, "proposal_consumed")
      proposals.set(operationID, Object.freeze({ ...prepared, consumed: true }))

      const decidedAt = new Date(now()).toISOString()
      const input: ExecuteExtensionInventoryInput = {
        operationID,
        policyAskedAt: prepared.proposal.policyAskedAt,
        session: session.repositoryBaseline
          ? { mode: "activate-once", report: session.report, repositoryBaseline: session.repositoryBaseline }
          : { mode: "activate-once", report: session.report },
        helper: dependencies.helper,
        proposal: prepared.proposal,
        consent:
          decision === "approve"
            ? { decision: "approved", decidedAt }
            : { decision: "rejected", decidedAt, reason: "user_rejected" },
        recordingStartedAt: new Date(now()).toISOString(),
        ledgerFilename: dependencies.ledgerFilename,
        spoolFilename: dependencies.spoolFilename,
      }
      try {
        return await execute(
          input,
          dependencies.mcpRegistry
            ? { onPrivateMcpRegistrySnapshot: (snapshot) => dependencies.mcpRegistry!.replace(snapshot) }
            : {},
        )
      } catch (cause) {
        if (cause instanceof ExtensionInventoryCoordinationError && cause.code !== "invalid_input") {
          return Object.freeze({
            status: "reconciliation_required",
            requestID,
            operationID,
            reason: "durable_state_unavailable",
          })
        }
        return blockedDecision(requestID, "execution_unavailable")
      } finally {
        proposals.delete(operationID)
      }
    },
  })
}

function validRequestID(input: unknown) {
  return typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)
}

function blockedPrepare(requestID: string, reason: Extract<ExtensionInventoryPrepareResult, { status: "blocked" }>["reason"]) {
  return Object.freeze({ status: "blocked", requestID, reason } as const)
}

function blockedDecision(requestID: string, reason: Extract<ExtensionInventoryDecisionResult, { status: "blocked" }>["reason"]) {
  return Object.freeze({ status: "blocked", requestID, reason } as const)
}
