import { timingSafeEqual } from "node:crypto"
import {
  cursorForAstraWorkSessionProjection,
  parseAstraWorkSessionControlRequest,
  parseAstraWorkSessionEventFrame,
  parseAstraWorkSessionSnapshotFrame,
  type AstraWorkSessionControlRequest,
  type AstraWorkSessionEventFrame,
  type AstraWorkSessionSnapshotFrame,
  type AstraWorkSessionTerminalFrame,
} from "@astra/domain/work-session-control"
import type { AstraWorkSessionControl } from "./work-session-control"
import { parseAstraWorkSessionProjection } from "@astra/domain/work-session"

const maximumRequestsPerSession = 1_024

type PublicFrame = AstraWorkSessionSnapshotFrame | AstraWorkSessionEventFrame

export type AstraWorkSessionControlDispatch =
  | Readonly<{ status: "rejected" }>
  | Readonly<{
      status: "accepted"
      requestId: string
      subscription: boolean
      run: (signal: AbortSignal, publish: (frame: PublicFrame) => Promise<void>) => Promise<AstraWorkSessionTerminalFrame>
    }>

export type AstraWorkSessionControlHandler = ReturnType<typeof createAstraWorkSessionControlHandler>

export function createAstraWorkSessionControlHandler(input: Readonly<{
  sessionID: string
  token: string
  control: AstraWorkSessionControl
}>) {
  const usedRequestIDs = new Set<string>()
  return Object.freeze({
    dispatch(candidate: unknown): AstraWorkSessionControlDispatch {
      const parsed = parseAstraWorkSessionControlRequest(candidate)
      if (!parsed.ok || parsed.value.sessionID !== input.sessionID || !sameToken(parsed.value.token, input.token)) {
        return { status: "rejected" }
      }
      const request = parsed.value
      if (usedRequestIDs.has(request.requestId)) return acceptedBlocked(request, "request_replayed")
      if (usedRequestIDs.size >= maximumRequestsPerSession) return acceptedBlocked(request, "control_limit_reached")
      usedRequestIDs.add(request.requestId)
      return {
        status: "accepted",
        requestId: request.requestId,
        subscription: request.method === "work-session.subscribe",
        run: (signal, publish) => run(input.control, request, signal, publish),
      }
    },
  })
}

async function run(
  control: AstraWorkSessionControl,
  request: AstraWorkSessionControlRequest,
  signal: AbortSignal,
  publish: (frame: PublicFrame) => Promise<void>,
): Promise<AstraWorkSessionTerminalFrame> {
  if (request.method === "work-session.decide") {
    await control.decide(request.decisionID, request.outcome)
    return complete(request.requestId)
  }
  if (request.method === "work-session.cancel") {
    await control.cancel()
    return complete(request.requestId)
  }
  const record = await control.snapshot(request.method === "work-session.subscribe" ? request.cursor : undefined)
  const snapshot = requireSnapshot(request.requestId, record.projection)
  await publish(snapshot)
  if (request.method === "work-session.snapshot") return complete(request.requestId)
  await control.subscribe(snapshot.cursor, signal, async (event, projection) => {
    await publish(requireEvent(request.requestId, event, projection))
  })
  return signal.aborted ? complete(request.requestId) : blocked(request.requestId, "state_unavailable")
}

function requireSnapshot(requestId: string, projection: unknown) {
  const verifiedProjection = parseAstraWorkSessionProjection(projection)
  if (!verifiedProjection.ok) throw new Error("Parent work-session snapshot is invalid")
  const parsed = parseAstraWorkSessionSnapshotFrame({
    schemaVersion: 1,
    type: "work-session.snapshot",
    requestId,
    projection: verifiedProjection.value,
    cursor: cursorForAstraWorkSessionProjection(verifiedProjection.value),
  })
  if (!parsed.ok) throw new Error("Parent work-session snapshot is invalid")
  return parsed.value
}

function requireEvent(requestId: string, event: unknown, projection: unknown) {
  const verifiedProjection = parseAstraWorkSessionProjection(projection)
  if (!verifiedProjection.ok) throw new Error("Parent work-session event projection is invalid")
  const parsed = parseAstraWorkSessionEventFrame({
    schemaVersion: 1,
    type: "work-session.event",
    requestId,
    event,
    projection: verifiedProjection.value,
    cursor: cursorForAstraWorkSessionProjection(verifiedProjection.value),
  })
  if (!parsed.ok) throw new Error("Parent work-session event is invalid")
  return parsed.value
}

function acceptedBlocked(request: AstraWorkSessionControlRequest, reason: string): AstraWorkSessionControlDispatch {
  return {
    status: "accepted",
    requestId: request.requestId,
    subscription: false,
    async run() {
      return blocked(request.requestId, reason)
    },
  }
}

function complete(requestId: string): AstraWorkSessionTerminalFrame {
  return { schemaVersion: 1, type: "work-session.terminal", requestId, status: "request_complete" }
}

function blocked(requestId: string, reason: string): AstraWorkSessionTerminalFrame {
  return { schemaVersion: 1, type: "work-session.terminal", requestId, status: "blocked", reason }
}

function sameToken(left: string, right: string) {
  const candidate = Buffer.from(left)
  const expected = Buffer.from(right)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
