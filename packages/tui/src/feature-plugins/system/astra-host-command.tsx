/** @jsxImportSource @opentui/solid */

import type {
  HostCommandControlPreview,
  HostCommandDecisionResult,
  HostCommandProgress,
} from "@astra/domain/host-command-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createAstraHostCommandClient, type AstraHostCommandClient } from "../../astra/host-command-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-host-command"

type HostCommandState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "preparing"; script: string; accepted: boolean }>
  | Readonly<{ status: "prepared"; script: string; preview: HostCommandControlPreview }>
  | Readonly<{
      status: "deciding"
      script: string
      preview: HostCommandControlPreview
      decision: "approve" | "reject"
      accepted: boolean
    }>
  | Readonly<{
      status: "progress"
      script: string
      preview: HostCommandControlPreview
      phase: HostCommandProgress["status"]
    }>
  | Readonly<{ status: "terminal"; script: string; result: HostCommandDecisionResult }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; operationID: string }>

export function AstraHostCommandView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraHostCommandClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const valueWidth = createMemo(() => Math.max(24, dimensions().width - 18))
  const [state, setState] = createSignal<HostCommandState>({ status: "idle" })
  let generation = 0
  let abort: AbortController | undefined
  let scroll: ScrollBoxRenderable | undefined

  const compose = () => {
    if (props.authority.mode !== "activate-once") {
      setState({ status: "blocked", reason: "read_only" })
      return
    }
    if (hostCommandProposalUnsettled(state().status) || props.api.ui.dialog.open) return
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="Governed host shell"
        placeholder="Exact zsh script · maximum 4096 UTF-8 bytes"
        onConfirm={(script) => {
          if (!validScript(script)) return
          props.api.ui.dialog.clear()
          const currentGeneration = ++generation
          abort?.abort()
          abort = new AbortController()
          setState({ status: "preparing", script, accepted: false })
          void props.client
            .prepare(script, {
              signal: abort.signal,
              onAccepted() {
                if (generation === currentGeneration) setState({ status: "preparing", script, accepted: true })
              },
            })
            .then((result) => {
              if (generation !== currentGeneration) return
              if (result.status === "prepared") setState({ status: "prepared", script, preview: result.preview })
              else setState({ status: "blocked", reason: result.reason })
            })
            .catch(() => {
              if (generation === currentGeneration) setState({ status: "blocked", reason: "shell_control_failed" })
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
        setState({ status: "terminal", script: current.script, result })
      })
      .catch(() => {
        if (generation === currentGeneration) {
          setState({ status: "reconciliation", operationID: current.preview.operationID })
        }
      })
  }

  const close = () => {
    if (hostCommandProposalUnsettled(state().status)) return
    generation++
    abort?.abort()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  // Approval and rejection are physical local gestures, never dispatchable commands.
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.shift || event.repeated || props.api.ui.dialog.open) return
    if (event.name === "up" || event.name === "down" || event.name === "pageup" || event.name === "pagedown") {
      event.preventDefault()
      event.stopPropagation()
      if (event.name === "up") scroll?.scrollBy(-1)
      if (event.name === "down") scroll?.scrollBy(1)
      if (event.name === "pageup" && scroll) scroll.scrollBy(-scroll.height)
      if (event.name === "pagedown" && scroll) scroll.scrollBy(scroll.height)
      return
    }
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
      { name: "astra.shell.compose", title: "Enter Exact Script", category: "Astra", run: compose },
      { name: "astra.shell.close", title: "Close Governed Shell", category: "Astra", run: close },
    ],
    bindings: [
      { key: "p", cmd: "astra.shell.compose", desc: "Script" },
      { key: "escape", cmd: "astra.shell.close", desc: "Close" },
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
        <text fg={props.api.theme.current.text}>Astra Governed Shell</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>p script · a approve · d reject · ↑↓ scroll · esc close</text>
      </box>
      <text flexShrink={0} fg={props.api.theme.current.error}>
        HOST EXECUTION — NO SANDBOX
      </text>
      <text flexShrink={0} fg={props.api.theme.current.error}>
        HOST FILESYSTEM UNRESTRICTED · COMMAND-DEFINED WRITES
      </text>
      <text flexShrink={0} fg={props.api.theme.current.error}>
        HOST NETWORK UNRESTRICTED · EXACT OUTPUT IS NOT VERIFICATION
      </text>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
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
        <Row label="STATE" value={hostCommandStateLabel(state())} api={props.api} />
        <For each={scriptLines(state())}>
          {(line) => <Row label="SCRIPT" value={Locale.truncate(line, valueWidth())} api={props.api} />}
        </For>
        <Show when={previewOf(state())}>
          {(preview) => (
            <>
              <Row label="OPERATION" value={preview().operationID} api={props.api} />
              <Row
                label="EXECUTABLE"
                value={`${preview().executable} ${preview().argvPrefix.join(" ")}`}
                api={props.api}
              />
              <Row
                label="SCRIPT DIGEST"
                value={Locale.truncate(preview().scriptDigest, valueWidth())}
                api={props.api}
              />
              <For each={preview().environment}>
                {(entry) => (
                  <Row
                    label="ENV"
                    value={`${entry.name}=${Locale.truncate(entry.value, valueWidth() - entry.name.length - 1)}`}
                    api={props.api}
                  />
                )}
              </For>
              <For each={preview().resources}>
                {(resource) => <Row label="RESOURCE" value={Locale.truncate(resource, valueWidth())} api={props.api} />}
              </For>
              <Row label="FILESYSTEM" value="HOST UNRESTRICTED" api={props.api} />
              <Row label="NETWORK" value="HOST UNRESTRICTED" api={props.api} />
              <Row label="WRITES" value="COMMAND DEFINED" api={props.api} />
              <Row label="EXPIRES" value={preview().expiresAt} api={props.api} />
              <Row
                label="CAPABILITY"
                value={Locale.truncate(preview().capabilityDigest, valueWidth())}
                api={props.api}
              />
              <Row label="VERIFY" value="NOT VERIFIED" api={props.api} />
            </>
          )}
        </Show>
        <Show when={terminalOf(state())}>
          {(result) => (
            <>
              <Row label="RESULT" value={hostCommandTerminalLabel(result())} api={props.api} />
              <Show when={outputOf(result())}>
                {(output) => (
                  <>
                    <Row
                      label="EXIT"
                      value={output().exitCode === null ? "UNKNOWN" : `${output().exitCode}`}
                      api={props.api}
                    />
                    <Row label="DIGEST" value={Locale.truncate(output().outputDigest, valueWidth())} api={props.api} />
                    <Row label="DIGEST SCOPE" value="STDOUT + STDERR + EXIT" api={props.api} />
                    <For each={output().stdoutLines}>
                      {(line) => <Row label="STDOUT" value={Locale.truncate(line, valueWidth())} api={props.api} />}
                    </For>
                    <For each={output().stderrLines}>
                      {(line) => <Row label="STDERR" value={Locale.truncate(line, valueWidth())} api={props.api} />}
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
      </scrollbox>
    </box>
  )
}

export function registerAstraHostCommand(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = createAstraHostCommandClient(process.env, authority.sessionID, {
    expectedWorkspaceRoot: authority.workspace.root,
  }),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraHostCommandView
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
        name: "astra.shell.open",
        title: "Governed Host Shell",
        slashName: "shell",
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

export function hostCommandProposalUnsettled(status: HostCommandState["status"]) {
  return status === "preparing" || status === "prepared" || status === "deciding" || status === "progress"
}

function scriptLines(state: HostCommandState) {
  if (!("script" in state)) return []
  return state.script.split("\n").map((line) => line.replaceAll("\t", "    "))
}

function previewOf(state: HostCommandState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}

function terminalOf(state: HostCommandState) {
  return state.status === "terminal" ? state.result : undefined
}

function outputOf(result: HostCommandDecisionResult) {
  return "output" in result ? (result.output ?? undefined) : undefined
}

function blockedOf(state: HostCommandState) {
  if (state.status === "blocked") return state.reason
  if (state.status === "terminal" && state.result.status === "blocked") return state.result.reason
  return undefined
}

function reconciliationOf(state: HostCommandState) {
  if (state.status === "reconciliation") return state.operationID
  if (state.status === "terminal" && state.result.status === "reconciliation_required") return state.result.operationID
  return undefined
}

function hostCommandStateLabel(state: HostCommandState) {
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
  return hostCommandTerminalLabel(state.result)
}

export function hostCommandTerminalLabel(result: HostCommandDecisionResult) {
  if (result.status === "completed_observed_not_verified") return "COMPLETED · OUTPUT OBSERVED · NOT VERIFIED"
  if (result.status === "denied_without_effect") return "DENIED · NO EFFECT"
  if (result.status === "failed_without_effect") return "FAILED · NO EFFECT"
  if (result.status === "reconciliation_required") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
  return "BLOCKED · NO EFFECT CLAIMED"
}

function validScript(input: string) {
  return (
    input.trim().length > 0 &&
    Buffer.byteLength(input) <= 4_096 &&
    !input.includes("\0") &&
    !/\p{C}/u.test(input.replaceAll("\n", "").replaceAll("\t", ""))
  )
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
