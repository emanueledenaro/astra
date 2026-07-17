import { describe, expect, test } from "bun:test"
import {
  computeMcpActivationCapabilityDigest,
  parseMcpActivationProposal,
  type McpActivationProposal,
} from "../src/mcp-activation"
import type { ContentDigest } from "../src/operation-contract"

const base = {
  schemaVersion: 1,
  operationID: "00000000-0000-4000-8000-000000000111",
  policyAskedAt: "2026-07-18T10:00:00.000Z",
  authorizationExpiresAt: "2026-07-18T10:15:00.000Z",
  leaseExpiresAt: "2026-07-18T10:15:00.000Z",
  session: { mode: "activate-once", trust: "trusted_once" },
  candidate: {
    candidateID: `sha256:${"1".repeat(64)}` as ContentDigest,
    displayName: "MCP candidate 11111111",
    sourcePath: ".mcp.json",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/rpc",
  },
  boundary: "host_no_sandbox",
  boundaryLabel: "HOST EXECUTION — NO SANDBOX",
  networkLabel: "NETWORK EGRESS — EXACT DESTINATION",
  requestBudget: ["initialize", "notifications/initialized", "tools/list"],
  guarantees: {
    credentials: "none",
    workspaceRootShared: "none",
    redirects: "forbidden",
    retries: "none",
    reconnect: "none",
    proxyEnvironment: "ignored",
    instructions: "untrusted_withheld",
    prompts: "not_loaded",
    resources: "not_loaded",
    toolInvocation: "forbidden",
    catalog: "bounded_observed_not_verified",
    sourceRevalidation: "device_inode_digest_after_claim",
    stop: "explicit_or_lease_or_session_close",
  },
} as const

function proposal(): McpActivationProposal {
  return {
    ...base,
    capabilityDigest: computeMcpActivationCapabilityDigest(base),
  }
}

describe("MCP activation authority", () => {
  test("accepts the exact immutable preview contract", () => {
    expect(parseMcpActivationProposal(proposal())).toEqual({ ok: true, value: proposal() })
  })

  test.each([
    ["userinfo", "https://user:secret@mcp.example.test/rpc"],
    ["query", "https://mcp.example.test/rpc?token=secret"],
    ["fragment", "https://mcp.example.test/rpc#fragment"],
    ["non-loopback HTTP", "http://example.test/rpc"],
    ["localhost alias", "http://localhost:3000/rpc"],
  ])("rejects %s endpoints", (_label, endpoint) => {
    const candidate = { ...proposal(), candidate: { ...proposal().candidate, endpoint } }
    expect(parseMcpActivationProposal(candidate)).toEqual({ ok: false, reason: "invalid_proposal" })
  })

  test.each(["http://127.0.0.1:3000/rpc", "http://[::1]:3000/rpc"])(
    "accepts literal loopback fixture endpoint %s",
    (endpoint) => {
      const withoutDigest = { ...base, candidate: { ...base.candidate, endpoint } }
      const candidate = { ...withoutDigest, capabilityDigest: computeMcpActivationCapabilityDigest(withoutDigest) }
      expect(parseMcpActivationProposal(candidate).ok).toBeTrue()
    },
  )

  test("rejects hidden fields and recomputed-looking tampering", () => {
    expect(parseMcpActivationProposal({ ...proposal(), headers: { authorization: "secret" } })).toEqual({
      ok: false,
      reason: "invalid_proposal",
    })
    expect(
      parseMcpActivationProposal({
        ...proposal(),
        guarantees: { ...proposal().guarantees, retries: "automatic" },
      }),
    ).toEqual({ ok: false, reason: "invalid_proposal" })
  })
})
