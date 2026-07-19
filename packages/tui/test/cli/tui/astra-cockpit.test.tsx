/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { AstraProviderClient } from "../../../src/astra/provider-client"
import { AstraCockpit } from "../../../src/component/astra-cockpit"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("renders one Astra surface with conversation on the left and live control on the right", async () => {
  await using directory = await tmpdir()
  const stateDirectory = path.join(directory.path, "state")
  await mkdir(stateDirectory, { recursive: true })
  await Bun.write(path.join(stateDirectory, "kv.json"), "{}")
  const app = await testRender(() => <Harness authority={authority} stateDirectory={stateDirectory} />, {
    width: 140,
    height: 34,
  })
  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    const frame = await app.waitForFrame((value) => value.includes("Waiting for your message"))
    expect(frame).toContain("ASTRA COCKPIT")
    expect(frame).toContain("CONVERSATION")
    expect(frame).toContain("CONTROL RAIL")
    expect(frame).toContain("LIVE ACTIVITY")
    expect(frame).toContain("PROVIDER Anthropic")
    expect(frame).toContain("MODEL    claude-sonnet-4-5-20250929")
    expect(frame).toContain("AGENTS")
    expect(frame).toContain("GIT")
    expect(frame).toContain("ACTIVE ONCE")
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("Lynx coordinator")
    expect(frame).toContain("No subagents active")
    expect(frame).not.toContain("Inherited prompt disabled")
  } finally {
    app.renderer.destroy()
  }
})

test("preserves the side-by-side control surface and truthful boundary at 80 columns", async () => {
  await using directory = await tmpdir()
  const stateDirectory = path.join(directory.path, "state")
  await mkdir(stateDirectory, { recursive: true })
  await Bun.write(path.join(stateDirectory, "kv.json"), "{}")
  const app = await testRender(
    () => <Harness authority={{ ...authority, mode: "read-only" }} stateDirectory={stateDirectory} />,
    { width: 80, height: 24 },
  )

  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    const frame = await app.waitForFrame((value) => value.includes("Workspace opened read-only"))
    expect(frame).toContain("CONVERSATION")
    expect(frame).toContain("CONTROL RAIL")
    expect(frame).toContain("Workspace opened read-only")
    expect(frame).toContain("EFFECTS DENIED — NO HOST")
    expect(frame).not.toContain("HOST EXECUTION — NO SANDBOX")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the truthful compact boundary when height cannot fit every detail", async () => {
  await using directory = await tmpdir()
  const stateDirectory = path.join(directory.path, "state")
  await mkdir(stateDirectory, { recursive: true })
  await Bun.write(path.join(stateDirectory, "kv.json"), "{}")
  const app = await testRender(
    () => <Harness authority={{ ...authority, mode: "read-only" }} stateDirectory={stateDirectory} />,
    { width: 104, height: 24 },
  )

  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    const frame = await app.waitForFrame((value) => value.includes("EFFECTS DENIED — NO HOST"))
    expect(frame).toContain("READ ONLY")
    expect(frame).toContain("EFFECTS DENIED — NO HOST")
    expect(frame).not.toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).not.toContain("WRITE    EXPLICIT CONSENT")
  } finally {
    app.renderer.destroy()
  }
})

function Harness(props: { authority: AstraSessionAuthority; stateDirectory: string }) {
  const keymap = createDefaultOpenTuiKeymap(useRenderer())
  const api = createTuiPluginApi({ keymap })
  return (
    <TestTuiContexts directory={props.authority.workspace.root} paths={{ state: props.stateDirectory }}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <OpencodeKeymapProvider keymap={keymap}>
              <AstraCockpit api={api} authority={props.authority} providerClient={providerClient} />
            </OpencodeKeymapProvider>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

const digest = `sha256:${"a".repeat(64)}` as const
const authority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-19T18:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/tmp/astra-cockpit-ui",
    identity: { device: "1", inode: "2" },
    securityDigest: digest,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority

const providerClient = {
  catalog: () =>
    Promise.resolve({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      status: "available",
      catalog: {
        providerID: "anthropic",
        providerName: "Anthropic",
        models: [
          {
            id: "claude-sonnet-4-5-20250929",
            name: "Claude Sonnet",
            limits: { context: 200_000, output: 8_192 },
          },
        ],
      },
    } as const),
  prepare: () => Promise.reject(new Error("No prompt expected")),
  decide: () => Promise.reject(new Error("No decision expected")),
  dispose() {},
} satisfies AstraProviderClient
