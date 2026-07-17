import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  parseMcpActivationControlPrepareResult,
  parseMcpActivationControlRequest,
} from "../src/mcp-activation-control"

const token = "A".repeat(43)
const digest = `sha256:${"1".repeat(64)}`

describe("MCP activation private control protocol", () => {
  test("accepts exact candidate intent without URL or config", () => {
    const value = { schemaVersion: 1, method: "mcp-activation.prepare", requestId: randomUUID(), sessionID: randomUUID(), token, candidateID: digest }
    expect(parseMcpActivationControlRequest(value).ok).toBe(true)
    expect(parseMcpActivationControlRequest({ ...value, url: "https://secret.example/rpc" }).ok).toBe(false)
    expect(parseMcpActivationControlRequest({ ...value, config: {} }).ok).toBe(false)
  })

  test("accepts only a redacted complete preview", () => {
    const value = {
      schemaVersion: 1,
      requestId: randomUUID(),
      status: "prepared",
      preview: {
        schemaVersion: 1,
        proposalID: randomUUID(),
        candidateID: digest,
        displayName: "MCP candidate 11111111",
        sourcePath: "opencode.json",
        transport: "streamable_http",
        destination: "public_https_withheld",
        leaseExpiresAt: "2026-07-18T12:15:00.000Z",
        capabilityDigest: digest,
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
        networkLabel: "NETWORK EGRESS — EXACT DESTINATION",
        requestBudget: ["initialize", "notifications/initialized", "tools/list"],
        credentials: "none",
        workspaceRootShared: "none",
        redirects: "forbidden",
        retries: "none",
        reconnect: "none",
        instructions: "withheld",
        toolInvocation: "forbidden",
        verification: "not_verified",
      },
    }
    expect(parseMcpActivationControlPrepareResult(value).ok).toBe(true)
    expect(parseMcpActivationControlPrepareResult({ ...value, preview: { ...value.preview, endpoint: "https://secret.example" } }).ok).toBe(false)
  })
})
