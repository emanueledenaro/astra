import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseControlledWriteDecisionResult,
  parseControlledWritePrepareResult,
  parseControlledWriteProgress,
  type ControlledWriteDecisionResult,
  type ControlledWritePrepareResult,
  type ControlledWriteProgress,
} from "@astra/domain/controlled-write-control"
import { AstraControlClientError } from "./control-client"

const responseLimitBytes = 32 * 1024
const defaultResponseTimeoutMs = 65_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RequestOptions = Readonly<{
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
}>

export type AstraControlledWriteClient = Readonly<{
  prepare: (options?: RequestOptions) => Promise<ControlledWritePrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    options?: RequestOptions & Readonly<{ onProgress?: (progress: ControlledWriteProgress) => void }>,
  ) => Promise<ControlledWriteDecisionResult>
  dispose: () => void
}>

/** Creates a lazy path-free client for the parent-owned controlled write. */
export function createAstraControlledWriteClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{ responseTimeoutMs?: number }> = {},
): AstraControlledWriteClient {
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
  let activeRequest: { cancel?: () => void } | undefined
  const preparedOperations = new Map<string, PreparedBinding>()

  function request<Result>(
    body: Readonly<Record<string, unknown>>,
    parseTerminal: (input: unknown) => Result | null,
    requestOptions: RequestOptions & Readonly<{ onProgress?: (progress: ControlledWriteProgress) => void }>,
    allowProgress: boolean,
    expectedBinding?: PreparedBinding,
  ) {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if (activeRequest) return Promise.reject(new AstraControlClientError("busy"))
    if (requestOptions.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))

    const requestID = randomUUID()
    const active: { cancel?: () => void } = {}
    activeRequest = active
    return exchange<Result>(
      {
        socketPath,
        timeoutMs,
        requestID,
        body: { schemaVersion: 1, requestId: requestID, sessionID, token, ...body },
        parseTerminal,
        allowProgress,
        expectedBinding,
        ...requestOptions,
      },
      (cancel) => {
        if (activeRequest === active) active.cancel = cancel
      },
    ).finally(() => {
      if (activeRequest === active) activeRequest = undefined
    })
  }

  return {
    prepare(requestOptions = {}) {
      return request(
        { method: "controlled-write.prepare" },
        (input) => {
          const parsed = parseControlledWritePrepareResult(input)
          return parsed.ok ? parsed.value : null
        },
        requestOptions,
        false,
      ).then((result) => {
        if (result.status === "prepared") {
          preparedOperations.set(result.preview.proposalID, {
            proposalID: result.preview.proposalID,
            operationID: result.preview.operationID,
            relativeTarget: result.preview.resource.relativeTarget,
            bytes: result.preview.resource.bytes,
            contentDigest: result.preview.resource.contentDigest,
          })
        }
        return result
      })
    },
    decide(proposalID, decision, requestOptions = {}) {
      if (!uuidPattern.test(proposalID)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      const expected = preparedOperations.get(proposalID)
      if (!expected) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request(
        { method: "controlled-write.decide", proposalID, decision },
        (input) => {
          const parsed = parseControlledWriteDecisionResult(input)
          if (!parsed.ok || parsed.value.proposalID !== proposalID) return null
          if ("operationID" in parsed.value && parsed.value.operationID !== expected.operationID) return null
          return parsed.value
        },
        requestOptions,
        true,
        expected,
      ).finally(() => preparedOperations.delete(proposalID))
    },
    dispose() {
      const active = activeRequest
      activeRequest = undefined
      active?.cancel?.()
    },
  }
}

type ExchangeInput<Result> = Readonly<{
  socketPath: string
  timeoutMs: number
  requestID: string
  body: Readonly<Record<string, unknown>>
  parseTerminal: (input: unknown) => Result | null
  allowProgress: boolean
  expectedBinding?: PreparedBinding
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
  onProgress?: (progress: ControlledWriteProgress) => void
}>

