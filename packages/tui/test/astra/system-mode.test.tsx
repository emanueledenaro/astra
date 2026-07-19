/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFile } from "node:fs/promises"
import { ASTRA_SYSTEM_MODE_STATUS, AstraSystemMode, isAstraSystemModeExitKey } from "../../src/astra/system-mode"

test("renders a truthful System Mode with no workspace authority", async () => {
  const app = await testRender(() => <AstraSystemMode onExit={() => {}} />, { width: 80, height: 20 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()

    expect(frame).toContain("ASTRA / SYSTEM")
    expect(frame).toContain(ASTRA_SYSTEM_MODE_STATUS)
    expect(frame).toContain("Lynx is idle")
    expect(frame).toContain("No workspace is open")
    expect(frame).toContain("Workspace, shell, Git, provider")
    expect(frame).toContain("plugin, and MCP effects are")
    expect(frame).toContain("unavailable")
    expect(frame).toContain("[Q] Exit")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps its exact safety contract readable without a fixed-width overflow", async () => {
  const app = await testRender(() => <AstraSystemMode onExit={() => {}} />, { width: 24, height: 12 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const normalized = frame.replace(/\s+/g, " ")

    expect(normalized).toContain(ASTRA_SYSTEM_MODE_STATUS)
    expect(frame).toContain("Idle")
    expect(frame).toContain("[Q] Exit")
    expect(ASTRA_SYSTEM_MODE_STATUS).toBe("SYSTEM MODE • NO WORKSPACE • EFFECTS DENIED")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the System Mode import graph inert", async () => {
  const source = await readFile(new URL("../../src/astra/system-mode.tsx", import.meta.url), "utf8")
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])

  expect(imports).toEqual(["@opentui/core", "@opentui/solid", "solid-js", "../component/lynx-model"])
  expect(source).not.toMatch(/process\.|Bun\.|node:|\.\/workspace|fetch\(|spawn\(|cwd\(|env\b/)
})

test("exits locally with Q, Escape, or Ctrl-C", async () => {
  let exits = 0
  const app = await testRender(() => <AstraSystemMode onExit={() => exits++} />)
  try {
    app.mockInput.pressKey("q")
    expect(exits).toBe(1)
  } finally {
    app.renderer.destroy()
  }

  expect(isAstraSystemModeExitKey({ name: "escape" })).toBeTrue()
  expect(isAstraSystemModeExitKey({ name: "c", ctrl: true })).toBeTrue()
  expect(isAstraSystemModeExitKey({ name: "c", ctrl: false })).toBeFalse()
})
