import { timingSafeEqual } from "node:crypto"
import {
  parseOperationViewControlRequest,
  parseOperationViewDetailResult,
  parseOperationViewListResult,
  parseOperationViewRecoveryResult,
  type OperationViewDetailResult,
  type OperationViewListResult,
  type OperationViewRecoveryResult,
} from "@astra/domain/operation-view-control"
import type { AstraOperationViewControl } from "./operation-view-control"

const maximumRequestsPerSession = 1_024

export type AstraOperationViewControlResult =
  | OperationViewListResult
  | OperationViewDetailResult
  | OperationViewRecoveryResult

export type AstraOperationViewControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "accepted"; requestId: string; terminal: Promise<AstraOperationViewControlResult> }>

export type AstraOperationViewControlHandler = ReturnType<typeof createAstraOperationViewControlHandler>

/** Authenticates and serializes read-only Operation view requests. */
export function createAstraOperationViewControlHandler(
  input: Readonly<{
    sessionID: string
    token: string
    control: AstraOperationViewControl
    timeoutMs: number
  }>,
) {
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined

  return {
    dispatch(candidate: unknown): AstraOperationViewControlDispatch {
      const parsed = parseOperationViewControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return acceptedBlocked(request, "request_replayed")
      if (usedRequestIDs.size >= maximumRequestsPerSession) return acceptedBlocked(request, "control_limit_reached")
      usedRequestIDs.add(request.requestId)
      if (activeRequestID) return acceptedBlocked(request, "control_busy")

      activeRequestID = request.requestId
      const operation = async () => {
        if (request.method === "operation-view.list") return input.control.list(request.requestId)
        if (request.method === "operation-view.recovery") return input.control.recovery(request.requestId)
        return input.control.detail(request.requestId, request.operationID)
      }
      const terminal = bounded(
        Promise.resolve()
          .then(operation)
          .then((result) => normalizeTerminal(request, result))
          .catch(() => blockedResult(request, "control_unavailable")),
        input.timeoutMs,
        blockedResult(request, "control_response_timed_out"),
      ).finally(() => {
        if (activeRequestID === request.requestId) activeRequestID = undefined
      })
      return { status: "accepted", requestId: request.requestId, terminal }
    },
  }
}

function normalizeTerminal(
  request: Extract<ReturnType<typeof parseOperationViewControlRequest>, { ok: true }>["value"],
  result: AstraOperationViewControlResult,
): AstraOperationViewControlResult {
  if (request.method === "operation-view.list") {
    const parsed = parseOperationViewListResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId
      ? parsed.value
      : blockedResult(request, "protocol_invalid")
  }
  if (request.method === "operation-view.recovery") {
    const parsed = parseOperationViewRecoveryResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId
      ? parsed.value
      : blockedResult(request, "protocol_invalid")
  }
  const parsed = parseOperationViewDetailResult(result)
  return parsed.ok &&
    parsed.value.requestId === request.requestId &&
    (parsed.value.status === "blocked" ||
      (parsed.value.status === "not_found"
        ? parsed.value.operationID === request.operationID
        : parsed.value.operation.operationID === request.operationID))
    ? parsed.value
    : blockedResult(request, "protocol_invalid")
}

function acceptedBlocked(
  request: Extract<ReturnType<typeof parseOperationViewControlRequest>, { ok: true }>["value"],
  reason: string,
): AstraOperationViewControlDispatch {
  return {
    status: "accepted",
    requestId: request.requestId,
    terminal: Promise.resolve(blockedResult(request, reason)),
  }
}

function blockedResult(
  request: Extract<ReturnType<typeof parseOperationViewControlRequest>, { ok: true }>["value"],
  reason: string,
): AstraOperationViewControlResult {
  return { schemaVersion: 1, requestId: request.requestId, status: "blocked", reason }
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

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
