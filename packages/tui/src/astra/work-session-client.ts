import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  cursorForAstraWorkSessionProjection,
  parseAstraWorkSessionAcceptedFrame,
  parseAstraWorkSessionEventFrame,
  parseAstraWorkSessionSnapshotFrame,
  parseAstraWorkSessionTerminalFrame,
  workSessionControlFrameLimitBytes,
  type AstraWorkSessionCursor,
  type AstraWorkSessionTerminalFrame,
} from "@astra/domain/work-session-control"
import { projectAstraWorkSessionEvent, type AstraWorkSessionProjection } from "@astra/domain/work-session"
import { AstraControlClientError } from "./control-client"

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const defaultTimeoutMs = 15_000
const defaultMaximumQueuedFrames = 32

export type AstraWorkSessionView =
  | Readonly<{
      status: "available"
      projection: AstraWorkSessionProjection
      cursor: AstraWorkSessionCursor
    }>
  | Readonly<{
      status: "state_unavailable"
      reason:
        | "transport_failed"
        | "protocol_invalid"
        | "backpressure_overflow"
        | "consumer_failed"
        | "timed_out"
        | "cancelled"
    }>

export type AstraWorkSessionClient = Readonly<{
  snapshot: () => Promise<AstraWorkSessionView>
  subscribe: (
    consumer: (view: AstraWorkSessionView) => void | Promise<void>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<void>
  decide: (decisionID: string, outcome: "approved" | "rejected") => Promise<AstraWorkSessionTerminalFrame>
  cancel: () => Promise<AstraWorkSessionTerminalFrame>
  dispose: () => void
}>

/** Lazy client for parent-owned work state. It validates, but never derives, a business phase. */
export function createAstraWorkSessionClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{ responseTimeoutMs?: number; maximumQueuedFrames?: number }> = {},
): AstraWorkSessionClient {
  const socketPath = environment.ASTRA_CONTROL_SOCKET
  const token = environment.ASTRA_CONTROL_TOKEN
  const available =
    typeof socketPath === "string" &&
    isAbsolute(socketPath) &&
    Buffer.byteLength(socketPath) <= 100 &&
    !/\p{C}/u.test(socketPath) &&
    typeof token === "string" &&
    tokenPattern.test(token) &&
    uuidPattern.test(sessionID)
  const timeoutMs = positiveInteger(options.responseTimeoutMs) ?? defaultTimeoutMs
  const maximumQueuedFrames = positiveInteger(options.maximumQueuedFrames) ?? defaultMaximumQueuedFrames
  const active = new Set<() => void>()
  let latest: Extract<AstraWorkSessionView, { status: "available" }> | undefined

  const authority = () => {
    if (!available || !socketPath || !token) throw new AstraControlClientError("unavailable")
    return { socketPath, token, sessionID, timeoutMs }
  }

  const snapshot = async () => {
    try {
      const result = await exchangeSnapshot(authority(), register(active))
      latest = result
      return result
    } catch (cause) {
      return unavailableView(cause)
    }
  }

  return {
    snapshot,
    async subscribe(consumer, subscriptionOptions = {}) {
      if (subscriptionOptions.signal?.aborted) return
      const current = latest ?? (await snapshot())
      if (current.status !== "available") {
        await safelyNotify(consumer, current)
        throw errorForUnavailable(current)
      }
      if (subscriptionOptions.signal?.aborted) {
        await safelyNotify(consumer, { status: "state_unavailable", reason: "cancelled" })
        return
      }
      try {
        await exchangeSubscription(
          {
            ...authority(),
            cursor: current.cursor,
            signal: subscriptionOptions.signal,
            maximumQueuedFrames,
            consumer: async (view) => {
              if (view.status === "available") latest = view
              await consumer(view)
            },
          },
          register(active),
        )
      } catch (cause) {
        if (cause instanceof AstraControlClientError && cause.code === "cancelled") return
        const view = unavailableView(cause)
        await safelyNotify(consumer, view)
        throw cause
      }
    },
    decide(decisionID, outcome) {
      if (!safeIdentifier(decisionID)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return exchangeTerminal(
        authority(),
        { method: "work-session.decide", decisionID, outcome },
        register(active),
      )
    },
    cancel() {
      return exchangeTerminal(authority(), { method: "work-session.cancel" }, register(active))
    },
    dispose() {
      const requests = [...active]
      active.clear()
      requests.forEach((cancel) => cancel())
    },
  }
}

type Authority = Readonly<{ socketPath: string; token: string; sessionID: string; timeoutMs: number }>

type RegisterCancel = (cancel: () => void) => () => void

function exchangeSnapshot(input: Authority, registerCancel: RegisterCancel) {
  const requestId = randomUUID()
  return new Promise<Extract<AstraWorkSessionView, { status: "available" }>>((resolve, reject) => {
    let accepted = false
    let snapshot: Extract<AstraWorkSessionView, { status: "available" }> | undefined
    const exchange = createExchange(input, requestId, registerCancel, reject, (value) => {
      const acceptedFrame = parseAstraWorkSessionAcceptedFrame(value)
      if (acceptedFrame.ok) {
        if (accepted) return exchange.fail("protocol_invalid")
        accepted = true
        return
      }
      const snapshotFrame = parseAstraWorkSessionSnapshotFrame(value)
      if (snapshotFrame.ok) {
        if (!accepted || snapshot) return exchange.fail("protocol_invalid")
        snapshot = { status: "available", projection: snapshotFrame.value.projection, cursor: snapshotFrame.value.cursor }
        return
      }
      const terminal = parseAstraWorkSessionTerminalFrame(value)
      if (!terminal.ok || !accepted || !snapshot || terminal.value.status !== "request_complete") {
        return exchange.fail("protocol_invalid")
      }
      const result = snapshot
      exchange.complete(() => resolve(result))
    })
    exchange.connect({ schemaVersion: 1, method: "work-session.snapshot", requestId, sessionID: input.sessionID, token: input.token })
  })
}

function exchangeTerminal(
  input: Authority,
  body:
    | Readonly<{ method: "work-session.decide"; decisionID: string; outcome: "approved" | "rejected" }>
    | Readonly<{ method: "work-session.cancel" }>,
  registerCancel: RegisterCancel,
) {
  const requestId = randomUUID()
  return new Promise<AstraWorkSessionTerminalFrame>((resolve, reject) => {
    let accepted = false
    const exchange = createExchange(input, requestId, registerCancel, reject, (value) => {
      const acceptedFrame = parseAstraWorkSessionAcceptedFrame(value)
      if (acceptedFrame.ok) {
        if (accepted) return exchange.fail("protocol_invalid")
        accepted = true
        return
      }
      const terminal = parseAstraWorkSessionTerminalFrame(value)
      if (!terminal.ok || !accepted) return exchange.fail("protocol_invalid")
      exchange.complete(() => resolve(terminal.value))
    })
    exchange.connect({ schemaVersion: 1, requestId, sessionID: input.sessionID, token: input.token, ...body })
  })
}

type SubscriptionInput = Authority &
  Readonly<{
    cursor: AstraWorkSessionCursor
    signal?: AbortSignal
    maximumQueuedFrames: number
    consumer: (view: AstraWorkSessionView) => Promise<void>
  }>

function exchangeSubscription(input: SubscriptionInput, registerCancel: RegisterCancel) {
  if (input.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))
  const requestId = randomUUID()
  return new Promise<void>((resolve, reject) => {
    let socket: Socket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let accepted = false
    let snapshot = false
    let current: AstraWorkSessionProjection | undefined
    let buffered = ""
    const queue: unknown[] = []
    let draining = false
    let unregister = () => {}

    const finish = (
      result: "cancelled" | AstraControlClientError["code"] | null,
      stateReason?: Extract<AstraWorkSessionView, { status: "state_unavailable" }>["reason"],
    ) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unregister()
      input.signal?.removeEventListener("abort", abort)
      socket?.destroy()
      if (result === null || result === "cancelled") resolve()
      else reject(stateReason ? new SubscriptionFailure(result, stateReason) : new AstraControlClientError(result))
    }
    const abort = () => finish("cancelled")
    unregister = registerCancel(abort)
    input.signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => finish("timed_out"), input.timeoutMs)
    const drain = async () => {
      if (draining || settled) return
      draining = true
      while (queue.length > 0 && !settled) {
        const value = queue.shift()
        const acceptedFrame = parseAstraWorkSessionAcceptedFrame(value)
        if (acceptedFrame.ok) {
          if (accepted) return finish("protocol_invalid")
          accepted = true
          continue
        }
        const snapshotFrame = parseAstraWorkSessionSnapshotFrame(value)
        if (snapshotFrame.ok) {
          if (!accepted || snapshot) return finish("protocol_invalid")
          snapshot = true
          if (timer) clearTimeout(timer)
          timer = undefined
          current = snapshotFrame.value.projection
          try {
            await input.consumer({
              status: "available",
              projection: snapshotFrame.value.projection,
              cursor: snapshotFrame.value.cursor,
            })
          } catch {
            return finishConsumerFailure(finish, input.consumer)
          }
          continue
        }
        const eventFrame = parseAstraWorkSessionEventFrame(value)
        if (!eventFrame.ok || !accepted || !snapshot || !current) return finish("protocol_invalid")
        if (
          eventFrame.value.event.sequence !== current.sequence + 1 ||
          eventFrame.value.event.previousDigest !== current.lastEventDigest ||
          eventFrame.value.event.sessionID !== current.sessionID
        ) {
          return finish("protocol_invalid")
        }
        const projected = projectAstraWorkSessionEvent(current, eventFrame.value.event)
        if (!projected.ok || projected.value.projectionDigest !== eventFrame.value.projection.projectionDigest) {
          return finish("protocol_invalid")
        }
        current = eventFrame.value.projection
        try {
          await input.consumer({
            status: "available",
            projection: eventFrame.value.projection,
            cursor: eventFrame.value.cursor,
          })
        } catch {
          return finishConsumerFailure(finish, input.consumer)
        }
      }
      draining = false
    }

    try {
      socket = createConnection(input.socketPath)
    } catch {
      finish("transport_failed")
      return
    }
    socket.setEncoding("utf8")
    socket.once("connect", () =>
      socket?.write(
        `${JSON.stringify({
          schemaVersion: 1,
          method: "work-session.subscribe",
          requestId,
          sessionID: input.sessionID,
          token: input.token,
          cursor: input.cursor,
        })}\n`,
      ),
    )
    socket.on("data", (chunk: string) => {
      buffered += chunk
      if (Buffer.byteLength(buffered) > workSessionControlFrameLimitBytes) return finish("protocol_invalid")
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        if (Buffer.byteLength(line) > workSessionControlFrameLimitBytes) return finish("protocol_invalid")
        const value = decode(line)
        if (!value || value.requestId !== requestId) return finish("protocol_invalid")
        queue.push(value)
        if (queue.length > input.maximumQueuedFrames) return finishBackpressure(finish, input.consumer)
      }
      void drain()
    })
    socket.once("error", () => finish("transport_failed"))
    socket.once("close", () => {
      if (!settled) finish("transport_failed")
    })
  })
}

