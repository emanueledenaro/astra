/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { registerAstraAppFeatures } from "../../../src/astra/features"
import { TuiConfigProvider } from "../../../src/config"
import { createBuiltinPlugins } from "../../../src/feature-plugins/builtins"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("keeps the Git Control Plane out of non-Astra OpenCode", () => {
  expect(
    createBuiltinPlugins({ experimentalEventSystem: false }).some((plugin) => plugin.id === "astra-git-control-plane"),
  ).toBe(false)
})

test("registers the real Astra /git surface without external effects", async () => {
  const effects: string[] = []
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }
  let route: TuiRouteDefinition | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({ keymap })
    const api = {
      ...base,
      get client(): never {
        effects.push("client")
        throw new Error("Unexpected client access")
      },
      get app(): never {
        effects.push("process")
        throw new Error("Unexpected process capability access")
      },
      get event(): never {
        effects.push("network")
        throw new Error("Unexpected network capability access")
      },
      get state(): never {
        effects.push("workspace")
        throw new Error("Unexpected workspace state access")
      },
      route: {
        register(routes) {
          route = routes.find((candidate) => candidate.name === "astra-git-control")
          return () => {}
        },
        navigate(name, params) {
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi

    registerAstraAppFeatures(api, authority)
    const open = commands.get("astra.git.open")
    expect(open?.slashName).toBe("git")
    void keymap.dispatchCommand("astra.git.open")

    return (
      <TestTuiContexts directory={authority.workspace.root}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            {route?.render({ params: "params" in current ? current.params : undefined })}
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 54, height: 14 })
  try {
    const frame = await app.waitForFrame((value) => value.includes("separate authorization required"))
    expect(frame).toContain("Git Control Plane")
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("WORKSPACE")
    expect(frame).toContain("astra-project")
    expect(frame).toContain("ACTIVE ONCE")
    expect(frame).toContain("NOT INSPECTED • NOT VERIFIED")
    expect(frame).toContain("Operation Kernel adapter required")
    expect(frame).toContain("PUSH        UNAVAILABLE")
    expect(frame).not.toContain("Stage")
    expect(frame).not.toContain("Unstage")
    expect(frame).not.toContain("Commit")
    expect(effects).toEqual([])
    expect(current.name).toBe("astra-git-control")
  } finally {
    app.renderer.destroy()
  }
})

const authority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-17T12:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/Users/example/Documents/very-long-workspace-name/astra-project",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"a".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority
