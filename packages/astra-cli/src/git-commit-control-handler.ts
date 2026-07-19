import { timingSafeEqual } from "node:crypto"
import {
  parseGitCommitControlRequest,
  parseGitCommitDecisionResult,
  parseGitCommitPrepareResult,
  parseGitCommitProgress,
  type GitCommitDecisionResult,
  type GitCommitPrepareResult,
  type GitCommitProgress,
} from "../../astra-domain/src/git-commit-control"
import type { AstraGitCommitControl } from "./git-commit-control"

const maximumRequestsPerSession = 1_024

export type AstraGitCommitControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "accepted"
      requestId: string
      method: "git-commit.prepare" | "git-commit.decide"
      terminal: Promise<GitCommitPrepareResult | GitCommitDecisionResult>
    }>

export type AstraGitCommitControlHandler = ReturnType<typeof createAstraGitCommitControlHandler>

/** Authenticates and serializes the private Commit-staged protocol. */
export function createAstraGitCommitControlHandler(
  input: Readonly<{
    sessionID: string
    token: string
    control: AstraGitCommitControl
  }>,
) {
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined

  return {
    dispatch(
      candidate: unknown,
      onProgress: (progress: GitCommitProgress) => void = () => {},
    ): AstraGitCommitControlDispatch {
      const parsed = parseGitCommitControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return acceptedBlocked(request, "request_replayed")
      if (usedRequestIDs.size >= maximumRequestsPerSession) return acceptedBlocked(request, "control_limit_reached")
      usedRequestIDs.add(request.requestId)
      if (activeRequestID) return acceptedBlocked(request, "control_busy")

      activeRequestID = request.requestId
      const progress = (value: GitCommitProgress) => {
        const parsedProgress = parseGitCommitProgress(value)
        if (
          !parsedProgress.ok ||
          request.method !== "git-commit.decide" ||
          parsedProgress.value.requestId !== request.requestId ||
          parsedProgress.value.proposalID !== request.proposalID
        )
          return
        onProgress(parsedProgress.value)
      }
      const operation = async () => {
        if (request.method === "git-commit.prepare") return input.control.prepare(request.requestId, request.message)
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
  request: Extract<ReturnType<typeof parseGitCommitControlRequest>, { ok: true }>["value"],
  result: GitCommitPrepareResult | GitCommitDecisionResult,
) {
  if (request.method === "git-commit.prepare") {
    const parsed = parseGitCommitPrepareResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId ? parsed.value : unavailable(request)
  }
  const parsed = parseGitCommitDecisionResult(result)
  return parsed.ok && parsed.value.requestId === request.requestId && parsed.value.proposalID === request.proposalID
    ? parsed.value
    : unavailable(request)
}

function acceptedBlocked(
  request: Extract<ReturnType<typeof parseGitCommitControlRequest>, { ok: true }>["value"],
  reason: string,
): AstraGitCommitControlDispatch {
  const terminal = Promise.resolve(unavailable(request, reason))
  return { status: "accepted", requestId: request.requestId, method: request.method, terminal }
}

function unavailable(
  request: Extract<ReturnType<typeof parseGitCommitControlRequest>, { ok: true }>["value"],
  reason = "control_unavailable",
): GitCommitPrepareResult | GitCommitDecisionResult {
  if (request.method === "git-commit.decide") {
    return { schemaVersion: 1, requestId: request.requestId, proposalID: request.proposalID, status: "blocked", reason }
  }
  return { schemaVersion: 1, requestId: request.requestId, status: "blocked", reason }
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
