/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { AstraProviderOperationView } from "../../../src/astra/provider-operation-view"
import { AstraControlRail } from "../../../src/component/astra-control-rail"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("keeps a pending provider operation visible when the work-session stream is unavailable", async () => {
  let updateOperation!: (value: AstraProviderOperationView) => void
  const pendingOperation = {
    state: "awaiting_decision",
    statusLabel: "AWAITING DECISION · NO NETWORK",
    operationID: "30000000-0000-4000-8000-000000000003",
    providerID: "anthropic",
    providerName: "Anthropic",
    modelID: "claude-sonnet",
    credentialProfile: "anthropic-api-key",
    destination: "https://api.anthropic.com/v1/messages",
    payloadBytes: 256,
    priorTurns: 2,
    historyBytes: 128,
    retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
    hostBoundary: "HOST EXECUTION — NO SANDBOX",
    networkBoundary: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
    capabilityDigest: `sha256:${"a".repeat(64)}`,
    headerNames: ["anthropic-version", "content-type", "x-api-key"],
    accountFingerprint: `sha256:${"b".repeat(64)}`,
    assurance: "NOT VERIFIED",
    decisionRequired: true,
  } as const satisfies AstraProviderOperationView
  function Harness() {
    const renderer = useRenderer()
    const api = createTuiPluginApi({ keymap: createDefaultOpenTuiKeymap(renderer) }) satisfies TuiPluginApi
    const [operation, setOperation] = createSignal<AstraProviderOperationView>(pendingOperation)
    updateOperation = setOperation
    return (
      <AstraControlRail
        api={api}
        view={{ status: "state_unavailable", reason: "transport_failed" }}
        candidateAvailable={false}
        providerOperation={operation()}
      />
    )
  }

  const render = await testRender(() => <Harness />, { width: 44, height: 32 })
  try {
    const frame = await render.waitForFrame((value) => value.includes("STATE UNAVAILABLE"))
    expect(frame).toContain("PROVIDER OPERATION")
    expect(frame).toContain("AWAITING DECISION")
    expect(frame).toContain("30000000-0000-4000-8000-")
    expect(frame).toContain("000000000003")
    expect(frame).toContain("Anthropic / claude-sonnet")
    expect(frame).toContain("anthropic-api-key")
    expect(frame).toContain("https://api.anthropic.com/v1/")
    expect(frame).toContain("messages")
    expect(frame).toContain("256 bytes")
    expect(frame).toContain("2 prior turns · 128 bytes")
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("NETWORK EGRESS — HOST TRANSPORT")
    expect(frame).toContain("— NO NETWORK SANDBOX")
    expect(frame).toContain("anthropic-version, content-type,")
    expect(frame).toContain("api-key")
    expect(frame).toContain("NOT VERIFIED")
    expect(frame).toContain("A APPROVE · D REJECT")

    updateOperation({
      ...pendingOperation,
      state: "denied_without_effect",
      statusLabel: "DENIED WITHOUT EFFECT / NOT SENT",
      decisionRequired: false,
    })
    const denied = await render.waitForFrame((value) => value.includes("DENIED WITHOUT EFFECT / NOT SENT"))
    expect(denied).not.toContain("A APPROVE · D REJECT")

    updateOperation({
      ...pendingOperation,
      state: "response_observed_not_verified",
      statusLabel: "RESPONSE OBSERVED — NOT VERIFIED",
      decisionRequired: false,
    })
    const completed = await render.waitForFrame((value) => value.includes("RESPONSE OBSERVED — NOT VERIFIED"))
    expect(completed).not.toContain("A APPROVE · D REJECT")
  } finally {
    render.renderer.destroy()
  }
})
