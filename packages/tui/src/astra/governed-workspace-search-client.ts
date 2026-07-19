import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseWorkspaceSearchDecisionResult,
  parseWorkspaceSearchPrepareResult,
  parseWorkspaceSearchProgress,
  type WorkspaceSearchDecisionResult,
  type WorkspaceSearchPrepareResult,
  type WorkspaceSearchProgress,
} from "@astra/domain/governed-workspace-search-control"
import { AstraControlClientError } from "./control-client"

const responseLimitBytes = 64 * 1024
const defaultResponseTimeoutMs = 65_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RequestOptions = Readonly<{
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
}>

export type AstraGovernedWorkspaceSearchClient = Readonly<{
  prepare: (query: string, options?: RequestOptions) => Promise<WorkspaceSearchPrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    options?: RequestOptions & Readonly<{ onProgress?: (progress: WorkspaceSearchProgress) => void }>,
  ) => Promise<WorkspaceSearchDecisionResult>
  dispose: () => void
}>

/** Creates a lazy client whose prepare request carries only a literal query. */
export function createAstraGovernedWorkspaceSearchClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{ responseTimeoutMs?: number; expectedWorkspaceRoot?: string }> = {},
): AstraGovernedWorkspaceSearchClient {
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
  const prepared = new Map<string, PreparedBinding>()

  function request<Result>(input: ExchangeInput<Result>) {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if (activeRequest) return Promise.reject(new AstraControlClientError("busy"))
    if (input.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))
    const requestID = randomUUID()
    const active: { cancel?: () => void } = {}
    activeRequest = active
    return exchange({ ...input, socketPath, token, sessionID, requestID, timeoutMs }, (cancel) => {
      if (activeRequest === active) active.cancel = cancel
    }).finally(() => {
      if (activeRequest === active) activeRequest = undefined
    })
  }

  return {
    prepare(query, requestOptions = {}) {
      if (!validQuery(query)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request({
        method: "search.prepare",
        query,
        parseTerminal(input) {
          const parsed = parseWorkspaceSearchPrepareResult(input)
          return parsed.ok ? parsed.value : null
        },
        ...requestOptions,
      }).then((result) => {
        if (result.status === "prepared") {
          if (
            options.expectedWorkspaceRoot !== undefined &&
            result.preview.workspaceRoot !== options.expectedWorkspaceRoot
          ) {
            throw new AstraControlClientError("protocol_invalid")
          }
          prepared.set(result.preview.proposalID, {
            operationID: result.preview.operationID,
            capabilityDigest: result.preview.capabilityDigest,
          })
        }
        return result
      })
    },
    decide(proposalID, decision, requestOptions = {}) {
      if (!uuidPattern.test(proposalID)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      const binding = prepared.get(proposalID)
      if (!binding) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request({
        method: "search.decide",
        proposalID,
        decision,
        binding,
        parseTerminal(input) {
          const parsed = parseWorkspaceSearchDecisionResult(input)
          if (!parsed.ok || parsed.value.proposalID !== proposalID) return null
          if (
            "operationID" in parsed.value &&
            (parsed.value.operationID !== binding.operationID ||
              parsed.value.capabilityDigest !== binding.capabilityDigest)
          )
            return null
          return parsed.value
        },
        ...requestOptions,
      }).finally(() => prepared.delete(proposalID))
    },
    dispose() {
      const active = activeRequest
      activeRequest = undefined
      active?.cancel?.()
    },
  }
}

type PreparedBinding = Readonly<{ operationID: string; capabilityDigest: string }>

type ExchangeInput<Result> = Readonly<{
  method: "search.prepare" | "search.decide"
  query?: string
  proposalID?: string
  decision?: "approve" | "reject"
  binding?: PreparedBinding
  parseTerminal: (input: unknown) => Result | null
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
  onProgress?: (progress: WorkspaceSearchProgress) => void
}>

type CompleteExchangeInput<Result> = ExchangeInput<Result> &
  Readonly<{
    socketPath: string
    token: string
    sessionID: string
    requestID: string
    timeoutMs: number
  }>

function exchange<Result>(input: CompleteExchangeInput<Result>, registerCancel: (cancel: () => void) => void) {
  return new Promise<Result>((complete, reject) => {
    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let accepted = false
    let bytes = 0
    let buffered = ""
    let progressIndex = 0
    let observation:
      | Readonly<{
          receiptID: string
          outputDigest: string
          outputLineCount: number | null
          outcome: "matches" | "no_matches"
        }>
      | undefined

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
    socket.once("connect", () => {
      socket?.write(
        JSON.stringify({
          schemaVersion: 1,
          method: input.method,
          requestId: input.requestID,
          sessionID: input.sessionID,
          token: input.token,
          ...(input.method === "search.prepare"
            ? { query: input.query }
            : { proposalID: input.proposalID, decision: input.decision }),
        }) + "\n",
      )
    })
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
          if (
            input.method !== "search.decide" ||
            input.decision !== "approve" ||
            !input.binding ||
            message.progress.proposalID !== input.proposalID ||
            message.progress.operationID !== input.binding.operationID ||
            message.progress.capabilityDigest !== input.binding.capabilityDigest ||
            message.progress.status !== progressOrder[progressIndex]
          )
            return finish({ ok: false, code: "protocol_invalid" })
          progressIndex++
          if (message.progress.status === "effect_observed_not_verified") {
            observation = {
              receiptID: message.progress.receiptID,
              outputDigest: message.progress.outputDigest,
              outputLineCount: message.progress.outputLineCount,
              outcome: message.progress.outcome,
            }
          }
          try {
            input.onProgress?.(message.progress)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        if (!validTerminalFlow(message.result, input, progressIndex, observation)) {
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

const progressOrder = ["recording_authority", "executing_host", "effect_observed_not_verified"] as const

function validTerminalFlow<Result>(
  result: Result,
  input: CompleteExchangeInput<Result>,
  progressIndex: number,
  observation:
    | Readonly<{
        receiptID: string
        outputDigest: string
        outputLineCount: number | null
        outcome: "matches" | "no_matches"
      }>
    | undefined,
) {
  const record = plainRecord(result)
  if (!record || record.requestId !== input.requestID) return false
  if (input.method === "search.prepare") return progressIndex === 0
  if (input.decision === "reject") {
    return progressIndex === 0 && (record.status === "denied_without_effect" || record.status === "blocked")
  }
  if (record.status === "blocked") return progressIndex === 0
  if (record.status === "failed_without_effect" || record.status === "reconciliation_required") {
    return progressIndex >= 1
  }
  if (record.status !== "completed_observed_not_verified" || progressIndex !== progressOrder.length || !observation) {
    return false
  }
  const output = plainRecord(record.output)
  return (
    record.receiptID === observation.receiptID &&
    output?.outputDigest === observation.outputDigest &&
    output?.digestScope === "stdout_only" &&
    output?.outputLineCount === observation.outputLineCount &&
    output?.outcome === observation.outcome
  )
}

type ControlMessage<Result> =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "progress"; progress: WorkspaceSearchProgress }>
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
    if (record.type === "search.progress") {
      if (!exactKeys(record, ["schemaVersion", "type", "requestId", "progress"])) return null
      const parsed = parseWorkspaceSearchProgress(record.progress)
      return parsed.ok && parsed.value.requestId === requestID ? { type: "progress", progress: parsed.value } : null
    }
    if (record.type !== "search.terminal" || !exactKeys(record, ["schemaVersion", "type", "requestId", "result"])) {
      return null
    }
    const result = parseTerminal(record.result)
    return result ? { type: "terminal", result } : null
  } catch {
    return null
  }
}

function validQuery(input: string) {
  return input.length > 0 && Buffer.byteLength(input) <= 512 && !/\p{C}/u.test(input)
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
