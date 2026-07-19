import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { parseContentDigest } from "../../astra-domain/src/operation-contract"
import { createParentPrivateMcpRegistry } from "../../astra-runtime/src/extension-inventory-operation"
import { createAstraMcpActivationControl } from "../src/mcp-activation-control"
import { createAstraMcpActivationControlHandler } from "../src/mcp-activation-control-handler"
import type { AstraWorkspaceSessionResult } from "../src/workspace-session"

const candidateID = contentDigest("1")
const candidate = Object.freeze({
  candidateID,
  serverName: "fixture",
  sourcePath: ".mcp.json",
  sourceDevice: "1",
  sourceInode: "2",
  sourceDigest: contentDigest("2"),
  configBindingDigest: contentDigest("3"),
  config: { type: "remote" as const, url: "https://example.com/rpc", oauth: false as const },
})

describe("MCP activation CLI control", () => {
  test("is inert in read-only and rejects unknown or stale IDs before proposing", async () => {
    const registry = createParentPrivateMcpRegistry()
    let proposed = 0
    const readOnly = control("read-only", registry, { propose() { proposed++; throw new Error("must not propose") } })
    expect(await readOnly.prepare(randomUUID(), candidateID)).toMatchObject({ status: "blocked", reason: "activate_once_required" })
    const active = control("activate-once", registry, { propose() { proposed++; throw new Error("must not propose") } })
    expect(await active.prepare(randomUUID(), candidateID)).toMatchObject({ status: "blocked", reason: "candidate_unknown" })
    registry.replace({ generationDigest: contentDigest("4"), entries: [candidate] })
    registry.clear()
    expect(await active.prepare(randomUUID(), candidateID)).toMatchObject({ status: "blocked", reason: "candidate_stale" })
    expect(proposed).toBe(0)
  })

  test("rejects without adapter use and consumes the exact proposal", async () => {
    const registry = populatedRegistry()
    let adapterCalls = 0
    const requestID = randomUUID()
    const instance = control("activate-once", registry, {
      async execute(input) {
        expect(input.consent.decision).toBe("rejected")
        return result(input.operationID, "denied_without_effect")
      },
      adapter: { descriptor: "astra-opencode:controlled-remote-mcp:v1", async connect() { adapterCalls++; throw new Error("must not connect") } },
    })
    const prepared = await instance.prepare(requestID, candidateID)
    if (prepared.status !== "awaiting_approval") throw new Error("Missing proposal")
    expect(await instance.decide(requestID, prepared.proposal.operationID, "reject")).toMatchObject({ status: "denied_without_effect" })
    expect(adapterCalls).toBe(0)
    expect(await instance.decide(requestID, prepared.proposal.operationID, "approve")).toMatchObject({ status: "blocked", reason: "proposal_unknown" })
  })

  test("reports active and accepts stop over the concurrent control path", async () => {
    const registry = populatedRegistry()
    const requestID = randomUUID()
    let stopped: string | undefined
    const instance = control("activate-once", registry, {
      async execute(input, dependencies) {
        dependencies.onActive?.({ operationID: input.operationID, catalogCount: 1, leaseExpiresAt: input.proposal.leaseExpiresAt })
        stopped = await dependencies.awaitStop({ operationID: input.operationID, catalogCount: 1, leaseExpiresAt: input.proposal.leaseExpiresAt })
        return result(input.operationID, "completed_observed_not_verified")
      },
    })
    const prepared = await instance.prepare(requestID, candidateID)
    if (prepared.status !== "awaiting_approval") throw new Error("Missing proposal")
    let active = false
    const terminal = instance.decide(requestID, prepared.proposal.operationID, "approve", () => { active = true })
    await Bun.sleep(0)
    expect(active).toBe(true)
    expect(await instance.stop(randomUUID(), prepared.proposal.operationID)).toMatchObject({ status: "stop_requested" })
    expect(await terminal).toMatchObject({ status: "completed_observed_not_verified" })
    expect(stopped).toBe("explicit")
  })

  test("session close stops an active lease and waits for its bounded terminal", async () => {
    const registry = populatedRegistry()
    const requestID = randomUUID()
    let stopped: string | undefined
    const instance = control("activate-once", registry, {
      async execute(input, dependencies) {
        dependencies.onActive?.({ operationID: input.operationID, catalogCount: 0, leaseExpiresAt: input.proposal.leaseExpiresAt })
        stopped = await dependencies.awaitStop({ operationID: input.operationID, catalogCount: 0, leaseExpiresAt: input.proposal.leaseExpiresAt })
        return result(input.operationID, "completed_observed_not_verified")
      },
    })
    const prepared = await instance.prepare(requestID, candidateID)
    if (prepared.status !== "awaiting_approval") throw new Error("Missing proposal")
    const terminal = instance.decide(requestID, prepared.proposal.operationID, "approve")
    await Bun.sleep(0)
    await instance.close()
    expect(await terminal).toMatchObject({ status: "completed_observed_not_verified" })
    expect(stopped).toBe("session_close")
  })

  test("session close aborts a connection before it becomes active", async () => {
    const registry = populatedRegistry()
    const requestID = randomUUID()
    let notifyConnecting: (() => void) | undefined
    const connecting = new Promise<void>((complete) => { notifyConnecting = complete })
    let aborted = false
    const instance = control("activate-once", registry, {
      async execute(input, dependencies) {
        notifyConnecting?.()
        await new Promise<void>((complete) => {
          dependencies.abortSignal?.addEventListener("abort", () => {
            aborted = true
            complete()
          }, { once: true })
        })
        return {
          operationID: input.operationID,
          state: "reconciliation_required",
          status: "effect_unknown",
          sequence: 1,
          lastCursor: 1,
          receiptID: randomUUID(),
          catalogCount: null,
          boundaryLabel: "HOST EXECUTION — NO SANDBOX",
          networkLabel: "NETWORK EGRESS — EXACT DESTINATION",
        } as const
      },
    })
    const prepared = await instance.prepare(requestID, candidateID)
    if (prepared.status !== "awaiting_approval") throw new Error("Missing proposal")
    const terminal = instance.decide(requestID, prepared.proposal.operationID, "approve")
    await connecting
    await instance.close()
    expect(await terminal).toMatchObject({ status: "effect_unknown", state: "reconciliation_required" })
    expect(aborted).toBe(true)
  })

  test("a stop that wins the socket race consumes the prepared proposal before decide", async () => {
    const registry = populatedRegistry()
    let executions = 0
    const sessionID = randomUUID()
    const token = "A".repeat(43)
    const handler = createAstraMcpActivationControlHandler({
      sessionID,
      token,
      control: control("activate-once", registry, {
        async execute() {
          executions++
          throw new Error("cancelled proposal must not execute")
        },
      }),
    })
    const preparedDispatch = handler.dispatch({ schemaVersion: 1, method: "mcp-activation.prepare", requestId: randomUUID(), sessionID, token, candidateID })
    if (preparedDispatch.status !== "accepted") throw new Error("prepare rejected")
    const prepared = await preparedDispatch.terminal
    if (!("status" in prepared) || prepared.status !== "prepared") throw new Error("Missing prepared proposal")
    const proposalID = prepared.preview.proposalID
    const stopped = handler.dispatch({ schemaVersion: 1, method: "mcp-activation.stop", requestId: randomUUID(), sessionID, token, proposalID })
    if (stopped.status !== "accepted") throw new Error("stop rejected")
    expect(await stopped.terminal).toMatchObject({ status: "stop_requested" })
    const decided = handler.dispatch({ schemaVersion: 1, method: "mcp-activation.decide", requestId: randomUUID(), sessionID, token, proposalID, decision: "approve" })
    if (decided.status !== "accepted") throw new Error("decide rejected")
    expect(await decided.terminal).toMatchObject({ status: "blocked", reason: "proposal_consumed" })
    expect(executions).toBe(0)
    await handler.close()
  })
})

