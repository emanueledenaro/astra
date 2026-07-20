/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFile } from "node:fs/promises"
import {
  ASTRA_NO_WORKSPACE_STATUS,
  AstraNoWorkspaceMode,
  createAstraNoWorkspaceModeEntry,
  isAstraNoWorkspaceModeExitKey,
} from "../../src/astra/no-workspace-mode"

const snapshot = {
  recentSessions: [{ sessionID: "session-1", workspaceRoot: "/work/astra", updatedAt: "2026-07-20T00:00:00.000Z" }],
} as const

test("renders the keyboard-first Launchpad with truthful unavailable actions", async () => {
  const app = await testRender(() => <AstraNoWorkspaceMode snapshot={snapshot} onDecision={() => {}} />, {
    width: 88,
    height: 24,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("ASTRA / LAUNCHPAD")
    expect(frame).toContain(ASTRA_NO_WORKSPACE_STATUS)
    expect(frame).toContain("[C] Create project")
    expect(frame).toContain("[O] Open workspace")
    expect(frame).toContain("[R] Continue session")
    expect(frame).toContain("[S] System")
    expect(frame).toContain("[Q] Exit")
    expect(frame).toContain("NOT AVAILABLE YET")
    expect(frame).toContain("/work/astra")
  } finally {
    app.renderer.destroy()
  }
})

test("opens a path entry locally without scanning a workspace", async () => {
  const app = await testRender(() => <AstraNoWorkspaceMode snapshot={snapshot} onDecision={() => {}} />, {
    width: 88,
    height: 24,
  })
  try {
    app.mockInput.pressKey("o")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Open workspace path")
    expect(app.captureCharFrame()).toContain("Enter an absolute path")
  } finally {
    app.renderer.destroy()
  }
})

test("returns an Open decision only after an absolute path is submitted", async () => {
  const decisions: Array<unknown> = []
  const app = await testRender(
    () => <AstraNoWorkspaceMode snapshot={snapshot} onDecision={(decision) => decisions.push(decision)} />,
    { width: 88, height: 24 },
  )
  try {
    app.mockInput.pressKey("o")
    for (const key of "/work/astra") app.mockInput.pressKey(key)
    app.mockInput.pressKey("\r")

    expect(decisions).toEqual([{ kind: "open-workspace", path: "/work/astra" }])
  } finally {
    app.renderer.destroy()
  }
})

test("fails closed before rendering malformed supplied snapshot data", async () => {
  const hostileSnapshot = {
    recentSessions: [
      { sessionID: "session-1", workspaceRoot: "/attacker\nDO NOT RENDER", updatedAt: "2026-07-20T00:00:00.000Z" },
    ],
  }
  const decisions: Array<unknown> = []

  expect(createAstraNoWorkspaceModeEntry(hostileSnapshot)).toEqual({ ok: false })

  const app = await testRender(
    () => <AstraNoWorkspaceMode snapshot={hostileSnapshot} onDecision={(decision) => decisions.push(decision)} />,
    { width: 88, height: 24 },
  )
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    app.mockInput.pressKey("s")
    app.mockInput.pressKey("q")

    expect(frame).toContain("Launchpad data unavailable")
    expect(frame).not.toContain("DO NOT RENDER")
    expect(decisions).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the Launchpad boundary readable in a compact terminal", async () => {
  const app = await testRender(() => <AstraNoWorkspaceMode snapshot={snapshot} onDecision={() => {}} />, {
    width: 32,
    height: 14,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const normalized = frame.replace(/\s+/g, " ")

    expect(normalized).toContain(ASTRA_NO_WORKSPACE_STATUS)
    expect(frame).toContain("Open workspace")
    expect(frame).toContain("System")
    expect(frame).toContain("Exit")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the Launchpad import graph inert", async () => {
  const source = await readFile(new URL("../../src/astra/no-workspace-mode.tsx", import.meta.url), "utf8")
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])

  expect(imports).toEqual([
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "@astra/domain/launchpad",
    "../component/lynx-model",
  ])
  expect(source).not.toMatch(/process\.|Bun\.|node:|\.\/workspace|fetch\(|spawn\(|cwd\(|env\b/)
})

test("keeps disabled actions inert and returns System or Exit decisions locally", async () => {
  const decisions: Array<string> = []
  const app = await testRender(() => (
    <AstraNoWorkspaceMode snapshot={snapshot} onDecision={(decision) => decisions.push(decision.kind)} />
  ))
  try {
    app.mockInput.pressKey("c")
    app.mockInput.pressKey("r")
    app.mockInput.pressKey("s")
    app.mockInput.pressKey("q")
    expect(decisions).toEqual(["open-system", "exit"])
  } finally {
    app.renderer.destroy()
  }

  expect(isAstraNoWorkspaceModeExitKey({ name: "escape" })).toBeTrue()
  expect(isAstraNoWorkspaceModeExitKey({ name: "c", ctrl: true })).toBeTrue()
  expect(isAstraNoWorkspaceModeExitKey({ name: "c", ctrl: false })).toBeFalse()
})
