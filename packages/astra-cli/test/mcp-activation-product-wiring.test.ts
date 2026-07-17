import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createAstraExtensionInventoryClient } from "../../tui/src/astra/extension-inventory-client"
import { createAstraMcpActivationClient } from "../../tui/src/astra/mcp-activation-client"
import {
  createParentPrivateMcpRegistry,
  inspectTrustedExtensionInventoryHelper,
} from "../../astra-runtime/src/extension-inventory-operation"
import { scanWorkspace } from "../../astra-runtime/src/workspace-preflight"
import { createAstraExtensionInventoryControl } from "../src/extension-inventory-control"
import { createAstraMcpActivationAdapter } from "../src/mcp-activation-adapter"
import { createAstraMcpActivationControl } from "../src/mcp-activation-control"
import { startAstraTuiControlServer } from "../src/tui-control-server"

const helperRoot = resolve(import.meta.dir, "../../../tools/astra-extension-inventory-native")
const helperPath = join(helperRoot, "build", "astra-extension-inventory")
const fixtures: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

beforeAll(() => {
  const build = Bun.spawnSync([join(helperRoot, "build.sh")], { stdout: "pipe", stderr: "pipe" })
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0)
})

afterAll(() => {
  for (const server of servers) void server.stop(true)
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

test("inventory registry activates one real loopback MCP through the redacted private product route", async () => {
  const root = await temp("positive")
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  const seen: string[] = []
  const fixture = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "DELETE") {
        seen.push("DELETE")
        return new Response(null, { status: 204 })
      }
      const body: unknown = await request.json()
      if (!record(body) || typeof body.method !== "string") return new Response(null, { status: 400 })
      seen.push(body.method)
      const headers = { "mcp-session-id": "private-session" }
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "never cross parent boundary" } }, { headers })
      if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers })
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "observed_only", description: "not invocable", inputSchema: { type: "object" } }] } }, { headers })
    },
  })
  servers.push(fixture)
  const secretEndpoint = `http://127.0.0.1:${fixture.port}/private-rpc`
  const configContent = JSON.stringify({ mcp: { first: { type: "remote", url: secretEndpoint, oauth: false }, second: { type: "remote", url: secretEndpoint, oauth: false }, third: { type: "remote", url: secretEndpoint, oauth: false }, fourth: { type: "remote", url: secretEndpoint, oauth: false } } })
  writeFileSync(join(workspace, "opencode.json"), configContent)
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(","))
  const session = { status: "opened", mode: "activate-once", report } as const
  const registry = createParentPrivateMcpRegistry()
  const base = Date.now()
  const activationIDs = [randomUUID(), randomUUID(), randomUUID()]
  const inventory = createAstraExtensionInventoryControl(session, {
    helper: await inspectTrustedExtensionInventoryHelper(helperPath),
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    mcpRegistry: registry,
  })
  const activation = createAstraMcpActivationControl(session, {
    registry,
    adapter: createAstraMcpActivationAdapter(),
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    now: () => base,
    operationID: () => activationIDs.shift() ?? randomUUID(),
  })
  const server = await startAstraTuiControlServer({ directory: state, workspaceRoot: report.root, sessionID: randomUUID(), extensionInventoryControl: inventory, mcpActivationControl: activation })
  const environment = { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token }
  const inventoryClient = createAstraExtensionInventoryClient(environment, server.sessionID, "activate-once")
  const client = createAstraMcpActivationClient(environment, server.sessionID, "activate-once", 5_000)
  const secondClient = createAstraMcpActivationClient(environment, server.sessionID, "activate-once", 5_000)
  try {
    const inventoryPreview = await within(inventoryClient.prepare(), "inventory prepare")
    if (inventoryPreview.status !== "prepared") throw new Error("Missing inventory preview")
    const inventoryResult = await within(inventoryClient.decide(inventoryPreview.preview.proposalID, "approve"), "inventory approve")
    if (inventoryResult.status !== "completed_observed_not_verified") throw new Error("Missing inventory result")
    const candidates = inventoryResult.candidates.filter((candidate) => candidate.kind === "mcp" && candidate.referenceClass === "remote")
    expect(candidates).toHaveLength(4)

    const stalePreview = await within(client.prepare(candidates[0]!.candidateID), "stale prepare")
    if (stalePreview.status !== "prepared") throw new Error("Missing stale preview")
    writeFileSync(join(workspace, "opencode.json"), "{}")
    expect(await within(client.decide(stalePreview.preview.proposalID, "approve"), "stale decision")).toMatchObject({ status: "failed_without_effect", reason: "candidate_stale" })
    expect(seen).toEqual([])
    writeFileSync(join(workspace, "opencode.json"), configContent)

    const deniedPreview = await within(client.prepare(candidates[1]!.candidateID), "denied prepare")
    if (deniedPreview.status !== "prepared") throw new Error("Missing denied preview")
    expect(JSON.stringify(deniedPreview)).not.toContain(secretEndpoint)
    expect(JSON.stringify(deniedPreview)).not.toMatch(/private-rpc|private-session|never cross parent boundary|configBindingDigest|sourceDevice/)
    expect(await within(client.decide(deniedPreview.preview.proposalID, "reject"), "denied decision")).toMatchObject({ status: "denied_without_effect" })
    expect(seen).toEqual([])

    const approvedPreview = await within(client.prepare(candidates[2]!.candidateID), "approved prepare")
    if (approvedPreview.status !== "prepared") throw new Error("Missing approved preview")
    expect(approvedPreview.preview).toMatchObject({ boundaryLabel: "HOST EXECUTION — NO SANDBOX", networkLabel: "NETWORK EGRESS — EXACT DESTINATION", destination: "literal_loopback_http_withheld", toolInvocation: "forbidden", instructions: "withheld" })
    let notifyActive: (() => void) | undefined
    const active = new Promise<void>((resolveActive) => { notifyActive = resolveActive })
    const terminal = client.decide(approvedPreview.preview.proposalID, "approve", (progress) => {
      expect(progress).toMatchObject({ status: "active", catalogCount: 1, verification: "not_verified" })
      notifyActive?.()
    })
    const activationStart = await within(Promise.race([
      active.then(() => ({ status: "active" as const })),
      terminal.then((result) => ({ status: "terminal" as const, result })),
    ]), "active progress")
    if (activationStart.status === "terminal") throw new Error(`Activation ended before active: ${JSON.stringify(activationStart.result)}`)
    expect(seen).toEqual(["initialize", "notifications/initialized", "tools/list"])

    const secondPreview = await within(secondClient.prepare(candidates[3]!.candidateID), "second prepare")
    if (secondPreview.status !== "prepared") throw new Error("Missing second preview")
    expect(await within(secondClient.decide(secondPreview.preview.proposalID, "approve"), "second decision")).toMatchObject({ status: "blocked", reason: "server_limit_reached" })
    expect(seen).toEqual(["initialize", "notifications/initialized", "tools/list"])

    expect(await within(client.stop(approvedPreview.preview.proposalID), "stop request")).toMatchObject({ status: "stop_requested" })
    expect(await within(terminal, "activation terminal")).toMatchObject({ status: "completed_observed_not_verified", catalogCount: 1, verification: "not_verified" })
    expect(seen).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"])
    expect(readFileSync(join(state, "operations.sqlite"))).not.toContain(secretEndpoint)
    expect(new TextDecoder().decode(readFileSync(join(state, "receipts.sqlite")))).not.toMatch(/private-session|never cross parent boundary/)

    let reconnects = 0
    const restarted = createAstraMcpActivationControl(session, {
      registry,
      adapter: {
        descriptor: "astra-opencode:controlled-remote-mcp:v1",
        async connect() {
          reconnects++
          throw new Error("restart must not reconnect")
        },
      },
      ledgerFilename: join(state, "operations.sqlite"),
      spoolFilename: join(state, "receipts.sqlite"),
      now: () => base,
      operationID: () => approvedPreview.preview.proposalID,
    })
    const retryRequestID = randomUUID()
    const retryPreview = await restarted.prepare(retryRequestID, candidates[2]!.candidateID)
    if (retryPreview.status !== "awaiting_approval") throw new Error("Missing restart preview")
    expect(await restarted.decide(retryRequestID, retryPreview.proposal.operationID, "approve")).toMatchObject({ status: "completed_observed_not_verified" })
    expect(reconnects).toBe(0)
    await restarted.close()
  } finally {
    inventoryClient.dispose()
    client.dispose()
    secondClient.dispose()
    await server.close()
    registry.clear()
  }
})

async function temp(name: string) {
  const path = await mkdtemp(join("/tmp", `astra-mcp-product-${name}-`))
  fixtures.push(path)
  chmodSync(path, 0o700)
  return resolve(path)
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function within<Value>(operation: Promise<Value>, label: string) {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3_000)
      timer.unref?.()
    }),
  ])
}
