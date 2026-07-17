/** @jsxImportSource @opentui/solid */

import type { ProviderTurnPreview } from "@astra/domain/provider-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount, type JSX } from "solid-js"
import type { AstraProviderClient } from "../../../src/astra/provider-client"
import { registerAstraChat } from "../../../src/feature-plugins/system/astra-chat"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("renders skill metadata only and rejects a prepared proposal before reset or close", async () => {
  const decisions: Array<Readonly<{ decision: string; finish: () => void }>> = []
  let catalogCalls = 0
  const client = {
    catalog() {
      catalogCalls += 1
      return Promise.resolve(catalogResult)
    },
    prepare() {
      return Promise.resolve({ schemaVersion: 1, requestId, status: "prepared", preview } as const)
    },
    decide(_proposalID, decision) {
      return new Promise((resolve) => {
        decisions.push({
          decision,
          finish: () =>
            resolve({
              schemaVersion: 1,
              requestId,
              proposalID,
              operationID,
              status: "denied_without_effect",
              receiptID: null,
            }),
        })
      })
    },
    dispose() {},
  } satisfies AstraProviderClient
  const app = await renderSurface(client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
    await prepareThroughDialog(app)
    const prepared = await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    expect(prepared).toContain("safe-skill")
    expect(prepared).toContain("UNTRUSTED INSTRUCTION DATA")
    expect(prepared).toContain("INCLUDED IN PROVIDER REQUEST")
    expect(prepared).not.toContain(privateInstructions)

    app.dispatch("astra.chat.reset")
    await waitUntil(() => decisions.length === 1)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toBe("reject")
    expect(catalogCalls).toBe(1)
    decisions[0]!.finish()
    await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
    expect(catalogCalls).toBe(2)

    await prepareThroughDialog(app)
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.chat.close")
    await waitUntil(() => decisions.length === 2)
    expect(decisions).toHaveLength(2)
    expect(decisions[1]!.decision).toBe("reject")
    expect(app.current().name).toBe("astra-chat")
    decisions[1]!.finish()
    await waitUntil(() => app.current().name === "session")
  } finally {
    app.render.renderer.destroy()
  }
})

async function prepareThroughDialog(app: Awaited<ReturnType<typeof renderSurface>>) {
  app.dispatch("astra.chat.compose")
}

function TestDialogPrompt(props: { onConfirm?: (value: string) => void }) {
  onMount(() => props.onConfirm?.("Use the activated skill"))
  return null
}

async function renderSurface(client: AstraProviderClient) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }
  let route: TuiRouteDefinition | undefined
  let dispatch!: (command: string) => void
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({ keymap })
    const [dialog, setDialog] = createSignal<JSX.Element>()
    const dialogApi = {
      ...base.ui.dialog,
      replace(render: () => JSX.Element) {
        setDialog(render())
      },
      clear() {
        setDialog(undefined)
      },
      open: false,
    }
    const api = {
      ...base,
      ui: { ...base.ui, dialog: dialogApi, DialogPrompt: TestDialogPrompt },
      route: {
        register(routes) {
          route = routes.find((candidate) => candidate.name === "astra-chat") ?? route
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
    registerAstraChat(api, authority, client)
    void keymap.dispatchCommand("astra.chat.open")
    dispatch = (command: string) => void keymap.dispatchCommand(command)
    return (
      <TestTuiContexts directory={authority.workspace.root}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
            {route?.render({ params: "params" in current ? current.params : undefined })}
            {dialog()}
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const render = await testRender(() => <Harness />, { width: 110, height: 28 })
  return { render, dispatch: (command: string) => dispatch(command), current: () => current }
}

async function waitUntil(condition: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for TUI state")
}

const requestId = "10000000-0000-4000-8000-000000000001"
const proposalID = "20000000-0000-4000-8000-000000000002"
const operationID = "30000000-0000-4000-8000-000000000003"
const modelID = "claude-sonnet-4-5-20250929"
const privateInstructions = "PRIVATE RAW INSTRUCTIONS MUST NOT RENDER"
const digest = `sha256:${"a".repeat(64)}` as const
const catalogResult = {
  schemaVersion: 1,
  requestId,
  status: "available",
  catalog: {
    providerID: "anthropic",
    providerName: "Anthropic",
    models: [{ id: modelID, name: "Claude Sonnet", limits: { context: 200_000, output: 8_192 } }],
  },
} as const
const preview = {
  proposalID,
  operationID,
  providerID: "anthropic",
  modelID,
  destination: { method: "POST", origin: "https://api.anthropic.com", path: "/v1/messages" },
  logicalPayload: { digest, bytes: 256, contextBindingDigest: digest },
  providerCapabilityDigest: digest,
  skillContext: {
    kind: "activated_skill",
    activationOperationID: "40000000-0000-4000-8000-000000000004",
    activationCapabilityDigest: digest,
    name: "safe-skill",
    provenance: "workspace_opencode",
    instructionsDigest: digest,
    trust: "UNTRUSTED INSTRUCTION DATA",
    resourceDiscovery: "none",
    assurance: "OBSERVED NOT VERIFIED",
    disclosure: "included_in_provider_request",
  },
  headerNames: ["anthropic-version", "content-type", "x-api-key"],
  credential: { accountFingerprint: digest, headerName: "x-api-key" },
  expiresAt: "2026-07-18T20:00:00.000Z",
  hostBoundaryLabel: "HOST EXECUTION — NO SANDBOX",
  networkBoundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
  assurance: "NOT VERIFIED",
} as const satisfies ProviderTurnPreview
const authority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-18T18:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/tmp/astra-chat-ui",
    identity: { device: "1", inode: "2" },
    securityDigest: digest,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority
