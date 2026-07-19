import { timingSafeEqual } from "node:crypto"
import {
  parseMcpActivationControlDecisionResult,
  parseMcpActivationControlPrepareResult,
  parseMcpActivationControlProgress,
  parseMcpActivationControlRequest,
  parseMcpActivationControlStopResult,
  type McpActivationControlDecisionResult,
  type McpActivationControlPrepareResult,
  type McpActivationControlProgress,
} from "@astra/domain/mcp-activation-control"
import type { AstraMcpActivationControl } from "./mcp-activation-control"

const maximumRequestsPerSession = 1_024

export type AstraMcpActivationControlHandler = ReturnType<typeof createAstraMcpActivationControlHandler>

/** Authenticates child intent while retaining proposals and raw candidate authority in the parent. */
export function createAstraMcpActivationControlHandler(input: Readonly<{
  sessionID: string
  token: string
  control: AstraMcpActivationControl
}>) {
  const usedRequestIDs = new Set<string>()
  const proposals = new Map<string, { prepareRequestID: string; operation?: Promise<McpActivationControlDecisionResult>; cancelled?: boolean }>()

  return Object.freeze({
    dispatch(candidate: unknown, onProgress?: (progress: McpActivationControlProgress) => void) {
      const parsed = parseMcpActivationControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) return { status: "rejected" as const }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return accepted(request.requestId, blocked(request, "request_replayed"))
      if (usedRequestIDs.size >= maximumRequestsPerSession) return accepted(request.requestId, blocked(request, "control_limit_reached"))
      usedRequestIDs.add(request.requestId)

      if (request.method === "mcp-activation.prepare") {
        const terminal = input.control.prepare(request.requestId, request.candidateID)
          .then((result) => mapPrepare(request.requestId, result, proposals))
          .catch(() => blocked(request, "control_unavailable"))
        return { status: "accepted" as const, requestId: request.requestId, terminal }
      }

      const prepared = proposals.get(request.proposalID)
      if (!prepared) return accepted(request.requestId, blocked(request, "proposal_unknown"))

      if (request.method === "mcp-activation.stop") {
        const terminal = prepared.operation
          ? input.control.stop(request.requestId, request.proposalID)
              .then((result) => requireStop({ schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, ...(result.status === "stop_requested" ? { status: "stop_requested" as const } : { status: "blocked" as const, reason: result.reason ?? "activation_unknown" }) }))
              .catch(() => blocked(request, "control_unavailable"))
          : Promise.resolve().then(() => {
              prepared.cancelled = true
              return requireStop({ schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, status: "stop_requested" })
            })
        return { status: "accepted" as const, requestId: request.requestId, terminal }
      }

      if (prepared.operation || prepared.cancelled) {
        return accepted(request.requestId, blocked(request, "proposal_consumed"))
      }
      prepared.operation = input.control.decide(prepared.prepareRequestID, request.proposalID, request.decision, (active) => {
        const progress = requireProgress({
          schemaVersion: 1,
          requestId: request.requestId,
          proposalID: request.proposalID,
          operationID: active.operationID,
          status: "active",
          catalogCount: active.catalogCount,
          leaseExpiresAt: active.leaseExpiresAt,
          verification: "not_verified",
        })
        onProgress?.(progress)
      }).then((result) => mapDecision(request.requestId, request.proposalID, result))
        .catch(() => requireDecision({ schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, operationID: request.proposalID, status: "reconciliation_required", reason: "durable_state_unavailable", verification: "not_verified" }))
      return { status: "accepted" as const, requestId: request.requestId, terminal: prepared.operation }
    },
    close: input.control.close,
  })
}

