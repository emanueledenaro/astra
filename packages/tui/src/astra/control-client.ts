import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseGitControlInspectionSummary,
  type GitControlInspectionSummary,
} from "@astra/domain/git-control-inspection"

const responseLimitBytes = 8 * 1024
const defaultResponseTimeoutMs = 35_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AstraGitInspectionClient = Readonly<{
  inspect: (options?: Readonly<{ signal?: AbortSignal; onAccepted?: (requestId: string) => void }>) => Promise<
    Readonly<{
      requestId: string
      summary: GitControlInspectionSummary
    }>
  >
  dispose: () => void
}>

export class AstraControlClientError extends Error {
  constructor(
    readonly code: "unavailable" | "busy" | "protocol_invalid" | "transport_failed" | "timed_out" | "cancelled",
  ) {
    super(`Astra control client: ${code}`)
  }
}

/** Creates a lazy client; no socket is opened until `inspect` is called. */
export function createAstraGitInspectionClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{ responseTimeoutMs?: number }> = {},
): AstraGitInspectionClient {
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
  const requestedTimeout = options.responseTimeoutMs
  const timeoutMs =
    typeof requestedTimeout === "number" && Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : defaultResponseTimeoutMs
  let activeRequest: { requestID: string; cancel?: () => void } | undefined

  return {
    inspect(inspectOptions = {}) {
      if (!available || !socketPath || !token) {
        return Promise.reject(new AstraControlClientError("unavailable"))
      }
      if (activeRequest) return Promise.reject(new AstraControlClientError("busy"))
      if (inspectOptions.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))

      const requestID = randomUUID()
      const request: { requestID: string; cancel?: () => void } = { requestID }
      activeRequest = request
      return exchange({ socketPath, token, sessionID, requestID, timeoutMs, ...inspectOptions }, (cancel) => {
        if (activeRequest === request) request.cancel = cancel
      }).finally(() => {
        if (activeRequest === request) activeRequest = undefined
      })
    },
    dispose() {
      const request = activeRequest
      activeRequest = undefined
      request?.cancel?.()
    },
  }
}

type ExchangeInput = Readonly<{
  socketPath: string
  token: string
  sessionID: string
  requestID: string
  timeoutMs: number
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
}>

function exchange(input: ExchangeInput, registerCancel: (cancel: () => void) => void) {
  return new Promise<Readonly<{ requestId: string; summary: GitControlInspectionSummary }>>((complete, reject) => {
    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let accepted = false
    let bytes = 0
    let buffered = ""

    const finish = (
      result:
        | Readonly<{ ok: true; summary: GitControlInspectionSummary }>
        | Readonly<{ ok: false; code: AstraControlClientError["code"] }>,
    ) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
      socket?.destroy()
      if (result.ok) complete({ requestId: input.requestID, summary: result.summary })
      else reject(new AstraControlClientError(result.code))
    }
    const abort = () => finish({ ok: false, code: "cancelled" })
    registerCancel(abort)
    input.signal?.addEventListener("abort", abort, { once: true })
    timeout = setTimeout(() => finish({ ok: false, code: "timed_out" }), input.timeoutMs)

    try {
      socket = createConnection(input.socketPath)
    } catch {
      finish({ ok: false, code: "transport_failed" })
      return
    }
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket?.write(
        JSON.stringify({
          schemaVersion: 1,
          method: "git.inspect",
          requestId: input.requestID,
          sessionID: input.sessionID,
          token: input.token,
        }) + "\n",
      )
    })
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > responseLimitBytes) {
        finish({ ok: false, code: "protocol_invalid" })
        return
      }
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        const message = parseMessage(line, input.requestID)
        if (!message) {
          finish({ ok: false, code: "protocol_invalid" })
          return
        }
        if (message.type === "accepted") {
          if (accepted) {
            finish({ ok: false, code: "protocol_invalid" })
            return
          }
          accepted = true
          try {
            input.onAccepted?.(input.requestID)
          } catch {
            finish({ ok: false, code: "protocol_invalid" })
            return
          }
          continue
        }
        if (!accepted) {
          finish({ ok: false, code: "protocol_invalid" })
          return
        }
        finish({ ok: true, summary: message.summary })
      }
    })
    socket.once("error", () => finish({ ok: false, code: "transport_failed" }))
    socket.once("close", () => {
      if (!settled) finish({ ok: false, code: "transport_failed" })
    })
  })
}

type ControlMessage =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "terminal"; summary: GitControlInspectionSummary }>

function parseMessage(input: string, requestID: string): ControlMessage | null {
  try {
    const value: unknown = JSON.parse(input)
    const record = plainRecord(value)
    if (!record || record.schemaVersion !== 1 || record.requestId !== requestID) return null
    if (record.type === "accepted") {
      return exactKeys(record, ["schemaVersion", "type", "requestId"]) ? { type: "accepted" } : null
    }
    if (record.type !== "terminal" || !exactKeys(record, ["schemaVersion", "type", "requestId", "summary"])) {
      return null
    }
    const summary = parseGitControlInspectionSummary(record.summary)
    return summary.ok ? { type: "terminal", summary: summary.value } : null
  } catch {
    return null
  }
}

function plainRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    record[key] = descriptor.value
  }
  return record
}

function exactKeys(input: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) {
  return Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))
}