function exchange<Result>(input: ExchangeInput<Result>, registerCancel: (cancel: () => void) => void) {
  return new Promise<Result>((complete, reject) => {
    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let accepted = false
    let progressIndex = 0
    let observedReceiptID: string | undefined
    let bytes = 0
    let buffered = ""

    const finish = (
      result: Readonly<{ ok: true; value: Result }> | Readonly<{ ok: false; code: AstraControlClientError["code"] }>,
    ) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
      socket?.destroy()
      if (result.ok) complete(result.value)
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
    socket.once("connect", () => socket?.write(JSON.stringify(input.body) + "\n"))
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > responseLimitBytes) return finish({ ok: false, code: "protocol_invalid" })
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        const message = parseMessage(line, input.requestID, input.parseTerminal)
        if (!message) return finish({ ok: false, code: "protocol_invalid" })
        if (message.type === "accepted") {
          if (accepted) return finish({ ok: false, code: "protocol_invalid" })
          accepted = true
          try {
            input.onAccepted?.(input.requestID)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        if (!accepted) return finish({ ok: false, code: "protocol_invalid" })
        if (message.type === "progress") {
          const expectedStatus = progressOrder[progressIndex]
          if (
            !input.allowProgress ||
            message.progress.status !== expectedStatus ||
            message.progress.proposalID !== input.expectedBinding?.proposalID ||
            (input.expectedBinding?.operationID !== undefined &&
              message.progress.operationID !== input.expectedBinding.operationID)
          ) {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          progressIndex++
          if (message.progress.status === "effect_observed_not_verified") {
            observedReceiptID = message.progress.receiptID
          }
          try {
            input.onProgress?.(message.progress)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        if (!terminalRequestMatches(message.result, input.requestID)) {
          return finish({ ok: false, code: "protocol_invalid" })
        }
        if (
          terminalClaimsVerified(message.result) &&
          (progressIndex !== progressOrder.length ||
            !verifiedTerminalMatches(message.result, input.expectedBinding, observedReceiptID))
        ) {
          return finish({ ok: false, code: "protocol_invalid" })
        }
        finish({ ok: true, value: message.result })
      }
    })
    socket.once("error", () => finish({ ok: false, code: "transport_failed" }))
    socket.once("close", () => {
      if (!settled) finish({ ok: false, code: "transport_failed" })
    })
  })
}

const progressOrder = [
  "recording_authority",
  "host_adapter_validating",
  "effect_observed_not_verified",
  "verifying",
] as const

function terminalClaimsVerified(input: unknown) {
  const record = plainRecord(input)
  return record?.status === "verified"
}

function terminalRequestMatches(input: unknown, requestID: string) {
  return plainRecord(input)?.requestId === requestID
}

function verifiedTerminalMatches(
  input: unknown,
  expected: PreparedBinding | undefined,
  observedReceiptID: string | undefined,
) {
  const result = plainRecord(input)
  const readback = plainRecord(result?.readback)
  return (
    expected !== undefined &&
    result?.operationID === expected.operationID &&
    result?.proposalID === expected.proposalID &&
    result?.receiptID === observedReceiptID &&
    readback?.relativeTarget === expected.relativeTarget &&
    readback?.bytes === expected.bytes &&
    readback?.contentDigest === expected.contentDigest
  )
}

type PreparedBinding = Readonly<{
  proposalID: string
  operationID: string
  relativeTarget: string
  bytes: number
  contentDigest: string
}>

type ControlMessage<Result> =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "progress"; progress: ControlledWriteProgress }>
  | Readonly<{ type: "terminal"; result: Result }>

function parseMessage<Result>(
  input: string,
  requestID: string,
  parseTerminal: (input: unknown) => Result | null,
): ControlMessage<Result> | null {
  try {
    const record = plainRecord(JSON.parse(input))
    if (!record || record.schemaVersion !== 1 || record.requestId !== requestID) return null
    if (record.type === "accepted") {
      return exactKeys(record, ["schemaVersion", "type", "requestId"]) ? { type: "accepted" } : null
    }
    if (record.type === "controlled-write.progress") {
      if (!exactKeys(record, ["schemaVersion", "type", "requestId", "progress"])) return null
      const parsed = parseControlledWriteProgress(record.progress)
      return parsed.ok && parsed.value.requestId === requestID ? { type: "progress", progress: parsed.value } : null
    }
    if (
      record.type !== "controlled-write.terminal" ||
      !exactKeys(record, ["schemaVersion", "type", "requestId", "result"])
    ) {
      return null
    }
    const result = parseTerminal(record.result)
    return result ? { type: "terminal", result } : null
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
