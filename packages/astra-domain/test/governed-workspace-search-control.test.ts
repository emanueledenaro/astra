import { describe, expect, test } from "bun:test"
import {
  parseWorkspaceSearchControlPreview,
  parseWorkspaceSearchControlRequest,
  parseWorkspaceSearchDecisionResult,
  parseWorkspaceSearchOutputSummary,
  workspaceSearchBoundaryLabel,
} from "../src/governed-workspace-search-control"

const requestId = "10000000-0000-4000-8000-000000000001"
const sessionID = "10000000-0000-4000-8000-000000000002"
const proposalID = "10000000-0000-4000-8000-000000000003"
const operationID = "10000000-0000-4000-8000-000000000004"
const receiptID = "10000000-0000-4000-8000-000000000005"
const token = "x".repeat(43)
const capabilityDigest = `sha256:${"a".repeat(64)}` as const

describe("governed workspace search control protocol", () => {
  test("accepts only a bounded literal query from the child", () => {
    const request = {
      schemaVersion: 1,
      method: "search.prepare",
      requestId,
      sessionID,
      token,
      query: "$(touch nope); * ? [literal]",
    }
    expect(parseWorkspaceSearchControlRequest(request)).toMatchObject({ ok: true, value: request })
    expect(parseWorkspaceSearchControlRequest({ ...request, workspaceRoot: "/tmp/other" })).toMatchObject({
      ok: false,
    })
    expect(parseWorkspaceSearchControlRequest({ ...request, argv: ["sh", "-c", "touch nope"] })).toMatchObject({
      ok: false,
    })
    expect(parseWorkspaceSearchControlRequest({ ...request, query: "bad\u001b[2J" })).toMatchObject({ ok: false })
    expect(parseWorkspaceSearchControlRequest({ ...request, query: "x".repeat(513) })).toMatchObject({ ok: false })
  })

  test("rejects accessor-backed requests without evaluating them", () => {
    let reads = 0
    const request = {
      schemaVersion: 1,
      method: "search.prepare",
      requestId,
      sessionID,
      token,
      get query() {
        reads++
        return "needle"
      },
    }
    expect(parseWorkspaceSearchControlRequest(request)).toMatchObject({ ok: false })
    expect(reads).toBe(0)
  })

  test("binds the public preview to the parent-owned executable and workspace", () => {
    const preview = {
      schemaVersion: 1,
      proposalID,
      operationID,
      query: "needle",
      queryBytes: 6,
      capabilityDigest,
      expiresAt: "2026-07-17T20:00:00.000Z",
      boundaryLabel: workspaceSearchBoundaryLabel,
      workspaceRoot: "/private/tmp/workspace",
      executable: "/usr/bin/grep",
      mode: "recursive_fixed_string",
      resources: ["process:/usr/bin/grep", "workspace:/private/tmp/workspace"],
      network: "host_unrestricted_not_requested",
      writes: [],
      verification: "not_verified",
    }
    expect(parseWorkspaceSearchControlPreview(preview)).toMatchObject({ ok: true, value: preview })
    expect(parseWorkspaceSearchControlPreview({ ...preview, executable: "/tmp/grep" })).toMatchObject({ ok: false })
    expect(parseWorkspaceSearchControlPreview({ ...preview, writes: ["file.txt"] })).toMatchObject({ ok: false })
  })

  test("allows only printable bounded display lines and observed-not-verified results", () => {
    const output = {
      outputDigest: `sha256:${"b".repeat(64)}`,
      digestScope: "stdout_only",
      outputLineCount: 1,
      outcome: "matches",
      exitCode: 0,
      displayLines: ["./source.txt:1:needle"],
      truncated: false,
    }
    expect(parseWorkspaceSearchOutputSummary(output)).toMatchObject({ ok: true, value: output })
    expect(parseWorkspaceSearchOutputSummary({ ...output, displayLines: ["owned\u001b]2;title\u0007"] })).toMatchObject(
      {
        ok: false,
      },
    )
    expect(
      parseWorkspaceSearchDecisionResult({
        schemaVersion: 1,
        requestId,
        proposalID,
        operationID,
        capabilityDigest,
        verification: "not_verified",
        status: "completed_observed_not_verified",
        receiptID,
        output,
      }),
    ).toMatchObject({ ok: true })
    expect(
      parseWorkspaceSearchDecisionResult({
        schemaVersion: 1,
        requestId,
        proposalID,
        operationID,
        capabilityDigest,
        verification: "verified",
        status: "verified",
      }),
    ).toMatchObject({ ok: false })
  })
})
