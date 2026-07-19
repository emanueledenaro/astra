import { describe, expect, test } from "bun:test"
import {
  parseGitStageControlInventory,
  parseGitStageControlRequest,
  parseGitStageDecisionResult,
  parseGitStageInventoryResult,
  parseGitStagePrepareRequest,
  parseGitStageProgress,
} from "../src/git-stage-control"
import { gitStageBoundaryLabel, gitStageLimitations } from "../src/git-stage-mutation"

const requestId = "11111111-1111-4111-8111-111111111111"
const sessionID = "22222222-2222-4222-8222-222222222222"
const inventoryID = "33333333-3333-4333-8333-333333333333"
const candidateID = "44444444-4444-4444-8444-444444444444"
const proposalID = "55555555-5555-4555-8555-555555555555"
const operationID = "66666666-6666-4666-8666-666666666666"
const receiptID = "77777777-7777-4777-8777-777777777777"
const token = "x".repeat(43)
const digest = `sha256:${"a".repeat(64)}` as const

function inventory() {
  return {
    schemaVersion: 1,
    action: "Stage selected",
    inventoryID,
    inventoryDigest: digest,
    baselineSnapshotDigest: digest,
    expiresAt: "2026-07-18T10:05:00.000Z",
    boundaryLabel: gitStageBoundaryLabel,
    verification: "not_verified",
    candidates: [{ candidateID, path: "src/app.ts", change: "modify" }],
    limitations: gitStageLimitations,
  } as const
}

describe("Git Stage selected control protocol", () => {
  test("accepts only opaque candidate IDs and never a child path", () => {
    const request = {
      schemaVersion: 1,
      method: "git-stage.prepare",
      requestId,
      sessionID,
      token,
      inventoryID,
      candidateIDs: [candidateID],
    } as const
    expect(parseGitStagePrepareRequest(request)).toMatchObject({ ok: true })
    expect(parseGitStageControlRequest({ ...request, path: "src/attacker.ts" }).ok).toBeFalse()
    expect(parseGitStageControlRequest({ ...request, candidateIDs: [candidateID, candidateID] }).ok).toBeFalse()
    expect(parseGitStageControlRequest({ ...request, candidateIDs: ["not-an-id"] }).ok).toBeFalse()
    let getterCalls = 0
    const accessor = Object.defineProperty({}, "method", {
      enumerable: true,
      get() {
        getterCalls++
        return "git-stage.inventory"
      },
    })
    expect(parseGitStageControlRequest(accessor).ok).toBeFalse()
    expect(getterCalls).toBe(0)
  })

  test("binds the parent inventory, HOST label, expiry, and candidate display", () => {
    expect(parseGitStageControlInventory(inventory())).toMatchObject({
      ok: true,
      value: {
        inventoryID,
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
        verification: "not_verified",
        candidates: [{ candidateID, path: "src/app.ts", change: "modify" }],
      },
    })
    expect(
      parseGitStageInventoryResult({ schemaVersion: 1, requestId, status: "inventory", inventory: inventory() }),
    ).toMatchObject({ ok: true })
    expect(parseGitStageControlInventory({ ...inventory(), boundaryLabel: "SANDBOXED" }).ok).toBeFalse()
    expect(parseGitStageControlInventory({ ...inventory(), expiresAt: "not-a-time" }).ok).toBeFalse()
    expect(
      parseGitStageControlInventory({ ...inventory(), candidates: [{ ...inventory().candidates[0], path: "../x" }] })
        .ok,
    ).toBeFalse()
    expect(
      parseGitStageControlInventory({
        ...inventory(),
        candidates: [{ ...inventory().candidates[0], path: "src/\u001b[31m.ts" }],
      }).ok,
    ).toBeFalse()
  })

  test("requires exact proposal, receipt, snapshot, and terminal verification binding", () => {
    const binding = {
      schemaVersion: 1,
      requestId,
      proposalID,
      proposalDigest: digest,
    } as const
    const progress = {
      ...binding,
      status: "effect_observed_not_verified",
      verification: "not_verified",
      operationID,
      receiptID,
      snapshotDigest: digest,
    } as const
    expect(parseGitStageProgress(progress)).toMatchObject({ ok: true })
    expect(parseGitStageProgress({ ...progress, verification: "verified" }).ok).toBeFalse()

    const terminal = {
      ...binding,
      status: "verified",
      verification: "independent_selected_index_and_preservation",
      operationID,
      receiptID,
      snapshotDigest: digest,
    } as const
    expect(parseGitStageDecisionResult(terminal)).toMatchObject({ ok: true })
    expect(parseGitStageDecisionResult({ ...terminal, receiptID: "wrong" }).ok).toBeFalse()
    expect(parseGitStageDecisionResult({ ...terminal, success: true }).ok).toBeFalse()
  })
})
