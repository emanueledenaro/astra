import { createHash, randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseProviderCatalogResult,
  parseProviderTurnDecisionResult,
  parseProviderTurnPrepareResult,
  parseProviderTurnProgress,
  providerControlRequestWireLimitBytes,
  providerControlResponseWireLimitBytes,
  type ProviderCatalogResult,
  type ProviderTurnDecisionResult,
  type ProviderTurnPrepareResult,
  type ProviderTurnProgress,
  type ProviderTurnSelection,
} from "@astra/domain/provider-control"
import { AstraControlClientError } from "./control-client"

const responseTimeoutMilliseconds = 40_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type RequestOptions = Readonly<{
  signal?: AbortSignal
  onAccepted?: () => void
  onProgress?: (progress: ProviderTurnProgress) => void
}>

export type AstraProviderClient = Readonly<{
  catalog: (options?: RequestOptions) => Promise<ProviderCatalogResult>
  prepare: (
    selection: ProviderTurnSelection,
    userText: string,
    options?: RequestOptions,
  ) => Promise<ProviderTurnPrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    options?: RequestOptions,
  ) => Promise<ProviderTurnDecisionResult>
  dispose: () => void
}>

/** Creates a lazy, path-free client for the dedicated parent provider socket. */
export function createAstraProviderClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
): AstraProviderClient {
  const socketPath = environment.ASTRA_PROVIDER_SOCKET
  const token = environment.ASTRA_PROVIDER_TOKEN
  const available =
    typeof socketPath === "string" &&
    isAbsolute(socketPath) &&
    Buffer.byteLength(socketPath) <= 100 &&
    !/\p{C}/u.test(socketPath) &&
    typeof token === "string" &&
    tokenPattern.test(token) &&
    uuidPattern.test(sessionID)
  let active: { cancel: () => void } | undefined
  const proposals = new Map<string, string>()

  function request<Result>(
    body: Readonly<Record<string, unknown>>,
    parse: (input: unknown) => Result | null,
    options: RequestOptions,
    progress:
      | Readonly<{
          proposalID: string
          operationID: string
          decision: "approve" | "reject"
        }>
      | undefined,
  ) {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if (active) return Promise.reject(new AstraControlClientError("busy"))
    if (options.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))
    const requestID = randomUUID()
    const encodedRequest = `${JSON.stringify({ schemaVersion: 1, requestId: requestID, sessionID, token, ...body })}\n`
    if (Buffer.byteLength(encodedRequest) > providerControlRequestWireLimitBytes) {
      return Promise.reject(new AstraControlClientError("protocol_invalid"))
    }
    return new Promise<Result>((resolve, reject) => {
      let socket: Socket | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      let accepted = false
      let bytes = 0
      let buffered = ""
      let progressIndex = 0
      const finish = (
        result:
          | Readonly<{ ok: true; value: Result }>
          | Readonly<{
              ok: false
              code: ConstructorParameters<typeof AstraControlClientError>[0]
            }>,
      ) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        socket?.destroy()
        if (active?.cancel === abort) active = undefined
        if (result.ok) resolve(result.value)
        else reject(new AstraControlClientError(result.code))
      }
      const abort = () => finish({ ok: false, code: "cancelled" })
      active = { cancel: abort }
      options.signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => finish({ ok: false, code: "timed_out" }), responseTimeoutMilliseconds)

      try {
        socket = createConnection(socketPath)
      } catch {
        finish({ ok: false, code: "transport_failed" })
        return
      }
      socket.setEncoding("utf8")
      socket.once("connect", () => socket?.write(encodedRequest))
      socket.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > providerControlResponseWireLimitBytes) return finish({ ok: false, code: "protocol_invalid" })
        buffered += chunk
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          if (!line || settled) continue
          const message = decode(line)
          if (!message || message.requestId !== requestID) return finish({ ok: false, code: "protocol_invalid" })
          if (message.type === "accepted") {
            if (accepted || Object.keys(message).length !== 3 || message.schemaVersion !== 1) {
              return finish({ ok: false, code: "protocol_invalid" })
            }
            accepted = true
            options.onAccepted?.()
            continue
          }
          if (!accepted) return finish({ ok: false, code: "protocol_invalid" })
          const parsedProgress = parseProviderTurnProgress(message)
          if (parsedProgress) {
            if (
              !progress ||
              parsedProgress.proposalID !== progress.proposalID ||
              parsedProgress.operationID !== progress.operationID
            ) {
              return finish({ ok: false, code: "protocol_invalid" })
            }
            const expected = progressOrder[progressIndex]
            if (parsedProgress.status !== expected) return finish({ ok: false, code: "protocol_invalid" })
            progressIndex += 1
            options.onProgress?.(parsedProgress)
            continue
          }
          const terminal = parse(message)
          if (!terminal) return finish({ ok: false, code: "protocol_invalid" })
          if (progress && !validTerminalProgress(terminal, progress.decision, progressIndex)) {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          if (!validCompletionDigest(terminal)) return finish({ ok: false, code: "protocol_invalid" })
          finish({ ok: true, value: terminal })
        }
      })
      socket.once("error", () => finish({ ok: false, code: "transport_failed" }))
      socket.once("close", () => {
        if (!settled) finish({ ok: false, code: "transport_failed" })
      })
    })
  }

  return {
    catalog(options = {}) {
      return request({ method: "provider.catalog" }, parseProviderCatalogResult, options, undefined)
    },
    prepare(selection, userText, options = {}) {
      if (!validSelection(selection)) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request(
        { method: "provider.turn.prepare", ...selection, userText },
        parseProviderTurnPrepareResult,
        options,
        undefined,
      ).then((result) => {
        if (result.status === "prepared") {
          if (
            result.preview.providerID !== selection.providerID ||
            result.preview.credential.profile !== selection.credentialProfile ||
            result.preview.modelID !== selection.modelID
          ) {
            throw new AstraControlClientError("protocol_invalid")
          }
          proposals.set(result.preview.proposalID, result.preview.operationID)
        }
        return result
      })
    },
    decide(proposalID, decision, options = {}) {
      const operationID = proposals.get(proposalID)
      if (!operationID) return Promise.reject(new AstraControlClientError("protocol_invalid"))
      return request(
        { method: "provider.turn.decide", proposalID, decision },
        parseProviderTurnDecisionResult,
        options,
        { proposalID, operationID, decision },
      ).finally(() => proposals.delete(proposalID))
    },
    dispose() {
      const request = active
      active = undefined
      request?.cancel()
    },
  }
}

