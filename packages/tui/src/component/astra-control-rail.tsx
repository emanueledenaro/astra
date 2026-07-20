/** @jsxImportSource @opentui/solid */

import type { AstraAgentProjection, AstraWorkSessionProjection } from "@astra/domain/work-session"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { For, Show, type JSX } from "solid-js"
import type { AstraWorkSessionView } from "../astra/work-session-client"
import { Lynx, type LynxPresentationState } from "./lynx"

export function AstraControlRail(props: {
  api: TuiPluginApi
  view: AstraWorkSessionView
  candidateAvailable: boolean
}) {
  return (
    <box width="100%" height="100%" flexDirection="column">
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={props.api.theme.current.primary}>CONTROL</text>
        <box flexGrow={1} />
        <text fg={statusColor(props.api, props.view)}>{statusLabel(props.view)}</text>
      </box>
      <Show
        when={props.view.status === "available" ? props.view.projection : undefined}
        fallback={
          <box marginTop={1} flexDirection="column">
            <text fg={props.api.theme.current.error}>STATE UNAVAILABLE</text>
            <text fg={props.api.theme.current.textMuted}>PARENT STREAM LOST</text>
            <text fg={props.api.theme.current.textMuted}>Control state is hidden until a fresh validated snapshot arrives.</text>
          </box>
        }
      >
        {(projection) => <AvailableRail api={props.api} projection={projection()} candidateAvailable={props.candidateAvailable} />}
      </Show>
    </box>
  )
}

function AvailableRail(props: {
  api: TuiPluginApi
  projection: AstraWorkSessionProjection
  candidateAvailable: boolean
}) {
  const pending = () => props.projection.decisions.filter((decision) => decision.state === "pending")
  const showIntent = () => props.projection.objective !== null || props.projection.phase !== "idle"
  return (
    <scrollbox flexGrow={1} stickyScroll={false}>
      <box flexDirection="column" paddingBottom={1}>
        <box marginTop={1}>
          <Lynx state={lynxState(props.projection)} size="compact" />
        </box>

        <Show when={props.projection.reconciliationPending}>
          <Section title="RECONCILIATION REQUIRED" api={props.api} tone="error">
            <RailValue value={props.projection.intent.summary} api={props.api} />
          </Section>
        </Show>

        <Show when={pending()[0]}>
          {(decision) => (
            <Section title="DECISION" api={props.api} tone="warning">
              <RailValue value={decision().summary} api={props.api} />
              <RailRow label="BOUNDARY" value={decision().boundary} api={props.api} />
              <For each={decision().resources}>{(resource) => <RailValue value={resource} api={props.api} prefix="• " />}</For>
              <Show when={pending().length > 1}>
                <text fg={props.api.theme.current.textMuted}>{pending().length - 1} OTHER PENDING</text>
              </Show>
              <text fg={props.api.theme.current.warning}>A APPROVE · D REJECT</text>
            </Section>
          )}
        </Show>

        <Show when={props.projection.phase === "review-ready"}>
          <Section title="REVIEW READY" api={props.api} tone="warning">
            <text fg={props.candidateAvailable ? props.api.theme.current.primary : props.api.theme.current.warning}>
              {props.candidateAvailable ? "CANDIDATE METADATA VALIDATED · CTRL+X R" : "CANDIDATE DETAILS UNAVAILABLE"}
            </text>
          </Section>
        </Show>

        <Show when={showIntent()}>
          <Section title="INTENT" api={props.api}>
            <Show when={props.projection.objective}>{(objective) => <RailValue value={objective()} api={props.api} />}</Show>
            <RailRow label="NOW" value={props.projection.intent.summary} api={props.api} />
            <RailRow label="NEXT" value={props.projection.intent.next} api={props.api} />
          </Section>
        </Show>

        <Show when={props.projection.agents.length > 0}>
          <Section title="WORK TREE" api={props.api}>
            <For each={props.projection.agents}>
              {(agent) => (
                <box flexDirection="column" marginBottom={1}>
                  <text fg={agentColor(props.api, agent)}>{`${agentPrefix(props.projection.agents, agent)}${agent.label} · ${agent.state.toUpperCase()}`}</text>
                  <text fg={props.api.theme.current.textMuted}>{`${"  ".repeat(agentDepth(props.projection.agents, agent))}${agent.activity}`}</text>
                  <text fg={props.api.theme.current.textMuted}>{`${"  ".repeat(agentDepth(props.projection.agents, agent))}effect authority: ${agent.effectAuthority}`}</text>
                </box>
              )}
            </For>
          </Section>
        </Show>

        <Show when={props.projection.evidence.length > 0}>
          <Section title="PROOF" api={props.api}>
            <For each={props.projection.evidence}>
              {(evidence) => (
                <box flexDirection="column" marginBottom={1}>
                  <RailValue value={`${evidence.label} · ${evidence.value}`} api={props.api} />
                  <text fg={props.api.theme.current.textMuted}>{evidence.assurance}</text>
                </box>
              )}
            </For>
          </Section>
        </Show>
      </box>
    </scrollbox>
  )
}

