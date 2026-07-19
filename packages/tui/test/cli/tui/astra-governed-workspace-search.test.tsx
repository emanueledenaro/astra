/** @jsxImportSource @opentui/solid */

import type { WorkspaceSearchDecisionResult } from "@astra/domain/governed-workspace-search-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AstraGovernedWorkspaceSearchClient } from "../../../src/astra/governed-workspace-search-client"
import {
  registerAstraGovernedWorkspaceSearch,
  workspaceSearchProposalUnsettled,
  workspaceSearchTerminalLabel,
} from "../../../src/feature-plugins/system/astra-governed-workspace-search"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("registers /search without dispatchable approval commands and shows the host boundary", async () => {
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
  } satisfies AstraGovernedWorkspaceSearchClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const frame = await app.render.waitForFrame((value) => value.includes("IDLE · NO REQUEST · NO EFFECT"))
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("FIXED TEXT · NO SHELL · NO WRITES")
    expect(app.commands.get("astra.search.open")?.slashName).toBe("search")
    expect(app.commands.has("astra.search.approve")).toBeFalse()
    expect(app.commands.has("astra.search.reject")).toBeFalse()
    expect(workspaceSearchProposalUnsettled("preparing")).toBeTrue()
    expect(workspaceSearchProposalUnsettled("prepared")).toBeTrue()
    expect(workspaceSearchProposalUnsettled("terminal")).toBeFalse()
    expect(app.navigations()).toBe(1)
    app.dispatch("astra.search.open")
    expect(app.navigations()).toBe(1)
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks query composition locally in read-only mode", async () => {
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
  } satisfies AstraGovernedWorkspaceSearchClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only" }, client)

  try {
    await app.render.waitForFrame((value) => value.includes("IDLE · NO REQUEST · NO EFFECT"))
    app.dispatch("astra.search.query")
    const frame = await app.render.waitForFrame((value) => value.includes("BLOCKED · NO EFFECT CLAIMED"))
    expect(frame).toContain("read only")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("labels completed output only as observed not verified", () => {
  expect(workspaceSearchTerminalLabel(completedResult)).toBe("OBSERVED — NOT VERIFIED")
  expect(workspaceSearchTerminalLabel(completedResult)).not.toContain("VERIFIED SUCCESS")
})

async function renderSurface(authority: AstraSessionAuthority, client: AstraGovernedWorkspaceSearchClient) {
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
          route = routes.find((candidate) => candidate.name === "astra-governed-workspace-search") ?? route
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
    registerAstraGovernedWorkspaceSearch(api, authority, client)
    void keymap.dispatchCommand("astra.search.open")
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

  const render = await testRender(() => <Harness />, { width: 100, height: 20 })
  return {
    render,
    commands,
    dispatch: (command: string) => dispatch(command),
    navigations: () => navigationCount,
  }
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
    digestScope: "stdout_only",
    outputLineCount: 1,
    outcome: "matches",
    exitCode: 0,
    displayLines: ["./source.txt:1:needle"],
    truncated: false,
  },
} as const satisfies WorkspaceSearchDecisionResult

const activeAuthority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-17T16:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/tmp/astra-search-ui",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"b".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority
