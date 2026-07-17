export type LynxPresentationState =
  | "initializing"
  | "idle"
  | "read-only"
  | "awaiting-decision"
  | "working"
  | "retrying"
  | "blocked"
  | "success"
  | "uncertain"
  | "error"

export type LynxSize = "full" | "compact"

export type LynxTone = "muted" | "primary" | "warning" | "success" | "error"

export type LynxPlayback = "static" | "loop" | "once-hold"

export type LynxIllustratedFrame = {
  id: string
  durationMs: number
}

export type LynxSequence = {
  state: LynxPresentationState
  label: string
  compactLabel: string
  tone: LynxTone
  terminal: {
    playback: "static" | "loop"
    frameDurationMs: number
    frames: Record<LynxSize, readonly (readonly string[])[]>
  }
  illustrated: {
    playback: LynxPlayback
    frames: readonly LynxIllustratedFrame[]
  }
}

export type LynxFrame = {
  lines: readonly string[]
  label: string
  tone: LynxTone
  durationMs: number
}

export const LYNX_SEQUENCES = {
  initializing: sequence({
    state: "initializing",
    eyes: "·",
    screen: "START ",
    label: "Astra is starting",
    compactLabel: "Starting",
    tone: "muted",
    illustrated: {
      playback: "loop",
      frames: frames(["initializing-01", 600], ["initializing-02", 600]),
    },
  }),
  idle: sequence({
    state: "idle",
    eyes: "·",
    screen: "READY ",
    label: "Lynx is idle",
    compactLabel: "Idle",
    tone: "muted",
    illustrated: {
      playback: "loop",
      frames: frames(["idle-01", 1600], ["idle-blink", 120], ["idle-01", 1600]),
    },
  }),
  "read-only": sequence({
    state: "read-only",
    eyes: "•",
    screen: " READ ",
    label: "Read-only workspace",
    compactLabel: "Read-only",
    tone: "primary",
    illustrated: { playback: "static", frames: frames(["read-only-01", 0]) },
  }),
  "awaiting-decision": sequence({
    state: "awaiting-decision",
    eyes: "◉",
    screen: " WAIT ",
    label: "Waiting for your decision",
    compactLabel: "Decision needed",
    tone: "warning",
    illustrated: {
      playback: "loop",
      frames: frames(["awaiting-01", 600], ["awaiting-02", 600]),
    },
  }),
  working: sequence({
    state: "working",
    eyes: "●",
    screen: " WORK ",
    label: "Lynx is typing",
    compactLabel: "Working",
    tone: "primary",
    typing: true,
    illustrated: {
      playback: "loop",
      frames: frames(["typing-01", 220], ["typing-02", 220]),
    },
  }),
  retrying: sequence({
    state: "retrying",
    eyes: "•",
    screen: "RETRY ",
    label: "Retry scheduled",
    compactLabel: "Retrying",
    tone: "warning",
    illustrated: {
      playback: "loop",
      frames: frames(["retrying-01", 600], ["retrying-02", 600]),
    },
  }),
  blocked: sequence({
    state: "blocked",
    eyes: "×",
    screen: " STOP ",
    label: "Operation blocked",
    compactLabel: "Blocked",
    tone: "warning",
    illustrated: { playback: "static", frames: frames(["blocked-01", 0]) },
  }),
  success: sequence({
    state: "success",
    eyes: "^",
    screen: " DONE ",
    label: "Operation completed",
    compactLabel: "Completed",
    tone: "success",
    illustrated: {
      playback: "once-hold",
      frames: frames(["success-01", 160], ["success-02", 160], ["success-03", 0]),
    },
  }),
  uncertain: sequence({
    state: "uncertain",
    eyes: "?",
    screen: "  ?   ",
    label: "Outcome uncertain",
    compactLabel: "Uncertain",
    tone: "warning",
    illustrated: {
      playback: "loop",
      frames: frames(["uncertain-01", 600], ["uncertain-02", 600]),
    },
  }),
  error: sequence({
    state: "error",
    eyes: "×",
    screen: "ERROR ",
    label: "Operation failed",
    compactLabel: "Failed",
    tone: "error",
    illustrated: { playback: "static", frames: frames(["error-01", 0]) },
  }),
} as const satisfies Record<LynxPresentationState, LynxSequence>

export function lynxSequence(state: LynxPresentationState): LynxSequence {
  return LYNX_SEQUENCES[state]
}

export function lynxFrame(
  state: LynxPresentationState,
  size: LynxSize,
  frameIndex: number,
  motionEnabled: boolean,
): LynxFrame {
  const value = lynxSequence(state)
  const frames = value.terminal.frames[size]
  const index = motionEnabled && frames.length > 1 ? Math.abs(frameIndex) % frames.length : 0
  return {
    lines: frames[index],
    label: size === "compact" ? value.compactLabel : value.label,
    tone: value.tone,
    durationMs: motionEnabled && frames.length > 1 ? value.terminal.frameDurationMs : 0,
  }
}

function sequence(input: {
  state: LynxPresentationState
  eyes: string
  screen: string
  label: string
  compactLabel: string
  tone: LynxTone
  typing?: boolean
  illustrated: LynxSequence["illustrated"]
}): LynxSequence {
  const terminalFrames = input.typing
    ? [terminal(input.eyes, input.screen, 0), terminal(input.eyes, input.screen, 1)]
    : [terminal(input.eyes, input.screen, 0)]
  return {
    state: input.state,
    label: input.label,
    compactLabel: input.compactLabel,
    tone: input.tone,
    terminal: {
      playback: input.typing ? "loop" : "static",
      frameDurationMs: input.typing ? 220 : 0,
      frames: {
        full: terminalFrames.map((frame) => frame.full),
        compact: terminalFrames.map((frame) => frame.compact),
      },
    },
    illustrated: input.illustrated,
  }
}

function terminal(eyes: string, screen: string, typingFrame: number) {
  const paws = typingFrame === 0 ? "  ▄██▄╲   ╱▄██▄" : "  ▄██▄╱   ╲▄██▄"
  const compactPaws = typingFrame === 0 ? "▟▙⌨▟▙" : "▙▟⌨▙▟"
  return {
    compact: [`▄█▄▟${eyes}▴${eyes}▙▄█▄  ${compactPaws}`],
    full: [
      "   ▄█▄     ▄█▄     ╭──────╮",
      "  █ ▀█▄   ▄█▀ █    │ ASTRA│",
      " █   ▀█▄█▄█▀   █   │      │",
      ` █   ${eyes}  ▴  ${eyes}   █   │${screen}│`,
      "  ▀▄    ▿    ▄▀    ╰──┬───╯",
      `${paws}    ╭──┴────╮`,
      " ▀▀▀▀▀     ▀▀▀▀▀   ╰────────╯",
    ].map((line) => line.padEnd(30)),
  }
}

function frames(...values: ReadonlyArray<readonly [id: string, durationMs: number]>): LynxIllustratedFrame[] {
  return values.map(([id, durationMs]) => ({ id, durationMs }))
}
