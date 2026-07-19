/** @jsxImportSource @opentui/solid */

import type { ControlledWriteDecisionResult, ControlledWritePreview } from "@astra/domain/controlled-write-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createAstraControlledWriteClient, type AstraControlledWriteClient } from "../../astra/controlled-write-client"
import { AstraControlClientError } from "../../astra/control-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-controlled-write"

type WriteState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "preparing"; accepted: boolean }>
  | Readonly<{ status: "prepared"; preview: ControlledWritePreview }>
  | Readonly<{ status: "deciding"; preview: ControlledWritePreview; decision: "approve" | "reject"; accepted: boolean }>
  | Readonly<{
      status: "progress"
      preview: ControlledWritePreview
      phase: "recording_authority" | "host_adapter_validating" | "effect_observed_not_verified" | "verifying"
    }>
  | Readonly<{ status: "terminal"; result: ControlledWriteDecisionResult }>
  | Readonly<{ status: "reconciliation"; operationID: string }>
  | Readonly<{ status: "blocked"; reason: string }>

export function AstraControlledWriteView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraControlledWriteClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const valueWidth = createMemo(() => Math.max(18, dimensions().width - 15))
  const [state, setState] = createSignal<WriteState>({ status: "idle" })
  let generation = 0
  let abort: AbortController | undefined

  const close = () => {
    if (decisionInFlight(state())) return
    generation++
    abort?.abort()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  const prepare = () => {
    if (props.authority.mode === "read-only") {
      setState({ status: "blocked", reason: "read_only" })
      return
    }
    const current = state()
    if (current.status === "preparing" || decisionInFlight(current)) return
    const currentGeneration = ++generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "preparing", accepted: false })
    void props.client
      .prepare({
        signal: abort.signal,
        onAccepted() {
          if (generation === currentGeneration) setState({ status: "preparing", accepted: true })
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (result.status === "prepared") setState({ status: "prepared", preview: result.preview })
        else setState({ status: "blocked", reason: result.reason })
      })
      .catch((error) => {
        if (generation === currentGeneration) setState({ status: "blocked", reason: clientFailureReason(error) })
      })
  }

  const decide = (decision: "approve" | "reject") => {
    const current = state()
    if (current.status !== "prepared") return
    const currentGeneration = ++generation
    abort = undefined
    setState({ status: "deciding", preview: current.preview, decision, accepted: false })
    void props.client
      .decide(current.preview.proposalID, decision, {
        onAccepted() {
          if (generation === currentGeneration) {
            setState({ status: "deciding", preview: current.preview, decision, accepted: true })
          }
        },
        onProgress(progress) {
          if (generation === currentGeneration) {
            setState({ status: "progress", preview: current.preview, phase: progress.status })
          }
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (decision === "reject" && result.status !== "denied_without_workspace_effect") {
          setState({ status: "reconciliation", operationID: current.preview.operationID })
          return
        }
        setState({ status: "terminal", result })
      })
      .catch(() => {
        if (generation !== currentGeneration) return
        setState({ status: "reconciliation", operationID: current.preview.operationID })
      })
  }

  onCleanup(() => {
    generation++
    abort?.abort()
  })

  useBindings(() => ({
    commands: [
      { name: "astra.write.prepare", title: "Prepare Controlled Write", category: "Astra", run: prepare },
      {
        name: "astra.write.approve",
        title: "Approve Controlled Write",
        category: "Astra",
        run: () => decide("approve"),
      },
      { name: "astra.write.reject", title: "Reject Controlled Write", category: "Astra", run: () => decide("reject") },
      { name: "astra.write.close", title: "Close Controlled Write", category: "Astra", run: close },
    ],
    bindings: [
      { key: "p", cmd: "astra.write.prepare", desc: "Prepare" },
      { key: "a", cmd: "astra.write.approve", desc: "Approve" },
      { key: "d", cmd: "astra.write.reject", desc: "Reject" },
      { key: "escape", cmd: "astra.write.close", desc: "Close" },
    ],
  }))

  return (
    <box
      position="absolute"
      zIndex={2500}
      left={0}
      top={0}
      width={dimensions().width}
      height={dimensions().height}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.api.theme.current.text}>Controlled Write</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>p prepare a approve d reject esc close</text>
      </box>
      <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
      <text fg={props.api.theme.current.warning}>HOST NETWORK UNRESTRICTED — NOT ISOLATED</text>
      <box height={1} />
      <Row
        label="WORKSPACE"
        value={Locale.truncateLeft(props.authority.workspace.root, valueWidth())}
        api={props.api}
      />
      <Row label="MODE" value={props.authority.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="STATE" value={stateLabel(state())} api={props.api} />
      <Show when={previewOf(state())}>
        {(preview) => (
          <>
            <Row label="OPERATION" value={preview().operationID} api={props.api} />
            <Row label="EFFECT" value="CREATE ONLY" api={props.api} />
            <Row label="TARGET" value={preview().resource.relativeTarget} api={props.api} />
            <Row label="BYTES" value={String(preview().resource.bytes)} api={props.api} />
            <Row
              label="CONTENT"
              value={Locale.truncate(preview().resource.contentDigest, valueWidth())}
              api={props.api}
            />
            <Row label="CAPABILITY" value={Locale.truncate(preview().capabilityDigest, valueWidth())} api={props.api} />
            <Row label="EXPIRES" value={preview().expiresAt} api={props.api} />
            <Row label="VERIFY" value="NOT VERIFIED" api={props.api} />
          </>
        )}
      </Show>
      <Show when={terminalOf(state())}>
        {(result) => (
          <>
            <Row label="RESULT" value={terminalLabel(result())} api={props.api} />
            <Show when={operationIDOf(result())}>
              {(operationID) => <Row label="OPERATION" value={operationID()} api={props.api} />}
            </Show>
            <Show when={result().status === "verified"}>
              <Row label="EVIDENCE" value="EXACT READBACK" api={props.api} />
            </Show>
          </>
        )}
      </Show>
      <Show when={blockedOf(state())}>
        {(reason) => <Row label="REASON" value={reason().replaceAll("_", " ")} api={props.api} />}
      </Show>
      <Show when={reconciliationOperationIDOf(state())}>
        {(operationID) => <Row label="OPERATION" value={operationID()} api={props.api} />}
      </Show>
    </box>
  )
}

export function registerAstraControlledWrite(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = createAstraControlledWriteClient({}, authority.sessionID),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraControlledWriteView
          api={api}
          authority={authority}
          client={client}
          returnRoute={parseReturnRoute(input.params?.returnRoute)}
        />
      ),
    },
  ])
  api.keymap.registerLayer({
    commands: [
      {
        name: "astra.write.open",
        title: "Controlled Write",
        slashName: "write",
        category: "Astra",
        namespace: "palette",
        run() {
          api.route.navigate(routeName, { returnRoute: api.route.current })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

function Row(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={13} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

function decisionInFlight(state: WriteState) {
  return state.status === "deciding" || state.status === "progress"
}

function previewOf(state: WriteState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}

function terminalOf(state: WriteState) {
  return state.status === "terminal" ? state.result : undefined
}

function blockedOf(state: WriteState) {
  if (state.status === "blocked") return state.reason
  if (state.status === "terminal" && state.result.status === "blocked") return state.result.reason
  return undefined
}

function operationIDOf(result: ControlledWriteDecisionResult) {
  return "operationID" in result ? result.operationID : undefined
}

function reconciliationOperationIDOf(state: WriteState) {
  return state.status === "reconciliation" ? state.operationID : undefined
}

function stateLabel(state: WriteState) {
  if (state.status === "idle") return "IDLE • NO REQUEST • NO EFFECT"
  if (state.status === "preparing") return state.accepted ? "PREPARING • NOT VERIFIED" : "QUEUED • NO EFFECT"
  if (state.status === "prepared") return "AWAITING EXPLICIT DECISION • NOT VERIFIED"
  if (state.status === "deciding") {
    if (!state.accepted) return "DECISION QUEUED • NOT VERIFIED"
    return state.decision === "approve"
      ? "REQUEST AUTHENTICATED • NOT VERIFIED"
      : "REJECTION REQUEST AUTHENTICATED • NO WORKSPACE EFFECT"
  }
  if (state.status === "progress") {
    if (state.phase === "recording_authority") return "RECORDING AUTHORITY • NOT VERIFIED"
    if (state.phase === "host_adapter_validating") return "HOST ADAPTER VALIDATING • NOT VERIFIED"
    if (state.phase === "effect_observed_not_verified") return "EFFECT OBSERVED • NOT VERIFIED"
    return "VERIFYING EXACT READBACK • NOT VERIFIED"
  }
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED • EFFECT UNKNOWN"
  if (state.status === "blocked") return "BLOCKED • NO EFFECT CLAIMED"
  return terminalLabel(state.result)
}

function terminalLabel(result: ControlledWriteDecisionResult) {
  if (result.status === "verified") return "VERIFIED • EXACT READBACK"
  if (result.status === "denied_without_workspace_effect") return "DENIED • NO WORKSPACE EFFECT"
  if (result.status === "failed_without_effect") return "FAILED • NO EFFECT"
  if (result.status === "reconciliation_required") return "RECONCILIATION REQUIRED • EFFECT UNKNOWN"
  return "BLOCKED • NO EFFECT CLAIMED"
}

function clientFailureReason(error: unknown) {
  if (!(error instanceof AstraControlClientError)) return "protocol_invalid"
  if (error.code === "unavailable") return "control_unavailable"
  if (error.code === "transport_failed") return "control_transport_failed"
  if (error.code === "timed_out") return "control_response_timed_out"
  if (error.code === "busy") return "control_busy"
  if (error.code === "cancelled") return "cancelled"
  return "protocol_invalid"
}

function parseReturnRoute(input: unknown): TuiRouteCurrent | undefined {
  if (!isRecord(input) || typeof input.name !== "string") return undefined
  if (!("params" in input)) return { name: input.name }
  if (!isRecord(input.params)) return undefined
  return { name: input.name, params: input.params }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
