/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AstraGitStageClient } from "../../../src/astra/git-stage-client"
import { registerAstraGitStage } from "../../../src/feature-plugins/system/astra-git-stage"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import {
  inventoryID,
  inventoryResult,
  preparedResult,
  proposalID,
  stagePreview,
  trackedCandidateID,
  verifiedResult,
} from "../../astra/git-stage-fixture"
import { activeAuthority } from "../../astra/git-unstage-fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("selects by opaque candidate ID and renders exact parent-authorized resources", async () => {
  const calls: Array<Readonly<{ inventoryID: string; candidateIDs: ReadonlyArray<string> }>> = []
  let decisions = 0
  const client = {
    inventory: () => Promise.resolve(inventoryResult()),
    prepare(id, candidateIDs) {
      calls.push({ inventoryID: id, candidateIDs })
      return Promise.resolve(preparedResult())
    },
    decide(id, decision) {
      decisions++
      expect(id).toBe(proposalID)
      expect(decision).toBe("approve")
      return Promise.resolve(verifiedResult())
    },
    dispose() {},
  } satisfies AstraGitStageClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const initial = await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    expect(initial).toContain("HOST EXECUTION — NO SANDBOX")
    expect(initial).toContain("Stage selected")
    expect(app.command("astra.git.stage.open")?.slashName).toBe("git-stage")

    app.dispatch("astra.git.stage.inventory")
    const inventory = await app.render.waitForFrame((frame) => frame.includes("SELECT CANDIDATES • NO EFFECT"))
    expect(inventory).toContain("new.ts")
    expect(inventory).toContain("tracked.ts")
    expect(inventory).toContain(trackedCandidateID)
    expect(calls).toHaveLength(0)

    app.pressArrow("down")
    app.pressLocal(" ")
    await app.render.waitForFrame((frame) => frame.includes("SELECTED     1/2"))
    app.pressLocal("p")
    const preview = await app.render.waitForFrame((frame) => frame.includes("AWAITING APPROVE OR REJECT"))
    expect(calls).toEqual([{ inventoryID, candidateIDs: [trackedCandidateID] }])
    expect(preview).toContain("tracked.ts")
    expect(preview).toContain(".git/index")
    expect(preview).toContain(".git/index.lock")
    expect(preview).toContain(".git/objects/22/")
    expect(preview).toContain("NOT VERIFIED")
    expect(decisions).toBe(0)

    expect(app.hasCommand("astra.git.stage.approve")).toBeFalse()
    app.dispatch("astra.git.stage.approve")
    expect(decisions).toBe(0)
    app.pressLocal("a")
    const terminal = await app.render.waitForFrame((frame) =>
      frame.includes("VERIFIED • SELECTED INDEX + PRESERVATION"),
    )
    expect(terminal).toContain("INDEPENDENT SELECTED INDEX + PRESERVATION")
    expect(decisions).toBe(1)
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks read-only locally and blocked terminals never assume an operation ID", async () => {
  let calls = 0
  const client = {
    inventory() {
      calls++
      return Promise.resolve(inventoryResult())
    },
    prepare() {
      calls++
      return Promise.resolve(preparedResult())
    },
    decide() {
      calls++
      return Promise.resolve(verifiedResult())
    },
    dispose() {},
  } satisfies AstraGitStageClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only", repositoryBaseline: null }, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.stage.inventory")
    const blocked = await app.render.waitForFrame((frame) => frame.includes("BLOCKED • NO EFFECT CLAIMED"))
    expect(blocked).toContain("read only")
    expect(blocked).not.toContain("\n OPERATION   ")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("escapes control characters in the workspace root before rendering", async () => {
  const client = {
    inventory: () => Promise.resolve(inventoryResult()),
    prepare: () => Promise.resolve(preparedResult()),
    decide: () => Promise.resolve(verifiedResult()),
    dispose() {},
  } satisfies AstraGitStageClient
  const authority = {
    ...activeAuthority,
    workspace: { ...activeAuthority.workspace, root: "/tmp/project\nSTATE VERIFIED\u001b[31m" },
  } satisfies AstraSessionAuthority
  const app = await renderSurface(authority, client)
  try {
    const frame = await app.render.waitForFrame((value) => value.includes("IDLE • NO REQUEST • NO EFFECT"))
    expect(frame).toContain("\\u{a}")
    expect(frame).toContain("\\u{1b}")
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("project\nSTATE VERIFIED")
  } finally {
    app.render.renderer.destroy()
  }
})

