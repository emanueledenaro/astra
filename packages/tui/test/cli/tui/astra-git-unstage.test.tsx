/** @jsxImportSource @opentui/solid */

import type {
  GitUnstageDecisionResult,
  GitUnstagePrepareResult,
  GitUnstageProgress,
} from "@astra/domain/git-unstage-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AstraGitUnstageClient } from "../../../src/astra/git-unstage-client"
import { registerAstraGitUnstage } from "../../../src/feature-plugins/system/astra-git-unstage"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { activeAuthority, preparedResult, progress, proposalID, verifiedResult } from "../../astra/git-unstage-fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("renders exact resources and keeps observed separate from independently verified", async () => {
  let prepareCalls = 0
  let decisionCalls = 0
  let acceptPrepare!: () => void
  let finishPrepare!: (value: GitUnstagePrepareResult) => void
  let acceptDecision!: () => void
  let emitProgress!: (value: GitUnstageProgress) => void
  let finishDecision!: (value: GitUnstageDecisionResult) => void
  const client = {
    prepare(options) {
      prepareCalls++
      acceptPrepare = () => options?.onAccepted?.("00000000-0000-8000-8000-000000000001")
      return new Promise((resolve) => (finishPrepare = resolve))
    },
    decide(id, decision, options) {
      decisionCalls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("approve")
      acceptDecision = () => options?.onAccepted?.("00000000-0000-8000-8000-000000000002")
      emitProgress = (value) => options?.onProgress?.(value)
      return new Promise((resolve) => (finishDecision = resolve))
    },
    dispose() {},
  } satisfies AstraGitUnstageClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const initial = await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    expect(initial).toContain("HOST EXECUTION — NO SANDBOX")
    expect(initial).toContain("Unstage all")
    expect(prepareCalls).toBe(0)

    app.dispatch("astra.git.unstage.prepare")
    await app.render.waitForFrame((frame) => frame.includes("QUEUED • NO EFFECT"))
    acceptPrepare()
    await app.render.waitForFrame((frame) => frame.includes("PREPARING • NOT VERIFIED"))
    finishPrepare(preparedResult())
    const preview = await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    expect(preview).toContain("STAGED")
    expect(preview).toContain("2")
    expect(preview).toContain(".git/index")
    expect(preview).toContain(".git/index.lock")
    expect(preview).toContain("/private/tmp • AFTER APPROVAL")
    expect(preview).toContain("astra-git-exec-*/git")
    expect(preview).toContain("baseline revalidation")
    expect(preview).toContain("operation execution")
    expect(preview).toContain("post state observation")
    expect(preview).toContain("independent verification")
    expect(preview).toContain("created after claim cleanup required before return")
    expect(preview).toContain("not requested host unrestricted")
    expect(decisionCalls).toBe(0)

    expect(app.hasCommand("astra.git.unstage.approve")).toBeFalse()
    expect(app.hasCommand("astra.git.unstage.reject")).toBeFalse()
    app.dispatch("astra.git.unstage.approve")
    expect(decisionCalls).toBe(0)
    app.pressLocal("a")
    acceptDecision()
    await app.render.waitForFrame((frame) => frame.includes("REQUEST AUTHENTICATED • NOT VERIFIED"))
    app.dispatch("astra.git.unstage.close")
    expect(app.current().name).toBe("astra-git-unstage")
    for (const status of [
      "recording_authority",
      "host_adapter_validating",
      "effect_observed_not_verified",
      "verifying",
    ] as const) {
      emitProgress(progress(status))
      const expected =
        status === "effect_observed_not_verified"
          ? "EFFECT OBSERVED • NOT VERIFIED"
          : status === "verifying"
            ? "VERIFYING INDEPENDENT POST-STATE • NOT VERIFIED"
            : status === "host_adapter_validating"
              ? "HOST ADAPTER VALIDATING • NOT VERIFIED"
              : "RECORDING AUTHORITY • NOT VERIFIED"
      const frame = await app.render.waitForFrame((value) => value.includes(expected))
      if (status === "effect_observed_not_verified") expect(frame).not.toContain("VERIFIED • INDEPENDENT")
    }
    finishDecision(verifiedResult())
    const terminal = await app.render.waitForFrame((frame) => frame.includes("VERIFIED • INDEPENDENT GIT POST-STATE"))
    expect(terminal).toContain("EVIDENCE")
    app.dispatch("astra.git.unstage.close")
    expect(app.current().name).toBe("session")
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks read-only locally without contacting the parent", async () => {
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
  } satisfies AstraGitUnstageClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only", repositoryBaseline: null }, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.unstage.prepare")
    const blocked = await app.render.waitForFrame((frame) => frame.includes("BLOCKED • NO EFFECT CLAIMED"))
    expect(blocked).toContain("read only")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("shows reconciliation after an approved request loses its terminal", async () => {
  let accept!: () => void
  let fail!: (error: Error) => void
  const client = {
    prepare() {
      return Promise.resolve(preparedResult())
    },
    decide(_id, _decision, options) {
      accept = () => options?.onAccepted?.("00000000-0000-8000-8000-000000000002")
      return new Promise<GitUnstageDecisionResult>((_resolve, reject) => (fail = reject))
    },
    dispose() {},
  } satisfies AstraGitUnstageClient
  const app = await renderSurface(activeAuthority, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.unstage.prepare")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.pressLocal("a")
    accept()
    fail(new Error("socket lost"))
    const frame = await app.render.waitForFrame((value) => value.includes("RECONCILIATION REQUIRED • EFFECT UNKNOWN"))
    expect(frame).not.toContain("VERIFIED • INDEPENDENT")
  } finally {
    app.render.renderer.destroy()
  }
})

test("requires a local D key to record rejection without a Git effect", async () => {
  let calls = 0
  const client = {
    prepare() {
      return Promise.resolve(preparedResult())
    },
    decide(id, decision) {
      calls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("reject")
      return Promise.resolve({
        schemaVersion: 1,
        requestId: "00000000-0000-8000-8000-000000000002",
        proposalID,
        proposalDigest: preparedResult().preview.authority.proposalDigest,
        status: "denied_without_git_effect",
        operationID: "30000000-0000-4000-8000-000000000003",
      } as const)
    },
    dispose() {},
  } satisfies AstraGitUnstageClient
  const app = await renderSurface(activeAuthority, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.git.unstage.prepare")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.git.unstage.reject")
    expect(calls).toBe(0)
    app.pressLocal("d")
    const denied = await app.render.waitForFrame((frame) => frame.includes("DENIED • NO GIT EFFECT"))
    expect(denied).not.toContain("RECONCILIATION REQUIRED")
    expect(calls).toBe(1)
  } finally {
    app.render.renderer.destroy()
  }
})

async function renderSurface(authority: AstraSessionAuthority, client: AstraGitUnstageClient) {
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
          route = routes.find((candidate) => candidate.name === "astra-git-unstage") ?? route
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
    registerAstraGitUnstage(api, authority, client)
    void keymap.dispatchCommand("astra.git.unstage.open")
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

  const render = await testRender(() => <Harness />, { width: 96, height: 25 })
  return {
    render,
    dispatch: (command: string) => dispatch(command),
    pressLocal: (key: string) => render.mockInput.pressKey(key),
    hasCommand: (command: string) => commands.has(command),
    current: () => current,
  }
}
