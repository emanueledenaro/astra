/** @jsxImportSource @opentui/solid */
import { TextAttributes, createCliRenderer } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, createSignal } from "solid-js"
import type { AstraLaunchpadDecision, AstraLaunchpadSnapshot } from "@astra/domain/launchpad"
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
} as const

const emptySnapshot: AstraLaunchpadSnapshot = { recentSessions: [] }

export const ASTRA_NO_WORKSPACE_STATUS = "NO WORKSPACE · NO PROJECT EFFECTS"

/** Opens the inert Launchpad and returns the user's requested parent-owned action. */
export async function runAstraNoWorkspaceMode(
  snapshot: AstraLaunchpadSnapshot = emptySnapshot,
): Promise<AstraLaunchpadDecision> {
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
  })
  let settled = false
  let complete!: (decision: AstraLaunchpadDecision) => void
  const decision = new Promise<AstraLaunchpadDecision>((resolve) => {
    complete = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  renderer.once("destroy", () => complete({ kind: "exit" }))

  try {
    await render(() => <AstraNoWorkspaceMode snapshot={snapshot} onDecision={complete} />, renderer)
    return await decision
  } finally {
    if (!renderer.isDestroyed) renderer.destroy()
  }
}

export function AstraNoWorkspaceMode(props: {
  snapshot: AstraLaunchpadSnapshot
  onDecision: (decision: AstraLaunchpadDecision) => void
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 18)
  const visual = createMemo(() => lynxFrame("idle", compact() ? "compact" : "full", 0, false))
  const [opening, setOpening] = createSignal(false)
  const [workspacePath, setWorkspacePath] = createSignal("")

  useKeyboard((event) => {
    const key = event.name.toLowerCase()
    if (opening()) {
      if (event.ctrl === true && key === "c") return props.onDecision({ kind: "exit" })
      if (key === "escape") {
        event.preventDefault()
        event.stopPropagation()
        return cancelWorkspacePath(setOpening, setWorkspacePath)
      }
      if (key === "backspace") return setWorkspacePath((path) => path.slice(0, -1))
      if (key === "return" && workspacePath().startsWith("/")) {
        return props.onDecision({ kind: "open-workspace", path: workspacePath() })
      }
      if (!event.ctrl && !event.meta && !event.shift && event.name.length === 1) {
        setWorkspacePath((path) => path + event.name)
      }
      return
    }

    if (isAstraNoWorkspaceModeExitKey(event)) return props.onDecision({ kind: "exit" })
    if (key === "o") return setOpening(true)
    if (key === "s") return props.onDecision({ kind: "open-system" })
  })

  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <box width={Math.min(82, Math.max(1, dimensions().width - 4))} flexDirection="column" gap={compact() ? 0 : 1}>
        <box flexDirection={compact() ? "column" : "row"} justifyContent="space-between">
          <text fg={palette.primary} attributes={TextAttributes.BOLD}>
            ASTRA / LAUNCHPAD
          </text>
          <text fg={palette.warning}>{ASTRA_NO_WORKSPACE_STATUS}</text>
        </box>

        <box
          border
          borderStyle="rounded"
          borderColor={palette.border}
          backgroundColor={palette.panel}
          paddingLeft={compact() ? 1 : 2}
          paddingRight={compact() ? 1 : 2}
          flexDirection={compact() ? "column" : "row"}
          gap={compact() ? 0 : 3}
        >
          <Show when={!compact()}>
            <box flexDirection="column" flexShrink={0}>
              <For each={visual().lines}>{(line) => <text fg={palette.accent}>{line}</text>}</For>
              <text fg={palette.accent}>{visual().label}</text>
            </box>
          </Show>

          <box flexDirection="column" flexGrow={1} minWidth={0} gap={compact() ? 0 : 1}>
            <Show
              when={opening()}
              fallback={
                <>
                  <Show when={!compact()}>
                    <text fg={palette.text} attributes={TextAttributes.BOLD}>
                      Start from a safe local boundary
                    </text>
                    <text fg={palette.muted}>Choose an action. Project effects remain unavailable here.</text>
                  </Show>
                  <text fg={palette.text}>
                    <span style={{ fg: palette.primary }}>[C]</span> Create project{" "}
                    <span style={{ fg: palette.warning }}>NOT AVAILABLE YET</span>
                  </text>
                  <text fg={palette.text}>
                    <span style={{ fg: palette.primary }}>[O]</span> Open workspace
                  </text>
                  <text fg={palette.text}>
                    <span style={{ fg: palette.primary }}>[R]</span> Continue session{" "}
                    <span style={{ fg: palette.warning }}>NOT AVAILABLE YET</span>
                  </text>
                  <text fg={palette.text}>
                    <span style={{ fg: palette.primary }}>[S]</span> System
                  </text>
                  <Show when={props.snapshot.recentSessions.length > 0 && !compact()}>
                    <box flexDirection="column">
                      <text fg={palette.muted}>Recent sessions</text>
                      <For each={props.snapshot.recentSessions}>
                        {(session) => <text fg={palette.muted}>{session.workspaceRoot}</text>}
                      </For>
                    </box>
                  </Show>
                </>
              }
            >
              <text fg={palette.text} attributes={TextAttributes.BOLD}>
                Open workspace path
              </text>
              <text fg={palette.primary}>{workspacePath() || "/"}</text>
              <text fg={palette.muted}>Enter an absolute path, then press Enter.</text>
              <text fg={palette.muted}>Esc cancels without opening or scanning anything.</text>
            </Show>
          </box>
        </box>

        <box flexDirection="row" gap={2}>
          <text fg={palette.text}>
            <span style={{ fg: palette.primary }}>[Q]</span> Exit
          </text>
          <Show when={!compact() && !opening()}>
            <text fg={palette.muted}>Create and Continue are unavailable until their parent coordinators exist.</text>
          </Show>
        </box>
      </box>
    </box>
  )
}

export function isAstraNoWorkspaceModeExitKey(event: Readonly<{ name: string; ctrl?: boolean }>) {
  return (event.ctrl === true && event.name === "c") || event.name === "escape" || event.name.toLowerCase() === "q"
}

function cancelWorkspacePath(setOpening: (value: boolean) => boolean, setWorkspacePath: (value: string) => string) {
  setWorkspacePath("")
  setOpening(false)
}
