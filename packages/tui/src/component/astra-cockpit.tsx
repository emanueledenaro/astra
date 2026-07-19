/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { createAstraProviderClient, type AstraProviderClient } from "../astra/provider-client"
import { AstraChatView, type AstraChatActivity } from "../feature-plugins/system/astra-chat"
import { Lynx, type LynxPresentationState } from "./lynx"

const initialActivity: AstraChatActivity = {
  status: "loading_catalog",
  label: "LOADING TRUSTED CATALOG · NO EFFECT",
  summary: "Loading the trusted provider catalog",
  decisionRequired: false,
}

/** The primary Astra product surface: conversation stays visible while control remains observable. */
export function AstraCockpit(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  providerClient?: AstraProviderClient
}) {
  const dimensions = useTerminalDimensions()
  const [activity, setActivity] = createSignal(initialActivity)
  const sideBySide = createMemo(() => dimensions().width >= 72 && dimensions().height >= 18)
  const detailedRail = createMemo(() => dimensions().width >= 104 && dimensions().height >= 32)
  const workspace = createMemo(() => workspaceName(props.authority.workspace.root))
  const ownsProviderClient = !props.providerClient
  const providerClient = props.providerClient ?? createAstraProviderClient(process.env, props.authority.sessionID)

  onCleanup(() => {
    if (ownsProviderClient) providerClient.dispose()
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={props.api.theme.current.primary}>◆ ASTRA COCKPIT</text>
        <text fg={props.api.theme.current.textMuted}> PROJECT / </text>
        <text fg={props.api.theme.current.text}>{workspace()}</text>
        <box flexGrow={1} />
        <text fg={modeColor(props.api, props.authority.mode)}>{modeLabel(props.authority.mode)}</text>
      </box>

      <box flexGrow={1} minHeight={0} flexDirection={sideBySide() ? "row" : "column"} gap={1}>
        <box
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          border
          borderStyle="rounded"
          borderColor={props.api.theme.current.primary}
        >
          <AstraChatView
            embedded
            api={props.api}
            authority={props.authority}
            client={providerClient}
            onActivity={setActivity}
          />
        </box>

        <box
          width={
            sideBySide()
              ? detailedRail()
                ? Math.min(46, Math.max(36, Math.floor(dimensions().width * 0.34)))
                : 32
              : "100%"
          }
          height={sideBySide() ? "100%" : 9}
          flexShrink={0}
          minHeight={0}
          border
          borderStyle="rounded"
          borderColor={activity().decisionRequired ? props.api.theme.current.warning : props.api.theme.current.border}
          paddingLeft={1}
          paddingRight={1}
        >
          <AstraControlRail
            api={props.api}
            authority={props.authority}
            activity={activity()}
            compact={!detailedRail()}
          />
        </box>
      </box>

      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={props.api.theme.current.textMuted}>P message · Ctrl+P actions · M model</text>
        <box flexGrow={1} />
        <Show when={dimensions().width >= 100}>
          <text fg={props.api.theme.current.warning}>VISIBLE INTENT → OBSERVED ACTION → EVIDENCE</text>
        </Show>
      </box>
    </box>
  )
}

export function AstraControlRail(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  activity: AstraChatActivity
  compact?: boolean
}) {
  const lynxState = createMemo(() => activityLynxState(props.activity))

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.api.theme.current.primary}>CONTROL RAIL</text>
        <box flexGrow={1} />
        <text fg={activityColor(props.api, props.activity)}>{activityStatus(props.activity)}</text>
      </box>

      <Show when={!props.compact}>
        <box marginTop={1} flexShrink={0}>
          <Lynx state={lynxState()} size="compact" />
        </box>

        <Section title="LIVE ACTIVITY" api={props.api}>
          <RailRow label="STATE" value={props.activity.label} api={props.api} />
          <RailRow label="NOW" value={props.activity.summary} api={props.api} />
          <Show when={props.activity.providerName ?? props.activity.providerID}>
            {(provider) => <RailRow label="PROVIDER" value={provider()} api={props.api} />}
          </Show>
          <Show when={props.activity.modelID}>
            {(modelID) => <RailRow label="MODEL" value={modelID()} api={props.api} />}
          </Show>
          <Show when={props.activity.operationID}>
            {(operationID) => <RailRow label="OP" value={shortID(operationID())} api={props.api} />}
          </Show>
          <Show when={props.activity.destination}>
            {(destination) => <RailRow label="NETWORK" value={destination()} api={props.api} />}
          </Show>
          <Show when={props.activity.payloadBytes !== undefined}>
            <RailRow label="PAYLOAD" value={`${props.activity.payloadBytes} bytes`} api={props.api} />
          </Show>
        </Section>

        <Show when={props.activity.decisionRequired}>
          <box marginTop={1} border borderStyle="rounded" borderColor={props.api.theme.current.warning} paddingLeft={1}>
            <text fg={props.api.theme.current.warning}>DECISION REQUIRED · A approve · D reject</text>
          </box>
        </Show>

        <Section title="AGENTS" api={props.api}>
          <RailRow label="LYNX" value="Lynx coordinator · ACTIVE" api={props.api} />
          <RailRow label="TEAM" value="No subagents active" api={props.api} />
        </Section>

        <Section title="WORKSPACE" api={props.api}>
          <RailRow label="MODE" value={modeLabel(props.authority.mode)} api={props.api} />
          <RailRow
            label="GIT"
            value={props.authority.repositoryBaseline ? "BASELINE LOCKED" : "NO BASELINE"}
            api={props.api}
          />
          <RailRow label="TRUST" value="SESSION ONLY · NOT PERSISTED" api={props.api} />
        </Section>

        <Section title="BOUNDARY" api={props.api}>
          <Show
            when={props.authority.mode === "activate-once"}
            fallback={<text fg={props.api.theme.current.primary}>EFFECTS DENIED — NO HOST EXECUTION</text>}
          >
            <text fg={props.api.theme.current.error}>HOST EXECUTION — NO SANDBOX</text>
            <RailRow label="WRITE" value="EXPLICIT CONSENT" api={props.api} />
            <RailRow label="SHELL" value="EXPLICIT CONSENT" api={props.api} />
            <RailRow label="NETWORK" value="PER TURN CONSENT" api={props.api} />
          </Show>
        </Section>
      </Show>

      <Show when={props.compact}>
        <RailRow label="NOW" value={props.activity.summary} api={props.api} />
        <RailRow label="MODE" value={modeLabel(props.authority.mode)} api={props.api} />
        <RailRow label="AGENTS" value="Lynx coordinator · 0 subagents" api={props.api} />
        <text
          fg={
            props.authority.mode === "activate-once" ? props.api.theme.current.error : props.api.theme.current.primary
          }
        >
          {props.authority.mode === "activate-once"
            ? "HOST EXECUTION — NO SANDBOX"
            : "EFFECTS DENIED — NO HOST EXECUTION"}
        </text>
      </Show>
    </box>
  )
}

