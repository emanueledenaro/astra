/** @jsxImportSource @opentui/solid */
import { TextAttributes, createCliRenderer, type KeyEvent } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, type JSX } from "solid-js"
import {
  parseAstraSystemSnapshot,
  type AstraSystemDecision,
  type AstraSystemSnapshot,
} from "@astra/domain/system-control"

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

const emptySnapshot: AstraSystemSnapshot = {
  version: "unknown",
  executionBackend: "host-no-sandbox",
  reviewMode: "manual",
  providers: [],
  extensions: [],
  recentSessions: [],
  recentReceipts: [],
}

export const ASTRA_SYSTEM_MODE_STATUS = "NO WORKSPACE AUTHORITY"

export type AstraSystemModeEntry =
  | Readonly<{ ok: true; snapshot: AstraSystemSnapshot }>
  | Readonly<{ ok: false }>

/** Parses parent-supplied display facts before the inert renderer sees them. */
export function createAstraSystemModeEntry(snapshot: unknown): AstraSystemModeEntry {
  const parsed = parseAstraSystemSnapshot(snapshot)
  if (!parsed.ok) return { ok: false }
  return { ok: true, snapshot: parsed.value }
}

/** Opens the inert Control Center and returns only a typed parent-owned intent. */
export async function runAstraSystemMode(snapshot: unknown = emptySnapshot): Promise<AstraSystemDecision> {
  const entry = createAstraSystemModeEntry(snapshot)
  if (!entry.ok) return { kind: "exit" }
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
  })
  let settled = false
  let complete!: (decision: AstraSystemDecision) => void
  const decision = new Promise<AstraSystemDecision>((resolve) => {
    complete = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  renderer.once("destroy", () => complete({ kind: "exit" }))

  try {
    await render(() => <AstraSystemMode snapshot={entry.snapshot} onDecision={complete} />, renderer)
    return await decision
  } finally {
    if (!renderer.isDestroyed) renderer.destroy()
  }
}

export function AstraSystemMode(props: {
  snapshot: unknown
  onDecision: (decision: AstraSystemDecision) => void
}) {
  const entry = createAstraSystemModeEntry(props.snapshot)
  if (!entry.ok) return <AstraSystemModeUnavailable />
  return <AstraSystemModeContent snapshot={entry.snapshot} onDecision={props.onDecision} />
}

function AstraSystemModeContent(props: {
  snapshot: AstraSystemSnapshot
  onDecision: (decision: AstraSystemDecision) => void
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 62 || dimensions().height < 18)
  const connectable = createMemo(() =>
    props.snapshot.providers.find((provider) => provider.id === "anthropic" && provider.credential === "missing"),
  )

  useKeyboard((event) => {
    if (isAstraSystemModeExitKey(event)) return props.onDecision({ kind: "exit" })
    const key = event.name.toLowerCase()
    if (key === "c" && connectable()) {
      return props.onDecision({ kind: "connect-provider", providerID: connectable()!.id })
    }
    if (key === "m") {
      return props.onDecision({
        kind: "set-review-mode",
        mode: props.snapshot.reviewMode === "manual" ? "auto-session" : "manual",
      })
    }
  })

  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <box width={Math.min(94, Math.max(1, dimensions().width - 4))} flexDirection="column" gap={compact() ? 0 : 1}>
        <box flexDirection={compact() ? "column" : "row"} justifyContent="space-between">
          <text fg={palette.primary} attributes={TextAttributes.BOLD}>
            ASTRA / CONTROL CENTER
          </text>
          <text fg={palette.warning}>{ASTRA_SYSTEM_MODE_STATUS}</text>
        </box>

        <Show
          when={!compact()}
          fallback={<CompactControlCenter snapshot={props.snapshot} />}
        >
          <box border borderStyle="rounded" borderColor={palette.border} backgroundColor={palette.panel} paddingLeft={2} paddingRight={2} flexDirection="column" gap={1}>
            <ControlSection title="Providers">
              <For each={props.snapshot.providers} fallback={<text fg={palette.muted}>No trusted provider metadata available.</text>}>
                {(provider) => (
                  <text fg={palette.text}>
                    {provider.name} · credential {provider.credential}
                  </text>
                )}
              </For>
            </ControlSection>
            <ControlSection title="Extensions">
              <For each={props.snapshot.extensions} fallback={<text fg={palette.muted}>No global extension inventory available.</text>}>
                {(extension) => (
                  <text fg={palette.text}>
                    {extension.kind} · {extension.id} · {extension.state}
                  </text>
                )}
              </For>
            </ControlSection>
            <ControlSection title="Sessions">
              <For each={props.snapshot.recentSessions} fallback={<text fg={palette.muted}>No global sessions available.</text>}>
                {(session) => <text fg={palette.text}>{session.workspaceRoot}</text>}
              </For>
            </ControlSection>
            <ControlSection title="Receipts">
              <For each={props.snapshot.recentReceipts} fallback={<text fg={palette.muted}>No ledger receipts available.</text>}>
                {(receipt) => (
                  <text fg={palette.text}>
                    {receipt.operationID} · {receipt.state}
                  </text>
                )}
              </For>
            </ControlSection>
            <ControlSection title="Diagnostics">
              <text fg={palette.muted}>Version: {props.snapshot.version}</text>
              <text fg={palette.muted}>Execution backend: {props.snapshot.executionBackend}</text>
              <text fg={palette.muted}>Review mode: {props.snapshot.reviewMode} · session memory only</text>
              <text fg={palette.warning}>Workspace files, Git, shell, and workspace Operations stay unavailable.</text>
            </ControlSection>
          </box>
        </Show>

        <Show
          when={!compact()}
          fallback={
            <box flexDirection="row" gap={1}>
              <Show when={connectable()}>
                <text fg={palette.text}><span style={{ fg: palette.primary }}>[C]</span> Connect</text>
              </Show>
              <text fg={palette.text}><span style={{ fg: palette.primary }}>[M]</span> Review</text>
              <text fg={palette.text}><span style={{ fg: palette.primary }}>[Q]</span> Exit</text>
            </box>
          }
        >
          <box flexDirection="row" gap={2}>
            <Show when={connectable()}>
              <text fg={palette.text}>
                <span style={{ fg: palette.primary }}>[C]</span> Connect provider
              </text>
            </Show>
            <text fg={palette.text}>
              <span style={{ fg: palette.primary }}>[M]</span> {props.snapshot.reviewMode === "manual" ? "Auto Review" : "Manual Review"}
            </text>
            <text fg={palette.text}>
              <span style={{ fg: palette.primary }}>[Q]</span> Exit
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function CompactControlCenter(props: { snapshot: AstraSystemSnapshot }) {
  return (
    <box border borderStyle="rounded" borderColor={palette.border} backgroundColor={palette.panel} paddingLeft={1} paddingRight={1} flexDirection="column">
      <text fg={palette.accent} attributes={TextAttributes.BOLD}>Providers</text>
      <text fg={palette.text}>{props.snapshot.providers[0]?.name ?? "No providers"}</text>
      <text fg={palette.accent} attributes={TextAttributes.BOLD}>Extensions</text>
      <text fg={palette.text}>{props.snapshot.extensions[0]?.id ?? "No extensions"}</text>
      <text fg={palette.accent} attributes={TextAttributes.BOLD}>Sessions · Receipts</text>
      <text fg={palette.muted}>{props.snapshot.recentSessions.length} sessions · {props.snapshot.recentReceipts.length} receipts</text>
      <text fg={palette.accent} attributes={TextAttributes.BOLD}>Diagnostics</text>
      <text fg={palette.warning}>{ASTRA_SYSTEM_MODE_STATUS}</text>
      <text fg={palette.muted}>Review: {props.snapshot.reviewMode}</text>
    </box>
  )
}

function ControlSection(props: { title: string; children: JSX.Element }) {
  return (
    <box flexDirection="column">
      <text fg={palette.accent} attributes={TextAttributes.BOLD}>{props.title}</text>
      {props.children}
    </box>
  )
}

function AstraSystemModeUnavailable() {
  return (
    <box width="100%" height="100%" backgroundColor={palette.background} alignItems="center" justifyContent="center">
      <text fg={palette.warning}>Control Center data unavailable</text>
    </box>
  )
}

export function isAstraSystemModeExitKey(event: Readonly<{ name: string; ctrl?: boolean }>) {
  return (event.ctrl === true && event.name === "c") || event.name === "escape" || event.name.toLowerCase() === "q"
}
