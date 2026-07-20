import { describe, expect, test } from "bun:test"
import { resolveCertifiedProviderAdapter, type CertifiedProviderAdapter } from "../src/provider-adapter-registry"
import {
  buildOpenAIResponsesOneTurnRequest,
  OpenAIResponsesOneTurnError,
  parseOpenAIResponsesOneTurnResponse,
} from "../src/openai-responses-one-turn"

const apiKeyAdapter = requiredAdapter("openai-api-key")
const codexAdapter = requiredAdapter("openai-codex-oauth")

describe("Astra OpenAI Responses one-turn protocol", () => {
  test("builds tool-free API-key and Codex OAuth requests for their exact destinations", () => {
    const build = (adapter: CertifiedProviderAdapter) =>
      buildOpenAIResponsesOneTurnRequest({
        adapter,
        modelID: "gpt-5.4",
        userText: "Explain the operation state.",
        maxOutputTokens: 1_024,
        sessionID: "019f6c64-25e9-7ce2-8817-45becb7e02fe",
        userAgent: "astra/local (darwin; arm64)",
        conversationTurns: [{ userText: "What is Astra?", assistantText: "A governed coding agent." }],
      })
    const apiKeyRequest = build(apiKeyAdapter)
    const codexRequest = build(codexAdapter)

    for (const [request, adapter] of [
      [apiKeyRequest, apiKeyAdapter],
      [codexRequest, codexAdapter],
    ] as const) {
      expect(request.headers).toEqual([
        ["accept", "text/event-stream"],
        ["content-type", "application/json"],
        ["originator", "opencode"],
        ["session-id", "019f6c64-25e9-7ce2-8817-45becb7e02fe"],
        ["user-agent", "astra/local (darwin; arm64)"],
      ])
      expect(JSON.parse(new TextDecoder().decode(request.privateWireBody))).toMatchObject({
        model: "gpt-5.4",
        instructions:
          "You are Astra, a professional coding assistant. Answer clearly and truthfully. This turn has no tools, files, shell, Git, skills, plugins, MCP, memory, or external-system access. Never claim that you used them.",
        input: [
          { role: "user", content: [{ type: "input_text", text: "What is Astra?" }] },
          { role: "assistant", content: [{ type: "output_text", text: "A governed coding agent." }] },
          { role: "user", content: [{ type: "input_text", text: "Explain the operation state." }] },
        ],
        tools: [],
        tool_choice: "none",
        store: false,
        stream: true,
      })
      expect(request.evidence.adapterDigest).toBe(adapter.adapterDigest)
      expect(JSON.stringify(request.evidence)).not.toContain("Explain the operation state.")
    }

    expect(apiKeyRequest.destination).toEqual(apiKeyAdapter.destination)
    expect(codexRequest.destination).toEqual(codexAdapter.destination)
    expect(JSON.parse(new TextDecoder().decode(apiKeyRequest.privateWireBody))).toMatchObject({
      max_output_tokens: 1_024,
    })
    expect(JSON.parse(new TextDecoder().decode(codexRequest.privateWireBody))).not.toHaveProperty("max_output_tokens")
  })

  test("observes a bounded terminal text response without claiming verification", () => {
    const response = parseOpenAIResponsesOneTurnResponse(rawResponse([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
      { type: "response.output_text.delta", item_id: "msg_1", delta: " from Astra." },
      { type: "response.output_text.done", item_id: "msg_1", text: "Hello from Astra." },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ]))

    expect(response).toMatchObject({
      status: "observed_not_verified",
      assistantText: "Hello from Astra.",
      finishReason: "stop",
      evidence: { eventCount: 5, assistantTextBytes: 17 },
    })
  })

  test("accepts the inherited Codex SSE terminal event without an artificial DONE sentinel", () => {
    const response = parseOpenAIResponsesOneTurnResponse(
      rawResponse(
        [
          { type: "response.output_text.delta", item_id: "msg_1", delta: "ASTRA-ONE" },
          { type: "response.completed", response: { id: "resp_1", status: "completed" } },
        ],
        false,
      ),
    )

    expect(response).toMatchObject({
      status: "observed_not_verified",
      assistantText: "ASTRA-ONE",
      finishReason: "stop",
    })
  })

  test("rejects tool use, failed or truncated streams, and a forged adapter before transport", () => {
    expect(() =>
      parseOpenAIResponsesOneTurnResponse(
        rawResponse([
          { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
          { type: "response.output_item.added", item: { type: "function_call", id: "call_1" } },
        ]),
      ),
    ).toThrow(new OpenAIResponsesOneTurnError("tool_use_rejected"))
    expect(() =>
      parseOpenAIResponsesOneTurnResponse(
        rawResponse([{ type: "response.failed", response: { id: "resp_1", status: "failed" } }]),
      ),
    ).toThrow(new OpenAIResponsesOneTurnError("provider_error"))
    expect(() =>
      parseOpenAIResponsesOneTurnResponse(
        rawResponse([{ type: "response.output_text.delta", item_id: "msg_1", delta: "partial" }]),
      ),
    ).toThrow(new OpenAIResponsesOneTurnError("stream_truncated"))

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- hostile adapter fixture
    const forged = {
      ...apiKeyAdapter,
      destination: { ...apiKeyAdapter.destination, origin: "https://proxy.example" },
    } as unknown as CertifiedProviderAdapter
    expect(() =>
      buildOpenAIResponsesOneTurnRequest({
        adapter: forged,
        modelID: "gpt-5.2-codex",
        userText: "Do not send this.",
        maxOutputTokens: 1_024,
        sessionID: "019f6c64-25e9-7ce2-8817-45becb7e02fe",
        userAgent: "astra/local (darwin; arm64)",
      }),
    ).toThrow(new OpenAIResponsesOneTurnError("adapter_rejected"))
  })
})

function requiredAdapter(profile: "openai-api-key" | "openai-codex-oauth") {
  const adapter = resolveCertifiedProviderAdapter("openai", profile)
  if (!adapter) throw new Error("Missing test adapter")
  return adapter
}

function rawResponse(events: ReadonlyArray<Readonly<Record<string, unknown>>>, done = true) {
  return {
    statusCode: 200,
    headers: [["content-type", "text/event-stream; charset=utf-8"]] as const,
    body: new TextEncoder().encode(
      `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`,
    ),
  }
}