function control(
  mode: "read-only" | "activate-once",
  registry: ReturnType<typeof createParentPrivateMcpRegistry>,
  overrides: Partial<Parameters<typeof createAstraMcpActivationControl>[1]> = {},
) {
  const session: Extract<AstraWorkspaceSessionResult, { status: "opened" }> = { status: "opened", mode, report }
  return createAstraMcpActivationControl(session, {
    registry,
    adapter: { descriptor: "astra-opencode:controlled-remote-mcp:v1", async connect() { throw new Error("unused") } },
    ledgerFilename: "/tmp/unused-ledger.sqlite",
    spoolFilename: "/tmp/unused-spool.sqlite",
    ...overrides,
  })
}

function populatedRegistry() {
  const registry = createParentPrivateMcpRegistry()
  registry.replace({ generationDigest: contentDigest("4"), entries: [candidate] })
  return registry
}

function result(operationID: string, status: "denied_without_effect" | "completed_observed_not_verified") {
  return {
    operationID,
    state: status === "denied_without_effect" ? "denied" as const : "completed" as const,
    status,
    sequence: 1,
    lastCursor: 1,
    receiptID: status === "denied_without_effect" ? null : randomUUID(),
    catalogCount: status === "denied_without_effect" ? null : 1,
    boundaryLabel: "HOST EXECUTION — NO SANDBOX" as const,
    networkLabel: "NETWORK EGRESS — EXACT DESTINATION" as const,
  }
}

function contentDigest(seed: string) {
  const parsed = parseContentDigest(`sha256:${seed.repeat(64)}`)
  if (!parsed.ok) throw new Error("invalid digest")
  return parsed.value
}

const report = Object.freeze({
  root: "/tmp/workspace",
  identity: { device: "3", inode: "4" },
  securityDigest: contentDigest("5"),
  completeness: "complete",
  state: "awaiting_decision",
  surfaces: [],
  blockers: [],
  scannedEntries: 0,
  scannedBytes: 0,
  limits: { maxEntries: 128, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxDurationMs: 1_000 },
})
