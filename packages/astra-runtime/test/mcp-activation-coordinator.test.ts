import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseContentDigest, type ContentDigest } from "../../astra-domain/src/operation-contract"
import {
  createMcpActivationSessionGate,
  executeMcpActivation,
  proposeMcpActivation,
  type McpActivationAdapter,
  type ParentPrivateMcpCandidate,
} from "../src/mcp-activation-coordinator"
import { scanWorkspace } from "../src/workspace-preflight"
import { createPinnedMcpWire } from "../src/mcp-pinned-fetch"
import { activateAstraControlledRemote } from "../../opencode/src/mcp/astra-controlled-remote"

const fixtures: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
  for (const server of servers.splice(0)) void server.stop(true)
})

describe("durable MCP activation coordinator", () => {
  test.each([
    ["local process", { type: "local", command: ["bun", "server.ts"] }],
    [
      "configured headers",
      { type: "remote", url: "https://mcp.example.test/rpc", headers: { Authorization: "Bearer secret" } },
    ],
    [
      "OAuth",
      { type: "remote", url: "https://mcp.example.test/rpc", oauth: { clientId: "client" } },
    ],
  ])("refuses ineligible %s candidates before any Operation or network authority", async (_label, config) => {
    const fixture = await makeFixture("approved")
    expect(() =>
      proposeMcpActivation({
        operationID: fixture.input.operationID,
        policyAskedAt: fixture.input.policyAskedAt,
        session: fixture.input.session,
        candidate: { ...fixture.input.candidate, config } as ParentPrivateMcpCandidate,
      }),
    ).toThrow("credential-free")
  })

  test("rejects without source read, DNS, or adapter execution", async () => {
    const fixture = await makeFixture("rejected")
    renameSource(fixture.workspace)
    let adapterCalls = 0
    const result = await executeMcpActivation(fixture.input, {
      sessionGate: createMcpActivationSessionGate(),
      adapter: adapter(() => adapterCalls++),
      awaitStop: async () => "explicit",
      now: fixture.now,
    })
    expect(result).toMatchObject({ state: "denied", status: "denied_without_effect" })
    expect(adapterCalls).toBe(0)
  })

  test("persists the claim before source validation and network activation", async () => {
    const fixture = await makeFixture("approved")
    let claimed = false
    let active = false
    const result = await executeMcpActivation(fixture.input, {
      sessionGate: createMcpActivationSessionGate(),
      onClaimPersisted: () => (claimed = true),
      onSourceRevalidated: () => expect(claimed).toBeTrue(),
      adapter: adapter(() => {
        expect(claimed).toBeTrue()
        active = true
      }),
      awaitStop: async () => "explicit",
      now: fixture.now,
    })
    expect(active).toBeTrue()
    expect(result).toMatchObject({ state: "completed", status: "completed_observed_not_verified", catalogCount: 1 })
  })

  test("detects config drift after claim with zero network", async () => {
    const fixture = await makeFixture("approved")
    writeFileSync(join(fixture.workspace, ".mcp.json"), '{"server":{"type":"remote","url":"https://changed.example/rpc"}}')
    let adapterCalls = 0
    const result = await executeMcpActivation(fixture.input, {
      sessionGate: createMcpActivationSessionGate(),
      adapter: adapter(() => adapterCalls++),
      awaitStop: async () => "explicit",
      now: fixture.now,
    })
    expect(result).toMatchObject({ state: "failed", status: "candidate_stale" })
    expect(adapterCalls).toBe(0)
  })

  test("allows only one active MCP per session", async () => {
    const first = await makeFixture("approved")
    const second = await makeFixture("approved")
    const gate = createMcpActivationSessionGate()
    let release!: () => void
    const stop = new Promise<void>((resolve) => (release = resolve))
    let active!: () => void
    const started = new Promise<void>((resolve) => (active = resolve))
    const running = executeMcpActivation(first.input, {
      sessionGate: gate,
      adapter: adapter(active),
      awaitStop: async () => {
        await stop
        return "explicit"
      },
      now: first.now,
    })
    await started
    let secondCalls = 0
    await expect(
      executeMcpActivation(second.input, {
        sessionGate: gate,
        adapter: adapter(() => secondCalls++),
        awaitStop: async () => "explicit",
        now: second.now,
      }),
    ).rejects.toMatchObject({ code: "server_limit_reached" })
    expect(secondCalls).toBe(0)
    release()
    await running
  })

  test("a post-claim failure reconciles and exact restart never reconnects", async () => {
    const fixture = await makeFixture("approved")
    let adapterCalls = 0
    const dependencies = {
      sessionGate: createMcpActivationSessionGate(),
      adapter: {
        descriptor: "astra-opencode:controlled-remote-mcp:v1" as const,
        async connect() {
          adapterCalls++
          throw new Error("fixture crash")
        },
      },
      awaitStop: async () => "explicit" as const,
      now: fixture.now,
    }
    const first = await executeMcpActivation(fixture.input, dependencies)
    const restarted = await executeMcpActivation(fixture.input, {
      ...dependencies,
      sessionGate: createMcpActivationSessionGate(),
    })
    expect(first).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(restarted).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(adapterCalls).toBe(1)
  })

  test("closes the active session when awaitStop throws synchronously", async () => {
    const fixture = await makeFixture("approved")
    let closes = 0
    const activeAdapter = adapter(() => undefined)
    const result = await executeMcpActivation(fixture.input, {
      sessionGate: createMcpActivationSessionGate(),
      adapter: {
        ...activeAdapter,
        async connect(input) {
          const active = await activeAdapter.connect(input)
          return { ...active, close: async () => void closes++ }
        },
      },
      awaitStop: () => {
        throw new Error("fixture stop watcher failed")
      },
      now: fixture.now,
    })
    expect(closes).toBe(1)
    expect(result).toMatchObject({ state: "completed", status: "completed_observed_not_verified" })
  })

  test("rejects a miswired adapter descriptor before the durable claim or effect", async () => {
    const fixture = await makeFixture("approved")
    let calls = 0
    const miswired = {
      ...adapter(() => calls++),
      descriptor: "different-adapter",
    } as unknown as McpActivationAdapter
    await expect(
      executeMcpActivation(fixture.input, {
        sessionGate: createMcpActivationSessionGate(),
        adapter: miswired,
        awaitStop: async () => "explicit",
        now: fixture.now,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(calls).toBe(0)
  })

  test("real loopback observes the durable claim before the exact bounded MCP exchange", async () => {
    let claimed = false
    const seen: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(claimed).toBeTrue()
        if (request.method === "DELETE") {
          seen.push("DELETE")
          return new Response(null, { status: 204 })
        }
        const body = await request.json()
        if (!body || typeof body !== "object" || !("method" in body) || typeof body.method !== "string") {
          return new Response(null, { status: 400 })
        }
        seen.push(body.method)
        if (body.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: "id" in body ? body.id : null,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
                instructions: "withheld fixture instruction",
              },
            },
            { headers: { "mcp-session-id": "durable-fixture" } },
          )
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202, headers: { "mcp-session-id": "durable-fixture" } })
        }
        return Response.json(
          {
            jsonrpc: "2.0",
            id: "id" in body ? body.id : null,
            result: { tools: [{ name: "observed_only", inputSchema: { type: "object" } }] },
          },
          { headers: { "mcp-session-id": "durable-fixture" } },
        )
      },
    })
    servers.push(server)
    const endpoint = `http://127.0.0.1:${server.port}/rpc`
    const fixture = await makeFixture("approved", endpoint)
    const result = await executeMcpActivation(fixture.input, {
      sessionGate: createMcpActivationSessionGate(),
      onClaimPersisted: () => (claimed = true),
      adapter: {
        descriptor: "astra-opencode:controlled-remote-mcp:v1",
        async connect(input) {
          const active = await activateAstraControlledRemote(createPinnedMcpWire(input.endpoint, { mode: "test_loopback" }), {
            signal: input.signal,
          })
          return {
            protocolVersion: active.protocolVersion,
            server: active.server,
            catalog: active.catalog.map((entry) => {
              const inputSchemaDigest = parseContentDigest(entry.inputSchemaDigest)
              if (!inputSchemaDigest.ok) throw new Error("invalid adapter catalog digest")
              return { ...entry, inputSchemaDigest: inputSchemaDigest.value }
            }),
            instructionsWithheld: active.instructionsWithheld,
            close: active.stop,
          }
        },
      },
      awaitStop: async () => "explicit",
      now: fixture.now,
    })
    expect(result).toMatchObject({ state: "completed", status: "completed_observed_not_verified", catalogCount: 1 })
    expect(seen).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"])
  })
})

