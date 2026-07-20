/** @jsxImportSource @opentui/solid */

import type { ProviderTurnPreview } from "@astra/domain/provider-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type {
  TuiDialogSelectProps,
  TuiPluginApi,
  TuiRouteCurrent,
  TuiRouteDefinition,
} from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount, type JSX } from "solid-js"
import type { AstraProviderClient } from "../../../src/astra/provider-client"
import {
  providerSelectionChoices,
  registerAstraChat,
} from "../../../src/feature-plugins/system/astra-chat"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("offers explicit certified OpenAI API-key and Codex OAuth credential choices", () => {
  const choices = providerSelectionChoices(catalogResult.catalog)

  expect(choices.map((choice) => choice.title)).toEqual([
    "Anthropic · API key",
    "OpenAI · API key",
    "OpenAI · Codex account",
  ])
  expect(choices.map((choice) => choice.selection)).toEqual([
    {
      providerID: "anthropic",
      credentialProfile: "anthropic-api-key",
      modelID,
    },
    {
      providerID: "openai",
      credentialProfile: "openai-api-key",
      modelID: "gpt-5.2-codex",
    },
    {
      providerID: "openai",
      credentialProfile: "openai-codex-oauth",
      modelID: "gpt-5.2-codex",
    },
  ])
  expect(choices.map((choice) => choice.value)).toEqual([
    "anthropic:anthropic-api-key",
    "openai:openai-api-key",
    "openai:openai-codex-oauth",
  ])
  expect(choices.every((choice) => choice.description.includes("CERTIFIED"))).toBeTrue()
})

test("applies the exact OpenAI credential profile selected through the provider dialog", async () => {
  for (const credentialProfile of ["openai-api-key", "openai-codex-oauth"] as const) {
    let selected = false
    let preparedSelection: Parameters<AstraProviderClient["prepare"]>[0] | undefined
    const client = {
      catalog: () => Promise.resolve(catalogResult),
      prepare(selection) {
        preparedSelection = selection
        return Promise.resolve({
          schemaVersion: 1,
          requestId,
          status: "blocked",
          reason: "credential_unavailable",
        } as const)
      },
      decide: () => Promise.reject(new Error("No proposal must be decided")),
      dispose() {},
    } satisfies AstraProviderClient
    const app = await renderSurface(client, {
      selectDialogValue: `openai:${credentialProfile}`,
      onDialogSelection: () => {
        selected = true
      },
    })

    try {
      await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
      app.dispatch("astra.chat.provider")
      await waitUntil(() => selected)
      app.dispatch("astra.chat.compose")
      await waitUntil(() => preparedSelection !== undefined)
      expect(preparedSelection).toEqual({
        providerID: "openai",
        credentialProfile,
        modelID: "gpt-5.2-codex",
      })
    } finally {
      app.render.renderer.destroy()
    }
  }
})

test("renders skill metadata only and rejects a prepared proposal before reset or close", async () => {
  const decisions: Array<Readonly<{ decision: string; finish: () => void }>> = []
  let catalogCalls = 0
  const client = {
    catalog() {
      catalogCalls += 1
      return Promise.resolve(catalogResult)
    },
    prepare() {
      return Promise.resolve({
        schemaVersion: 1,
        requestId,
        status: "prepared",
        preview,
      } as const)
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

test("explains safe credential setup without rendering a secret", async () => {
  const secret = "sk-ant-must-never-render"
  const client = {
    catalog: () => Promise.resolve(catalogResult),
    prepare: () =>
      Promise.resolve({
        schemaVersion: 1,
        requestId,
        status: "blocked",
        reason: "credential_unavailable",
      } as const),
    decide: () => Promise.reject(new Error("No proposal must be decided")),
    dispose() {},
  } satisfies AstraProviderClient
  const app = await renderSurface(client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
    await prepareThroughDialog(app)
    const blocked = await app.render.waitForFrame((frame) => frame.includes("credential unavailable"))
    expect(blocked).toContain("Run /connect to configure Anthropic through Astra.")
    expect(blocked).toContain("Astra reconnects this workspace automatically.")
    expect(blocked).toContain("Never exposed to chat, the AI, plugins, or MCP.")
    expect(blocked).not.toContain(secret)
  } finally {
    app.render.renderer.destroy()
  }
})

test("keeps the consented conversation transcript across turns and across a catalog reload", async () => {
  let decisions = 0
  const client = {
    catalog: () => Promise.resolve(catalogResult),
    prepare: () =>
      Promise.resolve({
        schemaVersion: 1,
        requestId,
        status: "prepared",
        preview,
      } as const),
    decide: () => {
      decisions += 1
      const assistantText = decisions === 1 ? "First observed answer" : "Second observed answer"
      return Promise.resolve({
        schemaVersion: 1,
        requestId,
        proposalID,
        operationID,
        status: "response_observed_not_verified",
        receiptID: "50000000-0000-4000-8000-000000000005",
        completionLabel: "COMPLETED — RESPONSE OBSERVED — NOT VERIFIED",
        response: {
          assistantText,
          assistantTextDigest: sha256(assistantText),
          assistantTextBytes: Buffer.byteLength(assistantText),
          finishReason: "stop",
        },
      } as const)
    },
    dispose() {},
  } satisfies AstraProviderClient
  const app = await renderSurface(client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
    await prepareThroughDialog(app)
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.chat.approve")
    await app.render.waitForFrame((frame) => frame.includes("First observed answer"))

    await prepareThroughDialog(app)
    await app.render.waitForFrame(
      (frame) => frame.includes("AWAITING EXPLICIT DECISION") && frame.includes("First observed answer"),
    )
    app.dispatch("astra.chat.approve")
    const completed = await app.render.waitForFrame(
      (frame) => frame.includes("First observed answer") && frame.includes("Second observed answer"),
    )
    expect(completed).toContain("COMPLETED — RESPONSE OBSERVED — NOT VERIFIED")
    expect(completed).not.toContain("a approve d reject")
    expect(app.hasCommand("astra.chat.approve")).toBeFalse()
    expect(app.hasCommand("astra.chat.reject")).toBeFalse()

    app.dispatch("astra.chat.reset")
    const reloaded = await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
    expect(reloaded).toContain("First observed answer")
    expect(reloaded).toContain("Second observed answer")
  } finally {
    app.render.renderer.destroy()
  }
})

test("removes provider decision controls after denial", async () => {
  const client = {
    catalog: () => Promise.resolve(catalogResult),
    prepare: () => Promise.resolve({ schemaVersion: 1, requestId, status: "prepared", preview } as const),
    decide: () =>
      Promise.resolve({
        schemaVersion: 1,
        requestId,
        proposalID,
        operationID,
        status: "denied_without_effect",
        receiptID: null,
      } as const),
    dispose() {},
  } satisfies AstraProviderClient
  const app = await renderSurface(client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("READY · NO REQUEST · NO EFFECT"))
    await prepareThroughDialog(app)
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.chat.reject")
    const denied = await app.render.waitForFrame((frame) => frame.includes("DENIED · ZERO NETWORK EFFECT"))
    expect(denied).not.toContain("a approve d reject")
    expect(app.hasCommand("astra.chat.approve")).toBeFalse()
    expect(app.hasCommand("astra.chat.reject")).toBeFalse()
  } finally {
    app.render.renderer.destroy()
  }
})

test("restores the durable transcript and keeps compatible unverified providers visible but disabled", async () => {
  let prepareCalls = 0
  const restoredText = "Restored after process restart"
  const client = {
    catalog: () =>
      Promise.resolve({
        ...catalogResult,
        transcript: {
          turns: [
            {
              providerID: "openai",
              modelID: "gpt-5.2-codex",
              userText: "What did we decide?",
              assistantText: restoredText,
              finishReason: "stop",
              assurance: "observed_not_verified",
            },
          ],
          historyDigest: digest,
          totalBytes: Buffer.byteLength("What did we decide?") + Buffer.byteLength(restoredText),
          retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
        },
      }),
    prepare: () => {
      prepareCalls += 1
      return Promise.reject(new Error("No provider turn is expected"))
    },
    decide: () => Promise.reject(new Error("No proposal is expected")),
    dispose() {},
  } satisfies AstraProviderClient
  const app = await renderSurface(client)

  try {
    const frame = await app.render.waitForFrame(
      (value) => value.includes(restoredText) && value.includes("Ollama · COMPATIBLE — NOT VERIFIED · DISABLED"),
    )
    expect(frame).toContain("What did we decide?")
    expect(frame).toContain("PARENT-OWNED DURABLE HISTORY · VERIFIED ON LOAD")
    expect(prepareCalls).toBe(0)
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

async function renderSurface(
  client: AstraProviderClient,
  options: Readonly<{
    selectDialogValue?: string
    onDialogSelection?: () => void
  }> = {},
) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current: TuiRouteCurrent = {
    name: "session",
    params: { sessionID: "session-1" },
  }
  let route: TuiRouteDefinition | undefined
  let dispatch!: (command: string) => void
  let hasCommand = (_command: string) => false
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    hasCommand = (command) =>
      keymap.getCommands({ visibility: "registered", filter: { name: command } }).length > 0
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({ keymap })
    const [dialog, setDialog] = createSignal<JSX.Element>()
    function TestDialogSelect<Value>(props: TuiDialogSelectProps<Value>) {
      onMount(() => {
        if (!options.selectDialogValue) return
        const choice = props.options.find((candidate) => candidate.value === options.selectDialogValue)
        choice?.onSelect?.()
        if (choice) options.onDialogSelection?.()
      })
      return null
    }
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
      ui: {
        ...base.ui,
        dialog: dialogApi,
        DialogPrompt: TestDialogPrompt,
        ...(options.selectDialogValue ? { DialogSelect: TestDialogSelect } : {}),
      },
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
            {route?.render({
              params: "params" in current ? current.params : undefined,
            })}
            {dialog()}
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const render = await testRender(() => <Harness />, {
    width: 110,
    height: 28,
  })
  return {
    render,
    dispatch: (command: string) => dispatch(command),
    current: () => current,
    hasCommand: (command: string) => hasCommand(command),
  }
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
function sha256(value: string) {
  return `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}` as const
}
const catalogResult = {
  schemaVersion: 1,
  requestId,
  status: "available",
  catalog: {
    providers: [
      {
        providerID: "anthropic",
        providerName: "Anthropic",
        assurance: "CERTIFIED",
        dispatchable: true,
        credentialProfiles: ["anthropic-api-key"],
        models: [
          {
            id: modelID,
            name: "Claude Sonnet",
            limits: { context: 200_000, output: 8_192 },
          },
        ],
      },
      {
        providerID: "openai",
        providerName: "OpenAI",
        assurance: "CERTIFIED",
        dispatchable: true,
        credentialProfiles: ["openai-api-key", "openai-codex-oauth"],
        models: [
          {
            id: "gpt-5.2-codex",
            name: "GPT-5.2 Codex",
            limits: { context: 400_000, output: 128_000 },
          },
        ],
      },
      {
        providerID: "ollama",
        providerName: "Ollama",
        assurance: "COMPATIBLE — NOT VERIFIED",
        dispatchable: false,
        credentialProfiles: [],
        models: [
          {
            id: "local-model",
            name: "Local Model",
            limits: { context: 32_000, output: 8_000 },
          },
        ],
      },
    ],
  },
  transcript: {
    turns: [],
    historyDigest: `sha256:${"0".repeat(64)}`,
    totalBytes: 0,
    retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
  },
} as const
const preview = {
  proposalID,
  operationID,
  providerID: "anthropic",
  modelID,
  adapter: {
    adapterID: "anthropic.messages.api-key.v1",
    adapterDigest: digest,
    assurance: "CERTIFIED",
  },
  destination: {
    method: "POST",
    origin: "https://api.anthropic.com",
    path: "/v1/messages",
  },
  logicalPayload: { digest, bytes: 256, contextBindingDigest: digest },
  conversation: {
    priorTurns: 0,
    historyBytes: 0,
    historyDigest: `sha256:${"0".repeat(64)}`,
    retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
  },
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
  credential: {
    profile: "anthropic-api-key",
    accountFingerprint: digest,
    headerName: "x-api-key",
  },
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
