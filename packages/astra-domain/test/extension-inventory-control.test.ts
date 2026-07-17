import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  parseExtensionInventoryControlDecisionResult,
  parseExtensionInventoryControlPrepareResult,
  parseExtensionInventoryControlRequest,
} from "../src/extension-inventory-control"

test("request protocol cannot carry workspace paths, helpers, argv, or activation input", () => {
  const base = {
    schemaVersion: 1,
    method: "extension-inventory.prepare",
    requestId: randomUUID(),
    sessionID: randomUUID(),
    token: "a".repeat(43),
  } as const
  expect(parseExtensionInventoryControlRequest(base).ok).toBe(true)
  for (const extra of [
    { workspacePath: "/private/workspace" },
    { helperPath: "/private/helper" },
    { argv: ["sh", "-c", "unsafe"] },
    { activate: true },
  ]) {
    expect(parseExtensionInventoryControlRequest({ ...base, ...extra }).ok).toBe(false)
  }
})

test("public results expose authority before approval and inactive candidates only after completion", () => {
  const requestId = randomUUID()
  const proposalID = randomUUID()
  expect(
    parseExtensionInventoryControlPrepareResult({
      schemaVersion: 1,
      requestId,
      status: "prepared",
      preview: {
        schemaVersion: 1,
        proposalID,
        expiresAt: "2026-07-18T12:05:00.000Z",
        capabilityDigest: `sha256:${"a".repeat(64)}`,
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
        helper: { kind: "astra_native_static_inventory", execution: "private_verified_snapshot_after_claim" },
        resourceClasses: ["workspace_extension_config_read"],
        allowlist: ["opencode.json"],
        verification: "not_verified",
      },
    }).ok,
  ).toBe(true)
  const completed = parseExtensionInventoryControlDecisionResult({
    schemaVersion: 1,
    requestId,
    proposalID,
    status: "completed_observed_not_verified",
    receiptID: randomUUID(),
    candidates: [
      {
        candidateID: `sha256:${"b".repeat(64)}`,
        kind: "plugin",
        displayName: "Plugin candidate bbbbbbbb",
        source: "config",
        sourcePath: "opencode.json",
        referenceClass: "package",
        referenceDigest: `sha256:${"c".repeat(64)}`,
        state: "inactive",
        verification: "not_verified",
      },
    ],
    verification: "not_verified",
  })
  expect(completed).toMatchObject({ ok: true, value: { status: "completed_observed_not_verified" } })
  expect(
    parseExtensionInventoryControlDecisionResult({
      schemaVersion: 1,
      requestId,
      proposalID,
      status: "denied_without_effect",
      candidates: [],
    }).ok,
  ).toBe(false)
})
