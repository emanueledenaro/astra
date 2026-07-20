/** @jsxImportSource @opentui/solid */

import type {
  ProviderControlCatalog,
  ProviderConversationTranscript,
  ProviderTurnDecisionResult,
  ProviderTurnPreview,
  ProviderTurnProgress,
  ProviderTurnSelection,
} from "@astra/domain/provider-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createAstraProviderClient, type AstraProviderClient } from "../../astra/provider-client"
import type { AstraProviderOperationView } from "../../astra/provider-operation-view"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-chat"
const maximumVisibleHistoryTurns = 8

type ChatTurn = Readonly<{
  providerID: string
  modelID: string
  userText: string
  assistantText: string
  finishReason: string
}>

type ChatContext = Readonly<{
  catalog: ProviderControlCatalog
  selection: ProviderTurnSelection
}>

export type ProviderSelectionChoice = Readonly<{
  title: string
  description: string
  value: string
  selection: ProviderTurnSelection
}>

type ChatState =
  | Readonly<{ status: "loading_catalog" }>
  | (Readonly<{ status: "ready" }> & ChatContext)
  | (Readonly<{ status: "preparing"; userText: string }> & ChatContext)
  | (Readonly<{
      status: "prepared"
      userText: string
      preview: ProviderTurnPreview
    }> &
      ChatContext)
  | (Readonly<{
      status: "deciding"
      userText: string
      preview: ProviderTurnPreview
      decision: "approve" | "reject"
    }> &
      ChatContext)
  | (Readonly<{
      status: "progress"
      userText: string
      preview: ProviderTurnPreview
      phase: ProviderTurnProgress["status"]
    }> &
      ChatContext)
  | (Readonly<{
      status: "completed"
      userText: string
      preview: ProviderTurnPreview
      result: Extract<ProviderTurnDecisionResult, { status: "response_observed_not_verified" }>
    }> &
      ChatContext)
  | (Readonly<{ status: "denied"; userText: string; preview: ProviderTurnPreview }> & ChatContext)
  | Readonly<{ status: "blocked"; reason: string; context?: ChatContext }>
  | Readonly<{ status: "reconciliation"; operationID: string; preview: ProviderTurnPreview }>

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
  providerOperation?: AstraProviderOperationView
  decisionRequired: boolean
}>

