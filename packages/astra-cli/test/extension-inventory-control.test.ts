import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { parseContentDigest } from "../../astra-domain/src/operation-contract"
import { ExtensionInventoryCoordinationError } from "../../astra-runtime/src/extension-inventory-operation"
import { createAstraExtensionInventoryControl } from "../src/extension-inventory-control"
import type { AstraWorkspaceSessionResult } from "../src/workspace-session"

const helper = Object.freeze({
  canonicalPath: "/tmp/astra-extension-inventory",
  device: "1",
  inode: "2",
  size: 100,
  digest: contentDigest("a"),
})

const report = Object.freeze({
  root: "/tmp/workspace",
  identity: { device: "3", inode: "4" },
  securityDigest: `sha256:${"b".repeat(64)}`,
  completeness: "complete",
  state: "awaiting_decision",
  surfaces: [],
  blockers: [],
  scannedEntries: 0,
  scannedBytes: 0,
  limits: { maxEntries: 128, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxDurationMs: 1_000 },
} as const)

describe("extension inventory CLI control", () => {
  test("is inert on construction and blocks read-only sessions", async () => {
    let proposals = 0
    let executions = 0
    const control = createAstraExtensionInventoryControl(opened("read-only"), {
      helper,
      ledgerFilename: "/tmp/ledger.sqlite",
      spoolFilename: "/tmp/spool.sqlite",
      propose(input) {
        proposals++
        throw new Error(input.operationID)
      },
      async execute() {
        executions++
        throw new Error("must not execute")
      },
    })
    expect(proposals).toBe(0)
    expect(executions).toBe(0)
    expect(await control.prepare(randomUUID())).toMatchObject({ status: "blocked", reason: "activate_once_required" })
    expect(proposals).toBe(0)
    expect(executions).toBe(0)
  })

  test("presents exact authority and dispatches one explicit local decision", async () => {
    const base = Date.parse("2026-07-17T12:00:00.000Z")
    let executions = 0
    const control = createAstraExtensionInventoryControl(opened("activate-once"), {
      helper,
      ledgerFilename: "/tmp/ledger.sqlite",
      spoolFilename: "/tmp/spool.sqlite",
      now: () => base,
      async execute(input) {
        executions++
        expect(input.consent.decision).toBe("rejected")
        expect(input.proposal.workspace.descriptor.childFD).toBe(3)
        return {
          operationID: input.operationID,
          state: "denied",
          status: "denied_without_effect",
          sequence: 3,
          lastCursor: 3,
          receiptID: null,
          boundaryLabel: "HOST EXECUTION — NO SANDBOX",
          inventory: null,
        }
      },
    })
    const requestID = randomUUID()
    const prepared = await control.prepare(requestID)
    expect(prepared.status).toBe("awaiting_approval")
    if (prepared.status !== "awaiting_approval") return
    expect(prepared.proposal).toMatchObject({
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      helper,
      session: { mode: "activate-once", trust: "trusted_once" },
    })
    expect(await control.decide(requestID, prepared.proposal.operationID, "reject")).toMatchObject({
      status: "denied_without_effect",
    })
    expect(executions).toBe(1)
    expect(await control.decide(requestID, prepared.proposal.operationID, "approve")).toMatchObject({
      status: "blocked",
      reason: "proposal_unknown",
    })
    expect(executions).toBe(1)
  })

  test("does not accept a decision bound to another request", async () => {
    let executions = 0
    const control = createAstraExtensionInventoryControl(opened("activate-once"), {
      helper,
      ledgerFilename: "/tmp/ledger.sqlite",
      spoolFilename: "/tmp/spool.sqlite",
      async execute() {
        executions++
        throw new Error("must not execute")
      },
    })
    const prepared = await control.prepare(randomUUID())
    if (prepared.status !== "awaiting_approval") throw new Error("Missing proposal")
    expect(await control.decide(randomUUID(), prepared.proposal.operationID, "approve")).toMatchObject({
      status: "blocked",
      reason: "proposal_unknown",
    })
    expect(executions).toBe(0)
  })

  test("does not hide an uncertain durable execution as an ordinary control error", async () => {
    const control = createAstraExtensionInventoryControl(opened("activate-once"), {
      helper,
      ledgerFilename: "/tmp/ledger.sqlite",
      spoolFilename: "/tmp/spool.sqlite",
      async execute() {
        throw new ExtensionInventoryCoordinationError("state_unavailable", "sanitized failure")
      },
    })
    const requestID = randomUUID()
    const prepared = await control.prepare(requestID)
    if (prepared.status !== "awaiting_approval") throw new Error("Missing proposal")
    expect(await control.decide(requestID, prepared.proposal.operationID, "approve")).toEqual({
      status: "reconciliation_required",
      requestID,
      operationID: prepared.proposal.operationID,
      reason: "durable_state_unavailable",
    })
  })

  test("prunes abandoned proposals after their authorization expires", async () => {
    let current = Date.parse("2026-07-17T12:00:00.000Z")
    const control = createAstraExtensionInventoryControl(opened("activate-once"), {
      helper,
      ledgerFilename: "/tmp/ledger.sqlite",
      spoolFilename: "/tmp/spool.sqlite",
      now: () => current,
    })
    for (let index = 0; index < 8; index++) {
      expect((await control.prepare(randomUUID())).status).toBe("awaiting_approval")
    }
    expect(await control.prepare(randomUUID())).toMatchObject({ status: "blocked", reason: "control_limit_reached" })
    current += 5 * 60_000 + 1
    expect((await control.prepare(randomUUID())).status).toBe("awaiting_approval")
  })
})

function opened(mode: "read-only" | "activate-once") {
  return { status: "opened", mode, report } as Extract<AstraWorkspaceSessionResult, { status: "opened" }>
}

function contentDigest(character: string) {
  const parsed = parseContentDigest(`sha256:${character.repeat(64)}`)
  if (!parsed.ok) throw new Error("Invalid test digest")
  return parsed.value
}