function Section(props: { title: string; api: TuiPluginApi; tone?: "warning" | "error"; children: JSX.Element }) {
  const color = () =>
    props.tone === "error"
      ? props.api.theme.current.error
      : props.tone === "warning"
        ? props.api.theme.current.warning
        : props.api.theme.current.primary
  return (
    <box marginTop={1} flexDirection="column" flexShrink={0}>
      <text fg={color()}>{props.title}</text>
      {props.children}
    </box>
  )
}

function RailRow(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={9} fg={props.api.theme.current.textMuted}>{props.label}</text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

function RailValue(props: { value: string; api: TuiPluginApi; prefix?: string }) {
  return <text fg={props.api.theme.current.text}>{`${props.prefix ?? ""}${props.value}`}</text>
}

function statusLabel(view: AstraWorkSessionView) {
  if (view.status !== "available") return "UNAVAILABLE"
  return view.projection.phase.replaceAll("-", " ").toUpperCase()
}

function statusColor(api: TuiPluginApi, view: AstraWorkSessionView) {
  if (view.status !== "available" || view.projection.phase === "blocked") return api.theme.current.error
  if (view.projection.reconciliationPending || view.projection.phase === "uncertain") return api.theme.current.warning
  return api.theme.current.primary
}

function lynxState(projection: AstraWorkSessionProjection): LynxPresentationState {
  if (projection.decisions.some((decision) => decision.state === "pending") || projection.phase === "review-ready") {
    return "awaiting-decision"
  }
  if (projection.reconciliationPending || projection.phase === "uncertain" || projection.phase === "reconciliation-required") {
    return "uncertain"
  }
  if (projection.phase === "blocked" || projection.agents.some((agent) => agent.state === "failed" || agent.state === "lost")) {
    return "blocked"
  }
  if (["analyzing", "working", "applying", "checking"].includes(projection.phase)) return "working"
  return "idle"
}

function agentDepth(agents: ReadonlyArray<AstraAgentProjection>, agent: AstraAgentProjection) {
  let depth = 0
  let parent = agent.parentAgentID
  while (parent && depth < agents.length) {
    depth += 1
    parent = agents.find((candidate) => candidate.agentID === parent)?.parentAgentID ?? null
  }
  return depth
}

function agentPrefix(agents: ReadonlyArray<AstraAgentProjection>, agent: AstraAgentProjection) {
  const depth = agentDepth(agents, agent)
  return depth === 0 ? "" : `${"  ".repeat(depth - 1)}└─ `
}

function agentColor(api: TuiPluginApi, agent: AstraAgentProjection) {
  if (agent.state === "failed" || agent.state === "lost") return api.theme.current.error
  if (agent.state === "waiting" || agent.state === "cancelled") return api.theme.current.warning
  if (agent.state === "completed") return api.theme.current.success
  return api.theme.current.text
}
