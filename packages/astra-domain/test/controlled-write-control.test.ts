import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import {
  controlledWriteBoundaryLabel,
  controlledWriteNetworkWarning,
  parseControlledWriteDecisionRequest,
  parseControlledWriteDecisionResult,
  parseControlledWritePrepareRequest,
  parseControlledWritePrepareResult,
  parseControlledWritePreview,
  parseControlledWriteProgress,
  type ControlledWritePreview,
} from "../src/controlled-write-control"

describe("controlled write TUI control contract", () => {
  test("accepts only path-free and content-free authenticated requests", () => {
    const prepare = parseControlledWritePrepareRequest(prepareRequest)
    const decide = parseControlledWriteDecisionRequest(decisionRequest)

    expect(prepare).toEqual({ ok: true, value: prepareRequest })
    expect(decide).toEqual({ ok: true, value: decisionRequest })
    expect(prepare.ok && Object.isFrozen(prepare.value)).toBeTrue()
    expect(decide.ok && Object.isFrozen(decide.value)).toBeTrue()

    for (const forbidden of [
      { path: ".astra-demo-marker" },
      { relativeTarget: ".astra-demo-marker" },
      { workspaceRoot: "/tmp/workspace" },
      { content: "owned by client" },
    ]) {
      expect(parseControlledWritePrepareRequest({ ...prepareRequest, ...forbidden })).toEqual({
        ok: false,
        reason: "invalid_prepare_request_shape",
      })
      expect(parseControlledWriteDecisionRequest({ ...decisionRequest, ...forbidden })).toEqual({
        ok: false,
        reason: "invalid_decision_request_shape",
      })
    }
  })

  test("bounds authentication fields, IDs, and decision vocabulary", () => {
    expect(parseControlledWritePrepareRequest({ ...prepareRequest, token: "a".repeat(42) })).toEqual({
      ok: false,
      reason: "invalid_prepare_request_value",
    })
    expect(parseControlledWritePrepareRequest({ ...prepareRequest, sessionID: "session-1" })).toEqual({
      ok: false,
      reason: "invalid_prepare_request_value",
    })
    expect(parseControlledWriteDecisionRequest({ ...decisionRequest, decision: "deny" })).toEqual({
      ok: false,
      reason: "invalid_decision_request_value",
    })
  })

  test("accepts an exact immutable create-only host preview", () => {
    const result = parseControlledWritePreview(preview)
    expect(result).toEqual({ ok: true, value: preview })
    expect(result.ok && Object.isFrozen(result.value)).toBeTrue()
    expect(result.ok && Object.isFrozen(result.value.boundary)).toBeTrue()
    expect(result.ok && Object.isFrozen(result.value.resource)).toBeTrue()
    expect(result.ok && Object.isFrozen(result.value.network)).toBeTrue()
    expect(result.ok && result.value.boundary.label).toBe("HOST EXECUTION — NO SANDBOX")
    expect(result.ok && result.value.resource.mode).toBe("create_only")
    expect(result.ok && result.value.network.mode).toBe("host_unrestricted")
  })

  test("rejects preview assurance inflation, unsafe targets, malformed bounds, and extra fields", () => {
    expect(parseControlledWritePreview({ ...preview, verification: "verified" })).toEqual({
      ok: false,
      reason: "invalid_preview_value",
    })
    expect(
      parseControlledWritePreview({ ...preview, resource: { ...preview.resource, relativeTarget: "../escape" } }),
    ).toEqual({ ok: false, reason: "invalid_preview_value" })
    expect(
      parseControlledWritePreview({ ...preview, resource: { ...preview.resource, relativeTarget: "safe-other-file" } }),
    ).toEqual({ ok: false, reason: "invalid_preview_value" })
    expect(parseControlledWritePreview({ ...preview, resource: { ...preview.resource, bytes: 0 } })).toEqual({
      ok: false,
      reason: "invalid_preview_value",
    })
    expect(parseControlledWritePreview({ ...preview, expiresAt: "2026-07-17T10:00:00Z" })).toEqual({
      ok: false,
      reason: "invalid_preview_value",
    })
    expect(parseControlledWritePreview({ ...preview, workspaceRoot: "/tmp/workspace" })).toEqual({
      ok: false,
      reason: "invalid_preview_shape",
    })
    expect(parseControlledWritePreview({ ...preview, content: "not part of the preview" })).toEqual({
      ok: false,
      reason: "invalid_preview_shape",
    })
  })

  test("parses prepared and blocked preparation results with exact variants", () => {
    const prepared = parseControlledWritePrepareResult({
      schemaVersion: 1,
      requestId,
      status: "prepared",
      preview,
    })
    const blocked = parseControlledWritePrepareResult({
      schemaVersion: 1,
      requestId,
      status: "blocked",
      reason: "read_only",
    })

    expect(prepared.ok && prepared.value.status).toBe("prepared")
    expect(blocked.ok && blocked.value.status).toBe("blocked")
    expect(prepared.ok && Object.isFrozen(prepared.value)).toBeTrue()
    expect(blocked.ok && Object.isFrozen(blocked.value)).toBeTrue()
    expect(
      parseControlledWritePrepareResult({
        schemaVersion: 1,
        requestId,
        status: "prepared",
        preview,
        reason: "not_allowed_here",
      }),
    ).toEqual({ ok: false, reason: "invalid_prepare_result_shape" })
  })

  test("distinguishes every terminal decision outcome", () => {
    const denied = { ...binding, status: "denied_without_workspace_effect" } as const
    const failed = { ...binding, status: "failed_without_effect", reason: "target_already_exists" } as const
    const verified = {
      ...binding,
      status: "verified",
      verification: "exact_readback",
      receiptID,
      evidenceID,
      readback,
    } as const
    const reconciliation = {
      ...binding,
      status: "reconciliation_required",
      reason: "verification_inconclusive",
    } as const
    const blocked = {
      schemaVersion: 1,
      requestId,
      proposalID,
      status: "blocked",
      reason: "proposal_expired",
    } as const

    for (const value of [denied, failed, verified, reconciliation, blocked]) {
      expect(parseControlledWriteDecisionResult(value)).toEqual({ ok: true, value })
    }
    const parsedVerified = parseControlledWriteDecisionResult(verified)
    expect(parsedVerified.ok && Object.isFrozen(parsedVerified.value)).toBeTrue()
    expect(
      parsedVerified.ok && parsedVerified.value.status === "verified" && Object.isFrozen(parsedVerified.value.readback),
    ).toBeTrue()

    expect(parseControlledWriteDecisionResult({ ...denied, receiptID })).toEqual({
      ok: false,
      reason: "invalid_decision_result_shape",
    })
    expect(parseControlledWriteDecisionResult({ ...verified, verification: "process_exit" })).toEqual({
      ok: false,
      reason: "invalid_decision_result_value",
    })
    expect(
      parseControlledWriteDecisionResult({
        ...verified,
        readback: { ...verified.readback, relativeTarget: "safe-other-file" },
      }),
    ).toEqual({ ok: false, reason: "invalid_decision_result_value" })
    expect(parseControlledWriteDecisionResult({ ...failed, reason: "unsafe reason\n" })).toEqual({
      ok: false,
      reason: "invalid_decision_result_value",
    })
  })

  test("keeps observed effect separate from independently verified success", () => {
    for (const status of ["recording_authority", "host_adapter_validating", "verifying"] as const) {
      const phase = { ...binding, status, verification: "not_verified" } as const
      expect(parseControlledWriteProgress(phase)).toEqual({ ok: true, value: phase })
      expect(parseControlledWriteProgress({ ...phase, receiptID })).toEqual({
        ok: false,
        reason: "invalid_progress_shape",
      })
    }
    const progress = {
      ...binding,
      status: "effect_observed_not_verified",
      verification: "not_verified",
      receiptID,
      observation: readback,
    } as const
    const result = parseControlledWriteProgress(progress)

    expect(result).toEqual({ ok: true, value: progress })
    expect(result.ok && Object.isFrozen(result.value)).toBeTrue()
    expect(
      result.ok && result.value.status === "effect_observed_not_verified" && Object.isFrozen(result.value.observation),
    ).toBeTrue()
    expect(parseControlledWriteProgress({ ...progress, verification: "exact_readback" })).toEqual({
      ok: false,
      reason: "invalid_progress_value",
    })
    expect(parseControlledWriteDecisionResult(progress)).toEqual({
      ok: false,
      reason: "invalid_decision_result_shape",
    })
  })

  test("rejects accessor-backed records without evaluating the accessor", () => {
    let accessed = false
    const input = { ...prepareRequest }
    Object.defineProperty(input, "token", {
      enumerable: true,
      get() {
        accessed = true
        return token
      },
    })

    expect(parseControlledWritePrepareRequest(input)).toEqual({
      ok: false,
      reason: "invalid_prepare_request_shape",
    })
    expect(accessed).toBeFalse()
  })
})

