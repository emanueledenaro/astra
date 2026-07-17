/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { AstraControlClientError } from "../../astra/control-client"
import {
  createAstraGitStageClient,
  type AstraGitStageClient,
  type GitStageControlPreview,
  type GitStageDecisionResult,
  type GitStageInventoryPreview,
} from "../../astra/git-stage-client"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-git-stage"

type StageState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "inventory-loading"; accepted: boolean }>
  | Readonly<{
      status: "inventory"
      inventory: GitStageInventoryPreview
      selected: ReadonlySet<string>
      cursor: number
    }>
  | Readonly<{
      status: "preparing"
      inventory: GitStageInventoryPreview
      selected: ReadonlySet<string>
      accepted: boolean
    }>
  | Readonly<{ status: "prepared"; preview: GitStageControlPreview }>
  | Readonly<{ status: "deciding"; preview: GitStageControlPreview; decision: "approve" | "reject"; accepted: boolean }>
  | Readonly<{
      status: "progress"
      preview: GitStageControlPreview
      phase: "recording_authority" | "host_adapter_validating" | "effect_observed_not_verified" | "verifying"
    }>
  | Readonly<{ status: "terminal"; result: GitStageDecisionResult }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; proposalDigest: string }>

export function AstraGitStageView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraGitStageClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal<StageState>({ status: "idle" })
  let generation = 0
  let abort: AbortController | undefined

  const navigateBack = () => {
    generation++
    abort?.abort()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  const close = () => {
    const current = state()
    if (decisionInFlight(current)) return
    if (current.status === "prepared") {
      decide("reject", true)
      return
    }
    navigateBack()
  }

  const loadInventory = () => {
    if (props.authority.mode === "read-only") {
      setState({ status: "blocked", reason: "read_only" })
      return
    }
    if (!props.authority.repositoryBaseline) {
      setState({ status: "blocked", reason: "git_baseline_required" })
      return
    }
    const current = state()
    if (current.status === "inventory-loading" || decisionInFlight(current)) return
    const currentGeneration = ++generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "inventory-loading", accepted: false })
    void props.client
      .inventory({
        signal: abort.signal,
        onAccepted() {
          if (generation === currentGeneration) setState({ status: "inventory-loading", accepted: true })
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (result.status === "blocked") {
          setState({ status: "blocked", reason: result.reason })
          return
        }
        setState({ status: "inventory", inventory: result.inventory, selected: new Set(), cursor: 0 })
      })
      .catch((error) => {
        if (generation === currentGeneration) setState({ status: "blocked", reason: clientFailureReason(error) })
      })
  }

  const prepare = () => {
    const current = state()
    if (current.status !== "inventory" || current.selected.size === 0) return
    const currentGeneration = ++generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "preparing", inventory: current.inventory, selected: current.selected, accepted: false })
    void props.client
      .prepare(current.inventory.inventoryID, [...current.selected], {
        signal: abort.signal,
        onAccepted() {
          if (generation === currentGeneration) {
            setState({ status: "preparing", inventory: current.inventory, selected: current.selected, accepted: true })
          }
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

  function decide(decision: "approve" | "reject", closeAfterDenial = false) {
    const current = state()
    if (current.status !== "prepared") return
    const currentGeneration = ++generation
    abort = undefined
    setState({ status: "deciding", preview: current.preview, decision, accepted: false })
    void props.client
      .decide(current.preview.proposalID, decision, {
        onAccepted() {
          if (generation === currentGeneration)
            setState({ status: "deciding", preview: current.preview, decision, accepted: true })
        },
        onProgress(progress) {
          if (generation === currentGeneration)
            setState({ status: "progress", preview: current.preview, phase: progress.status })
        },
      })
      .then((result) => {
        if (generation !== currentGeneration) return
        if (decision === "reject" && result.status !== "denied_without_git_effect") {
          setState({ status: "blocked", reason: "durable_rejection_unavailable" })
          return
        }
        if (decision === "reject" && closeAfterDenial) {
          navigateBack()
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

  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.shift || event.repeated) return
    const current = state()
    if (current.status === "inventory") {
      const delta = event.name === "up" ? -1 : event.name === "down" ? 1 : 0
      if (delta !== 0) {
        event.preventDefault()
        const last = Math.max(0, current.inventory.candidates.length - 1)
        setState({ ...current, cursor: Math.min(last, Math.max(0, current.cursor + delta)) })
        return
      }
      if (event.name === "space") {
        event.preventDefault()
        const candidate = current.inventory.candidates[current.cursor]
        if (!candidate) return
        const selected = new Set(current.selected)
        if (selected.has(candidate.candidateID)) selected.delete(candidate.candidateID)
        else selected.add(candidate.candidateID)
        setState({ ...current, selected })
        return
      }
      if (event.name.toLowerCase() === "p") {
        event.preventDefault()
        prepare()
      }
      return
    }
    if (current.status !== "prepared") return
    const decision = event.name.toLowerCase() === "a" ? "approve" : event.name.toLowerCase() === "d" ? "reject" : null
    if (!decision) return
    event.preventDefault()
    event.stopPropagation()
    decide(decision)
  })

  onCleanup(() => {
    const current = state()
    generation++
    abort?.abort()
    if (current.status === "prepared") {
      void props.client.decide(current.preview.proposalID, "reject").finally(() => props.client.dispose())
      return
    }
    props.client.dispose()
  })

  useBindings(() => ({
    commands: [
      { name: "astra.git.stage.inventory", title: "Load stage candidates", category: "Astra", run: loadInventory },
      { name: "astra.git.stage.close", title: "Exit Stage selected", category: "Astra", run: close },
    ],
    bindings: [
      { key: "i", cmd: "astra.git.stage.inventory", desc: "Inventory" },
      { key: "escape", cmd: "astra.git.stage.close", desc: "Exit" },
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
        <text fg={props.api.theme.current.text}>Git Control Plane — Stage selected</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>
          i inventory ↑↓ move space toggle p preview a approve d reject esc exit
        </text>
      </box>
      <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
      <text fg={props.api.theme.current.warning}>HOST NETWORK UNRESTRICTED — OPERATION REQUESTS NO NETWORK</text>
      <box height={1} />
      <Row
        label="WORKSPACE"
        value={Locale.truncateLeft(safeDisplay(props.authority.workspace.root), valueWidth(dimensions().width))}
        api={props.api}
      />
      <Row label="MODE" value={props.authority.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="ACTION" value="Stage selected" api={props.api} />
      <Row label="STATE" value={stateLabel(state())} api={props.api} />
      <Show when={inventoryOf(state())}>
        {(inventoryState) => (
          <>
            <Row
              label="SELECTED"
              value={`${inventoryState().selected.size}/${inventoryState().inventory.candidates.length}`}
              api={props.api}
            />
            <Row label="EXPIRES" value={inventoryState().inventory.expiresAt} api={props.api} />
            <For each={inventoryState().inventory.candidates}>
              {(candidate, index) => (
                <Row
                  label={`${index() === inventoryState().cursor ? ">" : " "}${inventoryState().selected.has(candidate.candidateID) ? "[x]" : "[ ]"}`}
                  value={`${candidate.change.toUpperCase()} ${candidate.path} • ${candidate.candidateID}`}
                  api={props.api}
                />
              )}
            </For>
          </>
        )}
      </Show>
      <Show when={previewOf(state())}>
        {(preview) => (
          <>
            <Row
              label="SELECTION"
              value={`${preview().authority.selection.candidateIDs.length} parent-issued candidate IDs`}
              api={props.api}
            />
            <For each={preview().authority.candidates}>
              {(candidate) => <Row label="PATH" value={candidate.path} api={props.api} />}
            </For>
            <For each={preview().authority.repositoryWrites}>
              {(resource) => <Row label="REPO WRITE" value={resource} api={props.api} />}
            </For>
            <For each={preview().authority.scratchWrites}>
              {(resource) => <Row label="SCRATCH" value={resource} api={props.api} />}
            </For>
            <Row label="NETWORK" value={preview().authority.network.replaceAll("_", " ")} api={props.api} />
            <For each={preview().authority.limitations}>
              {(limitation) => <Row label="LIMITATION" value={limitation.replaceAll("_", " ")} api={props.api} />}
            </For>
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
              <>
                <Row label="RECEIPT" value={receiptIDOf(result()) ?? "unknown"} api={props.api} />
                <Row label="SNAPSHOT" value={snapshotDigestOf(result()) ?? "unknown"} api={props.api} />
                <Row label="EVIDENCE" value="INDEPENDENT SELECTED INDEX + PRESERVATION" api={props.api} />
              </>
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

/** Returns an isolated registration function; the shared feature registry remains unchanged. */
export function createAstraGitStageRegistration(authority: AstraSessionAuthority, client = defaultClient(authority)) {
  return (api: TuiPluginApi) => registerAstraGitStage(api, authority, client)
}

export function registerAstraGitStage(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = defaultClient(authority),
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraGitStageView
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
        name: "astra.git.stage.open",
        title: "Git — Stage selected",
        category: "Astra",
        namespace: "palette",
        slashName: "git-stage",
        run() {
          api.route.navigate(routeName, { returnRoute: api.route.current })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

function defaultClient(authority: AstraSessionAuthority) {
  return createAstraGitStageClient(process.env, authority.sessionID, {
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
        {safeDisplay(props.label)}
      </text>
      <text fg={props.api.theme.current.text}>{safeDisplay(props.value)}</text>
    </box>
  )
}

function decisionInFlight(state: StageState) {
  return state.status === "deciding" || state.status === "progress"
}
function inventoryOf(state: StageState) {
  return state.status === "inventory" ? state : undefined
}
function previewOf(state: StageState) {
  return state.status === "prepared" || state.status === "deciding" || state.status === "progress"
    ? state.preview
    : undefined
}
function terminalOf(state: StageState) {
  return state.status === "terminal" ? state.result : undefined
}
function operationIDOf(result: GitStageDecisionResult) {
  return "operationID" in result ? (result.operationID ?? undefined) : undefined
}
function receiptIDOf(result: GitStageDecisionResult) {
  return result.status === "verified" ? result.receiptID : undefined
}
function snapshotDigestOf(result: GitStageDecisionResult) {
  return result.status === "verified" ? result.snapshotDigest : undefined
}
function blockedReason(state: StageState) {
  return state.status === "blocked"
    ? state.reason
    : state.status === "terminal" && state.result.status === "blocked"
      ? state.result.reason
      : undefined
}
function reconciliationDigest(state: StageState) {
  return state.status === "reconciliation" ? state.proposalDigest : undefined
}

function stateLabel(state: StageState) {
  if (state.status === "idle") return "IDLE • NO REQUEST • NO EFFECT"
  if (state.status === "inventory-loading")
    return state.accepted ? "INVENTORY OBSERVING • NO EFFECT" : "INVENTORY QUEUED • NO EFFECT"
  if (state.status === "inventory") return "SELECT CANDIDATES • NO EFFECT"
  if (state.status === "preparing")
    return state.accepted ? "PREPARING EXACT AUTHORITY • NO EFFECT" : "PREVIEW QUEUED • NO EFFECT"
  if (state.status === "prepared") return "AWAITING APPROVE OR REJECT • NOT VERIFIED"
  if (state.status === "deciding")
    return state.accepted
      ? state.decision === "approve"
        ? "AUTHORITY RECORDED • NOT VERIFIED"
        : "REJECTION RECORDED • NO GIT EFFECT"
      : "DECISION QUEUED • NOT VERIFIED"
  if (state.status === "progress") {
    if (state.phase === "recording_authority") return "RECORDING AUTHORITY • NOT VERIFIED"
    if (state.phase === "host_adapter_validating") return "HOST ADAPTER VALIDATING • NOT VERIFIED"
    if (state.phase === "effect_observed_not_verified") return "EFFECT OBSERVED • NOT VERIFIED"
    return "VERIFYING SELECTED INDEX + PRESERVATION • NOT VERIFIED"
  }
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED • EFFECT UNKNOWN"
  if (state.status === "blocked")
    return state.reason.includes("rejection") ? "REJECTION NOT RECORDED • NO GIT EFFECT" : "BLOCKED • NO EFFECT CLAIMED"
  return terminalLabel(state.result)
}

function terminalLabel(result: GitStageDecisionResult) {
  if (result.status === "verified") return "VERIFIED • SELECTED INDEX + PRESERVATION"
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
function safeDisplay(value: string) {
  return value.replace(/\p{C}/gu, (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`)
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
