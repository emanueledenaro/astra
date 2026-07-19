import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseMcpActivationControlDecisionResult,
  parseMcpActivationControlPrepareResult,
  parseMcpActivationControlProgress,
  parseMcpActivationControlStopResult,
  type McpActivationControlDecisionResult,
  type McpActivationControlPrepareResult,
  type McpActivationControlProgress,
  type McpActivationControlStopResult,
} from "@astra/domain/mcp-activation-control"
import { AstraControlClientError } from "./control-client"

const responseLimitBytes = 128 * 1024
const defaultResponseTimeoutMs = 16 * 60_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AstraMcpActivationClient = Readonly<{
  prepare: (candidateID: string) => Promise<McpActivationControlPrepareResult>
  decide: (proposalID: string, decision: "approve" | "reject", onProgress?: (progress: McpActivationControlProgress) => void) => Promise<McpActivationControlDecisionResult>
  stop: (proposalID: string) => Promise<McpActivationControlStopResult>
  dispose: () => void
}>

/** Uses an independent stop socket so an active approval cannot block shutdown. */
export function createAstraMcpActivationClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  mode: "read-only" | "activate-once",
  responseTimeoutMs = defaultResponseTimeoutMs,
): AstraMcpActivationClient {
  const socketPath = environment.ASTRA_CONTROL_SOCKET
  const token = environment.ASTRA_CONTROL_TOKEN
  const available = typeof socketPath === "string" && isAbsolute(socketPath) && Buffer.byteLength(socketPath) <= 100 && !/\p{C}/u.test(socketPath) && typeof token === "string" && tokenPattern.test(token) && uuidPattern.test(sessionID)
  const proposals = new Set<string>()
  let commandCancel: (() => void) | undefined
  let stopCancel: (() => void) | undefined

  const request = <Result>(input: ExchangeInput<Result>, channel: "command" | "stop") => {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if ((channel === "command" ? commandCancel : stopCancel)) return Promise.reject(new AstraControlClientError("busy"))
    return exchange({ ...input, socketPath, token, sessionID, timeoutMs: validTimeout(responseTimeoutMs) }, (dispose) => {
      if (channel === "command") commandCancel = dispose
      else stopCancel = dispose
    }).finally(() => {
      if (channel === "command") commandCancel = undefined
      else stopCancel = undefined
    })
  }

  return Object.freeze({
    prepare(candidateID) {
      if (mode === "read-only") return Promise.resolve({ schemaVersion: 1, requestId: randomUUID(), status: "blocked", reason: "activate_once_required" })
      return request({ method: "mcp-activation.prepare", candidateID, parse: parsePrepare }, "command").then((result) => {
        if (result.status === "prepared") proposals.add(result.preview.proposalID)
        return result
      })
    },
    decide(proposalID, decision, onProgress) {
      if (mode === "read-only") return Promise.resolve({ schemaVersion: 1, requestId: randomUUID(), proposalID, status: "blocked", reason: "activate_once_required" })
      if (!proposals.has(proposalID)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request({
        method: "mcp-activation.decide",
        proposalID,
        decision,
        parse: parseDecision,
        ...(onProgress ? { onProgress } : {}),
      }, "command")
        .then((result) => {
          if (result.status !== "reconciliation_required") proposals.delete(proposalID)
          return result
        })
        .catch((cause: unknown) => {
          if (decision !== "approve") throw cause
          return { schemaVersion: 1, requestId: randomUUID(), proposalID, operationID: proposalID, status: "reconciliation_required", reason: "effect_in_progress_or_unknown", verification: "not_verified" } as const
        })
    },
    stop(proposalID) {
      if (mode === "read-only") return Promise.resolve({ schemaVersion: 1, requestId: randomUUID(), proposalID, status: "blocked", reason: "activate_once_required" })
      if (!proposals.has(proposalID)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request({ method: "mcp-activation.stop", proposalID, parse: parseStop }, "stop")
    },
    dispose() {
      commandCancel?.()
      stopCancel?.()
      commandCancel = undefined
      stopCancel = undefined
    },
  })
}

type ExchangeInput<Result> = Readonly<{
  method: "mcp-activation.prepare" | "mcp-activation.decide" | "mcp-activation.stop"
  candidateID?: string
  proposalID?: string
  decision?: "approve" | "reject"
  parse: (value: unknown) => Result | null
  onProgress?: (progress: McpActivationControlProgress) => void
}>

function exchange<Result>(input: ExchangeInput<Result> & Readonly<{ socketPath: string; token: string; sessionID: string; timeoutMs: number }>, registerCancel: (cancel: () => void) => void) {
  return new Promise<Result>((complete, reject) => {
    const requestId = randomUUID()
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
    socket.once("connect", () => socket?.write(JSON.stringify({ schemaVersion: 1, method: input.method, requestId, sessionID: input.sessionID, token: input.token, ...(input.method === "mcp-activation.prepare" ? { candidateID: input.candidateID } : { proposalID: input.proposalID }), ...(input.method === "mcp-activation.decide" ? { decision: input.decision } : {}) }) + "\n"))
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > responseLimitBytes) return finish(new AstraControlClientError("protocol_invalid"))
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        const frame = parseFrame(line, requestId, input)
        if (!frame) return finish(new AstraControlClientError("protocol_invalid"))
        if (frame.type === "accepted") {
          if (accepted) return finish(new AstraControlClientError("protocol_invalid"))
          accepted = true
          continue
        }
        if (!accepted) return finish(new AstraControlClientError("protocol_invalid"))
        if (frame.type === "progress") {
          input.onProgress?.(frame.progress)
          continue
        }
        finish(frame.result)
      }
    })
    socket.once("error", () => finish(new AstraControlClientError("transport_failed")))
    socket.once("end", () => {
      if (!settled) finish(new AstraControlClientError("transport_failed"))
    })
  })
}

function parseFrame<Result>(line: string, requestId: string, input: ExchangeInput<Result>) {
  try {
    const value: unknown = JSON.parse(line)
    if (!record(value) || value.schemaVersion !== 1 || value.requestId !== requestId) return null
    if (value.type === "accepted" && Object.keys(value).length === 3) return { type: "accepted" as const }
    if (value.type === "mcp-activation.progress" && Object.keys(value).length === 4 && input.method === "mcp-activation.decide") {
      const parsed = parseMcpActivationControlProgress(value.progress)
      return parsed.ok && parsed.value.requestId === requestId && parsed.value.proposalID === input.proposalID
        ? { type: "progress" as const, progress: parsed.value }
        : null
    }
    if (value.type !== "mcp-activation.terminal" || Object.keys(value).length !== 4) return null
    const result = input.parse(value.result)
    const binding = record(result) ? result : null
    if (!result || !binding || binding.requestId !== requestId) return null
    if (input.method !== "mcp-activation.prepare" && binding.proposalID !== input.proposalID) return null
    return { type: "terminal" as const, result }
  } catch {
    return null
  }
}

function parsePrepare(input: unknown) {
  const parsed = parseMcpActivationControlPrepareResult(input)
  return parsed.ok ? parsed.value : null
}

function parseDecision(input: unknown) {
  const parsed = parseMcpActivationControlDecisionResult(input)
  return parsed.ok ? parsed.value : null
}

function parseStop(input: unknown) {
  const parsed = parseMcpActivationControlStopResult(input)
  return parsed.ok ? parsed.value : null
}

function validTimeout(input: number) {
  return Number.isSafeInteger(input) && input > 0 ? input : defaultResponseTimeoutMs
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
