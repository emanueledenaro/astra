import { createHash } from "node:crypto"
import {
  resolveCertifiedProviderDispatch,
  type CertifiedProviderAdapter,
} from "./provider-adapter-registry"

export const openAIResponsesOneTurnMaximumInputBytes = 65_536
export const openAIResponsesOneTurnMaximumRequestBytes = 131_072
export const openAIResponsesOneTurnMaximumConversationTurns = 64
export const openAIResponsesOneTurnMaximumConversationBytes = 65_536
export const openAIResponsesOneTurnMaximumResponseBytes = 1_048_576
export const openAIResponsesOneTurnMaximumAssistantBytes = 1_048_576
export const openAIResponsesOneTurnMaximumEvents = 8_192
export const openAIResponsesOneTurnMaximumOutputTokens = 4_096

const systemInstruction =
  "You are Astra, a professional coding assistant. Answer clearly and truthfully. This turn has no tools, files, shell, Git, skills, plugins, MCP, memory, or external-system access. Never claim that you used them."

export type OpenAIResponsesConversationTurn = Readonly<{
  userText: string
  assistantText: string
}>

export type OpenAIResponsesOneTurnRequest = Readonly<{
  destination: CertifiedProviderAdapter["destination"]
  headers: ReadonlyArray<readonly [name: string, value: string]>
  privateWireBody: Uint8Array
  evidence: Readonly<{
    adapterDigest: CertifiedProviderAdapter["adapterDigest"]
    requestDigest: `sha256:${string}`
    requestBytes: number
    conversationTurns: number
    conversationBytes: number
  }>
}>

export type OpenAIResponsesOneTurnRawResponse = Readonly<{
  statusCode: number
  headers: ReadonlyArray<readonly [name: string, value: string]>
  body: Uint8Array
}>

export type OpenAIResponsesOneTurnResult = Readonly<{
  status: "observed_not_verified"
  assistantText: string
  finishReason: "stop" | "length" | "content_filter"
  evidence: Readonly<{
    responseBodyDigest: `sha256:${string}`
    responseBodyBytes: number
    assistantTextDigest: `sha256:${string}`
    assistantTextBytes: number
    eventCount: number
  }>
}>

export class OpenAIResponsesOneTurnError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "OpenAIResponsesOneTurnError"
  }
}

/** Builds a bounded, text-only Responses API request for one certified OpenAI adapter. */
export function buildOpenAIResponsesOneTurnRequest(input: Readonly<{
  adapter: CertifiedProviderAdapter
  modelID: string
  userText: string
  maxOutputTokens: number
  conversationTurns?: ReadonlyArray<OpenAIResponsesConversationTurn>
}>): OpenAIResponsesOneTurnRequest {
  const adapter = requireOpenAIAdapter(input.adapter)
  const modelID = requireIdentifier(input.modelID, "model_rejected")
  const userText = requireText(input.userText, openAIResponsesOneTurnMaximumInputBytes, "user_text_rejected")
  if (
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > openAIResponsesOneTurnMaximumOutputTokens
  ) {
    fail("max_output_tokens_rejected")
  }
  const conversationTurns = requireConversation(input.conversationTurns ?? [])
  const conversationBytes = conversationTurns.reduce(
    (total, turn) => total + Buffer.byteLength(turn.userText, "utf8") + Buffer.byteLength(turn.assistantText, "utf8"),
    0,
  )
  const body = {
    model: modelID,
    instructions: systemInstruction,
    input: [
      ...conversationTurns.flatMap((turn) => [
        { role: "user" as const, content: [{ type: "input_text" as const, text: turn.userText }] },
        { role: "assistant" as const, content: [{ type: "output_text" as const, text: turn.assistantText }] },
      ]),
      { role: "user" as const, content: [{ type: "input_text" as const, text: userText }] },
    ],
    tools: [],
    tool_choice: "none",
    store: false,
    stream: true,
    max_output_tokens: input.maxOutputTokens,
  }
  const privateWireBody = new TextEncoder().encode(JSON.stringify(body))
  if (privateWireBody.byteLength > openAIResponsesOneTurnMaximumRequestBytes) fail("request_too_large")
  return deepFreeze({
    destination: { ...adapter.destination },
    headers: [
      ["accept", "text/event-stream"],
      ["content-type", "application/json"],
    ],
    privateWireBody,
    evidence: {
      adapterDigest: adapter.adapterDigest,
      requestDigest: digest(privateWireBody),
      requestBytes: privateWireBody.byteLength,
      conversationTurns: conversationTurns.length,
      conversationBytes,
    },
  })
}