function createExchange(
  input: Authority,
  requestId: string,
  registerCancel: RegisterCancel,
  reject: (reason: AstraControlClientError) => void,
  consume: (value: Record<string, unknown>) => void,
) {
  let socket: Socket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let buffered = ""
  let unregister = () => {}
  let terminalComplete: (() => void) | undefined
  const finish = (code: AstraControlClientError["code"] | null, complete?: () => void) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    unregister()
    socket?.destroy()
    if (code) reject(new AstraControlClientError(code))
    else complete?.()
  }
  unregister = registerCancel(() => finish("cancelled"))
  timer = setTimeout(() => finish("timed_out"), input.timeoutMs)
  return {
    connect(body: Readonly<Record<string, unknown>>) {
      try {
        socket = createConnection(input.socketPath)
      } catch {
        finish("transport_failed")
        return
      }
      socket.setEncoding("utf8")
      socket.once("connect", () => socket?.write(`${JSON.stringify(body)}\n`))
      socket.on("data", (chunk: string) => {
        buffered += chunk
        if (Buffer.byteLength(buffered) > workSessionControlFrameLimitBytes) return finish("protocol_invalid")
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          if (terminalComplete) return finish("protocol_invalid")
          const value = decode(line)
          if (!value || value.requestId !== requestId) return finish("protocol_invalid")
          consume(value)
        }
        if (terminalComplete && buffered.length > 0) finish("protocol_invalid")
      })
      socket.once("error", () => finish("transport_failed"))
      socket.once("end", () => {
        if (settled) return
        if (!terminalComplete || buffered.length > 0) return finish("protocol_invalid")
        finish(null, terminalComplete)
      })
      socket.once("close", () => {
        if (!settled) finish("transport_failed")
      })
    },
    fail(code: AstraControlClientError["code"]) {
      finish(code)
    },
    complete(complete: () => void) {
      if (terminalComplete) {
        finish("protocol_invalid")
        return
      }
      terminalComplete = complete
    },
  }
}

