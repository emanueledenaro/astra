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
import type { AstraExtensionInventoryClient } from "../../../src/astra/extension-inventory-client"
import type { AstraMcpActivationClient } from "../../../src/astra/mcp-activation-client"
import { parseContentDigest } from "@astra/domain/operation-contract"

test("keeps the Astra Extensions surface out of non-Astra OpenCode", () => {
  expect(
    createBuiltinPlugins({ experimentalEventSystem: false }).some((plugin) => plugin.id === "astra-extensions"),
  ).toBe(false)
})

test("opens Astra /extensions inertly, previews exact authority, and shows inactive candidates only after approval", async () => {
  const effects: string[] = []
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }
  let route: TuiRouteDefinition | undefined
  let dispatchCommand = (_name: string) => undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    dispatchCommand = (name) => {
      void keymap.dispatchCommand(name)
    }
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
        effects.push("filesystem")
        throw new Error("Unexpected workspace or filesystem state access")
      },
      route: {
        register(routes) {
          route = routes.find((candidate) => candidate.name === "astra-extensions")
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

    registerAstraAppFeatures(api, authority, undefined, undefined, undefined, undefined, undefined, undefined, inventoryClient, undefined, mcpClient)
    const open = commands.get("astra.extensions.open")
    expect(open?.slashName).toBe("extensions")
    void keymap.dispatchCommand("astra.extensions.open")

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

  const app = await testRender(() => <Harness />, { width: 88, height: 22 })
  try {
    const frame = await app.waitForFrame((value) => value.includes("I inspect"))
    expect(frame).toContain("Extensions")
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("SAFE START  ALWAYS ACTIVE")
    expect(frame).toContain("NOT INSPECTED • NOT VERIFIED")
    expect(frame).toContain("STATIC JSON/JSONC • NO ACTIVATION")
    expect(frame).toContain("NO AUTOMATIC discovery, initialization, or activation")
    expect(frame).toContain("M activate eligible MCP")
    expect(effects).toEqual([])
    expect(current.name).toBe("astra-extensions")
    dispatchCommand("astra.extensions.inventory")
    const preview = await app.waitForFrame((value) => value.includes("PRIVATE VERIFIED SNAPSHOT"))
    expect(preview).toContain("HOST EXECUTION — NO SANDBOX")
    expect(preview).toContain("workspace_extension_config_read")
    expect(preview).toContain("opencode.json")
    expect(preview).not.toContain("Plugin candidate")
    dispatchCommand("astra.extensions.approve")
    const completed = await app.waitForFrame((value) => value.includes("Plugin candidate abcdef12"))
    expect(completed).toContain("INACTIVE • NOT VERIFIED")
    expect(calls).toEqual(["prepare", "approve"])
    dispatchCommand("astra.extensions.mcp.prepare")
    const mcpPreview = await app.waitForFrame((value) => value.includes("MCP ACTIVATION • AWAITING_DECISION"))
    expect(mcpPreview).toContain("NETWORK EGRESS — EXACT DESTINATION")
    expect(mcpPreview).toContain("NO CREDENTIALS • NO WORKSPACE ROOT • INSTRUCTIONS WITHHELD")
    expect(mcpPreview).toContain("CATALOG ONLY • INVOCATION FORBIDDEN")
    dispatchCommand("astra.extensions.mcp.approve")
    const activeMcp = await app.waitForFrame((value) => value.includes("1 tools observed • S stop"))
    expect(activeMcp).toContain("MCP ACTIVATION • ACTIVE • NOT VERIFIED")
    dispatchCommand("astra.extensions.mcp.stop")
    const stoppedMcp = await app.waitForFrame((value) => value.includes("COMPLETED_OBSERVED_NOT_VERIFIED"))
    expect(stoppedMcp).toContain("1 tools")
    expect(mcpCalls).toEqual(["prepare", "approve", "stop"])
    dispatchCommand("astra.extensions.inventory")
    const nextPreview = await app.waitForFrame((value) => value.includes("AWAITING A/D"))
    expect(nextPreview).not.toContain("Plugin candidate abcdef12")
    dispatchCommand("astra.extensions.approve")
    const uncertain = await app.waitForFrame((value) => value.includes("A check status"))
    expect(uncertain).toContain("effect_in_progress_or_unknown")
    dispatchCommand("astra.extensions.close")
    expect(current.name).toBe("astra-extensions")
  } finally {
    app.renderer.destroy()
  }
})

