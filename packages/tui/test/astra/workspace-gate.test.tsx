/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { AstraWorkspaceGate, type AstraWorkspaceGateView } from "../../src/astra/workspace-gate"

const view = {
  workspace: "/work/astra",
  state: "awaiting-decision",
  preflight: "complete",
  git: "not-inspected",
  activationAllowed: false,
  scannedEntries: 12,
  scannedBytes: 2048,
  surfaces: [
    { kind: "git_metadata", path: ".git" },
    { kind: "repository_instructions", path: "AGENTS.md" },
  ],
  blockers: [],
} as const satisfies AstraWorkspaceGateView

test("renders the real Astra workspace decision surface", async () => {
  const frame = await renderGate(view, 100, 28)

  expect(frame).toContain("ASTRA / WORKSPACE GATE")
  expect(frame).toContain("AWAITING DECISION")
  expect(frame).toContain("/work/astra")
  expect(frame).toContain("PREFLIGHT COMPLETE")
  expect(frame).toContain("GIT NOT INSPECTED")
  expect(frame).toContain("[R] Open read-only")
  expect(frame).toContain("[A] Activate once (locked)")
  expect(frame).toContain("No workspace code, plugin, MCP, LSP, formatter, shell, or provider is started here.")
})

test("shows a non-interactive Git progress state instead of a blank terminal", async () => {
  const frame = await renderGate(
    { ...view, state: "working", git: "inspecting", detail: "Inspecting Git with bounded read-only checks." },
    100,
    28,
  )

  expect(frame).toContain("INSPECTING GIT")
  expect(frame).toContain("Lynx is checking the workspace")
  expect(frame).toContain("Inspecting Git with bounded read-only checks.")
  expect(frame).toContain("Activate once (locked)")
})

test("keeps the decision and safety status readable in a compact terminal", async () => {
  const frame = await renderGate({ ...view, state: "stale", git: "stale", detail: "Git changed" }, 48, 18)

  expect(frame).toContain("STALE")
  expect(frame).toContain("Git changed")
  expect(frame).toContain("Open read-only")
  expect(frame).toContain("Exit")
})

async function renderGate(input: AstraWorkspaceGateView, width: number, height: number) {
  const app = await testRender(() => <AstraWorkspaceGate view={input} onDecision={() => {}} />, { width, height })
  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}
