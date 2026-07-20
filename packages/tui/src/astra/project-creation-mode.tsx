/** @jsxImportSource @opentui/solid */
import { TextAttributes, createCliRenderer } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import {
  astraProjectCreationStack,
  parseAstraProjectCreationDetailsDecision,
  parseAstraProjectCreationProgress,
  parseAstraProjectCreationProposal,
  parseAstraProjectCreationResult,
  parseAstraProjectCreationResultDecision,
  type AstraProjectCreationDetailsDecision,
  type AstraProjectCreationProgress,
  type AstraProjectCreationProposal,
  type AstraProjectCreationResult,
  type AstraProjectCreationResultDecision,
  type AstraProjectCreationReviewDecision,
} from "@astra/domain/project-creation-ui"
import { lynxFrame } from "../component/lynx-model"

const palette = {
  background: "#07100f",
  panel: "#0d1b19",
  border: "#2d5a52",
  text: "#e6f2ee",
  muted: "#86a49d",
  primary: "#55e6c1",
  accent: "#d6a7ff",
  warning: "#f0bd6a",
  error: "#ff7b83",
} as const

const phases = "DETAILS > PROPOSAL > APPROVAL > OPERATION > RESULT"

/** Collects inert project intent. Filesystem authority remains in the CLI parent. */
export async function runAstraProjectCreationDetailsMode(): Promise<AstraProjectCreationDetailsDecision> {
  return runDecisionMode<AstraProjectCreationDetailsDecision>(
    (complete) => <AstraProjectCreationDetailsMode onDecision={complete} />,
    { kind: "cancel" },
  )
}

/** Presents the exact parent-supplied resources and returns only an approval decision. */
export async function runAstraProjectCreationReviewMode(
  proposalInput: unknown,
): Promise<AstraProjectCreationReviewDecision> {
  const proposal = parseAstraProjectCreationProposal(proposalInput)
  if (!proposal.ok) return { kind: "cancel" }
  return runDecisionMode<AstraProjectCreationReviewDecision>(
    (complete) => <AstraProjectCreationReviewMode proposal={proposal.value} onDecision={complete} />,
    { kind: "cancel" },
  )
}

export type AstraProjectCreationProgressSurface = Readonly<{
  update: (progress: unknown) => boolean
  close: () => void
}>

/** Opens a presentation-only surface that accepts strict progress snapshots from the CLI parent. */
export async function openAstraProjectCreationProgressMode(
  progressInput: unknown,
): Promise<AstraProjectCreationProgressSurface | null> {
  const initial = parseAstraProjectCreationProgress(progressInput)
  if (!initial.ok) return null
  const renderer = await createProjectCreationRenderer()
  const [progress, setProgress] = createSignal<AstraProjectCreationProgress>(initial.value)
  await render(() => <AstraProjectCreationOperationMode progress={progress()} />, renderer)
  let closed = false
  return Object.freeze({
    update(progressInput: unknown) {
      if (closed) return false
      const next = parseAstraProjectCreationProgress(progressInput)
      if (!next.ok) return false
      setProgress(next.value)
      return true
    },
    close() {
      if (closed) return
      closed = true
      if (!renderer.isDestroyed) renderer.destroy()
    },
  })
}

/** Shows accurate evidence and exposes Open only after exact verification. */
export async function runAstraProjectCreationResultMode(
  resultInput: unknown,
): Promise<AstraProjectCreationResultDecision> {
  const result = parseAstraProjectCreationResult(resultInput)
  if (!result.ok) return { kind: "exit" }
  return runDecisionMode<AstraProjectCreationResultDecision>(
    (complete) => <AstraProjectCreationResultMode result={result.value} onDecision={complete} />,
    { kind: "exit" },
  )
}

