import { timingSafeEqual } from "node:crypto"
import {
  parseExtensionInventoryControlDecisionResult,
  parseExtensionInventoryControlPrepareResult,
  parseExtensionInventoryControlRequest,
  type ExtensionInventoryControlDecisionResult,
  type ExtensionInventoryControlPrepareResult,
} from "@astra/domain/extension-inventory-control"
import type { AstraExtensionInventoryControl } from "./extension-inventory-control"

const maximumRequestsPerSession = 1_024

export type AstraExtensionInventoryControlHandler = ReturnType<typeof createAstraExtensionInventoryControlHandler>

/** Owns proposal bindings in the parent; the child can supply only intent and A/D. */
export function createAstraExtensionInventoryControlHandler(input: Readonly<{
  sessionID: string
  token: string
  control: AstraExtensionInventoryControl
  timeoutMs: number
}>) {
  const usedRequestIDs = new Set<string>()
  const proposals = new Map<string, PreparedProposal>()
  let activeRequestID: string | undefined

  return {
    dispatch(candidate: unknown) {
      const parsed = parseExtensionInventoryControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" as const }
      }
      const request = parsed.value
      for (const [proposalID, proposal] of proposals) {
        if ((!proposal.operation || proposal.settled) && Date.parse(proposal.expiresAt) <= Date.now()) {
          proposals.delete(proposalID)
        }
      }
      if (usedRequestIDs.has(request.requestId)) return accepted(request.requestId, blocked(request, "request_replayed"))
      if (usedRequestIDs.size >= maximumRequestsPerSession) {
        return accepted(request.requestId, blocked(request, "control_limit_reached"))
      }
      usedRequestIDs.add(request.requestId)
      if (request.method === "extension-inventory.prepare") {
        if (activeRequestID) return accepted(request.requestId, blocked(request, "control_busy"))
        activeRequestID = request.requestId
        const operation = input.control
          .prepare(request.requestId)
          .then((result) => mapPrepare(request.requestId, result, proposals))
          .catch(() => blocked(request, "control_unavailable"))
          .finally(() => {
            if (activeRequestID === request.requestId) activeRequestID = undefined
          })
        return {
          status: "accepted" as const,
          requestId: request.requestId,
          terminal: bounded(
            operation,
            input.timeoutMs,
            blocked(request, "control_response_timed_out"),
          ),
        }
      }
      const knownProposal = proposals.get(request.proposalID)
      if (!knownProposal) return accepted(request.requestId, blocked(request, "proposal_unknown"))
      if (knownProposal.operation) {
        if (knownProposal.decision !== request.decision) {
          return accepted(request.requestId, blocked(request, "proposal_consumed"))
        }
        return {
          status: "accepted" as const,
          requestId: request.requestId,
          terminal: bounded(
            knownProposal.operation
              .then((result) => mapDecision(request, result))
              .catch(() => decisionUnavailable(request)),
            input.timeoutMs,
            decisionTimedOut(request),
          ),
        }
      }
      if (activeRequestID) return accepted(request.requestId, blocked(request, "control_busy"))
      activeRequestID = request.requestId
      knownProposal.decision = request.decision
      knownProposal.operation = input.control.decide(
        knownProposal.prepareRequestID,
        request.proposalID,
        request.decision,
      )
      const operation = knownProposal.operation
        .finally(() => {
          knownProposal.settled = true
          if (activeRequestID === request.requestId) activeRequestID = undefined
        })
      const terminal = bounded(operation.then((result) => mapDecision(request, result)).catch(() => decisionUnavailable(request)), input.timeoutMs, decisionTimedOut(request))
      return { status: "accepted" as const, requestId: request.requestId, terminal }
    },
  }
}

function mapPrepare(
  requestId: string,
  result: Awaited<ReturnType<AstraExtensionInventoryControl["prepare"]>>,
  proposals: Map<string, PreparedProposal>,
): ExtensionInventoryControlPrepareResult {
  if (result.status === "blocked") return requirePrepare({ schemaVersion: 1, requestId, status: "blocked", reason: result.reason })
  const proposal = result.proposal
  const candidate = {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      schemaVersion: 1,
      proposalID: proposal.operationID,
      expiresAt: proposal.authorizationExpiresAt,
      capabilityDigest: proposal.capabilityDigest,
      boundaryLabel: proposal.boundaryLabel,
      helper: {
        kind: "astra_native_static_inventory",
        execution: proposal.guarantees.helperExecution,
      },
      resourceClasses: proposal.resourceClasses,
      allowlist: proposal.allowlist,
      verification: "not_verified",
    },
  } as const
  const parsed = parseExtensionInventoryControlPrepareResult(candidate)
  if (!parsed.ok || parsed.value.status !== "prepared") {
    return requirePrepare({ schemaVersion: 1, requestId, status: "blocked", reason: "protocol_invalid" })
  }
  proposals.set(proposal.operationID, { prepareRequestID: requestId, expiresAt: proposal.authorizationExpiresAt })
  return parsed.value
}

