import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseSkillActivationDecisionResult,
  parseSkillActivationPrepareResult,
  parseSkillActivationProgress,
  parseSkillInventoryResult,
  type SkillActivationDecisionResult,
  type SkillActivationPrepareResult,
  type SkillActivationProgress,
  type SkillInventoryResult,
} from "../../../astra-domain/src/skill-activation-control"
import { AstraControlClientError } from "./control-client"

const responseLimitBytes = 128 * 1024
const defaultResponseTimeoutMs = 65_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/

type RequestOptions = Readonly<{
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
  onProgress?: (progress: SkillActivationProgress) => void
}>

export type AstraSkillActivationClient = Readonly<{
  inventory: (options?: RequestOptions) => Promise<SkillInventoryResult>
  prepare: (inventoryID: string, candidateID: string, options?: RequestOptions) => Promise<SkillActivationPrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    options?: RequestOptions,
  ) => Promise<SkillActivationDecisionResult>
  dispose: () => void
}>

/** Creates a lazy client whose requests contain only parent-issued identifiers. */
export function createAstraSkillActivationClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{ responseTimeoutMs?: number }> = {},
): AstraSkillActivationClient {
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
  const timeoutMs =
    Number.isSafeInteger(options.responseTimeoutMs) && (options.responseTimeoutMs ?? 0) > 0
      ? options.responseTimeoutMs!
      : defaultResponseTimeoutMs
  let active: { cancel?: () => void } | undefined
  const inventories = new Map<string, ReadonlySet<string>>()
  const proposals = new Map<string, string>()

  function request<Result>(
    body: Readonly<Record<string, unknown>>,
    parseTerminal: (input: unknown) => Result | null,
    requestOptions: RequestOptions,
    expected?: Readonly<{ proposalID: string; operationID: string; decision: "approve" | "reject" }>,
  ) {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if (active) return Promise.reject(new AstraControlClientError("busy"))
    if (requestOptions.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))
    const requestId = randomUUID()
    const current: { cancel?: () => void } = {}
    active = current
    return exchange<Result>(
      {
        socketPath,
        timeoutMs,
        requestId,
        body: { schemaVersion: 1, requestId, sessionID, token, ...body },
        parseTerminal,
        ...(expected ? { expected } : {}),
        ...requestOptions,
      },
      (cancel) => {
        if (active === current) current.cancel = cancel
      },
    ).finally(() => {
      if (active === current) active = undefined
    })
  }

  return {
    inventory(requestOptions = {}) {
      return request<SkillInventoryResult>(
        { method: "skill.inventory" },
        (input) => {
          const parsed = parseSkillInventoryResult(input)
          return parsed.ok ? parsed.value : null
        },
        requestOptions,
      ).then((result) => {
        if (result.status === "complete") {
          inventories.clear()
          inventories.set(result.inventoryID, new Set(result.candidates.map((candidate) => candidate.candidateID)))
        }
        return result
      })
    },
    prepare(inventoryID, candidateID, requestOptions = {}) {
      if (!uuidPattern.test(inventoryID) || !digestPattern.test(candidateID) || !inventories.get(inventoryID)?.has(candidateID)) {
        return Promise.reject(new AstraControlClientError("protocol_invalid"))
      }
      return request<SkillActivationPrepareResult>(
        { method: "skill.prepare", inventoryID, candidateID },
        (input) => {
          const parsed = parseSkillActivationPrepareResult(input)
          if (!parsed.ok) return null
          if (parsed.value.status === "prepared" && parsed.value.preview.skill.candidateID !== candidateID) return null
          return parsed.value
        },
        requestOptions,
      ).then((result) => {
        inventories.delete(inventoryID)
        if (result.status === "prepared") proposals.set(result.preview.proposalID, result.preview.operationID)
        return result
      })
    },
    decide(proposalID, decision, requestOptions = {}) {
      const operationID = proposals.get(proposalID)
      if (!operationID || !uuidPattern.test(proposalID)) {
        return Promise.reject(new AstraControlClientError("protocol_invalid"))
      }
      return request<SkillActivationDecisionResult>(
        { method: "skill.decide", proposalID, decision },
        (input) => {
          const parsed = parseSkillActivationDecisionResult(input)
          if (!parsed.ok || parsed.value.proposalID !== proposalID) return null
          if ("operationID" in parsed.value && parsed.value.operationID !== operationID) return null
          return parsed.value
        },
        requestOptions,
        { proposalID, operationID, decision },
      ).finally(() => proposals.delete(proposalID))
    },
    dispose() {
      const current = active
      active = undefined
      current?.cancel?.()
    },
  }
}