/** Parses bounded SSE evidence. A terminal provider event is observed, never verified. */
export function parseOpenAIResponsesOneTurnResponse(
  input: OpenAIResponsesOneTurnRawResponse,
): OpenAIResponsesOneTurnResult {
  if (input.statusCode !== 200) fail("http_status_rejected")
  requireEventStreamContentType(input.headers)
  if (input.body.byteLength > openAIResponsesOneTurnMaximumResponseBytes) fail("response_too_large")
  const frames = parseSseFrames(decodeBody(input.body))
  let terminal = false
  let done = false
  let finishReason: OpenAIResponsesOneTurnResult["finishReason"] | null = null
  const chunks: Array<string> = []
  let assistantTextBytes = 0
  let eventCount = 0

  for (const frame of frames) {
    if (frame === "[DONE]") {
      if (done) fail("event_sequence_rejected")
      done = true
      continue
    }
    if (done || terminal) fail("event_sequence_rejected")
    const event = decodeEvent(frame)
    eventCount += 1
    rejectToolEvent(event)
    const eventType = requireEventType(event)
    if (eventType === "error" || eventType === "response.failed") fail("provider_error")
    if (eventType === "response.output_text.delta") {
      const delta = event.delta
      if (typeof delta !== "string") fail("event_invalid")
      const bytes = Buffer.byteLength(delta, "utf8")
      if (bytes > openAIResponsesOneTurnMaximumAssistantBytes - assistantTextBytes) fail("assistant_text_too_large")
      chunks.push(delta)
      assistantTextBytes += bytes
      continue
    }
    if (eventType === "response.completed") {
      if (responseStatus(event) !== "completed") fail("terminal_stop_rejected")
      terminal = true
      finishReason = "stop"
      continue
    }
    if (eventType === "response.incomplete") {
      const reason = incompleteReason(event)
      if (reason === "max_output_tokens") finishReason = "length"
      else if (reason === "content_filter") finishReason = "content_filter"
      else fail("terminal_stop_rejected")
      terminal = true
      continue
    }
    if (!safeNonTerminalEvents.has(eventType)) fail("event_invalid")
  }
  if (!terminal || !done || finishReason === null) fail("stream_truncated")
  if (assistantTextBytes === 0) fail("assistant_text_empty")
  const assistantText = chunks.join("")
  return {
    status: "observed_not_verified",
    assistantText,
    finishReason,
    evidence: {
      responseBodyDigest: digest(input.body),
      responseBodyBytes: input.body.byteLength,
      assistantTextDigest: digest(assistantText),
      assistantTextBytes,
      eventCount,
    },
  }
}

function requireOpenAIAdapter(input: CertifiedProviderAdapter) {
  const exact = resolveCertifiedProviderDispatch({
    providerID: input.providerID,
    credentialProfile: input.credentialProfile,
    destination: input.destination,
  })
  if (
    !exact ||
    exact.providerID !== "openai" ||
    exact.adapterID !== input.adapterID ||
    exact.adapterDigest !== input.adapterDigest ||
    exact.credential.headerName !== input.credential.headerName ||
    exact.credential.scheme !== input.credential.scheme ||
    exact.credential.accountHeaderName !== input.credential.accountHeaderName
  ) {
    return fail("adapter_rejected")
  }
  return exact
}

function requireConversation(input: ReadonlyArray<OpenAIResponsesConversationTurn>) {
  if (!Array.isArray(input) || input.length > openAIResponsesOneTurnMaximumConversationTurns) {
    return fail("conversation_too_large")
  }
  let bytes = 0
  const turns = input.map((turn) => {
    const record = conversationRecord(turn)
    if (Object.keys(record).length !== 2) fail("conversation_turn_rejected")
    const userText = requireText(record.userText, openAIResponsesOneTurnMaximumInputBytes, "conversation_turn_rejected")
    const assistantText = requireText(
      record.assistantText,
      openAIResponsesOneTurnMaximumAssistantBytes,
      "conversation_turn_rejected",
    )
    bytes += Buffer.byteLength(userText, "utf8") + Buffer.byteLength(assistantText, "utf8")
    if (bytes > openAIResponsesOneTurnMaximumConversationBytes) fail("conversation_too_large")
    return Object.freeze({ userText, assistantText })
  })
  return Object.freeze(turns)
}

