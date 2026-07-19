/** @jsxImportSource @opentui/solid */

import { createHash } from "node:crypto"
import type {
  ControlledWriteDecisionResult,
  ControlledWritePrepareResult,
} from "@astra/domain/controlled-write-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { AstraControlledWriteClient } from "../../../src/astra/controlled-write-client"
import { registerAstraAppFeatures } from "../../../src/astra/features"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("opens /write without a request and shows observed versus verified truthfully", async () => {
  let prepareCalls = 0
  let decisionCalls = 0
  let acceptPrepare!: () => void
  let finishPrepare!: (value: ControlledWritePrepareResult) => void
  let acceptDecision!: () => void
  let emitProgress!: (
    progress: typeof effectProgress | typeof recordingProgress | typeof adapterProgress | typeof verifyingProgress,
  ) => void
  let finishDecision!: (value: ControlledWriteDecisionResult) => void
  const client = {
    prepare(options) {
      prepareCalls++
      acceptPrepare = () => options?.onAccepted?.("50000000-0000-4000-8000-000000000005")
      return new Promise((resolve) => (finishPrepare = resolve))
    },
    decide(id, decision, options) {
      decisionCalls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("approve")
      acceptDecision = () => options?.onAccepted?.("60000000-0000-4000-8000-000000000006")
      emitProgress = (progress) => options?.onProgress?.(progress)
      return new Promise((resolve) => (finishDecision = resolve))
    },
    dispose() {},
  } satisfies AstraControlledWriteClient
  const app = await renderSurface(activeAuthority, client)

  try {
    const initial = await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    expect(initial).toContain("HOST EXECUTION — NO SANDBOX")
    expect(initial).toContain("HOST NETWORK UNRESTRICTED — NOT ISOLATED")
    expect(prepareCalls).toBe(0)
    expect(decisionCalls).toBe(0)

    app.dispatch("astra.write.prepare")
    expect(prepareCalls).toBe(1)
    await app.render.waitForFrame((frame) => frame.includes("QUEUED • NO EFFECT"))
    acceptPrepare()
    await app.render.waitForFrame((frame) => frame.includes("PREPARING • NOT VERIFIED"))
    finishPrepare(preparedResult)
    const preview = await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    expect(preview).toContain(".astra-demo-marker")
    expect(preview).toContain("CREATE ONLY")
    expect(preview).toContain("NOT VERIFIED")
    expect(decisionCalls).toBe(0)

    app.dispatch("astra.write.approve")
    expect(decisionCalls).toBe(1)
    acceptDecision()
    await app.render.waitForFrame((frame) => frame.includes("REQUEST AUTHENTICATED • NOT VERIFIED"))
    app.dispatch("astra.write.close")
    expect(app.current().name).toBe("astra-controlled-write")
    emitProgress(recordingProgress)
    await app.render.waitForFrame((frame) => frame.includes("RECORDING AUTHORITY • NOT VERIFIED"))
    emitProgress(adapterProgress)
    await app.render.waitForFrame((frame) => frame.includes("HOST ADAPTER VALIDATING • NOT VERIFIED"))
    emitProgress(effectProgress)
    const observed = await app.render.waitForFrame((frame) => frame.includes("EFFECT OBSERVED • NOT VERIFIED"))
    expect(observed).not.toContain("VERIFIED • EXACT READBACK")
    emitProgress(verifyingProgress)
    await app.render.waitForFrame((frame) => frame.includes("VERIFYING EXACT READBACK • NOT VERIFIED"))
    finishDecision(verifiedResult)
    const verified = await app.render.waitForFrame((frame) => frame.includes("VERIFIED • EXACT READBACK"))
    expect(verified).toContain("EVIDENCE")
    app.dispatch("astra.write.close")
    expect(app.current().name).toBe("session")
  } finally {
    app.render.renderer.destroy()
  }
})

test("shows reconciliation when the transport fails after approval was accepted", async () => {
  let acceptDecision!: () => void
  let failDecision!: (error: Error) => void
  const client = {
    prepare() {
      return Promise.resolve(preparedResult)
    },
    decide(_id, _decision, options) {
      acceptDecision = () => options?.onAccepted?.("60000000-0000-4000-8000-000000000006")
      return new Promise<ControlledWriteDecisionResult>((_resolve, reject) => (failDecision = reject))
    },
    dispose() {},
  } satisfies AstraControlledWriteClient
  const app = await renderSurface(activeAuthority, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.write.prepare")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.write.approve")
    acceptDecision()
    await app.render.waitForFrame((frame) => frame.includes("REQUEST AUTHENTICATED • NOT VERIFIED"))
    failDecision(new Error("socket closed"))
    const frame = await app.render.waitForFrame((value) => value.includes("RECONCILIATION REQUIRED • EFFECT UNKNOWN"))
    expect(frame).not.toContain("BLOCKED • NO EFFECT CLAIMED")
  } finally {
    app.render.renderer.destroy()
  }
})

test("shows reconciliation when approval may dispatch before accepted is observed", async () => {
  let failDecision!: (error: Error) => void
  const client = {
    prepare() {
      return Promise.resolve(preparedResult)
    },
    decide() {
      return new Promise<ControlledWriteDecisionResult>((_resolve, reject) => (failDecision = reject))
    },
    dispose() {},
  } satisfies AstraControlledWriteClient
  const app = await renderSurface(activeAuthority, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.write.prepare")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.write.approve")
    failDecision(new Error("accepted frame lost after server dispatch"))
    const frame = await app.render.waitForFrame((value) => value.includes("RECONCILIATION REQUIRED • EFFECT UNKNOWN"))
    expect(frame).not.toContain("BLOCKED • NO EFFECT CLAIMED")
  } finally {
    app.render.renderer.destroy()
  }
})

