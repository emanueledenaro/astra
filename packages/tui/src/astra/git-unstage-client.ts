import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseGitUnstageDecisionResult,
  parseGitUnstagePrepareResult,
  parseGitUnstageProgress,
  type GitUnstageDecisionResult,
  type GitUnstagePrepareResult,
  type GitUnstageProgress,
} from "@astra/domain/git-unstage-control"
import { AstraControlClientError } from "./control-client"
import { matchesAstraGitClientAuthority, type AstraGitClientAuthority } from "./git-client-authority"

const responseLimitBytes = 64 * 1024
const defaultResponseTimeoutMs = 65_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RequestOptions = Readonly<{
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
}>

export type AstraGitUnstageClient = Readonly<{
  prepare: (options?: RequestOptions) => Promise<GitUnstagePrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    options?: RequestOptions & Readonly<{ onProgress?: (progress: GitUnstageProgress) => void }>,
  ) => Promise<GitUnstageDecisionResult>
  dispose: () => void
}>

/** Creates a lazy path-free client for the parent-owned Unstage-all action. */
export function createAstraGitUnstageClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{
    responseTimeoutMs?: number
    expectedWorkspaceRoot?: string
    expectedBaselineSnapshotDigest?: string
    baselineAuthority?: AstraGitClientAuthority
  }> = {},
): AstraGitUnstageClient {
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
    prepare(requestOptions = {}) {
      return request({
        method: "git-unstage.prepare",
        parseTerminal(input) {
          const parsed = parseGitUnstagePrepareResult(input)
          return parsed.ok ? parsed.value : null
        },
        ...requestOptions,
      }).then((result) => {
        if (result.status === "prepared") {
          if (
            (options.expectedWorkspaceRoot !== undefined &&
              result.preview.authority.workspaceRoot !== options.expectedWorkspaceRoot) ||
            !matchesAstraGitClientAuthority(
              options.baselineAuthority,
              options.expectedBaselineSnapshotDigest,
              result.preview.authority.baseline.snapshotDigest,
            )
          ) {
            throw new AstraControlClientError("protocol_invalid")
          }
          prepared.set(result.preview.proposalID, {
            proposalID: result.preview.proposalID,
            proposalDigest: result.preview.authority.proposalDigest,
            baselineSnapshotDigest: result.preview.authority.baseline.snapshotDigest,
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
        method: "git-unstage.decide",
        proposalID,
        decision,
        binding,
        parseTerminal(input) {
          const parsed = parseGitUnstageDecisionResult(input)
          if (!parsed.ok || parsed.value.proposalID !== proposalID) return null
          if ("proposalDigest" in parsed.value && parsed.value.proposalDigest !== binding.proposalDigest) return null
          return parsed.value
        },
        ...requestOptions,
      })
        .then((result) => {
          if (result.status === "verified" && options.baselineAuthority) {
            options.baselineAuthority.advance(binding.baselineSnapshotDigest, result.snapshotDigest)
          }
          return result
        })
        .finally(() => prepared.delete(proposalID))
    },
    dispose() {
      const active = activeRequest
      activeRequest = undefined
      active?.cancel?.()
    },
  }
}

type PreparedBinding = Readonly<{
  proposalID: string
  proposalDigest: string
  baselineSnapshotDigest: `sha256:${string}`
}>

type ExchangeInput<Result> = Readonly<{
  method: "git-unstage.prepare" | "git-unstage.decide"
  proposalID?: string
  decision?: "approve" | "reject"
  binding?: PreparedBinding
  parseTerminal: (input: unknown) => Result | null
  signal?: AbortSignal
  onAccepted?: (requestId: string) => void
  onProgress?: (progress: GitUnstageProgress) => void
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
    let observation: Readonly<{ operationID: string; receiptID: string; snapshotDigest: string }> | undefined

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
          ...(input.method === "git-unstage.decide" ? { proposalID: input.proposalID, decision: input.decision } : {}),
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
            input.method !== "git-unstage.decide" ||
            input.decision !== "approve" ||
            !input.binding ||
            message.progress.proposalID !== input.binding.proposalID ||
            message.progress.proposalDigest !== input.binding.proposalDigest ||
            message.progress.status !== progressOrder[progressIndex]
          ) {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          progressIndex++
          if (message.progress.status === "effect_observed_not_verified") {
            observation = {
              operationID: message.progress.operationID,
              receiptID: message.progress.receiptID,
              snapshotDigest: message.progress.snapshotDigest,
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

const progressOrder = [
  "recording_authority",
  "host_adapter_validating",
  "effect_observed_not_verified",
  "verifying",
] as const

function validTerminalFlow<Result>(
  result: Result,
  input: CompleteExchangeInput<Result>,
  progressIndex: number,
  observation: Readonly<{ operationID: string; receiptID: string; snapshotDigest: string }> | undefined,
) {
  const record = plainRecord(result)
  if (!record) return false
  if (record.requestId !== input.requestID) return false
  if (input.method === "git-unstage.prepare") return progressIndex === 0
  if (input.decision === "reject") {
    return progressIndex === 0 && (record.status === "denied_without_git_effect" || record.status === "blocked")
  }
  if (record.status === "blocked") return progressIndex === 0
  if (record.status === "failed_without_effect" || record.status === "reconciliation_required") {
    return progressIndex >= 1
  }
  if (record.status !== "verified") return false
  return (
    progressIndex === progressOrder.length &&
    observation !== undefined &&
    record.operationID === observation.operationID &&
    record.receiptID === observation.receiptID &&
    record.snapshotDigest === observation.snapshotDigest
  )
}

type ControlMessage<Result> =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "progress"; progress: GitUnstageProgress }>
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
    if (record.type === "git-unstage.progress") {
      if (!exactKeys(record, ["schemaVersion", "type", "requestId", "progress"])) return null
      const parsed = parseGitUnstageProgress(record.progress)
      return parsed.ok && parsed.value.requestId === requestID ? { type: "progress", progress: parsed.value } : null
    }
    if (
      record.type !== "git-unstage.terminal" ||
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
