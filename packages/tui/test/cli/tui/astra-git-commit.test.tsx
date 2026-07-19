/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount, type JSX } from "solid-js"
import type { AstraGitCommitClient } from "../../../src/astra/git-commit-client"
import { registerAstraGitCommit } from "../../../src/feature-plugins/system/astra-git-commit"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import {
  commitMessage,
  commitOID,
  deniedResult,
  preparedResult,
  proposalID,
  verifiedResult,
} from "../../astra/git-commit-fixture"
import { activeAuthority } from "../../astra/git-unstage-fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("composes one exact message and renders parent-authorized repository writes before approval", async () => {
  const prepares: string[] = []
  let decisions = 0
  const client = {
    prepare(message) {
      prepares.push(message)
      return Promise.resolve(preparedResult())
    },
    decide(id, decision) {
      decisions++
      expect(id).toBe(proposalID)
      expect(decision).toBe("approve")
      return Promise.resolve(verifiedResult())
    },
    dispose() {},
  } satisfies AstraGitCommitClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const initial = await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    expect(initial).toContain("HOST EXECUTION — NO SANDBOX")
    expect(initial).toContain("Commit staged")
    expect(app.command("astra.git.commit.open")?.slashName).toBe("git-commit")
    expect(prepares).toHaveLength(0)

    app.dispatch("astra.git.commit.compose")
    const preview = await app.render.waitForFrame((frame) => frame.includes("AWAITING APPROVE OR REJECT"))
    expect(prepares).toEqual([commitMessage])
    expect(preview).toContain(commitMessage)
    expect(preview).toContain(".git/refs/heads/main")
    expect(preview).toContain(".git/refs/heads/main.lock")
    expect(preview).toContain(".git/objects/22/")
    expect(preview).toContain("NOT VERIFIED")
    expect(decisions).toBe(0)

    expect(app.hasCommand("astra.git.commit.approve")).toBeFalse()
    app.dispatch("astra.git.commit.approve")
    expect(decisions).toBe(0)
    app.pressLocal("a")
    const terminal = await app.render.waitForFrame((frame) =>
      frame.includes("VERIFIED • COMMIT BYTES + REPOSITORY STATE"),
    )
    expect(terminal).toContain("INDEPENDENT COMMIT BYTES + REPOSITORY STATE")
    expect(terminal).toContain(commitOID)
    expect(decisions).toBe(1)
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks read-only locally without contacting the parent control", async () => {
  let calls = 0
  const client = {
    prepare() {
      calls++
      return Promise.resolve(preparedResult())
    },
    decide() {
      calls++
      return Promise.resolve(verifiedResult())
    },
    dispose() {},
  } satisfies AstraGitCommitClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only", repositoryBaseline: null }, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.commit.compose")
    const blocked = await app.render.waitForFrame((frame) => frame.includes("BLOCKED • NO EFFECT CLAIMED"))
    expect(blocked).toContain("read only")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("requires a local reject gesture and reports no Git effect", async () => {
  let decisionCalls = 0
  const client = {
    prepare: (message) => {
      expect(message).toBe(commitMessage)
      return Promise.resolve(preparedResult())
    },
    decide(id, decision) {
      decisionCalls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("reject")
      return Promise.resolve(deniedResult())
    },
    dispose() {},
  } satisfies AstraGitCommitClient
  const app = await renderSurface(activeAuthority, client)
  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.commit.compose")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING APPROVE OR REJECT"))
    app.dispatch("astra.git.commit.reject")
    expect(decisionCalls).toBe(0)
    app.pressLocal("d")
    const denied = await app.render.waitForFrame((frame) => frame.includes("DENIED • NO GIT EFFECT"))
    expect(denied).not.toContain("VERIFIED •")
    expect(decisionCalls).toBe(1)
  } finally {
    app.render.renderer.destroy()
  }
})

function TestDialogPrompt(props: { onConfirm?: (value: string) => void }) {
  onMount(() => props.onConfirm?.(commitMessage))
  return null
}

async function renderSurface(authority: AstraSessionAuthority, client: AstraGitCommitClient) {
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
          route = routes.find((candidate) => candidate.name === "astra-git-commit") ?? route
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
    registerAstraGitCommit(api, authority, client)
    void keymap.dispatchCommand("astra.git.commit.open")
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

  const render = await testRender(() => <Harness />, { width: 120, height: 40 })
  return {
    render,
    dispatch: (command: string) => dispatch(command),
    pressLocal: (key: string) => render.mockInput.pressKey(key),
    hasCommand: (command: string) => commands.has(command),
    command: (command: string) => commands.get(command),
  }
}
