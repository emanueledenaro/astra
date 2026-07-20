import { describe, expect, test } from "bun:test"
import { parseAstraSystemDecision, parseAstraSystemSnapshot } from "../src/system-control"

const snapshot = {
  version: "1.18.3",
  executionBackend: "host-no-sandbox",
  reviewMode: "manual",
  providers: [{ id: "anthropic", name: "Anthropic", credential: "missing" }],
  extensions: [{ kind: "plugin", id: "global-plugin", state: "recorded" }],
  recentSessions: [
    {
      sessionID: "session-1",
      workspaceRoot: "/work/astra",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
  ],
  recentReceipts: [
    {
      operationID: "90000000-0000-4000-8000-000000000001",
      state: "succeeded",
      observedAt: "2026-07-20T00:00:00.000Z",
    },
  ],
} as const

describe("Astra System Control contract", () => {
  test("accepts the exact global snapshot and typed decisions", () => {
    expect(parseAstraSystemSnapshot(snapshot)).toEqual({ ok: true, value: snapshot })
    expect(parseAstraSystemDecision({ kind: "connect-provider", providerID: "anthropic" })).toEqual({
      ok: true,
      value: { kind: "connect-provider", providerID: "anthropic" },
    })
    expect(parseAstraSystemDecision({ kind: "set-review-mode", mode: "auto-session" })).toEqual({
      ok: true,
      value: { kind: "set-review-mode", mode: "auto-session" },
    })
    expect(parseAstraSystemDecision({ kind: "exit" })).toEqual({ ok: true, value: { kind: "exit" } })
  })

  test("rejects unsafe snapshot data and decisions with extra authority", () => {
    expect(
      parseAstraSystemSnapshot({
        ...snapshot,
        providers: [{ ...snapshot.providers[0], credential: "sk-ant-never-render" }],
      }),
    ).toEqual({ ok: false, reason: "invalid_system_snapshot" })
    expect(
      parseAstraSystemSnapshot({
        ...snapshot,
        extensions: [{ kind: "plugin", id: "global-plugin\nOPEN WORKSPACE", state: "recorded" }],
      }),
    ).toEqual({ ok: false, reason: "invalid_system_snapshot" })
    expect(
      parseAstraSystemSnapshot({
        ...snapshot,
        recentReceipts: [{ ...snapshot.recentReceipts[0], operationID: "not-an-operation" }],
      }),
    ).toEqual({ ok: false, reason: "invalid_system_snapshot" })
    expect(parseAstraSystemDecision({ kind: "connect-provider", providerID: "anthropic", secret: "sk-ant-secret" })).toEqual({
      ok: false,
      reason: "invalid_system_decision",
    })
    expect(parseAstraSystemDecision({ kind: "set-review-mode", mode: "always" })).toEqual({
      ok: false,
      reason: "invalid_system_decision",
    })
  })

  test("projects only credential presence, never credential material", () => {
    const parsed = parseAstraSystemSnapshot(snapshot)

    expect(parsed.ok).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain("sk-ant")
    expect(JSON.stringify(parsed)).toContain('"credential":"missing"')
  })
})
