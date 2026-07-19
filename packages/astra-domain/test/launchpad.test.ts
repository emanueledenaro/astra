import { describe, expect, test } from "bun:test"
import { parseAstraLaunchpadDecision, parseAstraLaunchpadSnapshot } from "../src/launchpad"

describe("Astra Launchpad contract", () => {
  test("accepts typed Launchpad decisions with an absolute workspace path", () => {
    const decision = { kind: "open-workspace", path: "/work/astra" } as const

    expect(parseAstraLaunchpadDecision(decision)).toEqual({ ok: true, value: decision })
    expect(parseAstraLaunchpadDecision({ kind: "create-project" })).toEqual({
      ok: true,
      value: { kind: "create-project" },
    })
    expect(parseAstraLaunchpadDecision({ kind: "continue-session", sessionID: "session-1" })).toEqual({
      ok: true,
      value: { kind: "continue-session", sessionID: "session-1" },
    })
    expect(parseAstraLaunchpadDecision({ kind: "open-system" })).toEqual({ ok: true, value: { kind: "open-system" } })
    expect(parseAstraLaunchpadDecision({ kind: "exit" })).toEqual({ ok: true, value: { kind: "exit" } })
  })

  test("rejects relative and control-character workspace paths", () => {
    expect(parseAstraLaunchpadDecision({ kind: "open-workspace", path: "relative/workspace" })).toEqual({
      ok: false,
      reason: "invalid_launchpad_decision",
    })
    expect(parseAstraLaunchpadDecision({ kind: "open-workspace", path: "/work/astra\nnext" })).toEqual({
      ok: false,
      reason: "invalid_launchpad_decision",
    })
  })

  test("accepts exact recent-session records and rejects malformed records", () => {
    const snapshot = {
      recentSessions: [
        {
          sessionID: "session-1",
          workspaceRoot: "/work/astra",
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    } as const

    expect(parseAstraLaunchpadSnapshot(snapshot)).toEqual({ ok: true, value: snapshot })
    expect(
      parseAstraLaunchpadSnapshot({
        recentSessions: [{ sessionID: "session-1", workspaceRoot: "relative", updatedAt: "2026-07-20T00:00:00.000Z" }],
      }),
    ).toEqual({ ok: false, reason: "invalid_launchpad_snapshot" })
    expect(
      parseAstraLaunchpadSnapshot({
        recentSessions: [{ sessionID: "session-1", workspaceRoot: "/work/astra", updatedAt: "yesterday" }],
      }),
    ).toEqual({ ok: false, reason: "invalid_launchpad_snapshot" })
    expect(
      parseAstraLaunchpadSnapshot({
        recentSessions: [
          { sessionID: "session-1", workspaceRoot: "/work/astra", updatedAt: "2026-07-20T00:00:00.000Z", extra: true },
        ],
      }),
    ).toEqual({ ok: false, reason: "invalid_launchpad_snapshot" })
  })
})
