/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AstraSkillActivationClient } from "../../../src/astra/skill-activation-client"
import { registerAstraSkillActivation } from "../../../src/feature-plugins/system/astra-skill-activation"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("keeps skills dormant until inspect and shows exact preview through observed not verified", async () => {
  let inventoryCalls = 0
  let prepareCalls = 0
  let decideCalls = 0
  let acceptInventory!: () => void
  let finishInventory!: () => void
  let finishPrepare!: () => void
  let acceptDecision!: () => void
  let emitProgress!: (status: "recording_authority" | "submitting_approval" | "effect_observed_not_verified") => void
  let finishDecision!: () => void
  const client = {
    inventory(options) {
      inventoryCalls++
      acceptInventory = () => options?.onAccepted?.(requestId)
      return new Promise((resolve) => (finishInventory = () => resolve(inventoryResult)))
    },
    prepare(id, candidate, options) {
      prepareCalls++
      expect(id).toBe(inventoryID)
      expect(candidate).toBe(digest)
      options?.onAccepted?.(requestId)
      return new Promise((resolve) => (finishPrepare = () => resolve(preparedResult)))
    },
    decide(id, decision, options) {
      decideCalls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("approve")
      acceptDecision = () => options?.onAccepted?.(requestId)
      emitProgress = (status) => options?.onProgress?.({ schemaVersion: 1, requestId, proposalID, operationID, status, verification: "not_verified" })
      return new Promise((resolve) => (finishDecision = () => resolve(completedResult)))
    },
    dispose() {},
  } satisfies AstraSkillActivationClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const initial = await app.render.waitForFrame((frame) => frame.includes("IDLE · NO SKILL READ"))
    expect(initial).toContain("WORKSPACE SKILL DATA IS UNTRUSTED")
    expect(inventoryCalls).toBe(0)
    expect(prepareCalls).toBe(0)
    expect(decideCalls).toBe(0)

    app.dispatch("astra.skill.inventory")
    expect(inventoryCalls).toBe(1)
    await app.render.waitForFrame((frame) => frame.includes("INVENTORY QUEUED · NO READ YET"))
    acceptInventory()
    await app.render.waitForFrame((frame) => frame.includes("INVENTORY ACTIVE · METADATA UNTRUSTED"))
    finishInventory()
    const inventory = await app.render.waitForFrame((frame) => frame.includes("1 SKILL(S) · NOT VERIFIED"))
    expect(inventory).toContain("UNTRUSTED WORKSPACE METADATA")
    expect(inventory).toContain(".opencode/skills/safe-skill/SKILL.md")

    app.dispatch("astra.skill.prepare")
    expect(prepareCalls).toBe(1)
    finishPrepare()
    const preview = await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION · NOT VERIFIED"))
    expect(preview).toContain("PRIVATE BUNDLE ONLY · NO TOOLS · NO PLUGINS · NO MCP")
    expect(preview).toContain("OBSERVED · NOT VERIFIED")
    expect(decideCalls).toBe(0)

    app.dispatch("astra.skill.approve")
    expect(decideCalls).toBe(1)
    acceptDecision()
    await app.render.waitForFrame((frame) => frame.includes("DECISION AUTHENTICATED · NOT VERIFIED"))
    emitProgress("recording_authority")
    await app.render.waitForFrame((frame) => frame.includes("RECORDING AUTHORITY · NOT VERIFIED"))
    emitProgress("submitting_approval")
    await app.render.waitForFrame((frame) => frame.includes("SUBMITTING APPROVAL · EFFECT NOT YET OBSERVED"))
    emitProgress("effect_observed_not_verified")
    await app.render.waitForFrame((frame) => frame.includes("SKILL CONTENT OBSERVED · NOT VERIFIED"))
    finishDecision()
    const terminal = await app.render.waitForFrame((frame) => frame.includes("COMPLETED · OBSERVED · NOT VERIFIED"))
    expect(terminal).not.toContain("VERIFIED SUCCESS")
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks inventory locally in read-only mode", async () => {
  let calls = 0
  const client = {
    inventory() { calls++; return Promise.resolve(inventoryResult) },
    prepare() { calls++; return Promise.resolve(preparedResult) },
    decide() { calls++; return Promise.resolve(completedResult) },
    dispose() {},
  } satisfies AstraSkillActivationClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only" }, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE · NO SKILL READ"))
    app.dispatch("astra.skill.inventory")
    const frame = await app.render.waitForFrame((value) => value.includes("BLOCKED · NO ACTIVATION CLAIMED"))
    expect(frame).toContain("read only")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("shows reconciliation when approval transport disconnects", async () => {
  let fail!: (error: Error) => void
  const client = {
    inventory() { return Promise.resolve(inventoryResult) },
    prepare() { return Promise.resolve(preparedResult) },
    decide(_proposalID, _decision, options) {
      options?.onAccepted?.(requestId)
      return new Promise<never>((_resolve, reject) => (fail = reject))
    },
    dispose() {},
  } satisfies AstraSkillActivationClient
  const app = await renderSurface(activeAuthority, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE · NO SKILL READ"))
    app.dispatch("astra.skill.inventory")
    await app.render.waitForFrame((frame) => frame.includes("1 SKILL(S) · NOT VERIFIED"))
    app.dispatch("astra.skill.prepare")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION · NOT VERIFIED"))
    app.dispatch("astra.skill.approve")
    await app.render.waitForFrame((frame) => frame.includes("DECISION AUTHENTICATED · NOT VERIFIED"))
    fail(new Error("connection lost after acceptance"))
    await app.render.waitForFrame((frame) => frame.includes("RECONCILIATION REQUIRED · EFFECT UNKNOWN"))
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks terminal control characters again at render time", async () => {
  const client = {
    inventory() {
      return Promise.resolve({
        ...inventoryResult,
        candidates: [{ ...candidate, relativePath: ".opencode/skills/spoof\n\u001b[2J/SKILL.md" }],
      })
    },
    prepare() { return Promise.resolve(preparedResult) },
    decide() { return Promise.resolve(completedResult) },
    dispose() {},
  } satisfies AstraSkillActivationClient
  const app = await renderSurface(activeAuthority, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE · NO SKILL READ"))
    app.dispatch("astra.skill.inventory")
    const frame = await app.render.waitForFrame((value) => value.includes("[unsafe text blocked]"))
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("spoof\n")
  } finally {
    app.render.renderer.destroy()
  }
})

async function renderSurface(authority: AstraSessionAuthority, client: AstraSkillActivationClient) {
  const commands = new Map<string, NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]>()
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
    const api = {
      ...base,
      route: {
        register(routes) { route = routes.find((candidate) => candidate.name === "astra-skill-activation") ?? route; return () => {} },
        navigate(name, params) { current = params ? { name, params } : { name } },
        get current() { return current },
      },
    } satisfies TuiPluginApi
    registerAstraSkillActivation(api, authority, client)
    expect(commands.get("astra.skill.open")?.slashName).toBe("skills")
    void keymap.dispatchCommand("astra.skill.open")
    dispatch = (command) => void keymap.dispatchCommand(command)
    return <TestTuiContexts directory={authority.workspace.root}><OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={createTuiResolvedConfig()}>{route?.render({ params: "params" in current ? current.params : undefined })}</TuiConfigProvider></OpencodeKeymapProvider></TestTuiContexts>
  }
  const render = await testRender(() => <Harness />, { width: 100, height: 20 })
  return { render, dispatch: (command: string) => dispatch(command) }
}

