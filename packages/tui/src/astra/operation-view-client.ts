import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseOperationViewDetailResult,
  parseOperationViewListResult,
  parseOperationViewRecoveryResult,
  type OperationViewDetailResult,
  type OperationViewListResult,
  type OperationViewRecoveryResult,
} from "@astra/domain/operation-view-control"
import { AstraControlClientError } from "./control-client"

const responseLimitBytes = 512 * 1024
const defaultResponseTimeoutMs = 15_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AstraOperationViewClient = Readonly<{
  list: () => Promise<OperationViewListResult>
  detail: (operationID: string) => Promise<OperationViewDetailResult>
  recovery: () => Promise<OperationViewRecoveryResult>
  dispose: () => void
}>

/**
 * Read-only client for the parent's durable Operation ledger projection.
 * Fails closed without the private control socket environment; the protocol
 * carries no mutation, path, or filter field.
 */
export function createAstraOperationViewClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  responseTimeoutMs = defaultResponseTimeoutMs,
): AstraOperationViewClient {
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
  let cancel: (() => void) | undefined

  const request = <Result>(
    input: Readonly<{
      method: "operation-view.list" | "operation-view.detail" | "operation-view.recovery"
      operationID?: string
      parse: (value: unknown) => Result | null
    }>,
  ) => {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if (cancel) return Promise.reject(new AstraControlClientError("busy"))
    const requestId = randomUUID()
    return exchange(
      {
        ...input,
        socketPath,
        token,
        sessionID,
        requestId,
        timeoutMs:
          Number.isSafeInteger(responseTimeoutMs) && responseTimeoutMs > 0
            ? responseTimeoutMs
            : defaultResponseTimeoutMs,
      },
      (dispose) => {
        cancel = dispose
      },
    ).finally(() => {
      cancel = undefined
    })
  }

  return {
    list() {
      return request({
        method: "operation-view.list",
        parse(value) {
          const parsed = parseOperationViewListResult(value)
          return parsed.ok ? parsed.value : null
        },
      })
    },
    detail(operationID) {
      if (!uuidPattern.test(operationID)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request({
        method: "operation-view.detail",
        operationID,
        parse(value) {
          const parsed = parseOperationViewDetailResult(value)
          if (!parsed.ok) return null
          if (parsed.value.status === "not_found" && parsed.value.operationID !== operationID) return null
          if (parsed.value.status === "detailed" && parsed.value.operation.operationID !== operationID) return null
          return parsed.value
        },
      })
    },
    recovery() {
      return request({
        method: "operation-view.recovery",
        parse(value) {
          const parsed = parseOperationViewRecoveryResult(value)
          return parsed.ok ? parsed.value : null
        },
      })
    },
    dispose() {
      cancel?.()
      cancel = undefined
    },
  }
}

type ExchangeInput<Result> = Readonly<{
  socketPath: string
  token: string
  sessionID: string
  requestId: string
  timeoutMs: number
  method: "operation-view.list" | "operation-view.detail" | "operation-view.recovery"
  operationID?: string
  parse: (value: unknown) => Result | null
}>

function exchange<Result>(input: ExchangeInput<Result>, registerCancel: (cancel: () => void) => void) {
  return new Promise<Result>((complete, reject) => {
    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let bytes = 0
    let buffered = ""
    let accepted = false
    let settled = false
    const finish = (result: Result | AstraControlClientError) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      socket?.destroy()
      if (result instanceof AstraControlClientError) reject(result)
      else complete(result)
    }
    registerCancel(() => finish(new AstraControlClientError("cancelled")))
    timeout = setTimeout(() => finish(new AstraControlClientError("timed_out")), input.timeoutMs)
    try {
      socket = createConnection(input.socketPath)
    } catch {
      finish(new AstraControlClientError("transport_failed"))
      return
    }
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket?.write(
        JSON.stringify({
          schemaVersion: 1,
          method: input.method,
          requestId: input.requestId,
          sessionID: input.sessionID,
          token: input.token,
          ...(input.method === "operation-view.detail" ? { operationID: input.operationID } : {}),
        }) + "\n",
      )
    })
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > responseLimitBytes) return finish(new AstraControlClientError("protocol_invalid"))
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        const frame = parseFrame(line, input.requestId, input.parse)
        if (!frame) return finish(new AstraControlClientError("protocol_invalid"))
        if (frame.type === "accepted") {
          if (accepted) return finish(new AstraControlClientError("protocol_invalid"))
          accepted = true
          continue
        }
        if (!accepted) return finish(new AstraControlClientError("protocol_invalid"))
        finish(frame.result)
      }
    })
    socket.once("error", () => finish(new AstraControlClientError("transport_failed")))
    socket.once("end", () => {
      if (!settled) finish(new AstraControlClientError("transport_failed"))
    })
  })
}

function parseFrame<Result>(line: string, requestId: string, parse: (value: unknown) => Result | null) {
  try {
    const value: unknown = JSON.parse(line)
    if (!record(value) || value.schemaVersion !== 1 || value.requestId !== requestId) return null
    if (value.type === "accepted" && Object.keys(value).length === 3) return { type: "accepted" as const }
    if (value.type !== "operation-view.terminal" || Object.keys(value).length !== 4) return null
    const result = parse(value.result)
    return result ? { type: "terminal" as const, result } : null
  } catch {
    return null
  }
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
