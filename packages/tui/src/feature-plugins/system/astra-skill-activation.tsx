/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import type {
  SkillActivationDecisionResult,
  SkillActivationPreviewView,
  SkillActivationProgress,
  SkillInventoryCandidateView,
} from "../../../../astra-domain/src/skill-activation-control"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"
import { createAstraSkillActivationClient, type AstraSkillActivationClient } from "../../astra/skill-activation-client"

const routeName = "astra-skill-activation"

type SkillState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "inventorying"; accepted: boolean }>
  | Readonly<{ status: "inventory"; inventoryID: string; candidates: ReadonlyArray<SkillInventoryCandidateView>; selected: number }>
  | Readonly<{ status: "preparing"; candidate: SkillInventoryCandidateView; accepted: boolean }>
  | Readonly<{ status: "prepared"; preview: SkillActivationPreviewView }>
  | Readonly<{ status: "deciding"; preview: SkillActivationPreviewView; decision: "approve" | "reject"; accepted: boolean }>
  | Readonly<{ status: "progress"; preview: SkillActivationPreviewView; phase: SkillActivationProgress["status"] }>
  | Readonly<{ status: "terminal"; result: SkillActivationDecisionResult }>
  | Readonly<{ status: "blocked"; reason: string }>
  | Readonly<{ status: "reconciliation"; operationID: string }>

