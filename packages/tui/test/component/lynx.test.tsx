/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Lynx, type LynxPresentationState, type LynxSize } from "../../src/component/lynx"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TestTuiContexts } from "../fixture/tui-environment"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("renders the full working Lynx with its laptop and accessible label", async () => {
  const frame = await renderLynx("working", "full")
  expect(frame).toContain("ASTRA")
  expect(frame).toContain("WORK")
  expect(frame).toContain("Lynx is typing")
})

test("renders an unambiguous compact decision state", async () => {
  const frame = await renderLynx("awaiting-decision", "compact")
  expect(frame).toContain("▄█▄▟◉▴◉▙▄█▄")
  expect(frame).toContain("Decision needed")
})

test("accepts an illustrated renderer while preserving the textual label", async () => {
  const frame = await renderLynx("working", "full", () => <text>illustrated typing frame</text>)
  expect(frame).toContain("illustrated typing frame")
  expect(frame).toContain("Lynx is typing")
  expect(frame).not.toContain("▄█▄")
})

test("falls back to terminal pixels when an illustrated renderer declines", async () => {
  const frame = await renderLynx("working", "full", () => undefined)
  expect(frame).toContain("▄█▄")
  expect(frame).toContain("Lynx is typing")
})

test("keeps the state label when the visual is hidden in a constrained layout", async () => {
  const frame = await renderLynx("retrying", "compact", undefined, false, false)
  expect(frame).toContain("Retrying")
  expect(frame).not.toContain("▄█▄")
})

test("passes illustrated playback capability without enabling terminal-only motion", async () => {
  const requests: boolean[] = []
  await renderLynx(
    "awaiting-decision",
    "full",
    (input) => {
      requests.push(input.motionEnabled)
      return <text>{input.sequence.frames[0].id}</text>
    },
    true,
  )
  expect(requests).toContain(true)
})

async function renderLynx(
  state: LynxPresentationState,
  size: LynxSize,
  renderIllustration?: Parameters<typeof Lynx>[0]["renderIllustration"],
  animate = false,
  showVisual = true,
) {
  await using directory = await tmpdir()
  const stateDirectory = path.join(directory.path, "state")
  await mkdir(stateDirectory, { recursive: true })
  await Bun.write(path.join(stateDirectory, "kv.json"), "{}")

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory.path} paths={{ state: stateDirectory }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Lynx
                state={state}
                size={size}
                animate={animate}
                color={false}
                showVisual={showVisual}
                renderIllustration={renderIllustration}
              />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 12 },
  )

  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    for (let attempt = 0; attempt < 40; attempt++) {
      const frame = app.captureCharFrame()
      if (frame.trim().length > 0) return frame
      await Bun.sleep(25)
      await app.renderOnce()
    }
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}
