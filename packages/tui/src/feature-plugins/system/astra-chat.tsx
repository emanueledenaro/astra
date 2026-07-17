/** @jsxImportSource @opentui/solid */

import type {
  ProviderControlCatalog,
  ProviderTurnDecisionResult,
  ProviderTurnPreview,
  ProviderTurnProgress,
} from "@astra/domain/provider-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createAstraProviderClient, type AstraProviderClient } from "../../astra/provider-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-chat"

type ChatState =
  | Readonly<{ status: "loading_catalog" }>
  | Readonly<{ status: "ready"; catalog: ProviderControlCatalog; modelID: string }>
  | Readonly<{ status: "preparing"; catalog: ProviderControlCatalog; modelID: string; userText: string }>
  | Readonly<{
      status: "prepared"
      catalog: ProviderControlCatalog
      modelID: string
      userText: string
      preview: ProviderTurnPreview
    }>
  | Readonly<{
      status: "deciding"
      catalog: ProviderControlCatalog
      modelID: string
      userText: string
      preview: ProviderTurnPreview
      decision: "approve" | "reject"
    }>
  | Readonly<{
      status: "progress"
      catalog: ProviderControlCatalog
      modelID: string
      userText: string
      preview: ProviderTurnPreview
      phase: ProviderTurnProgress["status"]
    }>
  | Readonly<{ status: "completed"; modelID: string; userText: string; result: Extract<ProviderTurnDecisionResult, { status: "response_observed_not_verified" }> }>
  | Readonly<{ status: "denied"; modelID: string; userText: string }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; operationID: string }>

export function AstraChatView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraProviderClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const valueWidth = createMemo(() => Math.max(24, dimensions().width - 18))
  const [state, setState] = createSignal<ChatState>({ status: "loading_catalog" })
  let generation = 0
  let abort: AbortController | undefined

  const loadCatalog = () => {
    const currentGeneration = ++generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "loading_catalog" })
    void props.client
      .catalog({ signal: abort.signal })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (result.status === "unavailable") return setState({ status: "blocked", reason: result.reason })
        setState({ status: "ready", catalog: result.catalog, modelID: result.catalog.models[0]!.id })
      })
      .catch(() => {
        if (generation === currentGeneration) setState({ status: "blocked", reason: "provider_control_unavailable" })
      })
  }

  const selectModel = () => {
    const current = state()
    if (current.status !== "ready") return
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title="Select Anthropic model"
        current={current.modelID}
        options={current.catalog.models.map((model) => ({
          title: model.name,
          description: model.id,
          value: model.id,
          onSelect: () => {
            setState({ ...current, modelID: model.id })
            props.api.ui.dialog.clear()
          },
        }))}
      />
    ))
  }

  const compose = () => {
    const current = state()
    if (props.authority.mode !== "activate-once") return setState({ status: "blocked", reason: "read_only" })
    if (current.status !== "ready") return
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="Message Astra"
        placeholder="Ask one question without tools or file access"
        onConfirm={(raw) => {
          const userText = raw.trim()
          if (!userText) return
          props.api.ui.dialog.clear()
          const currentGeneration = ++generation
          abort = new AbortController()
          setState({ status: "preparing", catalog: current.catalog, modelID: current.modelID, userText })
          void props.client
            .prepare(current.modelID, userText, { signal: abort.signal })
            .then((result) => {
              if (generation !== currentGeneration) return
              if (result.status === "blocked") return setState({ status: "blocked", reason: result.reason })
              setState({
                status: "prepared",
                catalog: current.catalog,
                modelID: current.modelID,
                userText,
                preview: result.preview,
              })
            })
            .catch(() => {
              if (generation === currentGeneration) setState({ status: "blocked", reason: "provider_control_failed" })
            })
        }}
      />
    ))
  }

  const decide = (decision: "approve" | "reject") => {
    const current = state()
    if (current.status !== "prepared") return
    const currentGeneration = ++generation
    abort = undefined
    setState({ ...current, status: "deciding", decision })
    void props.client
      .decide(current.preview.proposalID, decision, {
        onProgress(progress) {
          if (generation === currentGeneration) setState({ ...current, status: "progress", phase: progress.status })
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (result.status === "response_observed_not_verified") {
          setState({ status: "completed", modelID: current.modelID, userText: current.userText, result })
          return
        }
        if (result.status === "denied_without_effect") {
          setState({ status: "denied", modelID: current.modelID, userText: current.userText })
          return
        }
        if (result.status === "reconciliation_required") {
          setState({ status: "reconciliation", operationID: current.preview.operationID })
          return
        }
        setState({ status: "blocked", reason: result.reason })
      })
      .catch(() => {
        if (generation === currentGeneration) {
          setState({ status: "reconciliation", operationID: current.preview.operationID })
        }
      })
  }

  const reset = () => loadCatalog()
  const close = () => {
    if (decisionInFlight(state())) return
    generation += 1
    abort?.abort()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  onMount(loadCatalog)
  onCleanup(() => {
    generation += 1
    abort?.abort()
  })

  useBindings(() => ({
    enabled: !props.api.ui.dialog.open,
    commands: [
      { name: "astra.chat.model", title: "Select Chat Model", category: "Astra", run: selectModel },
      { name: "astra.chat.compose", title: "Compose Chat Message", category: "Astra", run: compose },
      { name: "astra.chat.approve", title: "Approve Provider Turn", category: "Astra", run: () => decide("approve") },
      { name: "astra.chat.reject", title: "Reject Provider Turn", category: "Astra", run: () => decide("reject") },
      { name: "astra.chat.reset", title: "Reset One-turn Chat", category: "Astra", run: reset },
      { name: "astra.chat.close", title: "Close Chat", category: "Astra", run: close },
    ],
    bindings: [
      { key: "m", cmd: "astra.chat.model", desc: "Model" },
      { key: "p", cmd: "astra.chat.compose", desc: "Prompt" },
      { key: "a", cmd: "astra.chat.approve", desc: "Approve" },
      { key: "d", cmd: "astra.chat.reject", desc: "Reject" },
      { key: "r", cmd: "astra.chat.reset", desc: "Reset" },
      { key: "escape", cmd: "astra.chat.close", desc: "Close" },
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
        <text fg={props.api.theme.current.text}>Astra Chat · Anthropic</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>m model p prompt a approve d reject r reset esc close</text>
      </box>
      <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
      <text fg={props.api.theme.current.warning}>NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX</text>
      <text fg={props.api.theme.current.warning}>ONE TURN · NO TOOLS · NO FILES · NO HISTORY · NOT VERIFIED</text>
      <box height={1} />
      <Row label="WORKSPACE" value={Locale.truncateLeft(props.authority.workspace.root, valueWidth())} api={props.api} />
      <Row label="MODE" value={props.authority.mode === "activate-once" ? "ACTIVE ONCE" : "READ ONLY"} api={props.api} />
      <Row label="STATE" value={stateLabel(state())} api={props.api} />
      <Show when={modelOf(state())}>{(model) => <Row label="MODEL" value={model()} api={props.api} />}</Show>
      <Show when={previewOf(state())}>
        {(preview) => (
          <>
            <Row label="OPERATION" value={preview().operationID} api={props.api} />
            <Row label="PROVIDER" value={`${preview().providerID} / ${preview().modelID}`} api={props.api} />
            <Row label="DESTINATION" value={`${preview().destination.origin}${preview().destination.path}`} api={props.api} />
            <Row label="BODY" value={`${preview().logicalPayload.bytes} bytes`} api={props.api} />
            <Row label="DIGEST" value={Locale.truncate(preview().logicalPayload.digest, valueWidth())} api={props.api} />
            <Row label="HEADERS" value={preview().headerNames.join(", ")} api={props.api} />
            <Row label="ACCOUNT" value={preview().credential.accountFingerprint} api={props.api} />
            <Row label="ASSURANCE" value="NOT VERIFIED" api={props.api} />
          </>
        )}
      </Show>
      <Show when={userTextOf(state())}>
        {(text) => (
          <box marginTop={1} flexDirection="column">
            <text fg={props.api.theme.current.textMuted}>YOU · MEMORY ONLY</text>
            <text fg={props.api.theme.current.text}>{text()}</text>
          </box>
        )}
      </Show>
      <Show when={completedOf(state())}>
        {(result) => (
          <box marginTop={1} flexDirection="column">
            <text fg={props.api.theme.current.success}>COMPLETED — RESPONSE OBSERVED — NOT VERIFIED</text>
            <text fg={props.api.theme.current.textMuted}>ASTRA · {result().response.finishReason.toUpperCase()}</text>
            <text fg={props.api.theme.current.text}>{result().response.assistantText}</text>
          </box>
        )}
      </Show>
      <Show when={blockedOf(state())}>{(reason) => <Row label="REASON" value={reason().replaceAll("_", " ")} api={props.api} />}</Show>
      <Show when={reconciliationOf(state())}>{(id) => <Row label="OPERATION" value={id()} api={props.api} />}</Show>
    </box>
  )
}

export function registerAstraChat(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = createAstraProviderClient(process.env, authority.sessionID),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraChatView
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
        name: "astra.chat.open",
        title: "Astra Chat",
        slashName: "chat",
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
      <text width={16} fg={props.api.theme.current.textMuted}>{props.label}</text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

function decisionInFlight(state: ChatState) {
  return state.status === "deciding" || state.status === "progress"
}

function modelOf(state: ChatState) {
  return "modelID" in state ? state.modelID : undefined
}

function previewOf(state: ChatState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}

function userTextOf(state: ChatState) {
  return "userText" in state ? state.userText : undefined
}

function completedOf(state: ChatState) {
  return state.status === "completed" ? state.result : undefined
}

function blockedOf(state: ChatState) {
  return state.status === "blocked" ? state.reason : undefined
}

function reconciliationOf(state: ChatState) {
  return state.status === "reconciliation" ? state.operationID : undefined
}

function stateLabel(state: ChatState) {
  if (state.status === "loading_catalog") return "LOADING TRUSTED CATALOG · NO EFFECT"
  if (state.status === "ready") return "READY · NO REQUEST · NO EFFECT"
  if (state.status === "preparing") return "PREPARING PRIVATE REQUEST · NO NETWORK"
  if (state.status === "prepared") return "AWAITING EXPLICIT DECISION · NO NETWORK · NOT VERIFIED"
  if (state.status === "deciding") return `${state.decision.toUpperCase()} REQUEST AUTHENTICATED · NOT VERIFIED`
  if (state.status === "progress") return state.phase.replaceAll("_", " ").toUpperCase()
  if (state.status === "completed") return "COMPLETED — RESPONSE OBSERVED — NOT VERIFIED"
  if (state.status === "denied") return "DENIED · ZERO NETWORK EFFECT"
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
  return "BLOCKED · NO EFFECT CLAIMED"
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