test("blocks prepare locally in read-only mode without contacting the parent", async () => {
  let calls = 0
  const client = {
    prepare() {
      calls++
      return Promise.resolve(preparedResult)
    },
    decide() {
      calls++
      return Promise.resolve(verifiedResult)
    },
    dispose() {},
  } satisfies AstraControlledWriteClient
  const app = await renderSurface({ ...activeAuthority, mode: "read-only" }, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.write.prepare")
    const blocked = await app.render.waitForFrame((frame) => frame.includes("BLOCKED • NO EFFECT CLAIMED"))
    expect(blocked).toContain("read only")
    expect(calls).toBe(0)
  } finally {
    app.render.renderer.destroy()
  }
})

test("does not call an unrecorded rejection no-effect", async () => {
  const client = {
    prepare() {
      return Promise.resolve(preparedResult)
    },
    decide(_id, decision) {
      expect(decision).toBe("reject")
      return Promise.resolve({
        schemaVersion: 1,
        requestId: "60000000-0000-4000-8000-000000000006",
        proposalID,
        status: "blocked",
        reason: "durable_state_unavailable",
      } as const)
    },
    dispose() {},
  } satisfies AstraControlledWriteClient
  const app = await renderSurface(activeAuthority, client)

  try {
    await app.render.waitForFrame((frame) => frame.includes("IDLE • NO REQUEST • NO EFFECT"))
    app.dispatch("astra.write.prepare")
    await app.render.waitForFrame((frame) => frame.includes("AWAITING EXPLICIT DECISION"))
    app.dispatch("astra.write.reject")
    const frame = await app.render.waitForFrame((value) => value.includes("RECONCILIATION REQUIRED • EFFECT UNKNOWN"))
    expect(frame).not.toContain("DENIED • NO WORKSPACE EFFECT")
  } finally {
    app.render.renderer.destroy()
  }
})

async function renderSurface(authority: AstraSessionAuthority, client: AstraControlledWriteClient) {
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
          route = routes.find((candidate) => candidate.name === "astra-controlled-write") ?? route
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
    registerAstraAppFeatures(api, authority, undefined, client)
    expect(commands.get("astra.write.open")?.slashName).toBe("write")
    void keymap.dispatchCommand("astra.write.open")
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

  const render = await testRender(() => <Harness />, { width: 76, height: 18 })
  return { render, dispatch: (command: string) => dispatch(command), current: () => current }
}

const activeAuthority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-17T12:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/Users/example/astra-project",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"a".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority

const proposalID = "10000000-0000-4000-8000-000000000001"
const operationID = "20000000-0000-4000-8000-000000000002"
const receiptID = "30000000-0000-4000-8000-000000000003"
const evidenceID = "40000000-0000-4000-8000-000000000004"
const markerContent = `Astra controlled host write\noperation_id=${operationID}\n`
const markerBytes = Buffer.byteLength(markerContent)
const contentDigest = `sha256:${createHash("sha256").update(markerContent).digest("hex")}` as const
const preparedResult = {
  schemaVersion: 1,
  requestId: "50000000-0000-4000-8000-000000000005",
  status: "prepared",
  preview: {
    schemaVersion: 1,
    operation: "controlled_write_create_only",
    operationID,
    proposalID,
    expiresAt: "2026-07-17T14:00:00.000Z",
    boundary: { mode: "host_no_sandbox", label: "HOST EXECUTION — NO SANDBOX" },
    resource: {
      kind: "workspace_relative_file",
      mode: "create_only",
      relativeTarget: ".astra-demo-marker",
      bytes: markerBytes,
      contentDigest,
    },
    capabilityDigest: `sha256:${"c".repeat(64)}`,
    network: { mode: "host_unrestricted", warning: "HOST NETWORK UNRESTRICTED — NOT ISOLATED" },
    verification: "not_verified",
  },
} as const satisfies ControlledWritePrepareResult
const effectProgress = {
  schemaVersion: 1,
  requestId: "60000000-0000-4000-8000-000000000006",
  proposalID,
  operationID,
  status: "effect_observed_not_verified",
  verification: "not_verified",
  receiptID,
  observation: { relativeTarget: ".astra-demo-marker", bytes: markerBytes, contentDigest },
} as const
const recordingProgress = {
  schemaVersion: 1,
  requestId: "60000000-0000-4000-8000-000000000006",
  proposalID,
  operationID,
  status: "recording_authority",
  verification: "not_verified",
} as const
const adapterProgress = { ...recordingProgress, status: "host_adapter_validating" } as const
const verifyingProgress = { ...recordingProgress, status: "verifying" } as const
const verifiedResult = {
  schemaVersion: 1,
  requestId: "60000000-0000-4000-8000-000000000006",
  proposalID,
  operationID,
  status: "verified",
  verification: "exact_readback",
  receiptID,
  evidenceID,
  readback: { relativeTarget: ".astra-demo-marker", bytes: markerBytes, contentDigest },
} as const satisfies ControlledWriteDecisionResult
