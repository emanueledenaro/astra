/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createAstraProviderClient, type AstraProviderClient } from "../astra/provider-client"
import {
  createAstraWorkSessionClient,
  type AstraWorkSessionClient,
  type AstraWorkSessionView,
} from "../astra/work-session-client"
import { useTuiConfig } from "../config"
import { AstraChatView, type AstraChatActivity } from "../feature-plugins/system/astra-chat"
import { useBindings } from "../keymap"
import { Locale } from "../util/locale"
import { AstraControlRail } from "./astra-control-rail"
import {
  AstraReviewMode,
  validateAstraCandidatePatchDetails,
  type AstraCandidatePatchDetails,
} from "./astra-review-mode"

export type { AstraCandidatePatchDetails } from "./astra-review-mode"

const initialActivity: AstraChatActivity = {
  status: "loading_catalog",
  label: "LOADING TRUSTED CATALOG · NO EFFECT",
  summary: "Loading the trusted provider catalog",
  decisionRequired: false,
}

/** Parent-owned work state surrounds a continuously mounted conversation surface. */
export function AstraCockpit(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  providerClient?: AstraProviderClient
  workSessionClient?: AstraWorkSessionClient
  candidatePatchDetails?: unknown
}) {
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const [activity, setActivity] = createSignal(initialActivity)
  const [workView, setWorkView] = createSignal<AstraWorkSessionView>({
    status: "state_unavailable",
    reason: "transport_failed",
  })
  const [compactControl, setCompactControl] = createSignal(false)
  const [reviewOpen, setReviewOpen] = createSignal(false)
  const sideBySide = createMemo(
    () =>
      (dimensions().width >= 124 && dimensions().height >= 28) ||
      (dimensions().width >= 92 && dimensions().height >= 22),
  )
  const railWidth = createMemo(() =>
    dimensions().width >= 124 ? Math.min(44, Math.max(36, Math.floor(dimensions().width * 0.3))) : 34,
  )
  const projection = createMemo(() => {
    const view = workView()
    return view.status === "available" ? view.projection : undefined
  })
  const pending = createMemo(() => projection()?.decisions.filter((decision) => decision.state === "pending") ?? [])
  const candidate = createMemo(() =>
    validateAstraCandidatePatchDetails(props.candidatePatchDetails, projection(), props.authority),
  )
  const ownsProviderClient = !props.providerClient
  const providerClient = props.providerClient ?? createAstraProviderClient(process.env, props.authority.sessionID)
  const ownsWorkSessionClient = !props.workSessionClient
  const workSessionClient = props.workSessionClient ?? createAstraWorkSessionClient(process.env, props.authority.sessionID)
  const subscription = new AbortController()

  const decide = (outcome: "approved" | "rejected") => {
    const decision = pending()[0]
    if (!decision) return
    void workSessionClient.decide(decision.decisionID, outcome).catch(() => {
      setWorkView({ status: "state_unavailable", reason: "transport_failed" })
    })
  }
  const toggleReview = () => {
    if (reviewOpen()) return setReviewOpen(false)
    if (props.api.ui.dialog.open || !candidate()) return
    setReviewOpen(true)
  }

  onMount(() => {
    let active = true
    void workSessionClient
      .snapshot()
      .then((view) => {
        if (!active) return
        setWorkView(view)
        if (view.status !== "available") return
        return workSessionClient.subscribe(
          (next) => {
            if (active) setWorkView(next)
          },
          { signal: subscription.signal },
        )
      })
      .catch(() => {
        if (active) setWorkView({ status: "state_unavailable", reason: "transport_failed" })
      })
    onCleanup(() => {
      active = false
    })
  })

  useBindings(() => ({
    enabled: !props.api.ui.dialog.open,
    commands: [
      {
        name: "astra.control.toggle",
        title: "Toggle Astra Control Rail",
        category: "Astra",
        run: () => {
          if (!sideBySide() && !reviewOpen()) setCompactControl((value) => !value)
        },
      },
      ...(pending().length > 0
        ? [
            { name: "astra.work.approve", title: "Approve Parent Decision", category: "Astra", run: () => decide("approved") },
            { name: "astra.work.reject", title: "Reject Parent Decision", category: "Astra", run: () => decide("rejected") },
          ]
        : []),
      { name: "astra.review.toggle", title: "Open Candidate Review", category: "Astra", run: toggleReview },
      { name: "astra.review.close", title: "Return to Astra Chat", category: "Astra", run: () => setReviewOpen(false) },
    ],
    bindings: [
      ...tuiConfig.keybinds.get("astra.control.toggle"),
      ...tuiConfig.keybinds.get("astra.review.toggle"),
      ...(pending().length > 0
        ? [
            { key: "a", cmd: "astra.work.approve", desc: "Approve" },
            { key: "d", cmd: "astra.work.reject", desc: "Reject" },
          ]
        : []),
      ...(reviewOpen() ? [{ key: "escape", cmd: "astra.review.close", desc: "Back to chat" }] : []),
    ],
  }))

  onCleanup(() => {
    subscription.abort()
    if (ownsProviderClient) providerClient.dispose()
    if (ownsWorkSessionClient) workSessionClient.dispose()
  })

  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <ContextBar api={props.api} authority={props.authority} activity={activity()} reviewOpen={reviewOpen()} width={dimensions().width - 2} />

      <box flexGrow={1} minHeight={0} flexDirection="row" gap={sideBySide() ? 1 : 0}>
        <box
          visible={sideBySide() || !compactControl()}
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          border
          borderStyle="rounded"
          borderColor={props.api.theme.current.primary}
        >
          <box visible={!reviewOpen()} width="100%" height="100%">
            <AstraChatView
              embedded
              api={props.api}
              authority={props.authority}
              client={providerClient}
              bindingsSuspended={reviewOpen()}
              workDecisionHasFocus={pending().length > 0}
              onActivity={setActivity}
            />
          </box>
          <box visible={reviewOpen()} width="100%" height="100%">
            <Show when={candidate()}>{(details) => <AstraReviewMode api={props.api} details={details()} />}</Show>
          </box>
        </box>

        <box
          visible={sideBySide() || compactControl()}
          width={sideBySide() ? railWidth() : "100%"}
          flexShrink={0}
          minHeight={0}
          border
          borderStyle="rounded"
          borderColor={pending().length > 0 ? props.api.theme.current.warning : props.api.theme.current.border}
          paddingLeft={1}
          paddingRight={1}
        >
          <AstraControlRail
            api={props.api}
            view={workView()}
            candidateAvailable={candidate() !== undefined}
            providerOperation={activity().providerOperation}
            workDecisionHasFocus={pending().length > 0}
          />
        </box>
      </box>

      <BoundaryBar
        api={props.api}
        authority={props.authority}
        compact={!sideBySide()}
        controlVisible={compactControl()}
      />
    </box>
  )
}

