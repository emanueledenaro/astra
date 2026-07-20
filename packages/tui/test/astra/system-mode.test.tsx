/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFile } from "node:fs/promises"
import {
  ASTRA_SYSTEM_MODE_STATUS,
  AstraSystemMode,
  createAstraSystemModeEntry,
  isAstraSystemModeExitKey,
} from "../../src/astra/system-mode"

const snapshot = {
  version: "1.18.3",
  executionBackend: "host-no-sandbox",
  reviewMode: "manual",
  providers: [{ id: "anthropic", name: "Anthropic", credential: "missing" }],
  extensions: [{ kind: "plugin", id: "global-plugin", state: "recorded" }],
  recentSessions: [
    { sessionID: "session-1", workspaceRoot: "/work/astra", updatedAt: "2026-07-20T00:00:00.000Z" },
  ],
  recentReceipts: [
    {
      operationID: "90000000-0000-4000-8000-000000000001",
      state: "succeeded",
      observedAt: "2026-07-20T00:00:00.000Z",
    },
  ],
} as const

test("renders a wide global Control Center with the exact no-workspace boundary", async () => {
  const app = await testRender(() => <AstraSystemMode snapshot={snapshot} onDecision={() => {}} />, { width: 96, height: 30 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("ASTRA / CONTROL CENTER")
    expect(frame).toContain(ASTRA_SYSTEM_MODE_STATUS)
    expect(ASTRA_SYSTEM_MODE_STATUS).toBe("NO WORKSPACE AUTHORITY")
    expect(frame).toContain("Providers")
    expect(frame).toContain("Extensions")
    expect(frame).toContain("Sessions")
    expect(frame).toContain("Receipts")
    expect(frame).toContain("Diagnostics")
    expect(frame).toContain("Anthropic")
    expect(frame).toContain("global-plugin")
    expect(frame).toContain("/work/astra")
    expect(frame).toContain("host-no-sandbox")
    expect(frame).toContain("Workspace files, Git, shell, and workspace Operations stay unavailable.")
    expect(frame).toContain("[C] Connect provider")
    expect(frame).toContain("[M] Auto Review")
    expect(frame).toContain("[Q] Exit")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the Control Center compact without losing its safety boundary", async () => {
  const app = await testRender(() => <AstraSystemMode snapshot={snapshot} onDecision={() => {}} />, { width: 32, height: 14 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const normalized = frame.replace(/\s+/g, " ")

    expect(normalized).toContain(ASTRA_SYSTEM_MODE_STATUS)
    expect(frame).toContain("Providers")
    expect(frame).toContain("Extensions")
    expect(frame).toContain("Review")
    expect(frame).toContain("Exit")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the System Mode import graph inert", async () => {
  const source = await readFile(new URL("../../src/astra/system-mode.tsx", import.meta.url), "utf8")
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])

  expect(imports).toEqual(["@opentui/core", "@opentui/solid", "solid-js", "@astra/domain/system-control"])
  expect(source).not.toMatch(/process\.|Bun\.|node:|\.\/workspace|fetch\(|spawn\(|cwd\(|env\b/)
})

test("returns only typed Connect, Review, or Exit intent locally", async () => {
  const decisions: Array<unknown> = []
  const app = await testRender(() => <AstraSystemMode snapshot={snapshot} onDecision={(decision) => decisions.push(decision)} />)
  try {
    app.mockInput.pressKey("c")
    expect(decisions).toEqual([{ kind: "connect-provider", providerID: "anthropic" }])
  } finally {
    app.renderer.destroy()
  }

  const review: Array<unknown> = []
  const reviewApp = await testRender(() => <AstraSystemMode snapshot={snapshot} onDecision={(decision) => review.push(decision)} />)
  try {
    reviewApp.mockInput.pressKey("m")
    expect(review).toEqual([{ kind: "set-review-mode", mode: "auto-session" }])
  } finally {
    reviewApp.renderer.destroy()
  }

  const exits: Array<unknown> = []
  const exitApp = await testRender(() => <AstraSystemMode snapshot={snapshot} onDecision={(decision) => exits.push(decision)} />)
  try {
    exitApp.mockInput.pressKey("q")
    expect(exits).toEqual([{ kind: "exit" }])
  } finally {
    exitApp.renderer.destroy()
  }

  expect(createAstraSystemModeEntry({ ...snapshot, providers: [{ ...snapshot.providers[0], credential: "sk-ant-secret" }] })).toEqual({
    ok: false,
  })

  expect(isAstraSystemModeExitKey({ name: "escape" })).toBeTrue()
  expect(isAstraSystemModeExitKey({ name: "c", ctrl: true })).toBeTrue()
  expect(isAstraSystemModeExitKey({ name: "c", ctrl: false })).toBeFalse()
})

test("keeps an unsupported missing provider visible but does not expose Connect", async () => {
  const unsupported = {
    ...snapshot,
    providers: [{ id: "unsupported", name: "Unsupported", credential: "missing" }],
  } as const
  const decisions: Array<unknown> = []
  const app = await testRender(
    () => <AstraSystemMode snapshot={unsupported} onDecision={(decision) => decisions.push(decision)} />,
    { width: 96, height: 30 },
  )
  try {
    await app.renderOnce()
    app.mockInput.pressKey("c")

    expect(app.captureCharFrame()).toContain("Unsupported · credential missing")
    expect(app.captureCharFrame()).not.toContain("[C] Connect provider")
    expect(decisions).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