const requestId = "10000000-0000-4000-8000-000000000001"
const inventoryID = "20000000-0000-4000-8000-000000000002"
const proposalID = "30000000-0000-4000-8000-000000000003"
const operationID = "40000000-0000-4000-8000-000000000004"
const receiptID = "50000000-0000-4000-8000-000000000005"
const digest = `sha256:${"b".repeat(64)}` as const
const candidate = { candidateID: digest, name: "safe-skill", description: "Untrusted", metadataTrust: "UNTRUSTED WORKSPACE METADATA", provenance: "workspace_opencode", relativePath: ".opencode/skills/safe-skill/SKILL.md", fileDigest: digest, fileBytes: 128, instructionsDigest: digest, instructionsBytes: 64 } as const
const inventoryResult = { schemaVersion: 1, requestId, status: "complete", inventoryID, candidates: [candidate], verification: "not_verified" } as const
const preparedResult = { schemaVersion: 1, requestId, status: "prepared", preview: { operationID, proposalID, expiresAt: "2026-07-17T18:00:00.000Z", boundaryLabel: "HOST EXECUTION — NO SANDBOX", capabilityDigest: digest, skill: { ...candidate, provenance: "workspace_opencode", trust: "UNTRUSTED INSTRUCTION DATA" }, effects: { workspaceRead: candidate.relativePath, workspaceWrite: "none", runtimeWrite: "private_session_skill_bundle", process: "none", network: "none", plugins: "none", mcp: "none", tools: "none" }, verification: "not_verified" } } as const
const completedResult = { schemaVersion: 1, requestId, proposalID, operationID, status: "completed_observed_not_verified", receiptID, verification: "not_verified" } as const
const activeAuthority = { schemaVersion: 1, sessionID: "00000000-0000-4000-8000-000000000001", issuedAt: "2026-07-17T16:00:00.000Z", mode: "activate-once", effectPolicy: "deny", workspace: { root: "/tmp/astra-skill-ui", identity: { device: "1", inode: "2" }, securityDigest: `sha256:${"a".repeat(64)}` }, repositoryBaseline: null } as const satisfies AstraSessionAuthority