export function AstraProjectCreationDetailsMode(props: {
  onDecision: (decision: AstraProjectCreationDetailsDecision) => void
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 18)
  const [step, setStep] = createSignal<0 | 1 | 2>(0)
  const [name, setName] = createSignal("")
  const [parentPath, setParentPath] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [issue, setIssue] = createSignal<string | null>(null)
  const value = () => (step() === 0 ? name() : step() === 1 ? parentPath() : objective())
  const setValue = (next: string) => {
    if (step() === 0) return setName(next)
    if (step() === 1) return setParentPath(next)
    return setObjective(next)
  }

  useKeyboard((event) => {
    const key = event.name.toLowerCase()
    if ((event.ctrl && key === "c") || key === "escape" || (key === "q" && event.shift)) {
      return props.onDecision({ kind: "cancel" })
    }
    if (key === "backspace") {
      setIssue(null)
      return setValue(value().slice(0, -1))
    }
    if (key === "return") {
      if (step() === 0) {
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name())) {
          return setIssue("Use lowercase letters, numbers, and internal hyphens.")
        }
        setIssue(null)
        return setStep(1)
      }
      if (step() === 1) {
        if (!parentPath().startsWith("/") || parentPath().includes("//")) {
          return setIssue("Enter one absolute parent path.")
        }
        setIssue(null)
        return setStep(2)
      }
      const decision = parseAstraProjectCreationDetailsDecision({
        kind: "submit",
        request: { name: name(), parentPath: parentPath(), objective: objective(), stack: astraProjectCreationStack },
      })
      if (!decision.ok) return setIssue("Enter a short single-line objective without control characters.")
      return props.onDecision(decision.value)
    }
    const character = event.name === "space" ? " " : event.name.length === 1 ? (event.shift ? event.name.toUpperCase() : event.name) : null
    if (!event.ctrl && !event.meta && character && value().length < 4_096) {
      setIssue(null)
      setValue(value() + character)
    }
  })

  return (
    <ProjectCreationFrame compact={compact()} phase="DETAILS">
      <text fg={palette.muted}>{phases}</text>
      <text fg={palette.text} attributes={TextAttributes.BOLD}>
        {step() === 0 ? "Project name" : step() === 1 ? "Absolute parent directory" : "Desired outcome"}
      </text>
      <text fg={palette.primary}>{value() || cursorPlaceholder(step())}</text>
      <Show when={!compact()}>
        <text fg={palette.muted}>
          {step() === 0
            ? "Lowercase local directory and package name."
            : step() === 1
              ? "The target directory must not exist."
              : `Built-in stack: ${astraProjectCreationStack} · no install · Git separate.`}
        </text>
      </Show>
      <Show when={issue()}>
        <text fg={palette.error}>{issue()}</text>
      </Show>
      <text fg={palette.muted}>Enter continues · Esc or Q cancels with no effect</text>
    </ProjectCreationFrame>
  )
}

export function AstraProjectCreationReviewMode(props: {
  proposal: unknown
  onDecision: (decision: AstraProjectCreationReviewDecision) => void
}) {
  const parsed = parseAstraProjectCreationProposal(props.proposal)
  if (!parsed.ok) return <ProjectCreationUnavailable />
  const proposal = parsed.value
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 18)

  useKeyboard((event) => {
    const key = event.name.toLowerCase()
    if ((event.ctrl && key === "c") || key === "escape" || key === "q") {
      return props.onDecision({ kind: "cancel" })
    }
    if (key === "a") {
      return props.onDecision({ kind: "approve", proposalDigest: proposal.proposalDigest })
    }
    if (key === "r") {
      return props.onDecision({ kind: "reject", proposalDigest: proposal.proposalDigest })
    }
  })

  return (
    <ProjectCreationFrame compact={compact()} phase="APPROVAL">
        <text fg={palette.muted}>{phases}</text>
        <text fg={palette.warning}>{proposal.boundary}</text>
        <text fg={palette.text}>{proposal.targetPath}</text>
        <text fg={palette.muted}>
          {proposal.files.length} files · {proposal.totalBytes} bytes · {proposal.stack}
        </text>
        <box flexDirection="column">
          <For each={proposal.files}>
            {(file) => (
              <text fg={palette.text}>
                {file.path} · {file.bytes} bytes{compact() ? "" : ` · ${shortDigest(file.contentDigest)}`}
              </text>
            )}
          </For>
        </box>
        <Show when={!compact()}>
          <text fg={palette.muted}>Proposal fingerprint</text>
          <text fg={palette.text}>{proposal.proposalDigest}</text>
        </Show>
        <text fg={palette.warning}>No install · No network · Git: separate step</text>
        <text fg={palette.text}>
          {compact() ? "[A] Approve · [R] Reject · [Q] Cancel" : "[A] Approve exact scaffold · [R] Reject · [Q] Cancel"}
        </text>
      </ProjectCreationFrame>
  )
}

export function AstraProjectCreationOperationMode(props: { progress: unknown }) {
  const parsed = parseAstraProjectCreationProgress(props.progress)
  if (!parsed.ok) return <ProjectCreationUnavailable />
  const progress = parsed.value
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 18)
  return (
    <ProjectCreationFrame compact={compact()} phase="OPERATION">
        <text fg={palette.muted}>{phases}</text>
        <text fg={palette.primary} attributes={TextAttributes.BOLD}>{progressLabel(progress.state)}</text>
        <text fg={palette.warning}>{progress.boundary}</text>
        <text fg={palette.text}>{progress.targetPath}</text>
        <IdentifierRows label="Operation" value={progress.operationID} compact={compact()} />
        <IdentifierRows label="Expected receipt" value={progress.expectedReceiptID} compact={compact()} />
        <IdentifierRows label="Observed receipt" value={progress.observedReceiptID} compact={compact()} />
        <Show when={!compact()}>
          <text fg={palette.muted}>Atomic create-only scaffold · independent verification follows</text>
        </Show>
      </ProjectCreationFrame>
  )
}