function conversationRecord(input: OpenAIResponsesConversationTurn): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("conversation_turn_rejected")
  return input as Record<string, unknown>
}

function requireIdentifier(input: unknown, code: string) {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input)) fail(code)
  return input
}

function requireText(input: unknown, maximumBytes: number, code: string) {
  if (typeof input !== "string" || input.trim().length === 0 || Buffer.byteLength(input, "utf8") > maximumBytes) {
    fail(code)
  }
  return input
}

function requireEventStreamContentType(headers: OpenAIResponsesOneTurnRawResponse["headers"]) {
  const values = headers
    .filter(([name]) => name.trim().toLowerCase() === "content-type")
    .map(([, value]) => value.trim().toLowerCase())
  if (values.length !== 1) fail("content_type_rejected")
  const [mediaType, ...parameters] = values[0]!.split(";").map((part) => part.trim())
  if (
    mediaType !== "text/event-stream" ||
    parameters.some((parameter) => parameter !== "charset=utf-8" && parameter !== 'charset="utf-8"')
  ) {
    fail("content_type_rejected")
  }
}

function decodeBody(input: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input)
  } catch {
    return fail("response_encoding_rejected")
  }
}

function parseSseFrames(input: string) {
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  if (!normalized.endsWith("\n\n")) fail("stream_truncated")
  const frames = normalized
    .split("\n\n")
    .slice(0, -1)
    .map(parseSseBlock)
    .filter((frame): frame is string => frame !== null)
  if (frames.length > openAIResponsesOneTurnMaximumEvents + 1) fail("event_limit_exceeded")
  return frames
}

function parseSseBlock(input: string) {
  let eventName: string | null = null
  const data: Array<string> = []
  for (const line of input.split("\n")) {
    if (line === "" || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    const raw = separator < 0 ? "" : line.slice(separator + 1)
    const value = raw.startsWith(" ") ? raw.slice(1) : raw
    if (field === "event") {
      if (eventName !== null) fail("stream_framing_rejected")
      eventName = value
    } else if (field === "data") data.push(value)
    else fail("stream_framing_rejected")
  }
  if (data.length === 0) return null
  const joined = data.join("\n")
  if (joined !== "[DONE]" && eventName && eventName !== requireEventType(decodeEvent(joined))) fail("event_invalid")
  return joined
}

function decodeEvent(input: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(input)
    if (!isRecord(value)) fail("event_invalid")
    return value
  } catch (error) {
    if (error instanceof OpenAIResponsesOneTurnError) throw error
    return fail("event_invalid")
  }
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function requireEventType(event: Readonly<Record<string, unknown>>) {
  if (typeof event.type !== "string" || event.type.length === 0 || event.type.length > 128) fail("event_invalid")
  return event.type
}

function rejectToolEvent(event: Readonly<Record<string, unknown>>) {
  const item = event.item
  const itemType = typeof item === "object" && item !== null && !Array.isArray(item) && "type" in item ? item.type : null
  if (
    requireEventType(event).includes("function_call") ||
    requireEventType(event).includes("tool_call") ||
    (typeof itemType === "string" && (itemType.includes("tool") || itemType === "function_call"))
  ) {
    fail("tool_use_rejected")
  }
}

function responseStatus(event: Readonly<Record<string, unknown>>) {
  const response = event.response
  return typeof response === "object" && response !== null && !Array.isArray(response) && "status" in response
    ? response.status
    : null
}

function incompleteReason(event: Readonly<Record<string, unknown>>) {
  const response = event.response
  if (typeof response !== "object" || response === null || Array.isArray(response) || !("incomplete_details" in response)) {
    return null
  }
  const details = response.incomplete_details
  return typeof details === "object" && details !== null && !Array.isArray(details) && "reason" in details
    ? details.reason
    : null
}

const safeNonTerminalEvents = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
])

function digest(input: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function deepFreeze<Value>(input: Value): Value {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  if (ArrayBuffer.isView(input)) return input
  Object.freeze(input)
  for (const value of Object.values(input)) deepFreeze(value)
  return input
}

function fail(code: string): never {
  throw new OpenAIResponsesOneTurnError(code)
}