type PreparedProposal = {
  prepareRequestID: string
  expiresAt: string
  decision?: "approve" | "reject"
  operation?: ReturnType<AstraExtensionInventoryControl["decide"]>
  settled?: boolean
}

function decisionTimedOut(
  request: Extract<ReturnType<typeof parseExtensionInventoryControlRequest>, { ok: true }>["value"] & {
    method: "extension-inventory.decide"
  },
) {
  if (request.decision === "reject") return blocked(request, "control_response_timed_out")
  return requireDecision({
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    status: "reconciliation_required",
    reason: "effect_in_progress_or_unknown",
  })
}

function decisionUnavailable(
  request: Extract<ReturnType<typeof parseExtensionInventoryControlRequest>, { ok: true }>["value"] & {
    method: "extension-inventory.decide"
  },
) {
  if (request.decision === "reject") return blocked(request, "control_unavailable")
  return requireDecision({
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    status: "reconciliation_required",
    reason: "durable_state_unavailable",
  })
}

function bounded<Result>(operation: Promise<Result>, timeoutMs: number, timedOut: Result) {
  return new Promise<Result>((complete) => {
    let settled = false
    const finish = (result: Result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      complete(result)
    }
    const timer = setTimeout(() => finish(timedOut), timeoutMs)
    timer.unref?.()
    void operation.then(finish)
  })
}

function mapDecision(
  request: Extract<ReturnType<typeof parseExtensionInventoryControlRequest>, { ok: true }>["value"] & {
    method: "extension-inventory.decide"
  },
  result: Awaited<ReturnType<AstraExtensionInventoryControl["decide"]>>,
): ExtensionInventoryControlDecisionResult {
  const common = { schemaVersion: 1 as const, requestId: request.requestId, proposalID: request.proposalID }
  let candidate: unknown
  if (result.status === "denied_without_effect" && request.decision === "reject") {
    candidate = { ...common, status: "denied_without_effect" }
  } else if (
    result.status === "completed_observed_not_verified" &&
    request.decision === "approve" &&
    result.receiptID &&
    result.inventory
  ) {
    candidate = {
      ...common,
      status: "completed_observed_not_verified",
      receiptID: result.receiptID,
      candidates: result.inventory.candidates,
      verification: "not_verified",
    }
  } else if (result.status === "failed_without_effect") {
    candidate = { ...common, status: "failed_without_effect", reason: "inventory_not_started" }
  } else if (result.status === "effect_unknown" || result.status === "reconciliation_required") {
    candidate = { ...common, status: "reconciliation_required", reason: "effect_unknown" }
  } else if (result.status === "blocked") {
    candidate = { ...common, status: "blocked", reason: result.reason }
  } else {
    candidate = { ...common, status: "blocked", reason: "protocol_invalid" }
  }
  const parsed = parseExtensionInventoryControlDecisionResult(candidate)
  return parsed.ok ? parsed.value : requireDecision({ ...common, status: "blocked", reason: "protocol_invalid" })
}

function blocked(
  request: Extract<ReturnType<typeof parseExtensionInventoryControlRequest>, { ok: true }>["value"],
  reason: string,
) {
  if (request.method === "extension-inventory.prepare") {
    return requirePrepare({ schemaVersion: 1, requestId: request.requestId, status: "blocked", reason })
  }
  return requireDecision({
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    status: "blocked",
    reason,
  })
}

function accepted<Result>(requestId: string, result: Result) {
  return { status: "accepted" as const, requestId, terminal: Promise.resolve(result) }
}

function requirePrepare(input: unknown) {
  const parsed = parseExtensionInventoryControlPrepareResult(input)
  if (!parsed.ok) throw new Error("Invalid public extension inventory prepare result")
  return parsed.value
}

function requireDecision(input: unknown) {
  const parsed = parseExtensionInventoryControlDecisionResult(input)
  if (!parsed.ok) throw new Error("Invalid public extension inventory decision result")
  return parsed.value
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
