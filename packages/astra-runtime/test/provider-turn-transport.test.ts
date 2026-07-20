import { afterAll, describe, expect, test } from "bun:test"
import { createHash, X509Certificate } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rootCertificates } from "node:tls"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import { digest } from "../src/controlled-write-authority"
import { OpenAIResponsesOneTurnError } from "../src/openai-responses-one-turn"
import { recoverProviderTurn, type ExecuteProviderTurnInput } from "../src/provider-turn-coordinator"
import {
  providerTurnLoopbackPolicyDigest,
  providerTurnPublicDnsPolicyDigest,
  providerTurnResolverImplementationDigest,
  providerTurnTransportImplementationDigest,
  type ProviderTurnNetworkPolicy,
} from "../src/provider-turn-network-policy"
import { runWithLedger } from "../src/operation-storage"
import {
  executeProviderTurnWithTrustedObservedTransport,
  executeProviderTurnWithTrustedTransport,
  providerTurnTransportTestOnly,
  trustedProviderTurnTransportDescriptor,
} from "../src/provider-turn-transport"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterAll(async () => {
  servers.forEach((server) => server.stop(true))
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("trusted provider turn transport boundary", () => {
  test("takes the parent credential only after consent and claim, then durably returns parsed text", async () => {
    const secret = "parent-only-secret"
    const body = new TextEncoder().encode('{"input":"private"}')
    let calls = 0
    let credentialTakes = 0
    const server = startServer(() => {
      calls += 1
      return new Response("data: terminal\n\n", { headers: { "content-type": "text/event-stream" } })
    })
    const input = await operationInput(server.url.origin, body)
    const result = await executeProviderTurnWithTrustedObservedTransport(
      input,
      async () => {
        credentialTakes += 1
        expect(await eventNames(input)).toEqual([
          "operation.admitted",
          "policy.ask",
          "approval.granted",
          "dispatch.requested",
          "executor.accepted",
        ])
        return {
          body,
          credential: { ...credentialBinding(), value: secret },
          headers: [["content-type", "application/json"]],
        }
      },
      (response) => ({
        status: "observed_not_verified",
        assistantText: "Hello from Astra",
        finishReason: "stop",
        evidence: {
          responseBodyDigest: rawDigest(response.body),
          responseBodyBytes: response.body.byteLength,
          assistantTextDigest: rawDigest(new TextEncoder().encode("Hello from Astra")),
          assistantTextBytes: Buffer.byteLength("Hello from Astra"),
          eventCount: 1,
        },
      }),
      {
        mode: "test_only_loopback",
        now: () => Date.parse(input.policyAskedAt) + 100,
        async requestApproval() {
          expect(credentialTakes).toBe(0)
          expect(calls).toBe(0)
          return "approve"
        },
      },
    )

    expect(credentialTakes).toBe(1)
    expect(calls).toBe(1)
    expect(result).toMatchObject({
      state: "completed",
      status: "response_observed_not_verified",
      response: { assistantText: "Hello from Astra", finishReason: "stop" },
    })
    expect(await eventNames(input)).toContain("effect.completed")
  })

  test("records an allowlisted provider parser reason without persisting private response data", async () => {
    const privateResponse = "private provider response that must not be persisted"
    const body = new TextEncoder().encode('{"input":"private"}')
    const server = startServer(() =>
      new Response(privateResponse, { headers: { "content-type": "text/event-stream" } }),
    )
    const input = await operationInput(server.url.origin, body)

    const result = await executeProviderTurnWithTrustedObservedTransport(
      input,
      async () => wireValues(body),
      () => {
        throw new OpenAIResponsesOneTurnError("event_sequence_rejected")
      },
      {
        mode: "test_only_loopback",
        now: () => Date.parse(input.policyAskedAt) + 100,
        async requestApproval() {
          return "approve"
        },
      },
    )

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    const durable = JSON.stringify(await durableEvents(input))
    expect(durable).toContain("PROVIDER_RESPONSE_EVENT_SEQUENCE_REJECTED")
    expect(durable).not.toContain(privateResponse)
  })

  test("sends exact bytes once and only after durable consent and claim", async () => {
    const secret = "Bearer provider-secret-that-must-not-be-persisted"
    const prompt = "private prompt that must remain outside durable facts"
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-5", input: prompt }))
    let calls = 0
    let requestBody = new Uint8Array()
    let authorization = ""
    const server = startServer(async (request) => {
      calls += 1
      requestBody = new Uint8Array(await request.arrayBuffer())
      authorization = request.headers.get("authorization") ?? ""
      return Response.json({ output: [{ type: "message", content: "hello" }] })
    })
    const input = await operationInput(server.url.origin, body)

    const result = await executeProviderTurnWithTrustedTransport(
      input,
      {
        body,
        credential: { ...credentialBinding(), value: secret },
        headers: [["content-type", "application/json"]],
      },
      {
        mode: "test_only_loopback",
        now: () => Date.parse(input.policyAskedAt) + 100,
        async requestApproval(preview) {
          expect(preview.credential).toEqual({
            profile: "openai-api-key",
            ...credentialBinding(),
            headerName: "authorization",
          })
          expect(preview.wireRequest).toEqual({
            method: "POST",
            path: "/v1/chat/completions",
            headerNames: ["authorization", "content-type"],
            timeoutMilliseconds: 1_000,
            maximumResponseBytes: 1_024,
          })
          expect(await eventNames(input)).toEqual(["operation.admitted", "policy.ask"])
          return "approve"
        },
      },
    )

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(result.boundaryLabel).toBe("NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX")
    expect(calls).toBe(1)
    expect(requestBody).toEqual(body)
    expect(authorization).toBe(secret)
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])
    const durable = JSON.stringify(await durableEvents(input))
    expect(durable).not.toContain(secret)
    expect(durable).not.toContain(prompt)
    expect(durable).not.toContain("VERIFIED")
    expect(durable).not.toContain("succeeded")
    expect(durable).toContain("provider_network_dispatch")
    expect(durable).toContain("127.0.0.1")
    expect(durable).toContain('\\"statusCode\\":200')
    expect(durable).toContain('\\"contentType\\":\\"application/json\\"')
  })

  test("rejects consent and mismatched bytes without any network effect", async () => {
    let calls = 0
    const server = startServer(() => {
      calls += 1
      return new Response("unexpected")
    })
    const body = new TextEncoder().encode('{"input":"approved bytes"}')
    const rejected = await operationInput(server.url.origin, body)
    const result = await executeProviderTurnWithTrustedTransport(rejected, wireValues(body), {
      mode: "test_only_loopback",
      now: () => Date.parse(rejected.policyAskedAt) + 100,
      async requestApproval() {
        return "reject"
      },
    })
    expect(result).toMatchObject({ state: "denied", status: "denied_without_effect" })
    expect(calls).toBe(0)

    const mismatch = await operationInput(server.url.origin, body)
    expect(() =>
      executeProviderTurnWithTrustedTransport(mismatch, wireValues(new TextEncoder().encode('{"input":"different"}')), {
        mode: "test_only_loopback",
        async requestApproval() {
          throw new Error("Consent must not be reached for mismatched bytes")
        },
      }),
    ).toThrow("does not match the admitted logical payload")

    const credentialMismatch = await operationInput(server.url.origin, body)
    for (const credential of [
      { ...credentialBinding(), handle: "auth:openai:other", value: "Bearer other" },
      { ...credentialBinding(), accountFingerprint: digest("other provider account"), value: "Bearer other" },
    ]) {
      expect(() =>
        executeProviderTurnWithTrustedTransport(
          credentialMismatch,
          { ...wireValues(body), credential },
          {
            mode: "test_only_loopback",
            async requestApproval() {
              throw new Error("Consent must not be reached for mismatched credentials")
            },
          },
        ),
      ).toThrow("does not match the admitted credential binding")
    }
    expect(calls).toBe(0)
  })

  test("preserves bounded status and normalized SSE content type as uncertain evidence", async () => {
    const body = new TextEncoder().encode('{"input":"stream"}')
    const server = startServer(
      () =>
        new Response("data: {}\n\n", {
          status: 202,
          headers: { "content-type": "Text/Event-Stream; Charset=UTF-8" },
        }),
    )
    const input = await operationInput(server.url.origin, body)
    const result = await executeProviderTurnWithTrustedTransport(input, wireValues(body), {
      mode: "test_only_loopback",
      now: () => Date.parse(input.policyAskedAt) + 100,
      async requestApproval() {
        return "approve"
      },
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    const durable = JSON.stringify(await durableEvents(input))
    expect(durable).toContain('\\"statusCode\\":202')
    expect(durable).toContain('\\"contentType\\":\\"text/event-stream\\"')
    expect(durable).not.toContain("VERIFIED")
  })

  test("revalidates authority immediately before writing credentials or body", async () => {
    let calls = 0
    const server = startServer(() => {
      calls += 1
      return new Response("unexpected")
    })
    const body = new TextEncoder().encode('{"input":"must not send"}')
    const input = await operationInput(server.url.origin, body)
    const result = await executeProviderTurnWithTrustedTransport(input, wireValues(body), {
      mode: "test_only_loopback",
      now: () => Date.parse(input.policyAskedAt) + 100,
      async beforeCredentialWrite() {
        await rm(input.report.root, { recursive: true, force: true })
        await mkdir(input.report.root)
      },
      async requestApproval() {
        return "approve"
      },
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(calls).toBe(0)
  })

  test("never follows redirects and never retries a refused response", async () => {
    let initialCalls = 0
    let redirectedCalls = 0
    const server = startServer((request) => {
      if (new URL(request.url).pathname === "/redirected") {
        redirectedCalls += 1
        return new Response("redirect target")
      }
      initialCalls += 1
      return new Response(null, { status: 307, headers: { location: "/redirected" } })
    })
    const body = new TextEncoder().encode('{"input":"one request"}')
    const input = await operationInput(server.url.origin, body)

    const result = await executeProviderTurnWithTrustedTransport(input, wireValues(body), {
      mode: "test_only_loopback",
      now: () => Date.parse(input.policyAskedAt) + 100,
      async requestApproval() {
        return "approve"
      },
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(initialCalls).toBe(1)
    expect(redirectedCalls).toBe(0)
    expect(await eventNames(input)).toContain("effect.unknown")
    expect(await eventNames(input)).not.toContain("effect.completed")
  })

  test("bounds response bytes and timeout without issuing a second request", async () => {
    let responseLimitCalls = 0
    const limitServer = startServer(() => {
      responseLimitCalls += 1
      return new Response("x".repeat(128))
    })
    const body = new TextEncoder().encode('{"input":"bounded"}')
    const limited = await operationInput(limitServer.url.origin, body, { maximumResponseBytes: 32 })
    expect(
      await executeProviderTurnWithTrustedTransport(limited, wireValues(body), {
        mode: "test_only_loopback",
        now: () => Date.parse(limited.policyAskedAt) + 100,
        async requestApproval() {
          return "approve"
        },
      }),
    ).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(responseLimitCalls).toBe(1)

    let timeoutCalls = 0
    const timeoutServer = startServer(async () => {
      timeoutCalls += 1
      await Bun.sleep(200)
      return new Response("late")
    })
    const timed = await operationInput(timeoutServer.url.origin, body, { timeoutMilliseconds: 100 })
    expect(
      await executeProviderTurnWithTrustedTransport(timed, wireValues(body), {
        mode: "test_only_loopback",
        now: () => Date.parse(timed.policyAskedAt) + 100,
        async requestApproval() {
          return "approve"
        },
      }),
    ).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(timeoutCalls).toBe(1)
    expect(JSON.stringify(await durableEvents(timed))).toContain("RESPONSE_TIMEOUT")
  })

  test("rejects response events processed after the logical deadline", async () => {
    const body = new TextEncoder().encode('{"input":"logical deadline"}')
    let clock = Date.now()
    let calls = 0
    const server = startServer(() => {
      calls += 1
      clock += 101
      return Response.json({ output: "too late" })
    })
    const input = await operationInput(server.url.origin, body, { timeoutMilliseconds: 100 })
    clock = Date.parse(input.policyAskedAt) + 100
    const result = await executeProviderTurnWithTrustedTransport(input, wireValues(body), {
      mode: "test_only_loopback",
      now: () => clock,
      async requestApproval() {
        return "approve"
      },
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(calls).toBe(1)
    expect(JSON.stringify(await durableEvents(input))).not.toContain("provider_network_dispatch")
  })

  test("does not resolve DNS before durable approval and claim", async () => {
    expect(trustedProviderTurnTransportDescriptor).toMatchObject({
      networkTransportProductionCapable: true,
      productIntegrationCapable: false,
      peerEnforcement: "dns_resolved_ip_pinned_and_verified",
      tlsEnforcement: "original_hostname_sni_and_certificate",
      terminalState: "effect_unknown_only",
    })
    const body = new TextEncoder().encode('{"input":"reject before DNS"}')
    const input = await operationInput("http://127.0.0.1:8787", body)
    const origin = "https://api.example.test"
    const productionInput = {
      ...input,
      plan: {
        ...input.plan,
        origin,
        transportPolicy: "https_only" as const,
        networkPolicy: httpsNetworkPolicy(origin),
      },
    }
    let resolverCalls = 0
    const result = await executeProviderTurnWithTrustedTransport(productionInput, wireValues(body), {
      mode: "test_only_https_seam",
      now: () => Date.parse(productionInput.policyAskedAt) + 100,
      async resolver() {
        resolverCalls += 1
        return [{ address: "1.1.1.1", family: 4 }]
      },
      async requestApproval() {
        expect(resolverCalls).toBe(0)
        return "reject"
      },
    })
    expect(result).toMatchObject({ state: "denied", status: "denied_without_effect" })
    expect(resolverCalls).toBe(0)
  })

  test("bounds DNS with the same deadline and aborts without any connect attempt", async () => {
    const body = new TextEncoder().encode('{"input":"bounded DNS"}')
    const input = await operationInput("http://127.0.0.1:8787", body, { timeoutMilliseconds: 100 })
    const productionInput = withHttpsOrigin(input, "https://api.example.test")
    let resolverAborted = false
    let connectAttempts = 0
    const result = await executeProviderTurnWithTrustedTransport(productionInput, wireValues(body), {
      mode: "test_only_https_seam",
      resolver(_hostname, signal) {
        signal.addEventListener("abort", () => {
          resolverAborted = true
        })
        return new Promise(() => {})
      },
      onConnectAttempt() {
        connectAttempts += 1
      },
      async requestApproval() {
        return "approve"
      },
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(resolverAborted).toBeTrue()
    expect(connectAttempts).toBe(0)
  })

  test("ignores delayed DNS after concurrent claim recovery and sends nothing", async () => {
    const body = new TextEncoder().encode('{"input":"expired after DNS"}')
    const input = await operationInput("http://127.0.0.1:8787", body, { timeoutMilliseconds: 30_000 })
    const productionInput = withHttpsOrigin(input, "https://api.example.test")
    let clock = Date.parse(productionInput.policyAskedAt) + 100
    let resolverStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolverStarted = resolve
    })
    let releaseResolver!: () => void
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve
    })
    let connectAttempts = 0
    const execution = executeProviderTurnWithTrustedTransport(productionInput, wireValues(body), {
      mode: "test_only_https_seam",
      now: () => clock,
      async resolver() {
        resolverStarted()
        await resolverGate
        return [{ address: "1.1.1.1", family: 4 }]
      },
      onConnectAttempt() {
        connectAttempts += 1
      },
      async requestApproval() {
        return "approve"
      },
    })

    await started
    clock += 61_000
    const recovered = await recoverProviderTurn(productionInput, { now: () => clock })
    expect(recovered).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    releaseResolver()
    const result = await execution
    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(connectAttempts).toBe(0)
  })

  test("rejects private DNS answers and pins one public address against rebinding", async () => {
    const policy = httpsNetworkPolicy("https://api.example.test")
    for (const addresses of [
      [{ address: "10.0.0.8", family: 4 }],
      [
        { address: "1.1.1.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      [{ address: "fe80::1", family: 6 }],
      [{ address: "ff02::1", family: 6 }],
      [{ address: "64:ff9b::a00:1", family: 6 }],
      [{ address: "100:0:0:1::1", family: 6 }],
      [{ address: "2001::1", family: 6 }],
      [{ address: "2002:c000:201::", family: 6 }],
      [{ address: "0.0.0.0", family: 4 }],
    ]) {
      const rejection = await providerTurnTransportTestOnly
        .resolveProviderNetwork(policy, Date.now, async () => addresses)
        .then(
          () => null,
          (error: unknown) => error,
        )
      if (!(rejection instanceof Error)) throw new Error("Expected an ineligible DNS address rejection")
      expect(rejection.message).toContain("ineligible address")
    }

    let dnsAnswer = "1.1.1.1"
    const evidence = await providerTurnTransportTestOnly.resolveProviderNetwork(policy, Date.now, async () => [
      { address: dnsAnswer, family: 4 },
    ])
    dnsAnswer = "10.0.0.8"
    expect(providerTurnTransportTestOnly.pinnedAddress(evidence, policy.hostname)).toEqual({
      address: "1.1.1.1",
      family: 4,
    })
    expect(() => providerTurnTransportTestOnly.pinnedAddress(evidence, "rebound.example.test")).toThrow()
  })

  test("requires the pinned connected peer and original TLS hostname", async () => {
    const policy = httpsNetworkPolicy("https://api.example.test")
    const evidence = await providerTurnTransportTestOnly.resolveProviderNetwork(policy, Date.now, async () => [
      { address: "1.1.1.1", family: 4 },
    ])
    expect(() => providerTurnTransportTestOnly.assertConnectedPeer(evidence.selectedAddress, "1.0.0.1")).toThrow(
      "connected peer mismatch",
    )
    expect(() => providerTurnTransportTestOnly.assertConnectedPeer(evidence.selectedAddress, undefined)).toThrow()
    expect(providerTurnTransportTestOnly.assertConnectedPeer(evidence.selectedAddress, "1.1.1.1")).toBeUndefined()

    const tls = providerTurnTransportTestOnly.tlsConnectionOptions(evidence)
    expect(tls.host).toBe(evidence.selectedAddress.address)
    expect(tls.servername).toBe(policy.hostname)
    expect(tls.rejectUnauthorized).toBeTrue()
    expect(tls.ALPNProtocols).toEqual(["http/1.1"])
    const unrelatedCertificate = new X509Certificate(rootCertificates[0]!).toLegacyObject()
    expect(tls.checkServerIdentity("ignored.example.test", unrelatedCertificate)).toBeInstanceOf(Error)
  })

  test("rejects malformed, oversized, informational, and ambiguous HTTP response headers", () => {
    const parse = providerTurnTransportTestOnly.parseRawResponse
    expect(() => parse(Buffer.from("HTTP/1.1 199 Continue\r\ncontent-length: 0\r\n\r\n"), 32)).toThrow(
      "status unsupported",
    )
    expect(() => parse(Buffer.from("HTTP/1.1 200 OK\r\nbad header\r\n\r\n"), 32)).toThrow("header invalid")
    expect(() => parse(Buffer.from(`HTTP/1.1 200 OK\r\nx-long: ${"x".repeat(65_536)}\r\n\r\n`), 32)).toThrow(
      "headers invalid",
    )
    expect(() =>
      parse(
        Buffer.from(
          "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-type: application/json\r\ncontent-length: 0\r\n\r\n",
        ),
        32,
      ),
    ).toThrow("header repeated")
  })

  test("completes framed HTTP responses without waiting for a keep-alive socket to close", () => {
    const parseComplete = providerTurnTransportTestOnly.tryParseCompleteRawResponse
    const chunkedHead = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n"
    const partialChunked = Buffer.from(`${chunkedHead}5\r\nhello\r\n`)
    expect(parseComplete(partialChunked, 32)).toBeUndefined()

    const completeChunked = Buffer.concat([partialChunked, Buffer.from("0\r\n\r\n")])
    expect(parseComplete(completeChunked, 32)).toMatchObject({
      body: new TextEncoder().encode("hello"),
      evidence: { statusCode: 200, contentType: "text/event-stream" },
    })

    const contentLengthHead = Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n")
    expect(parseComplete(Buffer.concat([contentLengthHead, Buffer.from("hell")]), 32)).toBeUndefined()
    expect(parseComplete(Buffer.concat([contentLengthHead, Buffer.from("hello")]), 32)?.body).toEqual(
      new TextEncoder().encode("hello"),
    )
  })
})

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return server
}

async function operationInput(
  origin: string,
  body: Uint8Array,
  limits: Readonly<{ timeoutMilliseconds?: number; maximumResponseBytes?: number }> = {},
) {
  const workspace = await temporaryDirectory("astra-provider-transport-workspace-")
  const state = await temporaryDirectory("astra-provider-transport-state-")
  await writeFile(join(workspace, "package.json"), "{}\n")
  const report = await scanWorkspace(workspace)
  const base = Date.now() - 500
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    plan: {
      operationID: crypto.randomUUID(),
      workspaceRoot: report.root,
      sessionID: "session-transport",
      messageID: "message-transport",
      providerID: "openai",
      modelID: "gpt-5",
      variant: null,
      adapter: {
        adapterID: "openai.responses.api-key.v1",
        adapterDigest: rawDigest(new TextEncoder().encode("certified OpenAI adapter")),
      },
      origin,
      transportPolicy: "test_only_loopback_http",
      networkPolicy: loopbackNetworkPolicy(origin),
      credential: {
        profile: "openai-api-key",
        handle: credentialBinding().handle,
        accountFingerprint: credentialBinding().accountFingerprint,
        headerName: "authorization",
      },
      wireRequest: {
        method: "POST",
        path: "/v1/chat/completions",
        headerNames: ["authorization", "content-type"],
        timeoutMilliseconds: limits.timeoutMilliseconds ?? 1_000,
        maximumResponseBytes: limits.maximumResponseBytes ?? 1_024,
      },
      logicalPayload: {
        digest: rawDigest(body),
        bytes: body.byteLength,
        historyDigest: rawDigest(new TextEncoder().encode("provider conversation history")),
      },
      executionBoundary: "network_egress_host_no_sandbox",
      createdAt: new Date(base).toISOString(),
    },
    report,
    policyAskedAt: new Date(base + 100).toISOString(),
    recordingStartedAt: new Date(base + 200).toISOString(),
  } satisfies ExecuteProviderTurnInput
}

function wireValues(body: Uint8Array) {
  return {
    body,
    credential: { ...credentialBinding(), value: "Bearer fixture-secret" },
    headers: [["content-type", "application/json"]] as const,
  }
}

function credentialBinding() {
  return {
    handle: "auth:openai:primary",
    accountFingerprint: digest("provider-account:fixture@example.test"),
  }
}

function loopbackNetworkPolicy(origin: string) {
  const url = new URL(origin)
  return {
    mode: "test_literal_loopback" as const,
    hostname: url.hostname,
    port: Number(url.port || 80),
    dnsPolicyDigest: providerTurnLoopbackPolicyDigest,
    resolverImplementationDigest: providerTurnResolverImplementationDigest,
    transportImplementationDigest: providerTurnTransportImplementationDigest,
  }
}

function httpsNetworkPolicy(origin: string): ProviderTurnNetworkPolicy {
  const url = new URL(origin)
  return {
    mode: "https_public_pinned",
    hostname: url.hostname,
    port: Number(url.port || 443),
    dnsPolicyDigest: providerTurnPublicDnsPolicyDigest,
    resolverImplementationDigest: providerTurnResolverImplementationDigest,
    transportImplementationDigest: providerTurnTransportImplementationDigest,
  }
}

function withHttpsOrigin(input: ExecuteProviderTurnInput, origin: string): ExecuteProviderTurnInput {
  return {
    ...input,
    plan: {
      ...input.plan,
      origin,
      transportPolicy: "https_only",
      networkPolicy: httpsNetworkPolicy(origin),
    },
  }
}

async function durableEvents(input: ExecuteProviderTurnInput) {
  const parsed = parseOperationID(input.plan.operationID)
  if (!parsed.ok) throw new Error("Invalid fixture Operation ID")
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.readEvents(parsed.value, { limit: 20 })
    }),
  )
}

async function eventNames(input: ExecuteProviderTurnInput) {
  return (await durableEvents(input)).map((event) => event.name)
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function rawDigest(input: Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