function ContextBar(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  activity: AstraChatActivity
  reviewOpen: boolean
  width: number
}) {
  const provider = () =>
    props.activity.providerName && props.activity.modelID
      ? `${props.activity.providerName}/${props.activity.modelID}`
      : "PROVIDER OFFLINE"
  const raw = () =>
    `◆ ASTRA │ ${workspaceName(props.authority.workspace.root)} │ ${branchAtAdmission(props.authority)} │ ${provider()} │ REVIEW MANUAL${props.reviewOpen ? " · CANDIDATE" : ""}`
  return (
    <box height={1} flexShrink={0}>
      <text fg={props.api.theme.current.primary} wrapMode="none">
        {Locale.truncate(raw(), Math.max(1, props.width))}
      </text>
    </box>
  )
}

function BoundaryBar(props: {
  api: TuiPluginApi
  authority: AstraSessionAuthority
  compact: boolean
  controlVisible: boolean
}) {
  return (
    <box height={1} flexShrink={0} flexDirection="row">
      <text fg={props.authority.mode === "activate-once" ? props.api.theme.current.error : props.api.theme.current.primary}>
        {props.authority.mode === "activate-once" ? "HOST EXECUTION — NO SANDBOX" : "READ ONLY — EFFECTS DENIED"}
      </text>
      <box flexGrow={1} />
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        {props.compact ? `Ctrl+X I ${props.controlVisible ? "CHAT" : "CONTROL"}` : "Ctrl+X I CONTROL · Ctrl+P ACTIONS"}
      </text>
    </box>
  )
}

function workspaceName(root: string) {
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root
}

function branchAtAdmission(authority: AstraSessionAuthority) {
  const head = authority.repositoryBaseline?.head
  if (!head) return "NO GIT"
  if (head.kind === "unborn" || head.kind === "symbolic") return head.symbolicRef.replace(/^refs\/heads\//u, "")
  return `DETACHED ${head.oid.slice(0, 8)}`
}