function Section(props: { title: string; api: TuiPluginApi; children: JSX.Element }) {
  return (
    <box marginTop={1} flexDirection="column" flexShrink={0}>
      <text fg={props.api.theme.current.primary}>{props.title}</text>
      {props.children}
    </box>
  )
}

function RailRow(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={9} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

function activityLynxState(activity: AstraChatActivity): LynxPresentationState {
  if (activity.status === "prepared") return "awaiting-decision"
  if (activity.status === "preparing" || activity.status === "deciding" || activity.status === "progress")
    return "working"
  if (activity.status === "completed") return "success"
  if (activity.status === "blocked" || activity.status === "denied") return "blocked"
  if (activity.status === "reconciliation") return "uncertain"
  if (activity.status === "loading_catalog") return "initializing"
  return "idle"
}

function activityStatus(activity: AstraChatActivity) {
  if (activity.status === "prepared") return "DECISION"
  if (activity.status === "preparing" || activity.status === "deciding" || activity.status === "progress")
    return "WORKING"
  if (activity.status === "completed") return "OBSERVED"
  if (activity.status === "blocked") return "BLOCKED"
  if (activity.status === "reconciliation") return "UNCERTAIN"
  if (activity.status === "loading_catalog") return "STARTING"
  return "IDLE"
}

function activityColor(api: TuiPluginApi, activity: AstraChatActivity) {
  if (activity.status === "completed") return api.theme.current.success
  if (activity.status === "blocked" || activity.status === "reconciliation") return api.theme.current.error
  if (activity.status === "prepared" || activity.status === "denied") return api.theme.current.warning
  return api.theme.current.primary
}

function modeLabel(mode: AstraSessionAuthority["mode"]) {
  return mode === "activate-once" ? "ACTIVE ONCE" : "READ ONLY"
}

function modeColor(api: TuiPluginApi, mode: AstraSessionAuthority["mode"]) {
  return mode === "activate-once" ? api.theme.current.warning : api.theme.current.primary
}

function workspaceName(root: string) {
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root
}

function shortID(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}