export function AstraProjectCreationResultMode(props: {
  result: unknown
  onDecision: (decision: AstraProjectCreationResultDecision) => void
}) {
  const parsed = parseAstraProjectCreationResult(props.result)
  if (!parsed.ok) return <ProjectCreationUnavailable />
  const result = parsed.value
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 18)

  useKeyboard((event) => {
    const key = event.name.toLowerCase()
    const decision =
      key === "o" ? { kind: "open-project", targetPath: result.targetPath } as const
      : key === "l" || key === "escape" ? { kind: "launchpad" } as const
      : key === "q" || (event.ctrl && key === "c") ? { kind: "exit" } as const
      : null
    if (!decision) return
    const checked = parseAstraProjectCreationResultDecision(decision, result)
    if (checked.ok) props.onDecision(checked.value)
  })

  return (
    <ProjectCreationFrame compact={compact()} phase="RESULT">
        <text fg={palette.muted}>{phases}</text>
        <text fg={resultColor(result.status)} attributes={TextAttributes.BOLD}>
          {resultLabel(result.status)}
        </text>
        <text fg={palette.text}>{result.targetPath}</text>
        <Show when={!compact()}>
          <text fg={palette.muted}>{result.detail}</text>
        </Show>
        <IdentifierRows label="Operation" value={result.operationID} compact={compact()} />
        <IdentifierRows label="Expected receipt" value={result.expectedReceiptID} compact={compact()} />
        <IdentifierRows label="Observed receipt" value={result.observedReceiptID} compact={compact()} />
        <text fg={palette.text}>
          {result.status === "verified" ? "[O] Open project · " : ""}[L] Launchpad · [Q] Exit
        </text>
      </ProjectCreationFrame>
  )
}

function ProjectCreationFrame(props: { compact: boolean; phase: string; children: JSX.Element }) {
  const dimensions = useTerminalDimensions()
  const visual = createMemo(() => lynxFrame("awaiting-decision", props.compact ? "compact" : "full", 0, false))
  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <box width={Math.min(96, Math.max(1, dimensions().width - 4))} flexDirection="column" gap={props.compact ? 0 : 1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={palette.primary} attributes={TextAttributes.BOLD}>ASTRA / CREATE PROJECT</text>
          <text fg={palette.accent}>{props.phase}</text>
        </box>
        <box border borderStyle="rounded" borderColor={palette.border} backgroundColor={palette.panel} paddingLeft={props.compact ? 1 : 2} paddingRight={props.compact ? 1 : 2} flexDirection={props.compact ? "column" : "row"} gap={props.compact ? 0 : 3}>
          <Show when={!props.compact && props.phase !== "APPROVAL" && dimensions().width >= 86}>
            <box flexDirection="column" flexShrink={0}>
              <For each={visual().lines}>{(line) => <text fg={palette.accent}>{line}</text>}</For>
              <text fg={palette.accent}>{visual().label}</text>
            </box>
          </Show>
          <box flexDirection="column" flexGrow={1} minWidth={0} gap={props.compact ? 0 : 1}>
            {props.children}
          </box>
        </box>
      </box>
    </box>
  )
}

function ProjectCreationUnavailable() {
  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <text fg={palette.error}>Project creation data unavailable</text>
    </box>
  )
}

async function runDecisionMode<Value>(
  view: (complete: (value: Value) => void) => JSX.Element,
  destroyedValue: Value,
): Promise<Value> {
  const renderer = await createProjectCreationRenderer()
  let settled = false
  let complete!: (value: Value) => void
  const decision = new Promise<Value>((resolve) => {
    complete = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  renderer.once("destroy", () => complete(destroyedValue))
  try {
    await render(() => view(complete), renderer)
    return await decision
  } finally {
    if (!renderer.isDestroyed) renderer.destroy()
  }
}

function createProjectCreationRenderer() {
  return createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
  })
}

function cursorPlaceholder(step: 0 | 1 | 2) {
  if (step === 0) return "project-name"
  if (step === 1) return "/absolute/parent"
  return "What should this project achieve?"
}

function shortDigest(value: string) {
  return `${value.slice(0, 19)}…`
}

function IdentifierRows(props: { label: string; value: string | null; compact: boolean }) {
  if (!props.value) return <text fg={palette.muted}>{props.label} · none</text>
  if (!props.compact) return <text fg={palette.muted}>{props.label} · {props.value}</text>
  return (
    <box flexDirection="column">
      <text fg={palette.muted}>{props.label} · {props.value.slice(0, 18)}</text>
      <text fg={palette.muted}>{props.value.slice(18)}</text>
    </box>
  )
}

function progressLabel(state: AstraProjectCreationProgress["state"]) {
  if (state === "effect_observed") return "OBSERVED — NOT VERIFIED"
  if (state === "verifying") return "VERIFYING"
  return "RUNNING"
}

function resultLabel(status: AstraProjectCreationResult["status"]) {
  if (status === "effect_observed") return "OBSERVED — NOT VERIFIED"
  if (status === "verified") return "VERIFIED"
  if (status === "failed_without_effect") return "FAILED WITHOUT EFFECT"
  if (status === "denied_without_effect") return "DENIED WITHOUT EFFECT"
  return "RECONCILIATION REQUIRED"
}

function resultColor(status: AstraProjectCreationResult["status"]) {
  if (status === "verified") return palette.primary
  if (status === "effect_observed" || status === "reconciliation_required") return palette.warning
  return palette.error
}
