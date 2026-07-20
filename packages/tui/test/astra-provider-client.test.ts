import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeProviderSkillContextBindingDigest, type ProviderTurnSkillContext } from "@astra/domain/provider-control"
import { AstraControlClientError } from "../src/astra/control-client"
import { createAstraProviderClient } from "../src/astra/provider-client"

const roots: string[] = []
const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(closeServer))
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("provider client accepts only correlated catalog, preview, progress, and observed response", async () => {
  let preparedRequest: Record<string, string> | undefined
  const fixture = await startFixture((socket, request) => {
    accepted(socket, request.requestId)
    if (request.method === "provider.catalog") return terminal(socket, catalogResult(request.requestId))
    if (request.method === "provider.turn.prepare") {
      preparedRequest = request
      return terminal(socket, prepareResult(request.requestId))
    }
    for (const status of progressOrder) progress(socket, request.requestId, status)
    terminal(socket, completionResult(request.requestId))
  })
  const client = createAstraProviderClient(fixture.environment, sessionID)
  const catalog = await client.catalog()
  expect(catalog).toMatchObject({
    status: "available",
    catalog: {
      providers: [{ providerID: "anthropic" }, { providerID: "openai" }],
    },
    transcript: {
      turns: [],
      retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
    },
  })
  const prepared = await client.prepare(anthropicSelection, "private prompt")
  expect(preparedRequest).toMatchObject({
    providerID: "anthropic",
    credentialProfile: "anthropic-api-key",
    modelID,
  })
  expect(prepared.status).toBe("prepared")
  if (prepared.status !== "prepared") throw new Error("Expected prepared fixture")
  const observed: string[] = []
  const result = await client.decide(prepared.preview.proposalID, "approve", {
    onProgress(event) {
      observed.push(event.status)
    },
  })

  expect(observed).toEqual([...progressOrder])
  expect(result).toMatchObject({
    status: "response_observed_not_verified",
    completionLabel: "COMPLETED — RESPONSE OBSERVED — NOT VERIFIED",
    response: { assistantText: "Hello Astra" },
  })
  client.dispose()
})

test("provider client rejects a forged response digest and a post-approval disconnect", async () => {
  const forged = await startFixture((socket, request) => {
    accepted(socket, request.requestId)
    if (request.method === "provider.turn.prepare") return terminal(socket, prepareResult(request.requestId))
    for (const status of progressOrder) progress(socket, request.requestId, status)
    terminal(socket, {
      ...completionResult(request.requestId),
      response: {
        ...completionResult(request.requestId).response,
        assistantTextDigest: digest("forged"),
      },
    })
  })
  const forgedClient = createAstraProviderClient(forged.environment, sessionID)
  const prepared = await forgedClient.prepare(anthropicSelection, "private")
  if (prepared.status !== "prepared") throw new Error("Expected prepared fixture")
  expect(await forgedClient.decide(prepared.preview.proposalID, "approve").catch((error) => error)).toMatchObject({
    code: "protocol_invalid",
  })

  const disconnected = await startFixture((socket, request) => {
    accepted(socket, request.requestId)
    if (request.method === "provider.turn.prepare") return terminal(socket, prepareResult(request.requestId))
    progress(socket, request.requestId, "recording_authority")
    socket.destroy()
  })
  const disconnectedClient = createAstraProviderClient(disconnected.environment, sessionID)
  const second = await disconnectedClient.prepare(anthropicSelection, "private")
  if (second.status !== "prepared") throw new Error("Expected prepared fixture")
  expect(await disconnectedClient.decide(second.preview.proposalID, "approve").catch((error) => error)).toMatchObject({
    code: "transport_failed",
  })
})

test("provider client fails closed without a private provider socket", async () => {
  const client = createAstraProviderClient({}, sessionID)
  const error = await client.catalog().catch((cause) => cause)
  expect(error).toBeInstanceOf(AstraControlClientError)
  expect(error).toMatchObject({ code: "unavailable" })
})

test("provider client accepts skill metadata while keeping instructions outside the public protocol", async () => {
  const privateInstructions = "private instructions must not cross the provider control socket"
  const fixture = await startFixture((socket, request) => {
    accepted(socket, request.requestId)
    terminal(socket, skillPrepareResult(request.requestId))
  })
  const client = createAstraProviderClient(fixture.environment, sessionID)
  const result = await client.prepare(anthropicSelection, "Use the selected skill")

  if (result.status !== "prepared") throw new Error("Expected skilled preview")
  expect(result.preview.skillContext).toMatchObject({
    name: "safe-skill",
    trust: "UNTRUSTED INSTRUCTION DATA",
    disclosure: "included_in_provider_request",
  })
  expect(result.preview.logicalPayload.contextBindingDigest).toBe(
    computeProviderSkillContextBindingDigest(skillContext),
  )
  expect(JSON.stringify(result)).not.toContain(privateInstructions)
})

