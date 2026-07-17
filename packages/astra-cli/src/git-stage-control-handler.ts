import { timingSafeEqual } from "node:crypto"
import {
  parseGitStageControlRequest,
  parseGitStageDecisionResult,
  parseGitStageInventoryResult,
  parseGitStagePrepareResult,
  parseGitStageProgress,
  type GitStageDecisionResult,
  type GitStageInventoryResult,
  type GitStagePrepareResult,
  type GitStageProgress,
} from "../../astra-domain/src/git-stage-control"
import type { AstraGitStageControl } from "./git-stage-control"

const maximumRequestsPerSession = 1_024

export type AstraGitStageControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "accepted"
      requestId: string
      method: "git-stage.inventory" | "git-stage.prepare" | "git-stage.decide"
      terminal: Promise<GitStageInventoryResult | GitStagePrepareResult | GitStageDecisionResult>
    }>

export type AstraGitStageControlHandler = ReturnType<typeof createAstraGitStageControlHandler>

/** Authenticates and serializes the private Stage-selected protocol. */
export function createAstraGitStageControlHandler(
  input: Readonly<{
    sessionID: string
    token: string
    control: AstraGitStageControl
  }>,
) {
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined

  return {
    dispatch(
      candidate: unknown,
      onProgress: (progress: GitStageProgress) => void = () => {},
    ): AstraGitStageControlDispatch {
      const parsed = parseGitStageControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return acceptedBlocked(request, "request_replayed")
      if (usedRequestIDs.size >= maximumRequestsPerSession) return acceptedBlocked(request, "control_limit_reached")
      usedRequestIDs.add(request.requestId)
      if (activeRequestID) return acceptedBlocked(request, "control_busy")

      activeRequestID = request.requestId
      const progress = (value: GitStageProgress) => {
        const parsedProgress = parseGitStageProgress(value)
        if (
          !parsedProgress.ok ||
          request.method !== "git-stage.decide" ||
          parsedProgress.value.requestId !== request.requestId ||
          parsedProgress.value.proposalID !== request.proposalID
        )
          return
        onProgress(parsedProgress.value)
      }
      const operation = async () => {
        if (request.method === "git-stage.inventory") return input.control.inventory(request.requestId)
        if (request.method === "git-stage.prepare") {
          return input.control.prepare(request.requestId, request.inventoryID, request.candidateIDs)
        }
        return input.control.decide(request.requestId, request.proposalID, request.decision, progress)
      }
      const terminal = Promise.resolve()
        .then(operation)
        .then((result) => normalizeTerminal(request, result))
        .catch(() => unavailable(request))
        .finally(() => {
          if (activeRequestID === request.requestId) activeRequestID = undefined
        })
      return { status: "accepted", requestId: request.requestId, method: request.method, terminal }
    },
  }
}

function normalizeTerminal(
  request: Extract<ReturnType<typeof parseGitStageControlRequest>, { ok: true }>["value"],
  result: GitStageInventoryResult | GitStagePrepareResult | GitStageDecisionResult,
) {
  if (request.method === "git-stage.inventory") {
    const parsed = parseGitStageInventoryResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId ? parsed.value : unavailable(request)
  }
  if (request.method === "git-stage.prepare") {
    const parsed = parseGitStagePrepareResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId ? parsed.value : unavailable(request)
  }
  const parsed = parseGitStageDecisionResult(result)
  return parsed.ok && parsed.value.requestId === request.requestId && parsed.value.proposalID === request.proposalID
    ? parsed.value
    : unavailable(request)
}

function acceptedBlocked(
  request: Extract<ReturnType<typeof parseGitStageControlRequest>, { ok: true }>["value"],
  reason: string,
): AstraGitStageControlDispatch {
  const terminal = Promise.resolve(unavailable(request, reason))
  return { status: "accepted", requestId: request.requestId, method: request.method, terminal }
}

function unavailable(
  request: Extract<ReturnType<typeof parseGitStageControlRequest>, { ok: true }>["value"],
  reason = "control_unavailable",
): GitStageInventoryResult | GitStagePrepareResult | GitStageDecisionResult {
  if (request.method === "git-stage.decide") {
    return { schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, status: "blocked", reason }
  }
  return { schemaVersion: 1, requestId: request.requestId, status: "blocked", reason }
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
