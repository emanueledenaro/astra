import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import { digest } from "../src/controlled-write-authority"
import type { ExecuteProviderTurnInput } from "../src/provider-turn-coordinator"
import { makeProviderTurnOperationFacts } from "../src/provider-turn-operation-facts"
import { runWithLedger } from "../src/operation-storage"
import {
  executeProviderTurnWithTrustedTransport,
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
  test("sends exact bytes once and only after durable consent and claim", async () => {
    const secret = "Bearer provider-secret-that-must-not-be-persisted"
    const prompt = "private prompt that must remain outside durable facts"
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-5", input: prompt }))
    let calls = 0
    let requestBody = new Uint8Array()
    let authorization = ""
    let claimObserved = false
    let input: ExecuteProviderTurnInput | undefined
    const server = startServer(async (request) => {
      calls += 1
      requestBody = new Uint8Array(await request.arrayBuffer())
      authorization = request.headers.get("authorization") ?? ""
      if (!input) throw new Error("Provider fixture input was not prepared")
      claimObserved = await hasDurableClaim(input)
      return Response.json({ output: [{ type: "message", content: "hello" }] })
    })
    input = await operationInput(server.url.origin, body)

    const result = await executeProviderTurnWithTrustedTransport(
      input,
      {
        body,
        credential: { ...credentialBinding(), value: secret },
        headers: [["content-type", "application/json"]],
      },
      {
        mode: "dormant_test_only",
        now: () => Date.parse(input!.policyAskedAt) + 100,
        async requestApproval(preview) {
          expect(preview.credential).toEqual({ ...credentialBinding(), headerName: "authorization" })
          expect(preview.wireRequest).toEqual({
            method: "POST",
            path: "/v1/chat/completions",
            headerNames: ["authorization", "content-type"],
            timeoutMilliseconds: 1_000,
            maximumResponseBytes: 1_024,
          })
          expect(await eventNames(input!)).toEqual(["operation.admitted", "policy.ask"])
          return "approve"
        },
      },
    )

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(result.boundaryLabel).toBe("NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX")
    expect(calls).toBe(1)
    expect(requestBody).toEqual(body)
    expect(authorization).toBe(secret)
    expect(claimObserved).toBeTrue()
    const durable = JSON.stringify(await durableEvents(input))
    expect(durable).not.toContain(secret)
    expect(durable).not.toContain(prompt)
    expect(durable).not.toContain("VERIFIED")
    expect(durable).not.toContain("succeeded")
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
      mode: "dormant_test_only",
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
        mode: "dormant_test_only",
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
            mode: "dormant_test_only",
            async requestApproval() {
              throw new Error("Consent must not be reached for mismatched credentials")
            },
          },
        ),
      ).toThrow("does not match the admitted credential binding")
    }
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
      mode: "dormant_test_only",
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
        mode: "dormant_test_only",
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
        mode: "dormant_test_only",
        now: () => Date.parse(timed.policyAskedAt) + 100,
        async requestApproval() {
          return "approve"
        },
      }),
    ).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(timeoutCalls).toBe(1)
  })

  test("rejects production enablement until connected-peer enforcement exists", async () => {
    expect(trustedProviderTurnTransportDescriptor).toMatchObject({
      productionCapable: false,
      peerEnforcement: "not_implemented",
      terminalState: "effect_unknown_only",
    })
    let calls = 0
    const server = startServer(() => {
      calls += 1
      return new Response("unexpected")
    })
    const body = new TextEncoder().encode('{"input":"production blocked"}')
    const input = await operationInput(server.url.origin, body)
    const productionInput = {
      ...input,
      plan: {
        ...input.plan,
        origin: "https://api.example.test",
        transportPolicy: "https_only" as const,
      },
    }
    expect(() =>
      executeProviderTurnWithTrustedTransport(productionInput, wireValues(body), {
        mode: "production",
        async requestApproval() {
          throw new Error("Consent must not be reached in unsupported production mode")
        },
      }),
    ).toThrow("requires DNS and connected-peer enforcement")
    expect(() =>
      executeProviderTurnWithTrustedTransport(productionInput, wireValues(body), {
        mode: "dormant_test_only",
        async requestApproval() {
          throw new Error("Consent must not be reached for HTTPS in dormant mode")
        },
      }),
    ).toThrow("limited to literal loopback fixtures")
    expect(calls).toBe(0)
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
      origin,
      transportPolicy: "test_only_loopback_http",
      credential: {
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
      logicalPayload: { digest: rawDigest(body), bytes: body.byteLength },
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

async function hasDurableClaim(input: ExecuteProviderTurnInput) {
  const facts = makeProviderTurnOperationFacts(input)
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return (yield* ledger.getDispatchSnapshot(facts.dispatchRequestID))?.claim !== null
    }),
  )
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