export function AstraSkillActivationView(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  client: AstraSkillActivationClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal<SkillState>({ status: "idle" })
  let abort: AbortController | undefined
  let generation = 0
  const valueWidth = createMemo(() => Math.max(20, dimensions().width - 17))

  const close = () => {
    const current = state()
    if (current.status === "deciding" || current.status === "progress") return
    props.client.dispose()
    abort?.abort()
    props.api.route.navigate(props.returnRoute?.name ?? "session", returnParams(props.returnRoute))
  }

  const inventory = () => {
    const current = state()
    if (current.status !== "idle" && current.status !== "blocked" && current.status !== "terminal") return
    if (props.authority.mode === "read-only") {
      setState({ status: "blocked", reason: "read_only" })
      return
    }
    generation++
    const run = generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "inventorying", accepted: false })
    props.client.inventory({
      signal: abort.signal,
      onAccepted() {
        if (run === generation) setState({ status: "inventorying", accepted: true })
      },
    }).then((result) => {
      if (run !== generation) return
      if (result.status === "blocked") {
        setState({ status: "blocked", reason: result.reason })
        return
      }
      setState({ status: "inventory", inventoryID: result.inventoryID, candidates: result.candidates, selected: 0 })
    }).catch(() => {
      if (run === generation) setState({ status: "blocked", reason: "control_unavailable" })
    })
  }

  const move = (offset: number) => {
    const current = state()
    if (current.status !== "inventory" || current.candidates.length === 0) return
    const selected = (current.selected + offset + current.candidates.length) % current.candidates.length
    setState({ ...current, selected })
  }

  const prepare = () => {
    const current = state()
    if (current.status !== "inventory") return
    const candidate = current.candidates[current.selected]
    if (!candidate) {
      setState({ status: "blocked", reason: "no_workspace_skills" })
      return
    }
    const run = ++generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "preparing", candidate, accepted: false })
    props.client.prepare(current.inventoryID, candidate.candidateID, {
      signal: abort.signal,
      onAccepted() {
        if (run === generation) setState({ status: "preparing", candidate, accepted: true })
      },
    }).then((result) => {
      if (run !== generation) return
      if (result.status === "blocked") {
        setState({ status: "blocked", reason: result.reason })
        return
      }
      setState({ status: "prepared", preview: result.preview })
    }).catch(() => {
      if (run === generation) setState({ status: "blocked", reason: "control_unavailable" })
    })
  }

  const decide = (decision: "approve" | "reject") => {
    const current = state()
    if (current.status !== "prepared") return
    const run = ++generation
    abort?.abort()
    abort = new AbortController()
    setState({ status: "deciding", preview: current.preview, decision, accepted: false })
    props.client.decide(current.preview.proposalID, decision, {
      signal: abort.signal,
      onAccepted() {
        if (run === generation) setState({ status: "deciding", preview: current.preview, decision, accepted: true })
      },
      onProgress(progress) {
        if (run === generation) setState({ status: "progress", preview: current.preview, phase: progress.status })
      },
    }).then((result) => {
      if (run !== generation) return
      if (decision === "reject" && result.status !== "denied_without_effect") {
        setState({ status: "reconciliation", operationID: current.preview.operationID })
        return
      }
      setState({ status: "terminal", result })
    }).catch(() => {
      if (run === generation) setState({ status: "reconciliation", operationID: current.preview.operationID })
    })
  }

  useKeyboard((event) => {
    if (event.name === "up" || event.name === "k") move(-1)
    if (event.name === "down" || event.name === "j") move(1)
  })
  useBindings(() => ({
    commands: [
      { name: "astra.skill.inventory", title: "Inspect Workspace Skills", category: "Astra", run: inventory },
      { name: "astra.skill.prepare", title: "Prepare Skill Activation", category: "Astra", run: prepare },
      { name: "astra.skill.approve", title: "Approve Skill Activation", category: "Astra", run: () => decide("approve") },
      { name: "astra.skill.reject", title: "Reject Skill Activation", category: "Astra", run: () => decide("reject") },
      { name: "astra.skill.close", title: "Close Skill Activation", category: "Astra", run: close },
    ],
    bindings: [
      { key: "i", cmd: "astra.skill.inventory", desc: "Inspect" },
      { key: "p", cmd: "astra.skill.prepare", desc: "Prepare" },
      { key: "a", cmd: "astra.skill.approve", desc: "Approve" },
      { key: "d", cmd: "astra.skill.reject", desc: "Reject" },
      { key: "escape", cmd: "astra.skill.close", desc: "Close" },
    ],
  }))
  onCleanup(() => {
    generation++
    abort?.abort()
  })

  const selected = createMemo(() => {
    const current = state()
    return current.status === "inventory" ? current.candidates[current.selected] : undefined
  })
  const preview = createMemo(() => {
    const current = state()
    return current.status === "prepared" || current.status === "deciding" || current.status === "progress"
      ? current.preview
      : undefined
  })

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width={dimensions().width} height={dimensions().height} paddingLeft={1} paddingRight={1} flexDirection="column">
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.api.theme.current.text}>Workspace Skills</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>i inspect · j/k select · p prepare · a approve · d reject · esc close</text>
      </box>
      <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
      <text fg={props.api.theme.current.warning}>WORKSPACE SKILL DATA IS UNTRUSTED</text>
      <box height={1} />
      <Row label="WORKSPACE" value={Locale.truncateLeft(safeTerminalText(props.authority.workspace.root), valueWidth())} api={props.api} />
      <Row label="MODE" value={props.authority.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="STATE" value={stateLabel(state())} api={props.api} />
      <Show when={selected()}>{(candidate) => <>
        <Row label="SKILL" value={candidate().name} api={props.api} />
        <Row label="PATH" value={Locale.truncate(safeTerminalText(candidate().relativePath), valueWidth())} api={props.api} />
        <Row label="PROVENANCE" value="WORKSPACE OPENCODE" api={props.api} />
        <Row label="METADATA" value="UNTRUSTED WORKSPACE METADATA" api={props.api} />
        <Row label="FILE" value={`${candidate().fileBytes} B · ${Locale.truncate(candidate().fileDigest, Math.max(10, valueWidth() - 12))}`} api={props.api} />
        <Row label="INSTRUCTIONS" value={`${candidate().instructionsBytes} B · ${Locale.truncate(candidate().instructionsDigest, Math.max(10, valueWidth() - 12))}`} api={props.api} />
      </>}</Show>
      <Show when={preview()}>{(value) => <>
        <Row label="OPERATION" value={value().operationID} api={props.api} />
        <Row label="SKILL" value={value().skill.name} api={props.api} />
        <Row label="PATH" value={Locale.truncate(safeTerminalText(value().skill.relativePath), valueWidth())} api={props.api} />
        <Row label="CONTENT" value={`${value().skill.instructionsBytes} B · ${Locale.truncate(value().skill.instructionsDigest, Math.max(10, valueWidth() - 12))}`} api={props.api} />
        <Row label="CAPABILITY" value={Locale.truncate(value().capabilityDigest, valueWidth())} api={props.api} />
        <Row label="EFFECTS" value="PRIVATE BUNDLE ONLY · NO TOOLS · NO PLUGINS · NO MCP" api={props.api} />
        <Row label="VERIFY" value="OBSERVED · NOT VERIFIED" api={props.api} />
      </>}</Show>
      <Show when={terminalResult(state())}>{(result) => <>
        <Row label="RESULT" value={terminalLabel(result())} api={props.api} />
        <Show when={operationIDOf(result())}>{(operationID) => <Row label="OPERATION" value={operationID()} api={props.api} />}</Show>
      </>}</Show>
      <Show when={blockedReason(state())}>
        {(reason) => <Row label="REASON" value={reason().replaceAll("_", " ")} api={props.api} />}
      </Show>
      <Show when={reconciliationOperationID(state())}>
        {(operationID) => <Row label="OPERATION" value={operationID()} api={props.api} />}
      </Show>
    </box>
  )
}

