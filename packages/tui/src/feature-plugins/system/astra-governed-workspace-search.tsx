/** @jsxImportSource @opentui/solid */

import type {
  WorkspaceSearchControlPreview,
  WorkspaceSearchDecisionResult,
  WorkspaceSearchProgress,
} from "@astra/domain/governed-workspace-search-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  createAstraGovernedWorkspaceSearchClient,
  type AstraGovernedWorkspaceSearchClient,
} from "../../astra/governed-workspace-search-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-governed-workspace-search"

type SearchState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "preparing"; query: string; accepted: boolean }>
  | Readonly<{ status: "prepared"; query: string; preview: WorkspaceSearchControlPreview }>
  | Readonly<{
      status: "deciding"
      query: string
      preview: WorkspaceSearchControlPreview
      decision: "approve" | "reject"
      accepted: boolean
    }>
  | Readonly<{
      status: "progress"
      query: string
      preview: WorkspaceSearchControlPreview
      phase: WorkspaceSearchProgress["status"]
    }>
  | Readonly<{ status: "terminal"; query: string; result: WorkspaceSearchDecisionResult }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; operationID: string }>

export function AstraGovernedWorkspaceSearchView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraGovernedWorkspaceSearchClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const valueWidth = createMemo(() => Math.max(24, dimensions().width - 18))
  const [state, setState] = createSignal<SearchState>({ status: "idle" })
  let generation = 0
  let abort: AbortController | undefined

  const compose = () => {
    if (props.authority.mode !== "activate-once") {
      setState({ status: "blocked", reason: "read_only" })
      return
    }
    if (proposalUnsettled(state()) || props.api.ui.dialog.open) return
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="Literal workspace search"
        placeholder="Fixed text only · maximum 512 UTF-8 bytes"
        onConfirm={(query) => {
          if (!query || Buffer.byteLength(query) > 512 || /\p{C}/u.test(query)) return
          props.api.ui.dialog.clear()
          const currentGeneration = ++generation
          abort?.abort()
          abort = new AbortController()
          setState({ status: "preparing", query, accepted: false })
          void props.client
            .prepare(query, {
              signal: abort.signal,
              onAccepted() {
                if (generation === currentGeneration) setState({ status: "preparing", query, accepted: true })
              },
            })
            .then((result) => {
              if (generation !== currentGeneration) return
              if (result.status === "prepared") setState({ status: "prepared", query, preview: result.preview })
              else setState({ status: "blocked", reason: result.reason })
            })
            .catch(() => {
              if (generation === currentGeneration) setState({ status: "blocked", reason: "search_control_failed" })
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
    setState({ ...current, status: "deciding", decision, accepted: false })
    void props.client
      .decide(current.preview.proposalID, decision, {
        onAccepted() {
          if (generation === currentGeneration) setState({ ...current, status: "deciding", decision, accepted: true })
        },
        onProgress(progress) {
          if (generation === currentGeneration) setState({ ...current, status: "progress", phase: progress.status })
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (result.status === "reconciliation_required") {
          setState({ status: "reconciliation", operationID: result.operationID })
          return
        }
        setState({ status: "terminal", query: current.query, result })
      })
      .catch(() => {
        if (generation === currentGeneration) {
          setState({ status: "reconciliation", operationID: current.preview.operationID })
        }
      })
  }

  const close = () => {
    if (proposalUnsettled(state())) return
    generation++
    abort?.abort()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  // Consent is a local keyboard gesture and has no dispatchable command name.
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.shift || event.repeated || props.api.ui.dialog.open) return
    const decision = event.name.toLowerCase() === "a" ? "approve" : event.name.toLowerCase() === "d" ? "reject" : null
    if (!decision || state().status !== "prepared") return
    event.preventDefault()
    event.stopPropagation()
    decide(decision)
  })

  onCleanup(() => {
    generation++
    abort?.abort()
  })

  useBindings(() => ({
    enabled: !props.api.ui.dialog.open,
    commands: [
      { name: "astra.search.query", title: "Enter Literal Search", category: "Astra", run: compose },
      { name: "astra.search.close", title: "Close Workspace Search", category: "Astra", run: close },
    ],
    bindings: [
      { key: "p", cmd: "astra.search.query", desc: "Query" },
      { key: "escape", cmd: "astra.search.close", desc: "Close" },
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
        <text fg={props.api.theme.current.text}>Astra Workspace Search</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>p query · a approve · d reject · esc close</text>
      </box>
      <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
      <text fg={props.api.theme.current.warning}>FIXED TEXT · NO SHELL · NO WRITES · HOST NETWORK UNRESTRICTED</text>
      <box height={1} />
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
      <Show when={queryOf(state())}>
        {(query) => <Row label="QUERY" value={Locale.truncate(query(), valueWidth())} api={props.api} />}
      </Show>
      <Show when={previewOf(state())}>
        {(preview) => (
          <>
            <Row label="OPERATION" value={preview().operationID} api={props.api} />
            <Row label="EXECUTABLE" value={preview().executable} api={props.api} />
            <Row label="MODE" value="RECURSIVE FIXED STRING" api={props.api} />
            <For each={preview().resources}>
              {(resource) => <Row label="RESOURCE" value={Locale.truncate(resource, valueWidth())} api={props.api} />}
            </For>
            <Row label="WRITES" value="NONE" api={props.api} />
            <Row label="NETWORK" value="NOT REQUESTED · HOST UNRESTRICTED" api={props.api} />
            <Row label="EXPIRES" value={preview().expiresAt} api={props.api} />
            <Row label="CAPABILITY" value={Locale.truncate(preview().capabilityDigest, valueWidth())} api={props.api} />
            <Row label="VERIFY" value="NOT VERIFIED" api={props.api} />
          </>
        )}
      </Show>
      <Show when={terminalOf(state())}>
        {(result) => (
          <>
            <Row label="RESULT" value={workspaceSearchTerminalLabel(result())} api={props.api} />
            <Show when={outputOf(result())}>
              {(output) => (
                <>
                  <Row label="OUTCOME" value={output().outcome.replaceAll("_", " ").toUpperCase()} api={props.api} />
                  <Row label="LINES" value={`${output().outputLineCount ?? "UNKNOWN"}`} api={props.api} />
                  <Row label="DIGEST" value={Locale.truncate(output().outputDigest, valueWidth())} api={props.api} />
                  <Row label="DIGEST SCOPE" value="STDOUT ONLY" api={props.api} />
                  <For each={output().displayLines}>
                    {(line) => <Row label="OUTPUT" value={Locale.truncate(line, valueWidth())} api={props.api} />}
                  </For>
                  <Show when={output().truncated}>
                    <Row label="OUTPUT" value="DISPLAY TRUNCATED" api={props.api} />
                  </Show>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={blockedOf(state())}>
        {(reason) => <Row label="REASON" value={reason().replaceAll("_", " ")} api={props.api} />}
      </Show>
      <Show when={reconciliationOf(state())}>{(id) => <Row label="OPERATION" value={id()} api={props.api} />}</Show>
    </box>
  )
}

export function registerAstraGovernedWorkspaceSearch(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = createAstraGovernedWorkspaceSearchClient(process.env, authority.sessionID, {
    expectedWorkspaceRoot: authority.workspace.root,
  }),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraGovernedWorkspaceSearchView
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
        name: "astra.search.open",
        title: "Workspace Literal Search",
        slashName: "search",
        category: "Astra",
        namespace: "palette",
        run() {
          if (api.route.current.name === routeName) return
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

function proposalUnsettled(state: SearchState) {
  return workspaceSearchProposalUnsettled(state.status)
}

export function workspaceSearchProposalUnsettled(status: SearchState["status"]) {
  return status === "preparing" || status === "prepared" || status === "deciding" || status === "progress"
}

function queryOf(state: SearchState) {
  return "query" in state ? state.query : undefined
}

function previewOf(state: SearchState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}

function terminalOf(state: SearchState) {
  return state.status === "terminal" ? state.result : undefined
}

function outputOf(result: WorkspaceSearchDecisionResult) {
  return "output" in result ? (result.output ?? undefined) : undefined
}

function blockedOf(state: SearchState) {
  if (state.status === "blocked") return state.reason
  if (state.status === "terminal" && state.result.status === "blocked") return state.result.reason
  return undefined
}

function reconciliationOf(state: SearchState) {
  return state.status === "reconciliation" ? state.operationID : undefined
}

function stateLabel(state: SearchState) {
  if (state.status === "idle") return "IDLE · NO REQUEST · NO EFFECT"
  if (state.status === "preparing") return state.accepted ? "PREPARING · NOT VERIFIED" : "QUEUED · NO EFFECT"
  if (state.status === "prepared") return "AWAITING LOCAL A/D DECISION · NOT VERIFIED"
  if (state.status === "deciding") {
    if (!state.accepted) return "DECISION QUEUED · NOT VERIFIED"
    return state.decision === "approve" ? "REQUEST AUTHENTICATED · NOT VERIFIED" : "REJECTION AUTHENTICATED · NO EFFECT"
  }
  if (state.status === "progress") {
    if (state.phase === "recording_authority") return "RECORDING AUTHORITY · NOT VERIFIED"
    if (state.phase === "executing_host") return "HOST EXECUTION · NOT VERIFIED"
    return "EFFECT OBSERVED · NOT VERIFIED"
  }
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
  if (state.status === "blocked") return "BLOCKED · NO EFFECT CLAIMED"
  return workspaceSearchTerminalLabel(state.result)
}

export function workspaceSearchTerminalLabel(result: WorkspaceSearchDecisionResult) {
  if (result.status === "completed_observed_not_verified") return "OBSERVED — NOT VERIFIED"
  if (result.status === "denied_without_effect") return "DENIED · NO EFFECT"
  if (result.status === "failed_without_effect") return "FAILED · NO EFFECT"
  if (result.status === "reconciliation_required") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
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