test("provider client preserves domain-valid escape-heavy request and response frames", async () => {
  const escapedPrompt = "\u0001".repeat(65_536)
  const escapedResponse = "\u0001".repeat(300_000)
  const fixture = await startFixture((socket, request) => {
    accepted(socket, request.requestId)
    if (request.method === "provider.turn.prepare") {
      expect(request.userText).toBe(escapedPrompt)
      return terminal(socket, prepareResult(request.requestId))
    }
    for (const status of progressOrder) progress(socket, request.requestId, status)
    terminal(socket, completionResult(request.requestId, escapedResponse))
  })
  const client = createAstraProviderClient(fixture.environment, sessionID)
  const prepared = await client.prepare(anthropicSelection, escapedPrompt)
  if (prepared.status !== "prepared") throw new Error("Expected prepared fixture")
  const result = await client.decide(prepared.preview.proposalID, "approve")

  expect(Buffer.byteLength(JSON.stringify(escapedResponse))).toBeGreaterThan(1_200_000)
  expect(result).toMatchObject({
    status: "response_observed_not_verified",
    response: {
      assistantText: escapedResponse,
      assistantTextBytes: escapedResponse.length,
    },
  })
})

test("provider client binds the exact OpenAI profile and rejects mutated preview authority", async () => {
  let observed: Record<string, string> | undefined
  const exact = await startFixture((socket, request) => {
    observed = request
    accepted(socket, request.requestId)
    terminal(socket, openAIPrepareResult(request.requestId))
  })
  const client = createAstraProviderClient(exact.environment, sessionID)
  const prepared = await client.prepare(openAISelection, "Keep the authority exact")
  expect(prepared.status).toBe("prepared")
  expect(observed).toMatchObject(openAISelection)

  for (const mutate of [
    (base: ReturnType<typeof openAIPrepareResult>) => ({
      ...base,
      preview: {
        ...base.preview,
        credential: { ...base.preview.credential, profile: "openai-api-key" },
      },
    }),
    (base: ReturnType<typeof openAIPrepareResult>) => ({
      ...base,
      preview: {
        ...base.preview,
        destination: {
          ...base.preview.destination,
          origin: "https://example.invalid",
        },
      },
    }),
  ]) {
    const fixture = await startFixture((socket, request) => {
      accepted(socket, request.requestId)
      terminal(socket, mutate(openAIPrepareResult(request.requestId)))
    })
    const mutatedClient = createAstraProviderClient(fixture.environment, sessionID)
    expect(await mutatedClient.prepare(openAISelection, "Reject mutation").catch((error) => error)).toMatchObject({
      code: "protocol_invalid",
    })
  }
})

const sessionID = "10000000-0000-4000-8000-000000000001"
const requestToken = "a".repeat(43)
const proposalID = "20000000-0000-4000-8000-000000000002"
const operationID = "30000000-0000-4000-8000-000000000003"
const receiptID = "40000000-0000-4000-8000-000000000004"
const modelID = "claude-sonnet-4-5-20250929"
const anthropicSelection = {
  providerID: "anthropic",
  credentialProfile: "anthropic-api-key",
  modelID,
} as const
const openAISelection = {
  providerID: "openai",
  credentialProfile: "openai-codex-oauth",
  modelID: "gpt-5.2-codex",
} as const
const progressOrder = [
  "recording_authority",
  "authority_claimed",
  "network_dispatch",
  "response_observed_not_verified",
  "receipt_acknowledged",
] as const

async function startFixture(handler: (socket: Socket, request: Record<string, string>) => void) {
  const root = await mkdtemp(join(tmpdir(), "astra-provider-client-"))
  roots.push(root)
  const socketPath = join(root, "provider.sock")
  const server = createServer((socket) => readRequest(socket).then((request) => handler(socket, request)))
  servers.push(server)
  await listen(server, socketPath)
  return {
    environment: {
      ASTRA_PROVIDER_SOCKET: socketPath,
      ASTRA_PROVIDER_TOKEN: requestToken,
    },
  }
}

function readRequest(socket: Socket) {
  return new Promise<Record<string, string>>((resolve) => {
    let value = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      value += chunk
      if (!value.endsWith("\n")) return
      resolve(JSON.parse(value))
    })
  })
}

function accepted(socket: Socket, requestId: string) {
  socket.write(JSON.stringify({ schemaVersion: 1, type: "accepted", requestId }) + "\n")
}

function progress(socket: Socket, requestId: string, status: (typeof progressOrder)[number]) {
  socket.write(
    JSON.stringify({
      schemaVersion: 1,
      requestId,
      proposalID,
      operationID,
      status,
    }) + "\n",
  )
}