type ExchangeInput<Result> = Readonly<{
  socketPath: string
  timeoutMs: number
  requestId: string
  body: Readonly<Record<string, unknown>>
  parseTerminal: (input: unknown) => Result | null
  expected?: Readonly<{ proposalID: string; operationID: string; decision: "approve" | "reject" }>
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
  onProgress?: (progress: SkillActivationProgress) => void
}>

function exchange<Result>(input: ExchangeInput<Result>, registerCancel: (cancel: () => void) => void) {
  return new Promise<Result>((complete, reject) => {
    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let accepted = false
    let progressIndex = 0
    let buffered = ""
    let bytes = 0

    const finish = (result: Readonly<{ ok: true; value: Result }> | Readonly<{ ok: false; code: AstraControlClientError["code"] }>) => {
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
    socket.once("connect", () => socket?.write(`${JSON.stringify(input.body)}\n`))
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > responseLimitBytes) return finish({ ok: false, code: "protocol_invalid" })
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        const message = parseMessage(line, input)
        if (!message) return finish({ ok: false, code: "protocol_invalid" })
        if (message.type === "accepted") {
          if (accepted) return finish({ ok: false, code: "protocol_invalid" })
          accepted = true
          try {
            input.onAccepted?.(input.requestId)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        if (!accepted) return finish({ ok: false, code: "protocol_invalid" })
        if (message.type === "progress") {
          const expectedStatus = ["recording_authority", "submitting_approval", "effect_observed_not_verified"][progressIndex]
          if (message.progress.status !== expectedStatus) return finish({ ok: false, code: "protocol_invalid" })
          progressIndex++
          try {
            input.onProgress?.(message.progress)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        const terminal: unknown = message.value
        if (
          input.expected &&
          record(terminal) &&
          terminal.status === "completed_observed_not_verified" &&
          progressIndex !== 3
        ) return finish({ ok: false, code: "protocol_invalid" })
        if (
          input.expected?.decision === "reject" &&
          record(terminal) &&
          terminal.status === "denied_without_effect" &&
          progressIndex !== 1
        ) return finish({ ok: false, code: "protocol_invalid" })
        finish({ ok: true, value: message.value })
      }
    })
    socket.once("error", () => finish({ ok: false, code: "transport_failed" }))
    socket.once("close", () => {
      if (!settled) finish({ ok: false, code: "transport_failed" })
    })
  })
}

function parseMessage<Result>(input: string, exchange: ExchangeInput<Result>) {
  try {
    const value: unknown = JSON.parse(input)
    if (!record(value) || value.schemaVersion !== 1 || value.requestId !== exchange.requestId) return null
    if (value.type === "accepted" && exact(value, ["schemaVersion", "type", "requestId"])) {
      return { type: "accepted" as const }
    }
    if (value.type === "skill.progress" && exact(value, ["schemaVersion", "type", "requestId", "progress"])) {
      const parsed = parseSkillActivationProgress(value.progress)
      if (!parsed.ok || !exchange.expected) return null
      if (parsed.value.proposalID !== exchange.expected.proposalID || parsed.value.operationID !== exchange.expected.operationID) return null
      return { type: "progress" as const, progress: parsed.value }
    }
    if (value.type !== "skill.terminal" || !exact(value, ["schemaVersion", "type", "requestId", "result"])) return null
    const terminal = exchange.parseTerminal(value.result)
    return terminal ? { type: "terminal" as const, value: terminal } : null
  } catch {
    return null
  }
}

function record(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}
function exact(input: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))
}
