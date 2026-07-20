/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo } from "solid-js"
import { lynxFrame } from "../component/lynx-model"
import { createAstraCliRenderer } from "./cli-renderer"
import type { AstraWorkspaceGateView, AstraWorkspaceMode } from "./workspace-gate-contract"

export type { AstraWorkspaceGateView, AstraWorkspaceMode } from "./workspace-gate-contract"

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

export async function chooseAstraWorkspaceMode(view: AstraWorkspaceGateView): Promise<AstraWorkspaceMode> {
  const renderer = await createWorkspaceGateRenderer()
  let settled = false
  let complete!: (decision: AstraWorkspaceMode) => void
  const decision = new Promise<AstraWorkspaceMode>((resolve) => {
    complete = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  renderer.once("destroy", () => complete("exit"))

  try {
    await render(() => <AstraWorkspaceGate view={view} onDecision={complete} />, renderer)
    return await decision
  } finally {
    if (!renderer.isDestroyed) renderer.destroy()
  }
}

/** Keeps the workspace safety state visible while a bounded check is running. */
export async function withAstraWorkspaceProgress<T>(
  view: AstraWorkspaceGateView,
  operation: () => Promise<T>,
): Promise<T> {
  const renderer = await createWorkspaceGateRenderer()
  try {
    await render(() => <AstraWorkspaceGate view={view} onDecision={() => {}} />, renderer)
    return await operation()
  } finally {
    if (!renderer.isDestroyed) renderer.destroy()
  }
}

function createWorkspaceGateRenderer() {
  return createAstraCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
  })
}

export function AstraWorkspaceGate(props: {
  view: AstraWorkspaceGateView
  onDecision: (decision: AstraWorkspaceMode) => void
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 74 || dimensions().height < 22)
  const working = createMemo(() => props.view.state === "working")
  const visual = createMemo(() => lynxFrame("awaiting-decision", compact() ? "compact" : "full", 0, false))
  const choices = createMemo(() => [
    {
      key: "R",
      label: "Open read-only",
      enabled: !working() && props.view.preflight === "complete",
      action: "read-only" as const,
    },
    {
      key: "G",
      label: props.view.git === "current" ? "Inspect Git again" : "Inspect Git",
      enabled: !working() && props.view.git !== "not-required" && props.view.preflight === "complete",
      action: "inspect-git" as const,
    },
    {
      key: "A",
      label: props.view.activationAllowed ? "Activate once" : "Activate once (locked)",
      enabled: !working() && props.view.activationAllowed,
      action: "activate-once" as const,
    },
    { key: "Q", label: "Exit", enabled: !working(), action: "exit" as const },
  ])

  useKeyboard((event) => {
    if ((event.ctrl && event.name === "c") || event.name === "escape") return props.onDecision("exit")
    const selected = choices().find((choice) => choice.key.toLowerCase() === event.name.toLowerCase())
    if (selected?.enabled) props.onDecision(selected.action)
  })

  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <box width={Math.min(92, Math.max(36, dimensions().width - 4))} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={palette.primary} attributes={TextAttributes.BOLD}>
            ASTRA / WORKSPACE GATE
          </text>
          <text fg={statusColor(props.view.state)}>{stateLabel(props.view)}</text>
        </box>

        <box
          border
          borderStyle="rounded"
          borderColor={palette.border}
          backgroundColor={palette.panel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection={compact() ? "column" : "row"}
          gap={compact() ? 1 : 3}
        >
          <box flexDirection="column" flexShrink={0}>
            <Show when={!compact()}>
              <For each={visual().lines}>{(line) => <text fg={palette.accent}>{line}</text>}</For>
            </Show>
            <text fg={palette.accent}>{working() ? "Lynx is checking the workspace" : visual().label}</text>
          </box>

          <box flexDirection="column" flexGrow={1} minWidth={0} gap={1}>
            <box flexDirection="column">
              <text fg={palette.muted}>Workspace</text>
              <text fg={palette.text} wrapMode="none">
                {props.view.workspace}
              </text>
            </box>

            <box flexDirection="row" gap={2}>
              <text fg={props.view.preflight === "complete" ? palette.primary : palette.error}>
                PREFLIGHT {props.view.preflight.toUpperCase()}
              </text>
              <text fg={gitColor(props.view.git)}>GIT {props.view.git.replaceAll("-", " ").toUpperCase()}</text>
              <text fg={palette.warning}>TRUST NOT STORED</text>
            </box>

            <Show when={!compact()}>
              <text fg={palette.muted}>
                Static bounded scan: {props.view.scannedEntries} entries / {props.view.scannedBytes} bytes
              </text>
            </Show>
            <Show when={!compact() && props.view.surfaces.length > 0}>
              <box flexDirection="column">
                <For each={props.view.surfaces.slice(0, 6)}>
                  {(surface) => (
                    <text fg={palette.muted}>
                      {surface.kind.replaceAll("_", " ")} · {surface.path}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <Show when={props.view.detail}>
              <text
                fg={
                  props.view.state === "awaiting-decision" || props.view.state === "working"
                    ? palette.muted
                    : palette.error
                }
              >
                {props.view.detail}
              </text>
            </Show>
            <Show when={props.view.blockers.length > 0}>
              <text fg={palette.error}>{props.view.blockers.join(" · ")}</text>
            </Show>
          </box>
        </box>

        <Show
          when={!compact()}
          fallback={
            <box flexDirection="column">
              <text fg={palette.text}>[R] Open read-only · [G] Inspect Git</text>
              <text fg={props.view.activationAllowed ? palette.text : palette.muted}>
                [A] {props.view.activationAllowed ? "Activate once" : "Activate once (locked)"} · [Q] Exit
              </text>
            </box>
          }
        >
          <box flexDirection="row" gap={2} flexWrap="wrap">
            <For each={choices()}>
              {(choice) => (
                <text fg={choice.enabled ? palette.text : palette.muted}>
                  <span style={{ fg: choice.enabled ? palette.primary : palette.muted }}>[{choice.key}]</span>{" "}
                  {choice.label}
                </text>
              )}
            </For>
          </box>
          <text fg={palette.muted}>
            No workspace code, plugin, MCP, LSP, formatter, shell, or provider is started here.
          </text>
        </Show>
      </box>
    </box>
  )
}

function stateLabel(view: AstraWorkspaceGateView) {
  if (view.state === "awaiting-decision") return "AWAITING DECISION"
  if (view.state === "working" && view.git === "inspecting") return "INSPECTING GIT"
  return view.state.toUpperCase()
}

function statusColor(state: AstraWorkspaceGateView["state"]) {
  if (state === "awaiting-decision") return palette.warning
  if (state === "working") return palette.primary
  return palette.error
}

function gitColor(state: AstraWorkspaceGateView["git"]) {
  if (state === "current" || state === "not-required") return palette.primary
  if (state === "stale" || state === "blocked") return palette.error
  return palette.warning
}
