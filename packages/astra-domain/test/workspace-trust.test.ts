import { describe, expect, test } from "bun:test"
import { WorkspaceTrust } from "../src"
import {
  projectWorkspaceTrustEvent,
  workspaceTrustEvents,
  workspaceTrustStates,
  workspaceTrustTransitions,
  type WorkspaceTrustReport,
} from "../src/workspace-trust"
import {
  expectedWorkspaceTrustEvents,
  expectedWorkspaceTrustStates,
  expectedWorkspaceTrustTransitions,
} from "./workspace-trust-transition.fixture"

describe("Workspace trust transition projector", () => {
  test("matches and accepts the independent ASTRA-0049 transition fixture", () => {
    expect(workspaceTrustTransitions).toEqual(expectedWorkspaceTrustTransitions)

    for (const transition of expectedWorkspaceTrustTransitions) {
      expect(projectWorkspaceTrustEvent(transition.from, transition.event)).toEqual({
        accepted: true,
        from: transition.from,
        event: transition.event,
        state: transition.to,
      })
    }
  })

  test("rejects every unlisted transition without changing state", () => {
    const legal = new Set(
      expectedWorkspaceTrustTransitions.map((transition) => `${transition.from}\0${transition.event}`),
    )

    for (const state of [null, ...workspaceTrustStates] as const) {
      for (const event of workspaceTrustEvents) {
        if (legal.has(`${state}\0${event}`)) continue

        expect(projectWorkspaceTrustEvent(state, event)).toEqual({
          accepted: false,
          code: "illegal_transition",
          state,
          event,
        })
      }
    }
  })

  test("starts every new open context untrusted", () => {
    expect(projectWorkspaceTrustEvent(null, "workspace.opened")).toEqual({
      accepted: true,
      from: null,
      event: "workspace.opened",
      state: "UNTRUSTED",
    })
    expect(workspaceTrustTransitions.filter((transition) => transition.from === null)).toHaveLength(1)
  })

  test("admits only complete preflight reports for a trust decision", () => {
    for (const state of ["UNTRUSTED", "PREFLIGHT_BLOCKED", "STALE"] as const) {
      expect(projectWorkspaceTrustEvent(state, "preflight.completed").state).toBe("AWAITING_DECISION")
    }

    for (const state of ["UNTRUSTED", "STALE"] as const) {
      expect(projectWorkspaceTrustEvent(state, "preflight.blocked").state).toBe("PREFLIGHT_BLOCKED")
    }
  })

  test("keeps read-only and exit decisions untrusted", () => {
    for (const state of ["PREFLIGHT_BLOCKED", "AWAITING_DECISION"] as const) {
      for (const event of ["decision.read_only", "decision.exit"] as const) {
        expect(projectWorkspaceTrustEvent(state, event)).toEqual({
          accepted: true,
          from: state,
          event,
          state: "UNTRUSTED",
        })
      }
    }
  })

  test("allows trust once only from an exact completed snapshot decision", () => {
    expect(workspaceTrustTransitions.filter((transition) => transition.to === "TRUSTED_ONCE")).toEqual([
      { from: "AWAITING_DECISION", event: "decision.activate_once", to: "TRUSTED_ONCE" },
    ])
    expect(projectWorkspaceTrustEvent("PREFLIGHT_BLOCKED", "decision.activate_once")).toEqual({
      accepted: false,
      code: "illegal_transition",
      state: "PREFLIGHT_BLOCKED",
      event: "decision.activate_once",
    })
  })

  test("discards process-local trust when the process ends", () => {
    expect(projectWorkspaceTrustEvent("TRUSTED_ONCE", "process.ended")).toEqual({
      accepted: true,
      from: "TRUSTED_ONCE",
      event: "process.ended",
      state: "UNTRUSTED",
    })
    expect(workspaceTrustStates.join(",")).not.toContain("TRUSTED_PROJECT")
  })

  test("invalidates decision and activation when the snapshot drifts", () => {
    for (const state of ["AWAITING_DECISION", "TRUSTED_ONCE"] as const) {
      expect(projectWorkspaceTrustEvent(state, "snapshot.drifted")).toEqual({
        accepted: true,
        from: state,
        event: "snapshot.drifted",
        state: "STALE",
      })
    }
    expect(projectWorkspaceTrustEvent("STALE", "decision.activate_once").accepted).toBeFalse()
  })

  test("exposes the complete domain through the package root namespace", () => {
    expect(WorkspaceTrust.workspaceTrustStates).toEqual(expectedWorkspaceTrustStates)
    expect(WorkspaceTrust.workspaceTrustEvents).toEqual(expectedWorkspaceTrustEvents)
    expect(WorkspaceTrust.workspaceTrustTransitions).toEqual(expectedWorkspaceTrustTransitions)
    expect(WorkspaceTrust.projectWorkspaceTrustEvent("AWAITING_DECISION", "decision.activate_once").state).toBe(
      "TRUSTED_ONCE",
    )
  })

  test("represents complete and blocked bounded preflight reports", () => {
    const completeReport = {
      root: "/workspace",
      identity: { device: "16777233", inode: "42" },
      securityDigest: "sha256:abc",
      completeness: "complete",
      state: "awaiting_decision",
      surfaces: [{ kind: "package_manifest", path: "package.json" }],
      blockers: [],
      scannedEntries: 1,
      scannedBytes: 120,
      limits: {
        maxEntries: 128,
        maxFileBytes: 65_536,
        maxTotalBytes: 262_144,
        maxDurationMs: 1_000,
      },
    } as const satisfies WorkspaceTrustReport
    const blockedReport = {
      ...completeReport,
      identity: null,
      securityDigest: null,
      completeness: "incomplete",
      state: "preflight_blocked",
      blockers: ["workspace_identity_unavailable"],
    } as const satisfies WorkspaceTrustReport

    expect(completeReport.state).toBe("awaiting_decision")
    expect(blockedReport).toMatchObject({
      identity: null,
      securityDigest: null,
      completeness: "incomplete",
      state: "preflight_blocked",
    })
  })

  test("keeps the domain module free of effect dependencies", async () => {
    const source = await Bun.file(new URL("../src/workspace-trust.ts", import.meta.url)).text()
    const forbiddenDependencies = [
      "node:fs",
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:dns",
      "node:process",
      "simple-git",
      "@opencode-ai/plugin",
      "@opencode-ai/sdk",
    ]

    expect(source).not.toContain("import ")
    for (const dependency of forbiddenDependencies) {
      expect(source).not.toContain(dependency)
    }
  })
})