const calls: string[] = []
let decisions = 0
const proposalID = "10000000-0000-4000-8000-000000000001"
const inventoryClient = {
  async prepare() {
    calls.push("prepare")
    return {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000001",
      status: "prepared",
      preview: {
        schemaVersion: 1,
        proposalID,
        expiresAt: "2026-07-18T12:05:00.000Z",
        capabilityDigest: `sha256:${"a".repeat(64)}` as const,
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
        helper: { kind: "astra_native_static_inventory", execution: "private_verified_snapshot_after_claim" },
        resourceClasses: ["workspace_extension_config_read"],
        allowlist: ["opencode.json"],
        verification: "not_verified",
      },
    } as const
  },
  async decide(id, decision) {
    expect(id).toBe(proposalID)
    calls.push(decision)
    decisions++
    if (decisions > 1) {
      return {
        schemaVersion: 1,
        requestId: "30000000-0000-4000-8000-000000000002",
        proposalID,
        status: "reconciliation_required",
        reason: "effect_in_progress_or_unknown",
      } as const
    }
    return {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000001",
      proposalID,
      status: "completed_observed_not_verified",
      receiptID: "40000000-0000-4000-8000-000000000001",
      candidates: [
        {
          candidateID: contentDigest("b"),
          kind: "plugin",
          displayName: "Plugin candidate abcdef12",
          source: "config",
          sourcePath: "opencode.json",
          referenceClass: "package",
          referenceDigest: contentDigest("c"),
          state: "inactive",
          verification: "not_verified",
        },
        {
          candidateID: contentDigest("d"),
          kind: "mcp",
          displayName: "MCP candidate deadbeef",
          source: "config",
          sourcePath: "opencode.json",
          referenceClass: "remote",
          referenceDigest: contentDigest("e"),
          state: "inactive",
          verification: "not_verified",
        },
      ],
      verification: "not_verified",
    } as const
  },
  dispose() {},
} satisfies AstraExtensionInventoryClient

const mcpCalls: string[] = []
let completeMcp: ((result: Awaited<ReturnType<AstraMcpActivationClient["decide"]>>) => void) | undefined
const mcpProposalID = "50000000-0000-4000-8000-000000000001"
const mcpClient = {
  async prepare(candidateID) {
    mcpCalls.push("prepare")
    expect(candidateID).toBe(contentDigest("d"))
    return {
      schemaVersion: 1,
      requestId: "60000000-0000-4000-8000-000000000001",
      status: "prepared",
      preview: {
        schemaVersion: 1,
        proposalID: mcpProposalID,
        candidateID: plainDigest("d"),
        displayName: "MCP candidate deadbeef",
        sourcePath: "opencode.json",
        transport: "streamable_http",
        destination: "public_https_withheld",
        leaseExpiresAt: "2026-07-18T12:15:00.000Z",
        capabilityDigest: plainDigest("f"),
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
        networkLabel: "NETWORK EGRESS — EXACT DESTINATION",
        requestBudget: ["initialize", "notifications/initialized", "tools/list"],
        credentials: "none",
        workspaceRootShared: "none",
        redirects: "forbidden",
        retries: "none",
        reconnect: "none",
        instructions: "withheld",
        toolInvocation: "forbidden",
        verification: "not_verified",
      },
    } as const
  },
  decide(proposalID, decision, onProgress) {
    mcpCalls.push(decision)
    expect(proposalID).toBe(mcpProposalID)
    onProgress?.({ schemaVersion: 1, requestId: "70000000-0000-4000-8000-000000000001", proposalID, operationID: proposalID, status: "active", catalogCount: 1, leaseExpiresAt: "2026-07-18T12:15:00.000Z", verification: "not_verified" })
    return new Promise((complete) => { completeMcp = complete })
  },
  async stop(proposalID) {
    mcpCalls.push("stop")
    completeMcp?.({ schemaVersion: 1, requestId: "80000000-0000-4000-8000-000000000001", proposalID, operationID: proposalID, status: "completed_observed_not_verified", receiptID: "90000000-0000-4000-8000-000000000001", catalogCount: 1, verification: "not_verified" })
    return { schemaVersion: 1, requestId: "a0000000-0000-4000-8000-000000000001", proposalID, status: "stop_requested" } as const
  },
  dispose() {},
} satisfies AstraMcpActivationClient

function contentDigest(character: string) {
  const parsed = parseContentDigest(`sha256:${character.repeat(64)}`)
  if (!parsed.ok) throw new Error("Invalid digest fixture")
  return parsed.value
}

function plainDigest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
}

const authority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-17T12:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/Users/example/Documents/astra-project",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"a".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority
