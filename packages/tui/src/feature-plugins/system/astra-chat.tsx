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
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createAstraProviderClient, type AstraProviderClient } from "../../astra/provider-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-chat"
const maximumVisibleHistoryTurns = 8

type ChatTurn = Readonly<{
  modelID: string
  userText: string
  assistantText: string
  finishReason: string
}>

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
  | Readonly<{
      status: "completed"
      catalog: ProviderControlCatalog
      modelID: string
      userText: string
      result: Extract<ProviderTurnDecisionResult, { status: "response_observed_not_verified" }>
    }>
  | Readonly<{ status: "denied"; catalog: ProviderControlCatalog; modelID: string; userText: string }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; operationID: string }>

export type AstraChatActivity = Readonly<{
  status: ChatState["status"]
  label: string
  summary: string
  providerID?: string
  providerName?: string
  modelID?: string
  operationID?: string
  destination?: string
  payloadBytes?: number
  decisionRequired: boolean
}>

export function AstraChatView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraProviderClient
  returnRoute?: TuiRouteCurrent
  embedded?: boolean
  onActivity?: (activity: AstraChatActivity) => void
}) {
  const dimensions = useTerminalDimensions()
  const valueWidth = createMemo(() => Math.max(24, dimensions().width - 18))
  const [state, setState] = createSignal<ChatState>({ status: "loading_catalog" })
  const [history, setHistory] = createSignal<ReadonlyArray<ChatTurn>>([])
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
    if (current.status !== "ready" && current.status !== "completed" && current.status !== "denied") return
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

  const decide = (decision: "approve" | "reject", afterDenied?: () => void) => {
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
          setHistory((turns) =>
            [
              ...turns,
              {
                modelID: current.modelID,
                userText: current.userText,
                assistantText: result.response.assistantText,
                finishReason: result.response.finishReason,
              },
            ].slice(-maximumVisibleHistoryTurns),
          )
          setState({
            status: "completed",
            catalog: current.catalog,
            modelID: current.modelID,
            userText: current.userText,
            result,
          })
          return
        }
        if (result.status === "denied_without_effect") {
          if (afterDenied) return afterDenied()
          setState({
            status: "denied",
            catalog: current.catalog,
            modelID: current.modelID,
            userText: current.userText,
          })
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

  // Reloads the catalog and rejects any pending proposal. The consented conversation history
  // lives in the parent and stays intact; the transcript keeps rendering it truthfully.
  const reset = () => {
    const current = state()
    if (current.status === "prepared") return decide("reject", loadCatalog)
    if (decisionInFlight(current)) return
    loadCatalog()
  }
  const close = () => {
    const navigate = () => {
      generation += 1
      abort?.abort()
      props.api.route.navigate(
        props.returnRoute?.name ?? "home",
        props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
      )
    }
    const current = state()
    if (current.status === "prepared") return decide("reject", navigate)
    if (decisionInFlight(current)) return
    navigate()
  }

  onMount(loadCatalog)
  createEffect(() => props.onActivity?.(chatActivity(state())))
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
      { name: "astra.chat.reset", title: "Reload Chat Catalog", category: "Astra", run: reset },
      { name: "astra.chat.close", title: "Close Chat", category: "Astra", run: close },
    ],
    bindings: [
      { key: "m", cmd: "astra.chat.model", desc: "Model" },
      { key: "p", cmd: "astra.chat.compose", desc: "Prompt" },
      { key: "a", cmd: "astra.chat.approve", desc: "Approve" },
      { key: "d", cmd: "astra.chat.reject", desc: "Reject" },
      { key: "r", cmd: "astra.chat.reset", desc: "Reload" },
      { key: "escape", cmd: "astra.chat.close", desc: "Close" },
    ],
  }))

  return (
    <box
      {...(props.embedded ? {} : { position: "absolute" as const, zIndex: 2500, left: 0, top: 0 })}
      width={props.embedded ? "100%" : dimensions().width}
      height={props.embedded ? "100%" : dimensions().height}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.api.theme.current.primary}>{props.embedded ? "CONVERSATION" : "Astra Chat · Anthropic"}</text>
        <box flexGrow={1} />
        <Show when={!props.embedded || dimensions().width >= 104}>
          <text fg={props.api.theme.current.textMuted}>
            {props.embedded
              ? "p message · m model · a/d decision"
              : "m model p prompt a approve d reject r reload esc close"}
          </text>
        </Show>
      </box>
      <Show when={!props.embedded}>
        <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
        <text fg={props.api.theme.current.warning}>NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX</text>
        <text fg={props.api.theme.current.warning}>
          CONSENTED MULTI-TURN · HISTORY IN PARENT MEMORY ONLY · NOT PERSISTED · NO TOOLS · NOT VERIFIED
        </text>
      </Show>
      <box height={1} />
      <Show when={!props.embedded}>
        <Row
          label="WORKSPACE"
          value={Locale.truncateLeft(props.authority.workspace.root, valueWidth())}
          api={props.api}
        />
        <Row
          label="MODE"
          value={props.authority.mode === "activate-once" ? "ACTIVE ONCE" : "READ ONLY"}
          api={props.api}
        />
        <Row label="STATE" value={stateLabel(state())} api={props.api} />
        <Show when={modelOf(state())}>{(model) => <Row label="MODEL" value={model()} api={props.api} />}</Show>
      </Show>
      <Show when={!props.embedded && previewOf(state())}>
        {(preview) => (
          <>
            <Row label="OPERATION" value={preview().operationID} api={props.api} />
            <Row label="PROVIDER" value={`${preview().providerID} / ${preview().modelID}`} api={props.api} />
            <Row
              label="DESTINATION"
              value={`${preview().destination.origin}${preview().destination.path}`}
              api={props.api}
            />
            <Row
              label="BODY"
              value={`${preview().logicalPayload.bytes} bytes leave this machine (includes history)`}
              api={props.api}
            />
            <Row
              label="HISTORY"
              value={`${preview().conversation.priorTurns} prior turns · ${preview().conversation.historyBytes} bytes · ${preview().conversation.retention}`}
              api={props.api}
            />
            <Row
              label="DIGEST"
              value={Locale.truncate(preview().logicalPayload.digest, valueWidth())}
              api={props.api}
            />
            <Row
              label="CAPABILITY"
              value={Locale.truncate(preview().providerCapabilityDigest, valueWidth())}
              api={props.api}
            />
            <Row
              label="CONTEXT"
              value={
                preview().logicalPayload.contextBindingDigest
                  ? Locale.truncate(preview().logicalPayload.contextBindingDigest!, valueWidth())
                  : "NONE"
              }
              api={props.api}
            />
            <Show when={preview().skillContext}>
              {(skill) => (
                <>
                  <Row label="SKILL" value={skill().name} api={props.api} />
                  <Row label="SKILL TRUST" value={skill().trust} api={props.api} />
                  <Row
                    label="SKILL DIGEST"
                    value={Locale.truncate(skill().instructionsDigest, valueWidth())}
                    api={props.api}
                  />
                  <Row
                    label="SKILL CAP"
                    value={Locale.truncate(skill().activationCapabilityDigest, valueWidth())}
                    api={props.api}
                  />
                  <Row
                    label="DISCLOSURE"
                    value={skill().disclosure.replaceAll("_", " ").toUpperCase()}
                    api={props.api}
                  />
                  <Row label="SKILL PROOF" value={skill().assurance} api={props.api} />
                </>
              )}
            </Show>
            <Row label="HEADERS" value={preview().headerNames.join(", ")} api={props.api} />
            <Row label="ACCOUNT" value={preview().credential.accountFingerprint} api={props.api} />
            <Row label="ASSURANCE" value="NOT VERIFIED" api={props.api} />
          </>
        )}
      </Show>
      <Show when={props.embedded && history().length === 0 && state().status === "ready"}>
        <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
          <text fg={props.api.theme.current.primary}>
            {props.authority.mode === "activate-once" ? "Astra is ready" : "Workspace opened read-only"}
          </text>
          <text fg={props.api.theme.current.textMuted}>
            {props.authority.mode === "activate-once"
              ? "Press P to write a message."
              : "Chat and workspace effects are denied."}
          </text>
          <text fg={props.api.theme.current.textMuted}>
            {props.authority.mode === "activate-once"
              ? "Every provider turn is previewed in the Control Rail."
              : "Restart and choose Activate once to work with Astra."}
          </text>
        </box>
      </Show>
      <For each={history()}>
        {(turn) => (
          <box marginTop={1} flexDirection="column">
            <text fg={props.api.theme.current.textMuted}>{`YOU · IN CONVERSATION · ${turn.modelID}`}</text>
            <text fg={props.api.theme.current.text}>{turn.userText}</text>
            <text
              fg={props.api.theme.current.textMuted}
            >{`ASTRA · ${turn.finishReason.toUpperCase()} · IN CONVERSATION`}</text>
            <text fg={props.api.theme.current.text}>{turn.assistantText}</text>
          </box>
        )}
      </For>
      <Show when={userTextOf(state())}>
        {(text) => (
          <box marginTop={1} flexDirection="column">
            <text fg={props.api.theme.current.textMuted}>
              {state().status === "denied" ? "YOU · DENIED · NOT SENT · NOT IN CONVERSATION" : "YOU · THIS TURN"}
            </text>
            <text fg={props.api.theme.current.text}>{text()}</text>
          </box>
        )}
      </Show>
      <Show when={props.embedded && state().status === "prepared"}>
        <box marginTop={1} flexDirection="column">
          <text fg={props.api.theme.current.warning}>APPROVAL REQUIRED — review the Control Rail</text>
          <text fg={props.api.theme.current.textMuted}>A approve · D reject · no network request has started</text>
        </box>
      </Show>
      <Show when={completedOf(state())}>
        <box marginTop={1} flexDirection="column">
          <text fg={props.api.theme.current.success}>COMPLETED — RESPONSE OBSERVED — NOT VERIFIED</text>
          <text fg={props.api.theme.current.textMuted}>Compose the next message to continue this conversation.</text>
        </box>
      </Show>
      <Show when={blockedOf(state())}>
        {(reason) => <Row label="REASON" value={reason().replaceAll("_", " ")} api={props.api} />}
      </Show>
      <Show when={blockedOf(state()) === "credential_unavailable"}>
        <box marginTop={1} flexDirection="column">
          <Row
            label="ACTION"
            value="Add an Anthropic API key with the existing OpenCode authentication flow."
            api={props.api}
          />
          <Row label="THEN" value="Restart Astra and open /chat again." api={props.api} />
          <Row label="SECRET" value="Never displayed or stored by this chat screen." api={props.api} />
        </box>
      </Show>
      <Show when={blockedOf(state()) === "conversation_limit_reached"}>
        <box marginTop={1} flexDirection="column">
          <Row label="ACTION" value="This conversation reached its history byte limit." api={props.api} />
          <Row label="TRUTH" value="Nothing was sent and nothing is ever silently truncated." api={props.api} />
          <Row label="THEN" value="Restart Astra to begin a new conversation." api={props.api} />
        </box>
      </Show>
      <Show when={reconciliationOf(state())}>{(id) => <Row label="OPERATION" value={id()} api={props.api} />}</Show>
      <Show when={props.embedded}>
        <box flexGrow={history().length === 0 && state().status === "ready" ? 0 : 1} />
        <box border borderStyle="rounded" borderColor={props.api.theme.current.border} paddingLeft={1} paddingRight={1}>
          <text fg={props.api.theme.current.textMuted}>❯ Press P to compose · Ctrl+P for governed actions</text>
        </box>
      </Show>
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
          if (api.route.current.name === "home") {
            api.ui.dialog.clear()
            return
          }
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
      <text width={16} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

