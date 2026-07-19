/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFile } from "node:fs/promises"
import {
  ASTRA_NO_WORKSPACE_STATUS,
  AstraNoWorkspaceMode,
  isAstraNoWorkspaceModeExitKey,
} from "../../src/astra/no-workspace-mode"

test("renders a truthful No Workspace mode with explicit open instructions", async () => {
  const app = await testRender(() => <AstraNoWorkspaceMode onExit={() => {}} />, { width: 86, height: 22 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("ASTRA / NO WORKSPACE")
    expect(frame).toContain(ASTRA_NO_WORKSPACE_STATUS)
    expect(frame).not.toContain("SYSTEM MODE")
    expect(frame).toContain("No workspace is open")
    expect(frame).toContain("astra .")
    expect(frame).toContain("astra /absolute/path")
    expect(frame).toContain("No directory was scanned")
    expect(frame).toContain("[Q] Exit")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the safety state visible in a compact terminal", async () => {
  const app = await testRender(() => <AstraNoWorkspaceMode onExit={() => {}} />, { width: 28, height: 13 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const normalized = frame.replace(/\s+/g, " ")

    expect(normalized).toContain(ASTRA_NO_WORKSPACE_STATUS)
    expect(frame).toContain("astra .")
    expect(frame).toContain("[Q] Exit")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the No Workspace import graph inert", async () => {
  const source = await readFile(new URL("../../src/astra/no-workspace-mode.tsx", import.meta.url), "utf8")
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])

  expect(imports).toEqual(["@opentui/core", "@opentui/solid", "solid-js", "../component/lynx-model"])
  expect(source).not.toMatch(/process\.|Bun\.|node:|\.\/workspace|fetch\(|spawn\(|cwd\(|env\b/)
})

test("exits locally with Q, Escape, or Ctrl-C", async () => {
  let exits = 0
  const app = await testRender(() => <AstraNoWorkspaceMode onExit={() => exits++} />)
  try {
    app.mockInput.pressKey("q")
    expect(exits).toBe(1)
  } finally {
    app.renderer.destroy()
  }

  expect(isAstraNoWorkspaceModeExitKey({ name: "escape" })).toBeTrue()
  expect(isAstraNoWorkspaceModeExitKey({ name: "c", ctrl: true })).toBeTrue()
  expect(isAstraNoWorkspaceModeExitKey({ name: "c", ctrl: false })).toBeFalse()
})
