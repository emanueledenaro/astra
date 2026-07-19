/** @jsxImportSource @opentui/solid */

import type { GitUnstageDecisionResult, GitUnstageControlPreview } from "@astra/domain/git-unstage-control"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup, Show } from "solid-js"
import { AstraControlClientError } from "../../astra/control-client"
import { createAstraGitUnstageClient, type AstraGitUnstageClient } from "../../astra/git-unstage-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-git-unstage"

type UnstageState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "preparing"; accepted: boolean }>
  | Readonly<{ status: "prepared"; preview: GitUnstageControlPreview }>
  | Readonly<{
      status: "deciding"
      preview: GitUnstageControlPreview
      decision: "approve" | "reject"
      accepted: boolean
    }>
  | Readonly<{
      status: "progress"
      preview: GitUnstageControlPreview
      phase: "recording_authority" | "host_adapter_validating" | "effect_observed_not_verified" | "verifying"
    }>
  | Readonly<{ status: "terminal"; result: GitUnstageDecisionResult }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; proposalDigest: string }>

export function AstraGitUnstageView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraGitUnstageClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal<UnstageState>({ status: "idle" })
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
    if (!props.authority.repositoryBaseline) {
      setState({ status: "blocked", reason: "git_baseline_required" })
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
        if (decision === "reject" && result.status !== "denied_without_git_effect") {
          setState({ status: "blocked", reason: "durable_rejection_unavailable" })
          return
        }
        setState({ status: "terminal", result })
      })
      .catch(() => {
        if (generation !== currentGeneration) return
        if (decision === "reject") {
          setState({ status: "blocked", reason: "rejection_status_unknown_no_git_effect" })
          return
        }
        setState({ status: "reconciliation", proposalDigest: current.preview.authority.proposalDigest })
      })
  }

  // Consent is a local keyboard gesture, never a remotely dispatchable command.
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.shift || event.repeated) return
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
    commands: [
      { name: "astra.git.unstage.prepare", title: "Prepare Unstage All", category: "Astra", run: prepare },
      { name: "astra.git.unstage.close", title: "Close Unstage All", category: "Astra", run: close },
    ],
    bindings: [
      { key: "p", cmd: "astra.git.unstage.prepare", desc: "Prepare" },
      { key: "escape", cmd: "astra.git.unstage.close", desc: "Close" },
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
        <text fg={props.api.theme.current.text}>Git Control Plane — Unstage all</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>p prepare a approve d reject esc close</text>
      </box>
      <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
      <text fg={props.api.theme.current.warning}>HOST NETWORK UNRESTRICTED — OPERATION REQUESTS NO NETWORK</text>
      <box height={1} />
      <Row
        label="WORKSPACE"
        value={Locale.truncateLeft(props.authority.workspace.root, valueWidth(dimensions().width))}
        api={props.api}
      />
      <Row label="MODE" value={props.authority.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="ACTION" value="Unstage all" api={props.api} />
      <Row label="STATE" value={stateLabel(state())} api={props.api} />
      <Show when={previewOf(state())}>
        {(preview) => (
          <>
            <Row label="STAGED" value={`${preview().authority.stagedCount} • GATE OBSERVED`} api={props.api} />
            <Row label="BASELINE" value="GATE OBSERVED • REVALIDATED AFTER APPROVAL" api={props.api} />
            <Row label="SPLIT INDEX" value="VALIDATED AFTER APPROVAL" api={props.api} />
            <Row label="REPO WRITE" value={preview().authority.repositoryWrites[0]} api={props.api} />
            <Row label="REPO WRITE" value={preview().authority.repositoryWrites[1]} api={props.api} />
            {preview().authority.scratchWrites.map((resource) => (
              <Row label="SCRATCH" value={resource} api={props.api} />
            ))}
            <Row
              label="SEALED ROOT"
              value={`${preview().authority.sealedExecutableScratch.root} • AFTER APPROVAL`}
              api={props.api}
            />
            <Row
              label="SEALED CLASS"
              value={`${preview().authority.sealedExecutableScratch.directoryPrefix}*/${preview().authority.sealedExecutableScratch.executableName}`}
              api={props.api}
            />
            {preview().authority.sealedExecutableScratch.purposes.map((purpose) => (
              <Row label="SEALED USE" value={purpose.replaceAll("_", " ")} api={props.api} />
            ))}
            <Row
              label="SEALED CLEAN"
              value={preview().authority.sealedExecutableScratch.lifecycle.replaceAll("_", " ")}
              api={props.api}
            />
            <Row label="CLEANUP" value={preview().authority.scratchCleanup.replaceAll("_", " ")} api={props.api} />
            <Row label="NETWORK" value={preview().authority.network.replaceAll("_", " ")} api={props.api} />
            <Row label="EXPIRES" value={preview().authority.expiresAt} api={props.api} />
            <Row
              label="PROPOSAL"
              value={Locale.truncate(preview().authority.proposalDigest, valueWidth(dimensions().width))}
              api={props.api}
            />
            <Row label="VERIFY" value="NOT VERIFIED" api={props.api} />
          </>
        )}
      </Show>
      <Show when={terminalOf(state())}>
        {(result) => (
          <>
            <Row label="RESULT" value={terminalLabel(result())} api={props.api} />
            <Show when={operationIDOf(result())}>
              {(operationID) => <Row label="OPERATION" value={operationID() ?? "unknown"} api={props.api} />}
            </Show>
            <Show when={result().status === "verified"}>
              <Row label="EVIDENCE" value="INDEPENDENT GIT POST-STATE" api={props.api} />
            </Show>
          </>
        )}
      </Show>
      <Show when={blockedReason(state())}>
        {(reason) => <Row label="REASON" value={reason().replaceAll("_", " ")} api={props.api} />}
      </Show>
      <Show when={reconciliationDigest(state())}>
        {(digest) => (
          <Row label="PROPOSAL" value={Locale.truncate(digest(), valueWidth(dimensions().width))} api={props.api} />
        )}
      </Show>
    </box>
  )
}