const requestId = "00000000-0000-4000-8000-000000000001"
const sessionID = "00000000-0000-4000-8000-000000000002"
const proposalID = "00000000-0000-4000-8000-000000000003"
const operationID = "00000000-0000-4000-8000-000000000004"
const receiptID = "36eb4a8c-2db5-8b06-a09c-4b85fe5ff4f7"
const evidenceID = "cebf0e2f-a0d3-89e6-bcba-8350a86bf5a5"
const markerContent = `Astra controlled host write\noperation_id=${operationID}\n`
const markerContentDigest = `sha256:${createHash("sha256").update(markerContent).digest("hex")}` as const
const token = "A".repeat(43)

const prepareRequest = {
  schemaVersion: 1,
  method: "controlled-write.prepare",
  requestId,
  sessionID,
  token,
} as const

const decisionRequest = {
  schemaVersion: 1,
  method: "controlled-write.decide",
  requestId,
  sessionID,
  token,
  proposalID,
  decision: "approve",
} as const

const preview = {
  schemaVersion: 1,
  operation: "controlled_write_create_only",
  operationID,
  proposalID,
  expiresAt: "2026-07-17T10:05:00.000Z",
  boundary: { mode: "host_no_sandbox", label: controlledWriteBoundaryLabel },
  resource: {
    kind: "workspace_relative_file",
    mode: "create_only",
    relativeTarget: ".astra-demo-marker",
    bytes: Buffer.byteLength(markerContent),
    contentDigest: markerContentDigest,
  },
  capabilityDigest: digest("b"),
  network: { mode: "host_unrestricted", warning: controlledWriteNetworkWarning },
  verification: "not_verified",
} as const satisfies ControlledWritePreview

const binding = { schemaVersion: 1, requestId, proposalID, operationID } as const
const readback = {
  relativeTarget: preview.resource.relativeTarget,
  bytes: preview.resource.bytes,
  contentDigest: preview.resource.contentDigest,
} as const

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}
