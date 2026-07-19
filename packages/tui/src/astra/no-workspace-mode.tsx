/** @jsxImportSource @opentui/solid */
import { TextAttributes, createCliRenderer, type KeyEvent } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo } from "solid-js"
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

export const ASTRA_NO_WORKSPACE_STATUS = "NO WORKSPACE • EFFECTS DENIED"

/** Opens the inert product home used when no workspace was proposed. */
export async function runAstraNoWorkspaceMode(): Promise<void> {
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
  })
  let settled = false
  let complete!: () => void
  const exited = new Promise<void>((resolve) => {
    complete = () => {
      if (settled) return
      settled = true
      resolve()
    }
  })
  const onKeypress = (event: KeyEvent) => {
    if (isAstraNoWorkspaceModeExitKey(event)) complete()
  }
  renderer.keyInput.on("keypress", onKeypress)
  renderer.once("destroy", complete)

  try {
    await render(() => <AstraNoWorkspaceMode onExit={complete} />, renderer)
    await exited
  } finally {
    renderer.keyInput.off("keypress", onKeypress)
    if (!renderer.isDestroyed) renderer.destroy()
  }
}

export function AstraNoWorkspaceMode(props: { onExit: () => void }) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 16)
  const visual = createMemo(() => lynxFrame("idle", compact() ? "compact" : "full", 0, false))

  useKeyboard((event) => {
    if (isAstraNoWorkspaceModeExitKey(event)) props.onExit()
  })

  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <box width={Math.min(82, Math.max(1, dimensions().width - 4))} flexDirection="column" gap={compact() ? 0 : 1}>
        <box flexDirection={compact() ? "column" : "row"} justifyContent="space-between">
          <text fg={palette.primary} attributes={TextAttributes.BOLD}>
            ASTRA / NO WORKSPACE
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
            <text fg={palette.text} attributes={TextAttributes.BOLD}>
              No workspace is open
            </text>
            <text fg={palette.muted}>Open one explicitly after leaving this screen:</text>
            <text fg={palette.primary}>astra .</text>
            <text fg={palette.primary}>astra /absolute/path</text>
            <Show when={!compact()}>
              <text fg={palette.muted}>No directory was scanned. No workspace service or effect was started.</text>
            </Show>
          </box>
        </box>

        <box flexDirection="row" gap={2}>
          <text fg={palette.text}>
            <span style={{ fg: palette.primary }}>[Q]</span> Exit
          </text>
          <Show when={!compact()}>
            <text fg={palette.muted}>Esc / Ctrl-C also exit</text>
          </Show>
        </box>
      </box>
    </box>
  )
}

export function isAstraNoWorkspaceModeExitKey(event: Readonly<{ name: string; ctrl?: boolean }>) {
  return (event.ctrl === true && event.name === "c") || event.name === "escape" || event.name.toLowerCase() === "q"
}