function unavailableView(cause: unknown): Extract<AstraWorkSessionView, { status: "state_unavailable" }> {
  if (cause instanceof SubscriptionFailure) return { status: "state_unavailable", reason: cause.stateReason }
  const code = cause instanceof AstraControlClientError ? cause.code : "protocol_invalid"
  const reason = code === "timed_out" ? "timed_out" : code === "transport_failed" ? "transport_failed" : "protocol_invalid"
  return { status: "state_unavailable", reason }
}

function errorForUnavailable(view: Extract<AstraWorkSessionView, { status: "state_unavailable" }>) {
  if (view.reason === "transport_failed") return new AstraControlClientError("transport_failed")
  if (view.reason === "timed_out") return new AstraControlClientError("timed_out")
  if (view.reason === "cancelled") return new AstraControlClientError("cancelled")
  return new AstraControlClientError("protocol_invalid")
}

async function safelyNotify(consumer: (view: AstraWorkSessionView) => void | Promise<void>, view: AstraWorkSessionView) {
  try {
    await consumer(view)
  } catch {
    // The state is already unavailable; a failing renderer cannot weaken it.
  }
}

function finishBackpressure(
  finish: (
    result: "cancelled" | AstraControlClientError["code"] | null,
    reason?: Extract<AstraWorkSessionView, { status: "state_unavailable" }>["reason"],
  ) => void,
  _consumer: (view: AstraWorkSessionView) => Promise<void>,
) {
  finish("protocol_invalid", "backpressure_overflow")
}

function finishConsumerFailure(
  finish: (
    result: "cancelled" | AstraControlClientError["code"] | null,
    reason?: Extract<AstraWorkSessionView, { status: "state_unavailable" }>["reason"],
  ) => void,
  _consumer: (view: AstraWorkSessionView) => Promise<void>,
) {
  finish("protocol_invalid", "consumer_failed")
}

class SubscriptionFailure extends AstraControlClientError {
  constructor(
    code: AstraControlClientError["code"],
    readonly stateReason: Extract<AstraWorkSessionView, { status: "state_unavailable" }>["reason"],
  ) {
    super(code)
  }
}

function register(active: Set<() => void>) {
  return (cancel: () => void) => {
    const wrapped = () => {
      active.delete(wrapped)
      cancel()
    }
    active.add(wrapped)
    return () => active.delete(wrapped)
  }
}

function decode(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function positiveInteger(input: unknown) {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 ? input : null
}

function safeIdentifier(input: string) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._:@/-]{0,255}$/u.test(input) && !/\p{C}/u.test(input)
}
