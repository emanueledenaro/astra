import { timingSafeEqual } from "node:crypto"
import {
  parseHostCommandControlRequest,
  parseHostCommandDecisionResult,
  parseHostCommandPrepareResult,
  parseHostCommandProgress,
  type HostCommandDecisionResult,
  type HostCommandPrepareResult,
  type HostCommandProgress,
} from "@astra/domain/host-command-control"
import type { AstraHostCommandControl } from "./host-command-control"

const maximumRequestsPerSession = 1_024

export type AstraHostCommandControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "accepted"
      requestId: string
      terminal: Promise<HostCommandPrepareResult | HostCommandDecisionResult>
    }>

export type AstraHostCommandControlHandler = ReturnType<typeof createAstraHostCommandControlHandler>

/** Authenticates and serializes shell requests while the parent retains all authority. */
export function createAstraHostCommandControlHandler(
  input: Readonly<{ sessionID: string; token: string; control: AstraHostCommandControl }>,
) {
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined

  return {
    dispatch(
      candidate: unknown,
      onProgress: (progress: HostCommandProgress) => void = () => {},
    ): AstraHostCommandControlDispatch {
      const parsed = parseHostCommandControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return acceptedBlocked(request, "request_replayed")
      if (usedRequestIDs.size >= maximumRequestsPerSession) return acceptedBlocked(request, "control_limit_reached")
      usedRequestIDs.add(request.requestId)
      if (activeRequestID) return acceptedBlocked(request, "control_busy")

      activeRequestID = request.requestId
      const progress = (value: HostCommandProgress) => {
        const parsedProgress = parseHostCommandProgress(value)
        if (
          !parsedProgress.ok ||
          request.method !== "host-command.decide" ||
          parsedProgress.value.requestId !== request.requestId ||
          parsedProgress.value.proposalID !== request.proposalID
        )
          return
        onProgress(parsedProgress.value)
      }
      const operation = async () => {
        if (request.method === "host-command.prepare") return input.control.prepare(request.requestId, request.script)
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

type Request = Extract<ReturnType<typeof parseHostCommandControlRequest>, { ok: true }>["value"]

function normalizeTerminal(request: Request, result: HostCommandPrepareResult | HostCommandDecisionResult) {
  if (request.method === "host-command.prepare") {
    const parsed = parseHostCommandPrepareResult(result)
    return parsed.ok && parsed.value.requestId === request.requestId ? parsed.value : unavailable(request)
  }
  const parsed = parseHostCommandDecisionResult(result)
  return parsed.ok && parsed.value.requestId === request.requestId && parsed.value.proposalID === request.proposalID
    ? parsed.value
    : unavailable(request)
}

function acceptedBlocked(request: Request, reason: string): AstraHostCommandControlDispatch {
  return { status: "accepted", requestId: request.requestId, terminal: Promise.resolve(unavailable(request, reason)) }
}

function unavailable(
  request: Request,
  reason = "control_unavailable",
): HostCommandPrepareResult | HostCommandDecisionResult {
  const common = { schemaVersion: 1 as const, requestId: request.requestId, status: "blocked" as const, reason }
  return request.method === "host-command.prepare" ? common : { ...common, proposalID: request.proposalID }
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
