import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import {
  lynxFrame,
  lynxSequence,
  type LynxPresentationState,
  type LynxSequence,
  type LynxSize,
  type LynxTone,
} from "./lynx-model"

export type { LynxPresentationState, LynxSequence, LynxSize } from "./lynx-model"

export type LynxIllustrationRenderer = (input: {
  state: LynxPresentationState
  size: LynxSize
  sequence: LynxSequence["illustrated"]
  motionEnabled: boolean
}) => JSX.Element | undefined

export function Lynx(props: {
  state: LynxPresentationState
  size?: LynxSize
  showVisual?: boolean
  animate?: boolean
  color?: boolean
  renderIllustration?: LynxIllustrationRenderer
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const [frameIndex, setFrameIndex] = createSignal(0)
  const size = () => props.size ?? "full"
  const sequence = createMemo(() => lynxSequence(props.state))
  const motionEnabled = createMemo(
    () =>
      props.animate !== false &&
      kv.get("animations_enabled", true) &&
      (props.renderIllustration
        ? sequence().illustrated.playback !== "static" && sequence().illustrated.frames.length > 1
        : sequence().terminal.frames[size()].length > 1),
  )
  const frame = createMemo(() => lynxFrame(props.state, size(), frameIndex(), motionEnabled()))
  const illustration = createMemo(() =>
    props.renderIllustration?.({
      state: props.state,
      size: size(),
      sequence: sequence().illustrated,
      motionEnabled: motionEnabled(),
    }),
  )
  const colorEnabled = () => props.color !== false && process.env.NO_COLOR === undefined
  const color = () => (colorEnabled() ? toneColor(frame().tone, theme) : undefined)

  createEffect(() => {
    const durationMs = frame().durationMs
    if (durationMs === 0) {
      setFrameIndex(0)
      return
    }
    const timer = setInterval(() => setFrameIndex((value) => value + 1), durationMs)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box flexDirection={size() === "compact" ? "row" : "column"} gap={size() === "compact" ? 1 : 0}>
      <Show when={props.showVisual !== false}>
        <Show when={illustration()} fallback={<TerminalVisual frame={frame()} color={color()} />}>
          {illustration()}
        </Show>
      </Show>
      <text fg={color()}>{frame().label}</text>
    </box>
  )
}

function TerminalVisual(props: { frame: ReturnType<typeof lynxFrame>; color?: RGBA }) {
  return (
    <box flexDirection="column">
      <For each={props.frame.lines}>
        {(line) => (
          <text fg={props.color} selectable={false} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

function toneColor(
  tone: LynxTone,
  theme: { primary: RGBA; warning: RGBA; success: RGBA; error: RGBA; textMuted: RGBA },
) {
  if (tone === "primary") return theme.primary
  if (tone === "warning") return theme.warning
  if (tone === "success") return theme.success
  if (tone === "error") return theme.error
  return theme.textMuted
}