function mapPrepare(
  requestId: string,
  result: Awaited<ReturnType<AstraMcpActivationControl["prepare"]>>,
  proposals: Map<string, { prepareRequestID: string }>,
): McpActivationControlPrepareResult {
  if (result.status === "blocked") return requirePrepare({ schemaVersion: 1, requestId, status: "blocked", reason: result.reason })
  const proposal = result.proposal
  const candidate = {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      schemaVersion: 1,
      proposalID: proposal.operationID,
      candidateID: proposal.candidate.candidateID,
      displayName: proposal.candidate.displayName,
      sourcePath: proposal.candidate.sourcePath,
      transport: proposal.candidate.transport,
      destination: proposal.candidate.endpoint.startsWith("https:") ? "public_https_withheld" : "literal_loopback_http_withheld",
      leaseExpiresAt: proposal.leaseExpiresAt,
      capabilityDigest: proposal.capabilityDigest,
      boundaryLabel: proposal.boundaryLabel,
      networkLabel: proposal.networkLabel,
      requestBudget: proposal.requestBudget,
      credentials: "none",
      workspaceRootShared: "none",
      redirects: "forbidden",
      retries: "none",
      reconnect: "none",
      instructions: "withheld",
      toolInvocation: "forbidden",
      verification: "not_verified",
    },
  } as const
  const parsed = parseMcpActivationControlPrepareResult(candidate)
  if (!parsed.ok || parsed.value.status !== "prepared") return requirePrepare({ schemaVersion: 1, requestId, status: "blocked", reason: "protocol_invalid" })
  proposals.set(proposal.operationID, { prepareRequestID: requestId })
  return parsed.value
}

function mapDecision(
  requestId: string,
  proposalID: string,
  result: Awaited<ReturnType<AstraMcpActivationControl["decide"]>>,
): McpActivationControlDecisionResult {
  if (result.status === "blocked") return requireDecision({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason: result.reason })
  const operationID = "operationID" in result ? result.operationID : proposalID
  if (result.status === "denied_without_effect") return requireDecision({ schemaVersion: 1, requestId, proposalID, operationID, status: "denied_without_effect" })
  if (result.status === "completed_observed_not_verified" && result.receiptID && result.catalogCount !== null) return requireDecision({ schemaVersion: 1, requestId, proposalID, operationID, status: "completed_observed_not_verified", receiptID: result.receiptID, catalogCount: result.catalogCount, verification: "not_verified" })
  if (result.status === "candidate_stale") return requireDecision({ schemaVersion: 1, requestId, proposalID, operationID, status: "failed_without_effect", reason: "candidate_stale", verification: "not_verified" })
  return requireDecision({ schemaVersion: 1, requestId, proposalID, operationID, status: "reconciliation_required", reason: result.status === "effect_unknown" ? "effect_unknown" : "durable_state_unavailable", verification: "not_verified" })
}

function blocked(
  request: Extract<ReturnType<typeof parseMcpActivationControlRequest>, { ok: true }>["value"],
  reason: string,
) {
  if (request.method === "mcp-activation.prepare") return requirePrepare({ schemaVersion: 1, requestId: request.requestId, status: "blocked", reason })
  if (request.method === "mcp-activation.stop") return requireStop({ schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, status: "blocked", reason })
  return requireDecision({ schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, status: "blocked", reason })
}

function accepted<Result>(requestId: string, result: Result) {
  return { status: "accepted" as const, requestId, terminal: Promise.resolve(result) }
}

function requirePrepare(input: unknown) {
  const parsed = parseMcpActivationControlPrepareResult(input)
  if (!parsed.ok) throw new Error("Invalid public MCP prepare result")
  return parsed.value
}

function requireProgress(input: unknown) {
  const parsed = parseMcpActivationControlProgress(input)
  if (!parsed.ok) throw new Error("Invalid public MCP progress")
  return parsed.value
}

function requireDecision(input: unknown) {
  const parsed = parseMcpActivationControlDecisionResult(input)
  if (!parsed.ok) throw new Error("Invalid public MCP decision result")
  return parsed.value
}

function requireStop(input: unknown) {
  const parsed = parseMcpActivationControlStopResult(input)
  if (!parsed.ok) throw new Error("Invalid public MCP stop result")
  return parsed.value
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
