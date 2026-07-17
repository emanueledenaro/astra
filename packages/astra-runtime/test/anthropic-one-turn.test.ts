import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  anthropicOneTurnMaximumAssistantBytes,
  anthropicOneTurnMaximumResponseBytes,
  AnthropicOneTurnError,
  buildAnthropicOneTurnRequest,
  createAnthropicCatalogAuthority,
  parseAnthropicOneTurnResponse,
  sealValidatedAnthropicModelCatalog,
} from "../src/anthropic-one-turn"

const catalogAuthority = createAnthropicCatalogAuthority()
const catalog = sealValidatedAnthropicModelCatalog(catalogAuthority, {
  modelIDs: ["claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"],
  validationSourceDigest: digest("validated Anthropic catalog fixture"),
})

describe("Astra Anthropic one-turn protocol", () => {
  test("builds one fixed, tool-free request for an exact catalog model", () => {
    const privatePrompt = "Explain this function without changing files."
    const request = buildAnthropicOneTurnRequest({
      catalogAuthority,
      catalog,
      modelID: "claude-haiku-4-5-20251001",
      userText: privatePrompt,
      maxTokens: 512,
    })

    expect(request.destination).toEqual({
      method: "POST",
      origin: "https://api.anthropic.com",
      path: "/v1/messages",
    })
    expect(request.headers).toEqual([
      ["anthropic-version", "2023-06-01"],
      ["content-type", "application/json"],
    ])
    expect(JSON.parse(new TextDecoder().decode(request.privateWireBody))).toEqual({
      model: "claude-haiku-4-5-20251001",
      system: [
        {
          type: "text",
          text: "You are Astra, a professional coding assistant. Answer clearly and truthfully. This turn has no tools, files, shell, Git, skills, plugins, MCP, memory, or external-system access. Never claim that you used them.",
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: privatePrompt }] }],
      stream: true,
      max_tokens: 512,
    })
    expect(JSON.stringify(request.evidence)).not.toContain(privatePrompt)
    expect(request.evidence).toMatchObject({
      catalogDigest: catalog.catalogDigest,
      requestBytes: request.privateWireBody.byteLength,
    })
    expect(request.evidence.requestDigest).toBe(digest(request.privateWireBody))
  })

  test("canonicalizes catalog models and rejects a forged digest or altered projection", () => {
    const canonical = sealValidatedAnthropicModelCatalog(catalogAuthority, {
      modelIDs: ["model-z", "model-a", "model-z"],
      validationSourceDigest: digest("trusted projection"),
    })
    expect(canonical.modelIDs).toEqual(["model-a", "model-z"])

    const forged = {
      ...canonical,
      modelIDs: ["attacker-controlled-model"],
      catalogDigest: zeroDigest(),
    }
    expectCode(
      () =>
        buildAnthropicOneTurnRequest({
          catalogAuthority,
          catalog: forged,
          modelID: "attacker-controlled-model",
          userText: "private",
          maxTokens: 128,
        }),
      "catalog_rejected",
    )

    const altered = { ...canonical, modelIDs: [...canonical.modelIDs, "model-injected"] }
    expectCode(
      () =>
        buildAnthropicOneTurnRequest({
          catalogAuthority,
          catalog: altered,
          modelID: "model-injected",
          userText: "private",
          maxTokens: 128,
        }),
      "catalog_rejected",
    )

    const attackerAuthority = createAnthropicCatalogAuthority()
    const selfConsistentForgery = sealValidatedAnthropicModelCatalog(attackerAuthority, {
      modelIDs: ["attacker-controlled-model"],
      validationSourceDigest: digest("caller-controlled nonzero source digest"),
    })
    expectCode(
      () =>
        buildAnthropicOneTurnRequest({
          catalogAuthority,
          catalog: selfConsistentForgery,
          modelID: "attacker-controlled-model",
          userText: "private",
          maxTokens: 128,
        }),
      "catalog_rejected",
    )
  })

  test("rejects models outside the validated catalog and invalid token limits without leaking input", () => {
    const secret = "private-prompt-secret"
    for (const input of [
      { catalog, modelID: "claude-not-in-catalog", userText: secret, maxTokens: 128 },
      { catalog, modelID: "claude-haiku-4-5-20251001", userText: secret, maxTokens: 0 },
      { catalog, modelID: "claude-haiku-4-5-20251001", userText: secret, maxTokens: 4_097 },
    ] as const) {
      const error = capture(() => buildAnthropicOneTurnRequest({ catalogAuthority, ...input }))
      expect(error.message).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
    }
  })

  test("parses a bounded terminal text stream as observed and not verified", () => {
    const body = sse(
      { type: "message_start", message: { usage: { input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " Astra" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
      { type: "message_stop" },
    )
    const result = parseAnthropicOneTurnResponse(response(body))

    expect(result).toEqual({
      status: "observed_not_verified",
      assistantText: "Hello Astra",
      finishReason: "stop",
      evidence: {
        responseBodyDigest: digest(body),
        responseBodyBytes: body.byteLength,
        assistantTextDigest: digest("Hello Astra"),
        assistantTextBytes: 11,
        eventCount: 7,
      },
    })
    expect(JSON.stringify(result)).not.toContain("VERIFIED")
  })

  test("rejects non-success status and non-SSE content types", () => {
    const terminal = validBody("ok")
    expectCode(() => parseAnthropicOneTurnResponse(response(terminal, 429)), "http_status_rejected")
    expectCode(() => parseAnthropicOneTurnResponse(response(terminal, 201)), "http_status_rejected")
    expectCode(
      () =>
        parseAnthropicOneTurnResponse({
          statusCode: 200,
          headers: [["content-type", "application/json"]],
          body: terminal,
        }),
      "content_type_rejected",
    )
  })

  test("rejects malformed events and provider errors without echoing response text", () => {
    const secret = "provider-error-secret"
    expectCode(
      () => parseAnthropicOneTurnResponse(response(bytes(`data: {"type":\n\n`))),
      "event_invalid",
    )
    const error = capture(() =>
      parseAnthropicOneTurnResponse(response(sse({ type: "error", error: { type: "api_error", message: secret } }))),
    )
    expect(error.code).toBe("provider_error")
    expect(error.message).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  test("rejects local and provider-executed tool use", () => {
    for (const type of ["tool_use", "server_tool_use", "web_search_tool_result"] as const) {
      const body = sse(
        { type: "message_start", message: { usage: {} } },
        { type: "content_block_start", index: 0, content_block: { type, id: "tool-1", name: "search" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      )
      expectCode(() => parseAnthropicOneTurnResponse(response(body)), "tool_use_rejected")
    }
  })

  test("rejects oversized wire responses and oversized assistant text", () => {
    expectCode(
      () =>
        parseAnthropicOneTurnResponse(
          response(new Uint8Array(anthropicOneTurnMaximumResponseBytes + 1).fill("x".charCodeAt(0))),
        ),
      "response_too_large",
    )
    expectCode(
      () => parseAnthropicOneTurnResponse(response(validBody("x".repeat(anthropicOneTurnMaximumAssistantBytes + 1)))),
      "assistant_text_too_large",
    )
  })

  test("rejects truncated streams and streams without a valid terminal stop", () => {
    const truncated = bytes(
      sseText(
        { type: "message_start", message: { usage: {} } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      ).slice(0, -2),
    )
    expectCode(() => parseAnthropicOneTurnResponse(response(truncated)), "stream_truncated")

    const noStop = sse(
      { type: "message_start", message: { usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "content_block_stop", index: 0 },
    )
    expectCode(() => parseAnthropicOneTurnResponse(response(noStop)), "stream_truncated")

    const invalidStop = sse(
      { type: "message_start", message: { usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
      { type: "message_stop" },
    )
    expectCode(() => parseAnthropicOneTurnResponse(response(invalidStop)), "terminal_stop_rejected")
  })
})

function validBody(text: string) {
  return sse(
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  )
}

function response(body: Uint8Array, statusCode = 200) {
  return {
    statusCode,
    headers: [["content-type", "text/event-stream; charset=utf-8"]] as const,
    body,
  }
}

function sse(...events: ReadonlyArray<unknown>) {
  return bytes(sseText(...events))
}

function sseText(...events: ReadonlyArray<unknown>) {
  return events.map((event) => `event: ${eventType(event)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

function eventType(event: unknown) {
  if (typeof event !== "object" || event === null || !("type" in event) || typeof event.type !== "string") {
    return "message"
  }
  return event.type
}

function bytes(input: string) {
  return new TextEncoder().encode(input)
}

function digest(input: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function zeroDigest(): `sha256:${string}` {
  return `sha256:${"0".repeat(64)}`
}

function capture(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (error instanceof AnthropicOneTurnError) return error
    throw error
  }
  throw new Error("Expected the operation to fail")
}

function expectCode(run: () => unknown, code: AnthropicOneTurnError["code"]) {
  expect(capture(run).code).toBe(code)
}
