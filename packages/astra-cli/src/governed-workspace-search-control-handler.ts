import { timingSafeEqual } from "node:crypto"
import {
  parseWorkspaceSearchControlRequest,
  parseWorkspaceSearchDecisionResult,
  parseWorkspaceSearchPrepareResult,
  parseWorkspaceSearchProgress,
  type WorkspaceSearchDecisionResult,
  type WorkspaceSearchPrepareResult,
  type WorkspaceSearchProgress,
} from "@astra/domain/governed-workspace-search-control"
import type { AstraGovernedWorkspaceSearchControl } from "./governed-workspace-search-control"

const maximumRequestsPerSession = 1_024

export type AstraGovernedWorkspaceSearchControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "accepted"
      requestId: string
      terminal: Promise<WorkspaceSearchPrepareResult | WorkspaceSearchDecisionResult>
    }>

export type AstraGovernedWorkspaceSearchControlHandler = ReturnType<
  typeof createAstraGovernedWorkspaceSearchControlHandler
>

/** Authenticates and serializes search requests. The parent retains task
 * ownership until settlement even when the requesting socket disconnects. */
export function createAstraGovernedWorkspaceSearchControlHandler(
  input: Readonly<{
    sessionID: string
    token: string
    control: AstraGovernedWorkspaceSearchControl
  }>,
) {
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined

  return {
    dispatch(
      candidate: unknown,
      onProgress: (progress: WorkspaceSearchProgress) => void = () => {},
    ): AstraGovernedWorkspaceSearchControlDispatch {
      const parsed = parseWorkspaceSearchControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return acceptedBlocked(request, "request_replayed")
      if (usedRequestIDs.size >= maximumRequestsPerSession) return acceptedBlocked(request, "control_limit_reached")
      usedRequestIDs.add(request.requestId)
      if (activeRequestID) return acceptedBlocked(request, "control_busy")

      activeRequestID = request.requestId
      const progress = (value: WorkspaceSearchProgress) => {
        const parsedProgress = parseWorkspaceSearchProgress(value)
        if (
          !parsedProgress.ok ||
          request.method !== "search.decide" ||
          parsedProgress.value.requestId !== request.requestId ||
          parsedProgress.value.proposalID !== request.proposalID
        )
          return
        onProgress(parsedProgress.value)
      }
      const operation = async () => {
        if (request.method === "search.prepare") return input.control.prepare(request.requestId, request.query)
        return input.control.decide(request.requestId, request.proposalID, request.decision, progress)
      }
      const terminal = Promise.resolve()
        .then(operation)
        .then((result) => normalizeTerminal(request, result))
        .catch(() => unavailable(request))
        .finally(() => {
          if (activeRequestID === request.requestId) activeRequestID = undefined
        })
      return { status: "accepted", requestId: request.requestId, terminal }
    },
  }
}

function normalizeTerminal(
  request: Extract<ReturnType<typeof parseWorkspaceSearchControlRequest>, { ok: true }>["value"],
  result: WorkspaceSearchPrepareResult | WorkspaceSearchDecisionResult,
) {
  if (request.method === "search.prepare") {
    const parsed = parseWorkspaceSearchPrepareResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId ? parsed.value : unavailable(request)
  }
  const parsed = parseWorkspaceSearchDecisionResult(result)
  return parsed.ok && parsed.value.requestId === request.requestId && parsed.value.proposalID === request.proposalID
    ? parsed.value
    : unavailable(request)
}

function acceptedBlocked(
  request: Extract<ReturnType<typeof parseWorkspaceSearchControlRequest>, { ok: true }>["value"],
  reason: string,
): AstraGovernedWorkspaceSearchControlDispatch {
  const terminal = Promise.resolve(
    request.method === "search.prepare"
      ? ({ schemaVersion: 1, requestId: request.requestId, status: "blocked", reason } as const)
      : ({
          schemaVersion: 1,
          requestId: request.requestId,
          proposalID: request.proposalID,
          status: "blocked",
          reason,
        } as const),
  )
  return { status: "accepted", requestId: request.requestId, terminal }
}

function unavailable(
  request: Extract<ReturnType<typeof parseWorkspaceSearchControlRequest>, { ok: true }>["value"],
): WorkspaceSearchPrepareResult | WorkspaceSearchDecisionResult {
  if (request.method === "search.prepare") {
    return { schemaVersion: 1, requestId: request.requestId, status: "blocked", reason: "control_unavailable" }
  }
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    status: "blocked",
    reason: "control_unavailable",
  }
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