export function AstraChatView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraProviderClient
  returnRoute?: TuiRouteCurrent
  embedded?: boolean
  bindingsSuspended?: boolean
  workDecisionHasFocus?: boolean
  onActivity?: (activity: AstraChatActivity) => void
}) {
  const dimensions = useTerminalDimensions()
  const valueWidth = createMemo(() => Math.max(24, dimensions().width - 18))
  const [state, setState] = createSignal<ChatState>({
    status: "loading_catalog",
  })
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
        if (result.status === "unavailable") {
          setState({ status: "blocked", reason: result.reason })
          return
        }
        const selection = initialSelection(result.catalog)
        if (!selection) {
          setState({ status: "blocked", reason: "provider_rejected" })
          return
        }
        if (result.transcript.turns.length > 0 || history().length === 0) {
          setHistory(transcriptTurns(result.transcript))
        }
        setState({ status: "ready", catalog: result.catalog, selection })
      })
      .catch(() => {
        if (generation === currentGeneration)
          setState({
            status: "blocked",
            reason: "provider_control_unavailable",
          })
      })
  }

  const selectModel = () => {
    const current = state()
    if (current.status !== "ready") return
    const provider = current.catalog.providers.find(
      (candidate) => candidate.providerID === current.selection.providerID,
    )
    if (!provider) return
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={`Select ${provider.providerName} model`}
        current={current.selection.modelID}
        options={provider.models.map((model) => ({
          title: model.name,
          description: model.id,
          value: model.id,
          onSelect: () => {
            setState({
              ...current,
              selection: { ...current.selection, modelID: model.id },
            })
            props.api.ui.dialog.clear()
          },
        }))}
      />
    ))
  }

  const selectProvider = () => {
    const current = state()
    if (current.status !== "ready") return
    const choices = providerSelectionChoices(current.catalog)
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title="Select certified provider credential"
        current={providerSelectionValue(current.selection)}
        options={choices.map((choice) => ({
          title: choice.title,
          description: choice.description,
          value: choice.value,
          onSelect: () => {
            setState({ ...current, selection: choice.selection })
            props.api.ui.dialog.clear()
          },
        }))}
      />
    ))
  }

  const compose = () => {
    const current = state()
    if (props.authority.mode !== "activate-once") {
      setState({ status: "blocked", reason: "read_only" })
      return
    }
    if (current.status !== "ready" && current.status !== "completed" && current.status !== "denied") return
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="Message Astra"
        placeholder="Ask one question without tools or file access"
        onConfirm={(raw) => {
          const userText = raw.trim()
          if (!userText) return
          props.api.ui.dialog.clear()
          if (userText === "/connect") {
            void props.api.keymap.dispatchCommand("astra.provider.connect")
            return
          }
          const currentGeneration = ++generation
          abort = new AbortController()
          setState({
            status: "preparing",
            catalog: current.catalog,
            selection: current.selection,
            userText,
          })
          void props.client
            .prepare(current.selection, userText, { signal: abort.signal })
            .then((result) => {
              if (generation !== currentGeneration) return
              if (result.status === "blocked") {
                setState({
                  status: "blocked",
                  reason: result.reason,
                  context: current,
                })
                return
              }
              setState({
                status: "prepared",
                catalog: current.catalog,
                selection: current.selection,
                userText,
                preview: result.preview,
              })
            })
            .catch(() => {
              if (generation === currentGeneration)
                setState({
                  status: "blocked",
                  reason: "provider_control_failed",
                })
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
          if (generation === currentGeneration)
            setState({
              ...current,
              status: "progress",
              phase: progress.status,
            })
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (result.status === "response_observed_not_verified") {
          setHistory((turns) =>
            [
              ...turns,
              {
                providerID: current.selection.providerID,
                modelID: current.selection.modelID,
                userText: current.userText,
                assistantText: result.response.assistantText,
                finishReason: result.response.finishReason,
              },
            ].slice(-maximumVisibleHistoryTurns),
          )
          setState({
            status: "completed",
            catalog: current.catalog,
            selection: current.selection,
            userText: current.userText,
            preview: current.preview,
            result,
          })
          return
        }
        if (result.status === "denied_without_effect") {
          if (afterDenied) return afterDenied()
          setState({
            status: "denied",
            catalog: current.catalog,
            selection: current.selection,
            userText: current.userText,
            preview: current.preview,
          })
          return
        }
        if (result.status === "reconciliation_required") {
          setState({
            status: "reconciliation",
            operationID: current.preview.operationID,
            preview: current.preview,
          })
          return
        }
        setState({ status: "blocked", reason: result.reason })
      })
      .catch(() => {
        if (generation === currentGeneration) {
          setState({
            status: "reconciliation",
            operationID: current.preview.operationID,
            preview: current.preview,
          })
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
    enabled: !props.api.ui.dialog.open && props.bindingsSuspended !== true,
    commands: [
      {
        name: "astra.chat.provider",
        title: "Select Chat Provider",
        category: "Astra",
        run: selectProvider,
      },
      {
        name: "astra.chat.model",
        title: "Select Chat Model",
        category: "Astra",
        run: selectModel,
      },
      {
        name: "astra.chat.compose",
        title: "Compose Chat Message",
        category: "Astra",
        run: compose,
      },
      ...(providerDecisionEligible(state(), props)
        ? [
            {
              name: "astra.chat.approve",
              title: "Approve Provider Turn",
              category: "Astra",
              run: () => decide("approve"),
            },
            {
              name: "astra.chat.reject",
              title: "Reject Provider Turn",
              category: "Astra",
              run: () => decide("reject"),
            },
          ]
        : []),
      {
        name: "astra.chat.reset",
        title: "Reload Chat Catalog",
        category: "Astra",
        run: reset,
      },
      {
        name: "astra.chat.close",
        title: "Close Chat",
        category: "Astra",
        run: close,
      },
    ],
    bindings: [
      { key: "v", cmd: "astra.chat.provider", desc: "Provider" },
      { key: "m", cmd: "astra.chat.model", desc: "Model" },
      { key: "p", cmd: "astra.chat.compose", desc: "Prompt" },
      ...(providerDecisionEligible(state(), props)
        ? [
            { key: "a", cmd: "astra.chat.approve", desc: "Approve" },
            { key: "d", cmd: "astra.chat.reject", desc: "Reject" },
          ]
        : []),
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
        <text fg={props.api.theme.current.primary}>
          {props.embedded ? "CONVERSATION" : `Astra Chat · ${selectedProviderName(state())}`}
        </text>
        <box flexGrow={1} />
        <Show when={!props.embedded || dimensions().width >= 104}>
          <text fg={props.api.theme.current.textMuted}>
            {props.embedded
              ? `p message · v provider · m model${providerDecisionEligible(state(), props) ? " · a/d decision" : ""}`
              : `v provider m model p prompt${providerDecisionEligible(state(), props) ? " a approve d reject" : ""} r reload esc close`}
          </text>
        </Show>
      </box>
      <Show when={!props.embedded}>
        <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
        <text fg={props.api.theme.current.warning}>NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX</text>
        <text fg={props.api.theme.current.warning}>
          PARENT-OWNED DURABLE HISTORY · VERIFIED ON LOAD · NO TOOLS · RESPONSES NOT VERIFIED
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
        <Show when={!previewOf(state()) && selectionOf(state())}>
          {(selection) => (
            <Row
              label="PROVIDER"
              value={`${selectedProviderName(state())} · ${selection().credentialProfile}`}
              api={props.api}
            />
          )}
        </Show>
        <Show when={modelOf(state())}>{(model) => <Row label="MODEL" value={model()} api={props.api} />}</Show>
        <Show when={!previewOf(state()) && unverifiedProviderLabel(state())}>
          {(label) => <Row label="COMPATIBLE" value={label()} api={props.api} />}
        </Show>
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
            <text
              fg={props.api.theme.current.textMuted}
            >{`YOU · IN CONVERSATION · ${turn.providerID}/${turn.modelID}`}</text>
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
          <text fg={props.api.theme.current.warning}>
            {props.workDecisionHasFocus
              ? "WAITING — WORK DECISION HAS FOCUS"
              : "APPROVAL REQUIRED — review the Control Rail"}
          </text>
          <text fg={props.api.theme.current.textMuted}>
            {props.workDecisionHasFocus
              ? "Resolve the work decision first · no network request has started"
              : "A approve · D reject · no network request has started"}
          </text>
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
            value={`Run /connect to configure ${selectedProviderName(state())} through Astra.`}
            api={props.api}
          />
          <Row label="THEN" value="Astra reconnects this workspace automatically." api={props.api} />
          <Row label="SECRET" value="Never exposed to chat, the AI, plugins, or MCP." api={props.api} />
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

function providerDecisionEligible(
  state: ChatState,
  props: Readonly<{ bindingsSuspended?: boolean; workDecisionHasFocus?: boolean }>,
) {
  return state.status === "prepared" && props.bindingsSuspended !== true && props.workDecisionHasFocus !== true
}

function modelOf(state: ChatState) {
  return selectionOf(state)?.modelID
}

function selectionOf(state: ChatState) {
  if ("selection" in state) return state.selection
  return state.status === "blocked" ? state.context?.selection : undefined
}

function previewOf(state: ChatState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}

function operationPreviewOf(state: ChatState) {
  return previewOf(state) ??
    (state.status === "completed" || state.status === "denied" || state.status === "reconciliation"
      ? state.preview
      : undefined)
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
  const preview = operationPreviewOf(state)
  const selection = selectionOf(state)
  const modelID = modelOf(state)
  return {
    status: state.status,
    label: stateLabel(state),
    summary: activitySummary(state),
    ...(selection
      ? {
          providerID: selection.providerID,
          providerName: selectedProviderName(state),
        }
      : {}),
    ...(modelID ? { modelID } : {}),
    ...(preview ? { operationID: preview.operationID } : {}),
    ...(preview
      ? {
          destination: `${preview.destination.origin}${preview.destination.path}`,
        }
      : {}),
    ...(preview ? { payloadBytes: preview.logicalPayload.bytes } : {}),
    ...(preview ? { providerOperation: providerOperationView(state, preview) } : {}),
    decisionRequired: state.status === "prepared",
  }
}

function providerOperationView(state: ChatState, preview: ProviderTurnPreview): AstraProviderOperationView {
  return {
    state: providerOperationState(state),
    statusLabel: providerOperationStatusLabel(state),
    operationID: preview.operationID,
    providerID: preview.providerID,
    providerName: selectedProviderName(state),
    modelID: preview.modelID,
    credentialProfile: preview.credential.profile,
    destination: `${preview.destination.origin}${preview.destination.path}`,
    payloadBytes: preview.logicalPayload.bytes,
    priorTurns: preview.conversation.priorTurns,
    historyBytes: preview.conversation.historyBytes,
    retention: preview.conversation.retention,
    hostBoundary: preview.hostBoundaryLabel,
    networkBoundary: preview.networkBoundaryLabel,
    capabilityDigest: preview.providerCapabilityDigest,
    headerNames: preview.headerNames,
    accountFingerprint: preview.credential.accountFingerprint,
    assurance: "NOT VERIFIED",
    decisionRequired: state.status === "prepared",
  }
}

function providerOperationState(state: ChatState): AstraProviderOperationView["state"] {
  if (state.status === "prepared") return "awaiting_decision"
  if (state.status === "deciding") return state.decision === "approve" ? "approving" : "rejecting"
  if (state.status === "denied") return "denied_without_effect"
  if (state.status === "completed") return "response_observed_not_verified"
  if (state.status === "reconciliation") return "reconciliation_required"
  return "in_progress"
}

function providerOperationStatusLabel(state: ChatState) {
  if (state.status === "prepared") return "AWAITING DECISION · NO NETWORK"
  if (state.status === "deciding") {
    return state.decision === "approve" ? "APPROVAL RECORDED · NOT VERIFIED" : "REJECTION RECORDING · NO EFFECT CLAIM"
  }
  if (state.status === "progress") return state.phase.replaceAll("_", " ").toUpperCase()
  if (state.status === "denied") return "DENIED WITHOUT EFFECT / NOT SENT"
  if (state.status === "completed") return "RESPONSE OBSERVED — NOT VERIFIED"
  return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
}

function catalogOf(state: ChatState) {
  if ("catalog" in state) return state.catalog
  return state.status === "blocked" ? state.context?.catalog : undefined
}

function selectedProviderName(state: ChatState) {
  const selection = selectionOf(state)
  return (
    catalogOf(state)?.providers.find((provider) => provider.providerID === selection?.providerID)?.providerName ??
    "No provider"
  )
}

function unverifiedProviderLabel(state: ChatState) {
  const providers = catalogOf(state)?.providers.filter((provider) => !provider.dispatchable) ?? []
  return providers.length === 0
    ? undefined
    : providers.map((provider) => `${provider.providerName} · ${provider.assurance} · DISABLED`).join("; ")
}

function initialSelection(catalog: ProviderControlCatalog): ProviderTurnSelection | undefined {
  return providerSelectionChoices(catalog)[0]?.selection
}

function selectionsForProvider(
  provider: ProviderControlCatalog["providers"][number],
): ReadonlyArray<ProviderTurnSelection> {
  if (provider.assurance !== "CERTIFIED" || !provider.dispatchable || !provider.models[0]) return []
  if (provider.providerID === "anthropic" && provider.credentialProfiles.includes("anthropic-api-key")) {
    return [
      {
        providerID: "anthropic",
        credentialProfile: "anthropic-api-key",
        modelID: provider.models[0].id,
      },
    ]
  }
  if (provider.providerID === "openai") {
    const model = provider.models.find((candidate) => candidate.id === "gpt-5.4") ?? provider.models[0]
    if (!model) return []
    const selections: ProviderTurnSelection[] = []
    if (provider.credentialProfiles.includes("openai-api-key")) {
      selections.push({
        providerID: "openai",
        credentialProfile: "openai-api-key",
        modelID: model.id,
      })
    }
    if (provider.credentialProfiles.includes("openai-codex-oauth")) {
      selections.push({
        providerID: "openai",
        credentialProfile: "openai-codex-oauth",
        modelID: model.id,
      })
    }
    return selections
  }
  return []
}

/** Returns one explicit TUI choice for every certified credential route. */
export function providerSelectionChoices(catalog: ProviderControlCatalog): ReadonlyArray<ProviderSelectionChoice> {
  return catalog.providers.flatMap((provider) =>
    selectionsForProvider(provider).map((selection) => ({
      title: providerSelectionTitle(selection),
      description: providerSelectionDescription(selection),
      value: providerSelectionValue(selection),
      selection,
    })),
  )
}

function providerSelectionTitle(selection: ProviderTurnSelection) {
  if (selection.providerID === "anthropic") return "Anthropic · API key"
  return selection.credentialProfile === "openai-api-key" ? "OpenAI · API key" : "OpenAI · Codex account"
}

function providerSelectionDescription(selection: ProviderTurnSelection) {
  if (selection.providerID === "anthropic") return "CERTIFIED · OpenCode credential · Anthropic API billing"
  return selection.credentialProfile === "openai-api-key"
    ? "CERTIFIED · OpenCode credential · OpenAI API billing"
    : "CERTIFIED · OpenCode credential · Codex OAuth subscription"
}

function providerSelectionValue(selection: ProviderTurnSelection) {
  return `${selection.providerID}:${selection.credentialProfile}`
}

function transcriptTurns(transcript: ProviderConversationTranscript): ReadonlyArray<ChatTurn> {
  return transcript.turns.slice(-maximumVisibleHistoryTurns).map((turn) => ({
    providerID: turn.providerID,
    modelID: turn.modelID,
    userText: turn.userText,
    assistantText: turn.assistantText,
    finishReason: turn.finishReason,
  }))
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