/** Returns an isolated registration function so integration needs one call. */
export function createAstraGitUnstageRegistration(authority: AstraSessionAuthority, client = defaultClient(authority)) {
  return (api: TuiPluginApi) => registerAstraGitUnstage(api, authority, client)
}

export function registerAstraGitUnstage(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = defaultClient(authority),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraGitUnstageView
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
        name: "astra.git.unstage.open",
        title: "Git — Unstage all",
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

function defaultClient(authority: AstraSessionAuthority) {
  return createAstraGitUnstageClient(process.env, authority.sessionID, {
    expectedWorkspaceRoot: authority.workspace.root,
    ...(authority.repositoryBaseline
      ? { expectedBaselineSnapshotDigest: authority.repositoryBaseline.snapshotDigest }
      : {}),
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

function decisionInFlight(state: UnstageState) {
  return state.status === "deciding" || state.status === "progress"
}

function previewOf(state: UnstageState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}

function terminalOf(state: UnstageState) {
  return state.status === "terminal" ? state.result : undefined
}

function operationIDOf(result: GitUnstageDecisionResult) {
  return "operationID" in result ? (result.operationID ?? undefined) : undefined
}

function blockedReason(state: UnstageState) {
  if (state.status === "blocked") return state.reason
  if (state.status === "terminal" && state.result.status === "blocked") return state.result.reason
  return undefined
}

function reconciliationDigest(state: UnstageState) {
  return state.status === "reconciliation" ? state.proposalDigest : undefined
}

function stateLabel(state: UnstageState) {
  if (state.status === "idle") return "IDLE • NO REQUEST • NO EFFECT"
  if (state.status === "preparing") return state.accepted ? "PREPARING • NOT VERIFIED" : "QUEUED • NO EFFECT"
  if (state.status === "prepared") return "AWAITING EXPLICIT DECISION • NOT VERIFIED"
  if (state.status === "deciding") {
    if (!state.accepted) return "DECISION QUEUED • NOT VERIFIED"
    return state.decision === "approve"
      ? "REQUEST AUTHENTICATED • NOT VERIFIED"
      : "REJECTION AUTHENTICATED • NO GIT EFFECT"
  }
  if (state.status === "progress") {
    if (state.phase === "recording_authority") return "RECORDING AUTHORITY • NOT VERIFIED"
    if (state.phase === "host_adapter_validating") return "HOST ADAPTER VALIDATING • NOT VERIFIED"
    if (state.phase === "effect_observed_not_verified") return "EFFECT OBSERVED • NOT VERIFIED"
    return "VERIFYING INDEPENDENT POST-STATE • NOT VERIFIED"
  }
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED • EFFECT UNKNOWN"
  if (state.status === "blocked") {
    return state.reason.includes("rejection") ? "REJECTION NOT RECORDED • NO GIT EFFECT" : "BLOCKED • NO EFFECT CLAIMED"
  }
  return terminalLabel(state.result)
}

function terminalLabel(result: GitUnstageDecisionResult) {
  if (result.status === "verified") return "VERIFIED • INDEPENDENT GIT POST-STATE"
  if (result.status === "denied_without_git_effect") return "DENIED • NO GIT EFFECT"
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

function valueWidth(width: number) {
  return Math.max(16, width - 15)
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