function terminal(socket: Socket, result: unknown) {
  socket.end(JSON.stringify(result) + "\n")
}

function catalogResult(requestId: string) {
  return {
    schemaVersion: 1,
    requestId,
    status: "available",
    catalog: {
      providers: [
        {
          providerID: "anthropic",
          providerName: "Anthropic",
          assurance: "CERTIFIED",
          dispatchable: true,
          credentialProfiles: ["anthropic-api-key"],
          models: [
            {
              id: modelID,
              name: "Claude Sonnet",
              limits: { context: 200_000, output: 8_192 },
            },
          ],
        },
        {
          providerID: "openai",
          providerName: "OpenAI",
          assurance: "CERTIFIED",
          dispatchable: true,
          credentialProfiles: ["openai-api-key", "openai-codex-oauth"],
          models: [
            {
              id: "gpt-5.2-codex",
              name: "GPT-5.2 Codex",
              limits: { context: 400_000, output: 128_000 },
            },
          ],
        },
      ],
    },
    transcript: {
      turns: [],
      historyDigest: `sha256:${"0".repeat(64)}`,
      totalBytes: 0,
      retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
    },
  }
}

function prepareResult(requestId: string) {
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      proposalID,
      operationID,
      providerID: "anthropic",
      modelID,
      adapter: {
        adapterID: "anthropic.messages.api-key.v1",
        adapterDigest: digest("anthropic adapter"),
        assurance: "CERTIFIED",
      },
      destination: {
        method: "POST",
        origin: "https://api.anthropic.com",
        path: "/v1/messages",
      },
      logicalPayload: {
        digest: digest("private body"),
        bytes: 128,
        contextBindingDigest: null,
      },
      conversation: {
        priorTurns: 0,
        historyBytes: 0,
        historyDigest: `sha256:${"0".repeat(64)}`,
        retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
      },
      providerCapabilityDigest: digest("provider capability"),
      skillContext: null,
      headerNames: ["anthropic-version", "content-type", "x-api-key"],
      credential: {
        profile: "anthropic-api-key",
        accountFingerprint: `sha256:${"2".repeat(64)}`,
        headerName: "x-api-key",
      },
      expiresAt: "2026-07-17T16:00:00.000Z",
      hostBoundaryLabel: "HOST EXECUTION — NO SANDBOX",
      networkBoundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
      assurance: "NOT VERIFIED",
    },
  }
}

function openAIPrepareResult(requestId: string) {
  const base = prepareResult(requestId)
  return {
    ...base,
    preview: {
      ...base.preview,
      providerID: "openai",
      modelID: "gpt-5.2-codex",
      adapter: {
        adapterID: "openai.responses.codex-oauth.v1",
        adapterDigest: digest("openai adapter"),
        assurance: "CERTIFIED",
      },
      destination: {
        method: "POST",
        origin: "https://chatgpt.com",
        path: "/backend-api/codex/responses",
      },
      headerNames: [
        "accept",
        "authorization",
        "content-type",
        "originator",
        "session-id",
        "user-agent",
      ],
      credential: {
        profile: "openai-codex-oauth",
        accountFingerprint: `sha256:${"3".repeat(64)}`,
        headerName: "authorization",
      },
    },
  } as const
}

function skillPrepareResult(requestId: string) {
  const base = prepareResult(requestId)
  return {
    ...base,
    preview: {
      ...base.preview,
      logicalPayload: {
        ...base.preview.logicalPayload,
        contextBindingDigest: computeProviderSkillContextBindingDigest(skillContext),
      },
      skillContext,
    },
  }
}

const skillContext = {
  kind: "activated_skill",
  activationOperationID: "50000000-0000-4000-8000-000000000005",
  activationCapabilityDigest: digest("skill capability"),
  name: "safe-skill",
  provenance: "workspace_opencode",
  instructionsDigest: digest("private instructions must not cross the provider control socket"),
  trust: "UNTRUSTED INSTRUCTION DATA",
  resourceDiscovery: "none",
  assurance: "OBSERVED NOT VERIFIED",
  disclosure: "included_in_provider_request",
} as const satisfies ProviderTurnSkillContext

function completionResult(requestId: string, assistantText = "Hello Astra") {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    operationID,
    status: "response_observed_not_verified",
    receiptID,
    completionLabel: "COMPLETED — RESPONSE OBSERVED — NOT VERIFIED",
    response: {
      assistantText,
      assistantTextDigest: digest(assistantText),
      assistantTextBytes: Buffer.byteLength(assistantText),
      finishReason: "stop",
    },
  }
}

function digest(input: string) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function listen(server: Server, socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}