function decisionInFlight(state: ChatState) {
  return state.status === "preparing" || state.status === "deciding" || state.status === "progress"
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
  if (state.status === "completed") return undefined
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
  if (state.status === "denied") return "DENIED · ZERO NETWORK EFFECT · CONVERSATION INTACT"
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
  return "BLOCKED · NO EFFECT CLAIMED"
}

function chatActivity(state: ChatState): AstraChatActivity {
  const preview = previewOf(state)
  const catalog = catalogOf(state)
  const modelID = modelOf(state)
  return {
    status: state.status,
    label: stateLabel(state),
    summary: activitySummary(state),
    ...(catalog ? { providerID: catalog.providerID, providerName: catalog.providerName } : {}),
    ...(modelID ? { modelID } : {}),
    ...(preview ? { operationID: preview.operationID } : {}),
    ...(preview ? { destination: `${preview.destination.origin}${preview.destination.path}` } : {}),
    ...(preview ? { payloadBytes: preview.logicalPayload.bytes } : {}),
    decisionRequired: state.status === "prepared",
  }
}

function catalogOf(state: ChatState) {
  return "catalog" in state ? state.catalog : undefined
}

function activitySummary(state: ChatState) {
  if (state.status === "loading_catalog") return "Loading the trusted provider catalog"
  if (state.status === "ready") return "Waiting for your message"
  if (state.status === "preparing") return "Preparing the request locally"
  if (state.status === "prepared") return "Waiting for your provider decision"
  if (state.status === "deciding")
    return state.decision === "approve" ? "Recording your approval" : "Recording your rejection"
  if (state.status === "progress") {
    if (state.phase === "recording_authority") return "Recording bounded authority"
    if (state.phase === "authority_claimed") return "Authority claimed by the provider worker"
    if (state.phase === "network_dispatch") return "Sending the approved request"
    if (state.phase === "response_observed_not_verified") return "Provider response observed"
    return "Recording the provider receipt"
  }
  if (state.status === "completed") return "Provider response received"
  if (state.status === "denied") return "Request rejected without network effect"
  if (state.status === "reconciliation") return "Provider outcome requires reconciliation"
  return `Blocked: ${state.reason.replaceAll("_", " ")}`
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