function adapter(onConnect: () => void): McpActivationAdapter {
  return {
    descriptor: "astra-opencode:controlled-remote-mcp:v1",
    async connect() {
      onConnect()
      return {
        catalog: [{ name: "fixture", description: null, inputSchemaDigest: digest("schema") }],
        protocolVersion: "2025-03-26",
        server: { name: "fixture", version: "1" },
        instructionsWithheld: true,
        async close() {},
      }
    },
  }
}

async function makeFixture(decision: "approved" | "rejected", endpoint = "https://mcp.example.test/rpc") {
  const workspace = await temp("workspace")
  const state = await temp("state")
  const sourcePath = join(workspace, ".mcp.json")
  const content = Buffer.from(JSON.stringify({ server: { type: "remote", url: endpoint, oauth: false } }))
  writeFileSync(sourcePath, content)
  const facts = statSync(sourcePath)
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete" || !report.identity || !report.securityDigest) throw new Error("fixture preflight")
  const operationID = randomUUID()
  const askedAt = "2026-07-17T22:00:00.000Z"
  const candidate: ParentPrivateMcpCandidate = {
    candidateID: digest("candidate"),
    serverName: "server",
    sourcePath: ".mcp.json",
    sourceDevice: String(facts.dev),
    sourceInode: String(facts.ino),
    sourceDigest: digestBytes(content),
    configBindingDigest: digest("binding"),
    config: { type: "remote", url: endpoint, oauth: false },
  }
  const proposal = proposeMcpActivation({
    operationID,
    policyAskedAt: askedAt,
    session: { mode: "activate-once", report },
    candidate,
  })
  let tick = Date.parse(askedAt) + 3_000
  return {
    workspace,
    input: {
      operationID,
      policyAskedAt: askedAt,
      session: { mode: "activate-once" as const, report },
      candidate,
      proposal,
      consent:
        decision === "approved"
          ? ({ decision, decidedAt: "2026-07-17T22:00:01.000Z" } as const)
          : ({ decision, decidedAt: "2026-07-17T22:00:01.000Z", reason: "user_rejected" } as const),
      recordingStartedAt: "2026-07-17T22:00:02.000Z",
      ledgerFilename: join(state, "operations.sqlite"),
      spoolFilename: join(state, "receipts.sqlite"),
    },
    now: () => tick++,
  }
}

function renameSource(workspace: string) {
  rmSync(join(workspace, ".mcp.json"))
}

async function temp(name: string) {
  const root = await mkdtemp(join(tmpdir(), `astra-mcp-${name}-`))
  mkdirSync(root, { recursive: true })
  fixtures.push(root)
  return root
}

function digest(input: string): ContentDigest {
  return `sha256:${createHash("sha256").update(input).digest("hex")}` as ContentDigest
}

function digestBytes(input: Uint8Array): ContentDigest {
  return `sha256:${createHash("sha256").update(input).digest("hex")}` as ContentDigest
}
