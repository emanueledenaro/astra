/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { GitControlInspectionSummary } from "@astra/domain/git-control-inspection"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import {
  AstraControlClientError,
  createAstraGitInspectionClient,
  type AstraGitInspectionClient,
} from "../../astra/control-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-git-control"

export type AstraGitControlPlaneState = Readonly<{
  workspace: string
  mode: "read-only" | "activate-once"
}>

type InspectionState =
  | Readonly<{ status: "not_inspected" }>
  | Readonly<{ status: "queued" }>
  | Readonly<{ status: "running"; requestId: string }>
  | Readonly<{
      status: "completed"
      requestId: string
      summary: Extract<GitControlInspectionSummary, { status: "complete" }>
    }>
  | Readonly<{
      status: "blocked"
      requestId?: string
      reason:
        | Extract<GitControlInspectionSummary, { status: "blocked" }>["reason"]
        | "control_unavailable"
        | "control_transport_failed"
        | "control_response_timed_out"
        | "protocol_invalid"
    }>

export function AstraGitControlPlaneView(props: {
  api: TuiPluginApi
  state: AstraGitControlPlaneState
  client: AstraGitInspectionClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 72)
  const workspaceWidth = createMemo(() => Math.max(16, dimensions().width - 14))
  const [inspection, setInspection] = createSignal<InspectionState>({ status: "not_inspected" })
  const completed = createMemo(() => {
    const current = inspection()
    return current.status === "completed" ? current : undefined
  })
  const blocked = createMemo(() => {
    const current = inspection()
    return current.status === "blocked" ? current : undefined
  })
  let generation = 0
  let abort: AbortController | undefined

  const close = () => {
    generation++
    abort?.abort()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  const inspect = () => {
    const current = inspection()
    if (current.status === "queued" || current.status === "running") return
    const currentGeneration = ++generation
    abort?.abort()
    abort = new AbortController()
    setInspection({ status: "queued" })
    void props.client
      .inspect({
        signal: abort.signal,
        onAccepted(requestId) {
          if (generation !== currentGeneration) return
          setInspection({ status: "running", requestId })
        },
      })
      .then(({ requestId, summary }) => {
        if (generation !== currentGeneration) return
        if (summary.status === "complete") {
          setInspection({ status: "completed", requestId, summary })
          return
        }
        setInspection({ status: "blocked", requestId, reason: summary.reason })
      })
      .catch((error) => {
        if (generation !== currentGeneration) return
        setInspection({ status: "blocked", reason: clientFailureReason(error) })
      })
  }

  onCleanup(() => {
    generation++
    abort?.abort()
  })

  useBindings(() => ({
    commands: [
      {
        name: "astra.git.inspect",
        title: "Inspect Git Workspace",
        category: "Astra",
        run: inspect,
      },
      {
        name: "astra.git.close",
        title: "Close Git Control Plane",
        category: "Astra",
        run: close,
      },
    ],
    bindings: [
      { key: "i", cmd: "astra.git.inspect", desc: "Inspect Git Workspace" },
      { key: "escape", cmd: "astra.git.close", desc: "Close Git Control Plane" },
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
        <text fg={props.api.theme.current.text}>Git Control Plane</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>i inspect esc close</text>
      </box>
      <text fg={props.api.theme.current.warning}>HOST EXECUTION — NO SANDBOX</text>
      <box height={1} />
      <Row label="WORKSPACE" value={Locale.truncateLeft(props.state.workspace, workspaceWidth())} api={props.api} />
      <Row label="MODE" value={props.state.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="BOUNDS" value="BOUNDED READ ONLY • NOT VERIFIED" api={props.api} />
      <Row label="STATE" value={stateLabel(inspection())} api={props.api} />
      <Row
        label="INSPECT"
        value={isWorking(inspection()) ? "inspection in progress" : "press i to inspect"}
        api={props.api}
      />
      <Show when={completed()}>
        {(current) => (
          <>
            <Row label="CHANGES" value={countsLabel(current().summary.counts)} api={props.api} />
            <Row
              label="REPORT"
              value={Locale.truncate(current().summary.reportDigest, workspaceWidth())}
              api={props.api}
            />
          </>
        )}
      </Show>
      <Show when={blocked()}>
        {(current) => <Row label="REASON" value={current().reason.replaceAll("_", " ")} api={props.api} />}
      </Show>
      <Show when={compact()}>
        <Row label="MUTATIONS" value="unavailable" api={props.api} />
        <Row label="" value="write operations unavailable" api={props.api} />
        <Row label="PUSH" value="UNAVAILABLE" api={props.api} />
        <Row label="" value="separate authorization required" api={props.api} />
      </Show>
      <Show when={!compact()}>
        <Row label="MUTATIONS" value="unavailable until the Operation Kernel adapter exists" api={props.api} />
        <Row label="PUSH" value="UNAVAILABLE — separate authorization required" api={props.api} />
      </Show>
    </box>
  )
}

function Row(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={12} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

export function registerAstraGitControlPlane(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = createAstraGitInspectionClient({}, authority.sessionID),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraGitControlPlaneView
          api={api}
          state={{ workspace: authority.workspace.root, mode: authority.mode }}
          client={client}
          returnRoute={parseReturnRoute(input.params?.returnRoute)}
        />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "astra.git.open",
        title: "Git Control Plane",
        slashName: "git",
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

function isWorking(state: InspectionState) {
  return state.status === "queued" || state.status === "running"
}

function stateLabel(state: InspectionState) {
  if (state.status === "not_inspected") return "NOT INSPECTED • NOT VERIFIED"
  if (state.status === "queued") return "QUEUED • NOT VERIFIED"
  if (state.status === "running") return "RUNNING • NOT VERIFIED"
  if (state.status === "completed") return "COMPLETED • OBSERVED • NOT VERIFIED"
  return "BLOCKED • NOT VERIFIED"
}

function countsLabel(counts: Extract<GitControlInspectionSummary, { status: "complete" }>["counts"]) {
  return `${counts.total} total • ${counts.staged} staged • ${counts.unstaged} unstaged • ${counts.untracked} untracked • ${counts.conflicts} conflicts`
}

function clientFailureReason(error: unknown): Extract<InspectionState, { status: "blocked" }>["reason"] {
  if (!(error instanceof AstraControlClientError)) return "protocol_invalid"
  if (error.code === "unavailable") return "control_unavailable"
  if (error.code === "transport_failed") return "control_transport_failed"
  if (error.code === "timed_out") return "control_response_timed_out"
  if (error.code === "busy") return "control_busy"
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