/** Registers the isolated route and open command; product composition opts in later. */
export function registerAstraSkillActivation(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client = createAstraSkillActivationClient({}, authority.sessionID),
) {
  api.route.register([{ name: routeName, render: (input) => <AstraSkillActivationView api={api} authority={authority} client={client} returnRoute={parseReturnRoute(input.params?.returnRoute)} /> }])
  api.keymap.registerLayer({ commands: [{
    name: "astra.skill.open",
    title: "Workspace Skills",
    slashName: "skills",
    category: "Astra",
    namespace: "palette",
    run() {
      api.route.navigate(routeName, { returnRoute: api.route.current })
      api.ui.dialog.clear()
    },
  }] })
}

function Row(props: { label: string; value: string; api: TuiPluginApi }) {
  return <box flexDirection="row" flexShrink={0}><text width={14} fg={props.api.theme.current.textMuted}>{props.label}</text><text fg={props.api.theme.current.text}>{props.value}</text></box>
}

function stateLabel(state: SkillState) {
  if (state.status === "idle") return "IDLE · NO SKILL READ"
  if (state.status === "inventorying") return state.accepted ? "INVENTORY ACTIVE · METADATA UNTRUSTED" : "INVENTORY QUEUED · NO READ YET"
  if (state.status === "inventory") return state.candidates.length ? `${state.candidates.length} SKILL(S) · NOT VERIFIED` : "NO WORKSPACE SKILLS"
  if (state.status === "preparing") return state.accepted ? "PREPARING CAPABILITY · NOT VERIFIED" : "PREPARE QUEUED · NO ACTIVATION"
  if (state.status === "prepared") return "AWAITING EXPLICIT DECISION · NOT VERIFIED"
  if (state.status === "deciding") return state.accepted ? "DECISION AUTHENTICATED · NOT VERIFIED" : "DECISION QUEUED · NOT VERIFIED"
  if (state.status === "progress") {
    if (state.phase === "recording_authority") return "RECORDING AUTHORITY · NOT VERIFIED"
    if (state.phase === "submitting_approval") return "SUBMITTING APPROVAL · EFFECT NOT YET OBSERVED"
    return "SKILL CONTENT OBSERVED · NOT VERIFIED"
  }
  if (state.status === "reconciliation") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
  if (state.status === "blocked") return "BLOCKED · NO ACTIVATION CLAIMED"
  return terminalLabel(state.result)
}

function terminalLabel(result: SkillActivationDecisionResult) {
  if (result.status === "completed_observed_not_verified") return "COMPLETED · OBSERVED · NOT VERIFIED"
  if (result.status === "denied_without_effect") return "DENIED · NO EFFECT"
  if (result.status === "failed_without_effect") return "FAILED · NO EFFECT"
  if (result.status === "reconciliation_required") return "RECONCILIATION REQUIRED · EFFECT UNKNOWN"
  return "BLOCKED · NO ACTIVATION CLAIMED"
}

function terminalResult(state: SkillState) { return state.status === "terminal" ? state.result : undefined }
function operationIDOf(result: SkillActivationDecisionResult) { return "operationID" in result ? result.operationID : undefined }
function blockedReason(state: SkillState) { return state.status === "blocked" ? state.reason : undefined }
function reconciliationOperationID(state: SkillState) { return state.status === "reconciliation" ? state.operationID : undefined }
function returnParams(route: TuiRouteCurrent | undefined) { return route && "params" in route ? route.params : undefined }
function parseReturnRoute(input: unknown): TuiRouteCurrent | undefined {
  if (!record(input) || typeof input.name !== "string") return undefined
  if (!("params" in input)) return { name: input.name }
  if (!record(input.params)) return undefined
  return { name: input.name, params: input.params }
}
function record(input: unknown): input is Record<string, unknown> { return typeof input === "object" && input !== null && !Array.isArray(input) }
function safeTerminalText(input: string) { return /[\p{Cc}\p{Cf}]/u.test(input) ? "[unsafe text blocked]" : input }
