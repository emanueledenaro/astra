import { timingSafeEqual } from "node:crypto"
import {
  parseGitUnstageControlRequest,
  parseGitUnstageDecisionResult,
  parseGitUnstagePrepareResult,
  parseGitUnstageProgress,
  type GitUnstageDecisionResult,
  type GitUnstagePrepareResult,
  type GitUnstageProgress,
} from "@astra/domain/git-unstage-control"
import type { AstraGitUnstageControl } from "./git-unstage-control"

const maximumRequestsPerSession = 1_024

export type AstraGitUnstageControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "accepted"
      requestId: string
      method: "git-unstage.prepare" | "git-unstage.decide"
      terminal: Promise<GitUnstagePrepareResult | GitUnstageDecisionResult>
    }>

export type AstraGitUnstageControlHandler = ReturnType<typeof createAstraGitUnstageControlHandler>

/** Authenticates and serializes the private Git-mutation protocol. Ownership
 * remains active until the parent-side task settles, even if a client leaves. */
export function createAstraGitUnstageControlHandler(
  input: Readonly<{
    sessionID: string
    token: string
    control: AstraGitUnstageControl
  }>,
) {
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined

  return {
    dispatch(
      candidate: unknown,
      onProgress: (progress: GitUnstageProgress) => void = () => {},
    ): AstraGitUnstageControlDispatch {
      const parsed = parseGitUnstageControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) {
        return acceptedBlocked(request, "request_replayed")
      }
      if (usedRequestIDs.size >= maximumRequestsPerSession) {
        return acceptedBlocked(request, "control_limit_reached")
      }
      usedRequestIDs.add(request.requestId)
      if (activeRequestID) return acceptedBlocked(request, "control_busy")

      activeRequestID = request.requestId
      const progress = (value: GitUnstageProgress) => {
        const parsedProgress = parseGitUnstageProgress(value)
        if (
          !parsedProgress.ok ||
          parsedProgress.value.requestId !== request.requestId ||
          request.method !== "git-unstage.decide" ||
          parsedProgress.value.proposalID !== request.proposalID
        ) {
          return
        }
        onProgress(parsedProgress.value)
      }
      const operation = async (): Promise<GitUnstagePrepareResult | GitUnstageDecisionResult> => {
        if (request.method === "git-unstage.prepare") return input.control.prepare(request.requestId)
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
  request: Extract<ReturnType<typeof parseGitUnstageControlRequest>, { ok: true }>["value"],
  result: GitUnstagePrepareResult | GitUnstageDecisionResult,
) {
  if (request.method === "git-unstage.prepare") {
    const parsed = parseGitUnstagePrepareResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId ? parsed.value : unavailable(request)
  }
  const parsed = parseGitUnstageDecisionResult(result)
  return parsed.ok && parsed.value.requestId === request.requestId && parsed.value.proposalID === request.proposalID
    ? parsed.value
    : unavailable(request)
}

function acceptedBlocked(
  request: Extract<ReturnType<typeof parseGitUnstageControlRequest>, { ok: true }>["value"],
  reason: string,
): AstraGitUnstageControlDispatch {
  const terminal = Promise.resolve(
    request.method === "git-unstage.prepare"
      ? ({ schemaVersion: 1, requestId: request.requestId, status: "blocked", reason } as const)
      : ({
          schemaVersion: 1,
          requestId: request.requestId,
          proposalID: request.proposalID,
          status: "blocked",
          reason,
        } as const),
  )
  return { status: "accepted", requestId: request.requestId, method: request.method, terminal }
}

function unavailable(
  request: Extract<ReturnType<typeof parseGitUnstageControlRequest>, { ok: true }>["value"],
): GitUnstagePrepareResult | GitUnstageDecisionResult {
  if (request.method === "git-unstage.prepare") {
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