test("requires a local reject gesture and reports no Git effect", async () => {
  let decisionCalls = 0
  const client = {
    inventory: () => Promise.resolve(inventoryResult()),
    prepare: () => Promise.resolve(preparedResult()),
    decide(id, decision) {
      decisionCalls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("reject")
      return Promise.resolve({
        schemaVersion: 1,
        requestId: "b0000000-0000-4000-8000-00000000000b",
        proposalID,
        proposalDigest: stagePreview.proposalDigest,
        status: "denied_without_git_effect",
        operationID: "60000000-0000-4000-8000-000000000006",
      } as const)
    },
    dispose() {},
  } satisfies AstraGitStageClient
  const app = await renderSurface(activeAuthority, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.stage.inventory")
    await app.render.waitForFrame((frame) => frame.includes("SELECT CANDIDATES • NO EFFECT"))
    app.pressLocal(" ")
    await app.render.waitForFrame((frame) => frame.includes("SELECTED     1/2"))
    app.pressLocal("p")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING APPROVE OR REJECT"))
    app.dispatch("astra.git.stage.reject")
    expect(decisionCalls).toBe(0)
    app.pressLocal("d")
    const denied = await app.render.waitForFrame((frame) => frame.includes("DENIED • NO GIT EFFECT"))
    expect(denied).not.toContain("VERIFIED")
    expect(decisionCalls).toBe(1)
  } finally {
    app.render.renderer.destroy()
  }
})

test("escape from a prepared proposal durably rejects before leaving", async () => {
  let resolveDenial!: (value: ReturnType<typeof deniedResult>) => void
  const denial = new Promise<ReturnType<typeof deniedResult>>((resolve) => {
    resolveDenial = resolve
  })
  const calls: string[] = []
  const client = {
    inventory: () => Promise.resolve(inventoryResult()),
    prepare: () => Promise.resolve(preparedResult()),
    decide(id, decision) {
      calls.push(`${id}:${decision}`)
      return denial
    },
    dispose() {},
  } satisfies AstraGitStageClient
  const app = await renderSurface(activeAuthority, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.stage.inventory")
    await app.render.waitForFrame((frame) => frame.includes("SELECT CANDIDATES • NO EFFECT"))
    app.pressLocal(" ")
    app.pressLocal("p")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING APPROVE OR REJECT"))
    app.dispatch("astra.git.stage.close")
    await app.render.waitForFrame((frame) => frame.includes("DECISION QUEUED • NOT VERIFIED"))
    expect(app.route().name).toBe("astra-git-stage")
    expect(calls).toEqual([`${proposalID}:reject`])
    resolveDenial(deniedResult())
    await waitUntil(() => app.route().name === "session")
  } finally {
    app.render.renderer.destroy()
  }
})

function deniedResult() {
  return {
    schemaVersion: 1,
    requestId: "b0000000-0000-4000-8000-00000000000b",
    proposalID,
    proposalDigest: stagePreview.proposalDigest,
    status: "denied_without_git_effect",
    operationID: "60000000-0000-4000-8000-000000000006",
  } as const
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for the route transition")
}

async function renderSurface(authority: AstraSessionAuthority, client: AstraGitStageClient) {
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
    const api = {
      ...base,
      route: {
        register(routes) {
          route = routes.find((candidate) => candidate.name === "astra-git-stage") ?? route
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
    registerAstraGitStage(api, authority, client)
    void keymap.dispatchCommand("astra.git.stage.open")
    dispatch = (command: string) => void keymap.dispatchCommand(command)
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

  const render = await testRender(() => <Harness />, { width: 120, height: 32 })
  return {
    render,
    dispatch: (command: string) => dispatch(command),
    pressLocal: (key: string) => render.mockInput.pressKey(key),
    pressArrow: (direction: "up" | "down") => render.mockInput.pressArrow(direction),
    hasCommand: (command: string) => commands.has(command),
    command: (command: string) => commands.get(command),
    route: () => current,
  }
}