function validSelection(input: ProviderTurnSelection) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.modelID)) return false
  if (input.providerID === "anthropic") return input.credentialProfile === "anthropic-api-key"
  return input.credentialProfile === "openai-api-key" || input.credentialProfile === "openai-codex-oauth"
}

const progressOrder = [
  "recording_authority",
  "authority_claimed",
  "network_dispatch",
  "response_observed_not_verified",
  "receipt_acknowledged",
] as const

function validTerminalProgress(input: unknown, decision: "approve" | "reject", count: number) {
  if (typeof input !== "object" || input === null || !("status" in input)) return false
  if (decision === "reject") return input.status === "denied_without_effect" && count === 1
  if (input.status === "response_observed_not_verified") return count === progressOrder.length
  return input.status === "reconciliation_required" && count >= 1
}

function validCompletionDigest(input: unknown) {
  if (typeof input !== "object" || input === null || !("status" in input)) return false
  if (input.status !== "response_observed_not_verified" || !("response" in input)) return true
  const response = input.response
  if (
    typeof response !== "object" ||
    response === null ||
    !("assistantText" in response) ||
    !("assistantTextDigest" in response)
  ) {
    return false
  }
  if (typeof response.assistantText !== "string" || typeof response.assistantTextDigest !== "string") return false
  return `sha256:${createHash("sha256").update(response.assistantText).digest("hex")}` === response.assistantTextDigest
}

function decode(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}
