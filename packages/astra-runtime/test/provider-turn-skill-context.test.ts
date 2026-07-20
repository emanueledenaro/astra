import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  makeProviderTurnOperationFacts,
  type ProviderTurnOperationFactsInput,
} from "../src/provider-turn-operation-facts"
import {
  providerTurnPublicDnsPolicyDigest,
  providerTurnResolverImplementationDigest,
  providerTurnTransportImplementationDigest,
} from "../src/provider-turn-network-policy"

describe("provider turn skill-context authority", () => {
  test("binds the non-secret context digest into preview and capability authority", () => {
    const contextBindingDigest = digest("activated skill public descriptor")
    const withSkill = facts(contextBindingDigest)
    const withoutSkill = facts(null, withSkill.plan.operationID)
    const skillAuthority = makeProviderTurnOperationFacts(withSkill)
    const plainAuthority = makeProviderTurnOperationFacts(withoutSkill)

    expect({
      ...skillAuthority.preview.logicalPayload,
      digest: String(skillAuthority.preview.logicalPayload.digest),
      contextBindingDigest: String(skillAuthority.preview.logicalPayload.contextBindingDigest),
      historyDigest: String(skillAuthority.preview.logicalPayload.historyDigest),
    }).toEqual({
      digest: withSkill.plan.logicalPayload.digest,
      bytes: withSkill.plan.logicalPayload.bytes,
      contextBindingDigest,
      historyDigest: withSkill.plan.logicalPayload.historyDigest,
    })
    expect(String(skillAuthority.adapterRequest.logicalPayload.contextBindingDigest)).toBe(contextBindingDigest)
    expect(skillAuthority.capabilityDigest).not.toBe(plainAuthority.capabilityDigest)
    expect(JSON.stringify(skillAuthority)).not.toContain("private skill instructions")
  })

  test("rejects a malformed context binding before authority is created", () => {
    expect(() => makeProviderTurnOperationFacts(facts("sha256:not-a-digest"))).toThrow(
      "The provider turn digest is invalid",
    )
  })

  test("snapshots the context binding so later caller mutation cannot alter authority", () => {
    const input = facts(digest("original context"))
    const first = makeProviderTurnOperationFacts(input)
    const mutable = input.plan.logicalPayload as { contextBindingDigest: string | null }
    mutable.contextBindingDigest = digest("mutated context")

    expect(String(first.preview.logicalPayload.contextBindingDigest)).toBe(digest("original context"))
    expect(makeProviderTurnOperationFacts(input).capabilityDigest).not.toBe(first.capabilityDigest)
  })
})

function facts(contextBindingDigest: string | null, operationID = crypto.randomUUID()) {
  const createdAt = "2026-07-17T12:00:00.000Z"
  return {
    plan: {
      operationID,
      workspaceRoot: "/tmp/astra-provider-skill-context",
      sessionID: "session-1",
      messageID: "message-1",
      providerID: "anthropic",
      modelID: "claude-haiku-4-5-20251001",
      variant: null,
      adapter: {
        adapterID: "anthropic.messages.api-key.v1",
        adapterDigest: digest("certified Anthropic adapter"),
      },
      origin: "https://api.anthropic.com",
      transportPolicy: "https_only",
      networkPolicy: {
        mode: "https_public_pinned",
        hostname: "api.anthropic.com",
        port: 443,
        dnsPolicyDigest: providerTurnPublicDnsPolicyDigest,
        resolverImplementationDigest: providerTurnResolverImplementationDigest,
        transportImplementationDigest: providerTurnTransportImplementationDigest,
      },
      credential: {
        profile: "anthropic-api-key",
        handle: "auth:anthropic:primary",
        accountFingerprint: digest("provider account"),
        headerName: "x-api-key",
      },
      wireRequest: {
        method: "POST",
        path: "/v1/messages",
        headerNames: ["anthropic-version", "content-type", "x-api-key"],
        timeoutMilliseconds: 30_000,
        maximumResponseBytes: 1_048_576,
      },
      logicalPayload: {
        digest: digest("private skill instructions and user prompt"),
        bytes: 42,
        contextBindingDigest,
        historyDigest: digest("provider conversation history"),
      },
      executionBoundary: "network_egress_host_no_sandbox",
      createdAt,
    },
    report: {
      root: "/tmp/astra-provider-skill-context",
      identity: { device: "1", inode: "2" },
      securityDigest: digest("workspace security"),
      completeness: "complete",
      state: "awaiting_decision",
      surfaces: [],
      blockers: [],
      scannedEntries: 0,
      scannedBytes: 0,
      limits: { maxEntries: 1, maxFileBytes: 1, maxTotalBytes: 1, maxDurationMs: 1 },
    },
    policyAskedAt: createdAt,
    recordingStartedAt: createdAt,
  } satisfies ProviderTurnOperationFactsInput
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
