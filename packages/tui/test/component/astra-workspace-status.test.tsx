/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import { testRender } from "@opentui/solid"
import { AstraWorkspaceStatus, getAstraWorkspaceStatus } from "../../src/component/astra-workspace-status"

test("describes a fail-closed read-only Astra workspace", () => {
  expect(getAstraWorkspaceStatus(authority("read-only"))).toMatchObject({
    mode: "read-only",
    label: "ASTRA  •  READ ONLY  •  EFFECTS DENIED",
  })
})

test("does not promise host effects before the Astra control plane exists", () => {
  expect(getAstraWorkspaceStatus(authority("activate-once"))).toMatchObject({
    mode: "activate-once",
    label: "ASTRA  •  ACTIVE ONCE  •  EFFECTS BLOCKED",
  })
})

test("does not alter the inherited OpenCode interface outside Astra", () => {
  expect(getAstraWorkspaceStatus(undefined)).toBeUndefined()
})

test("renders the read-only state as a visible TUI strip", async () => {
  const app = await testRender(() => <AstraWorkspaceStatus authority={authority("read-only")} />, {
    width: 60,
    height: 3,
  })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ASTRA  •  READ ONLY  •  EFFECTS DENIED")
  } finally {
    app.renderer.destroy()
  }
})

function authority(mode: AstraSessionAuthority["mode"]): AstraSessionAuthority {
  return {
    schemaVersion: 1,
    sessionID: "32a18f14-58c7-4d67-92a0-29f0dcf8977c",
    issuedAt: "2026-07-17T16:00:00.000Z",
    mode,
    effectPolicy: "deny",
    workspace: {
      root: "/workspace",
      identity: { device: "1", inode: "2" },
      securityDigest: `sha256:${"a".repeat(64)}`,
    },
    repositoryBaseline: null,
  }
}
