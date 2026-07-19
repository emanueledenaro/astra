/** @jsxImportSource @opentui/solid */

import type { HostCommandDecisionResult } from "@astra/domain/host-command-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AstraHostCommandClient } from "../../../src/astra/host-command-client"
import {
  hostCommandProposalUnsettled,
  hostCommandTerminalLabel,
  registerAstraHostCommand,
} from "../../../src/feature-plugins/system/astra-host-command"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("registers /shell without dispatchable consent and exposes every unrestricted host boundary", async () => {
  let calls = 0
  const client = {
    prepare() {
      calls++
      return Promise.resolve({ schemaVersion: 1, requestId, status: "blocked", reason: "unused" } as const)
    },
    decide() {
      calls++
      return Promise.resolve({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "unused" } as const)
    },
    dispose() {},
  } satisfies AstraHostCommandClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const frame = await app.render.waitForFrame((value) => value.includes("IDLE · NO REQUEST · NO EFFECT"))
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("HOST FILESYSTEM UNRESTRICTED · COMMAND-DEFINED WRITES")
    expect(frame).toContain("HOST NETWORK UNRESTRICTED · EXACT OUTPUT IS NOT VERIFICATION")
    expect(app.commands.get("astra.shell.open")?.slashName).toBe("shell")
    expect(app.commands.has("astra.shell.approve")).toBeFalse()
    expect(app.commands.has("astra.shell.reject")).toBeFalse()
    expect(hostCommandProposalUnsettled("prepared")).toBeTrue()
    expect(hostCommandProposalUnsettled("terminal")).toBeFalse()
    expect(app.navigations()).toBe(1)
    app.dispatch("astra.shell.open")
    expect(app.navigations()).toBe(1)
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks shell composition locally in read-only mode", async () => {
  let calls = 0
  const client = {
    prepare() {
      calls++
      return Promise.reject(new Error("must not run"))
    },
    decide() {
      calls++
      return Promise.reject(new Error("must not run"))
    },
    dispose() {},
  } satisfies AstraHostCommandClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only" }, client)

  try {
    await app.render.waitForFrame((value) => value.includes("IDLE · NO REQUEST · NO EFFECT"))
    app.dispatch("astra.shell.compose")
    const frame = await app.render.waitForFrame((value) => value.includes("BLOCKED · NO EFFECT CLAIMED"))
    expect(frame).toContain("read only")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("labels zero exit only as observed output, never verified", () => {
  expect(hostCommandTerminalLabel(completedResult)).toBe("COMPLETED · OUTPUT OBSERVED · NOT VERIFIED")
  expect(hostCommandTerminalLabel(completedResult)).not.toBe("VERIFIED")
})

async function renderSurface(authority: AstraSessionAuthority, client: AstraHostCommandClient) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }
  let route: TuiRouteDefinition | undefined
  let dispatch!: (command: string) => void
  let navigationCount = 0

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
      route: {
        register(routes) {
          route = routes.find((candidate) => candidate.name === "astra-host-command") ?? route
          return () => {}
        },
        navigate(name, params) {
          navigationCount++
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi
    registerAstraHostCommand(api, authority, client)
    void keymap.dispatchCommand("astra.shell.open")
    dispatch = (command) => void keymap.dispatchCommand(command)
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

  const render = await testRender(() => <Harness />, { width: 110, height: 20 })
  return { render, commands, dispatch: (command: string) => dispatch(command), navigations: () => navigationCount }
}

const requestId = "10000000-0000-4000-8000-000000000001"
const proposalID = "10000000-0000-4000-8000-000000000002"
const operationID = "10000000-0000-4000-8000-000000000003"
const receiptID = "10000000-0000-4000-8000-000000000004"
const digest = `sha256:${"a".repeat(64)}` as const
const completedResult = {
  schemaVersion: 1,
  requestId,
  proposalID,
  operationID,
  capabilityDigest: digest,
  verification: "not_verified",
  status: "completed_observed_not_verified",
  receiptID,
  output: {
    outputDigest: digest,
    digestScope: "stdout_stderr_exit",
    exitCode: 0,
    stdoutLines: ["astra-shell-ready"],
    stderrLines: [],
    truncated: false,
  },
} as const satisfies HostCommandDecisionResult

const activeAuthority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-17T16:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/tmp/astra-shell-ui",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"b".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority
