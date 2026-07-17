/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useBindings } from "../../keymap"
import type { AstraExtensionInventoryClient } from "../../astra/extension-inventory-client"
import type {
  ExtensionInventoryControlDecisionResult,
  ExtensionInventoryControlPreview,
} from "@astra/domain/extension-inventory-control"

const routeName = "astra-extensions"

export function AstraExtensionsView(props: {
  api: TuiPluginApi
  mode: AstraSessionAuthority["mode"]
  client: AstraExtensionInventoryClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 78)
  const [preview, setPreview] = createSignal<ExtensionInventoryControlPreview>()
  const [result, setResult] = createSignal<ExtensionInventoryControlDecisionResult>()
  const [status, setStatus] = createSignal<
    "idle" | "preparing" | "awaiting_decision" | "executing" | "reconciliation_required" | "blocked"
  >("idle")
  const [reason, setReason] = createSignal<string>()
  const completed = createMemo(() => {
    const terminal = result()
    return terminal?.status === "completed_observed_not_verified" ? terminal : undefined
  })

  const close = () => {
    if (status() === "executing" || status() === "reconciliation_required") {
      setReason("effect_in_progress_or_unknown")
      return
    }
    props.client.dispose()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  const inspect = async () => {
    if (status() === "preparing" || status() === "executing" || preview()) return
    setStatus("preparing")
    setReason(undefined)
    setResult(undefined)
    try {
      const prepared = await props.client.prepare()
      if (prepared.status === "blocked") {
        setReason(prepared.reason)
        setStatus("blocked")
        return
      }
      setPreview(prepared.preview)
      setStatus("awaiting_decision")
    } catch {
      setReason("control_unavailable")
      setStatus("blocked")
    }
  }

  const decide = async (decision: "approve" | "reject") => {
    const authority = preview()
    if (
      !authority ||
      (status() !== "awaiting_decision" && status() !== "reconciliation_required") ||
      (status() === "reconciliation_required" && decision !== "approve")
    )
      return
    setStatus("executing")
    try {
      const terminal = await props.client.decide(authority.proposalID, decision)
      setResult(terminal)
      setStatus(
        terminal.status === "blocked"
          ? "blocked"
          : terminal.status === "reconciliation_required"
            ? "reconciliation_required"
            : "idle",
      )
      if (terminal.status === "blocked") setReason(terminal.reason)
      if (terminal.status === "reconciliation_required") setReason(terminal.reason)
      if (terminal.status !== "reconciliation_required") setPreview(undefined)
    } catch {
      if (decision === "approve") {
        setReason("effect_in_progress_or_unknown")
        setStatus("reconciliation_required")
        return
      }
      setReason("control_unavailable")
      setStatus("blocked")
      setPreview(undefined)
    }
  }

  onCleanup(() => props.client.dispose())

  useBindings(() => ({
    commands: [
      {
        name: "astra.extensions.close",
        title: "Close Astra Extensions",
        category: "Astra",
        run: close,
      },
      { name: "astra.extensions.inventory", title: "Inspect Extensions", category: "Astra", run: inspect },
      { name: "astra.extensions.approve", title: "Approve Extension Inventory", category: "Astra", run: () => decide("approve") },
      { name: "astra.extensions.deny", title: "Deny Extension Inventory", category: "Astra", run: () => decide("reject") },
    ],
    bindings: [
      { key: "escape", cmd: "astra.extensions.close", desc: "Close Astra Extensions" },
      { key: "i", cmd: "astra.extensions.inventory", desc: "Inspect Extensions" },
      { key: "a", cmd: "astra.extensions.approve", desc: "Approve Extension Inventory" },
      { key: "d", cmd: "astra.extensions.deny", desc: "Deny Extension Inventory" },
    ],
  }))

  return (
    <box
      position="absolute"
      zIndex={2500}
      left={0}
      top={0}
      width={dimensions().width}
      height={dimensions().height}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.api.theme.current.text}>Extensions</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>esc</text>
      </box>
      <text fg={props.api.theme.current.warning}>HOST EXECUTION — NO SANDBOX</text>
      <box height={1} />
      <Row label="MODE" value={props.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="SAFE START" value="ALWAYS ACTIVE" api={props.api} />
      <Row
        label="STATE"
        value={
          status() === "idle"
            ? result()?.status ?? "NOT INSPECTED • NOT VERIFIED"
            : status() === "awaiting_decision"
              ? "AWAITING A/D • NOT VERIFIED"
              : status().toUpperCase()
        }
        api={props.api}
      />
      <Row label="INVENTORY" value="STATIC JSON/JSONC • NO ACTIVATION" api={props.api} />
      <Row
        label="DISCOVERY"
        value={
          compact()
            ? "NO AUTO • discovery, init, activation"
            : "NO AUTOMATIC discovery, initialization, or activation"
        }
        api={props.api}
      />
      <Show when={preview()}>
        {(authority) => (
          <>
            <box height={1} />
            <Row label="HELPER" value="ASTRA NATIVE • PRIVATE VERIFIED SNAPSHOT" api={props.api} />
            <Row label="RESOURCES" value={authority().resourceClasses.join(" • ")} api={props.api} />
            <Row label="ALLOWLIST" value={authority().allowlist.join(" • ")} api={props.api} />
            <text fg={props.api.theme.current.warning}>
              {status() === "reconciliation_required" ? "A check status • close blocked while uncertain" : "A approve • D deny"}
            </text>
          </>
        )}
      </Show>
      <Show when={completed()}>
        {(terminal) => (
          <>
            <box height={1} />
            <text fg={props.api.theme.current.warning}>CANDIDATES • INACTIVE • NOT VERIFIED</text>
            <For each={terminal().candidates}>
              {(candidate) => (
                <Row
                  label={candidate.kind.toUpperCase()}
                  value={`${candidate.displayName} • ${candidate.referenceClass} • INACTIVE • NOT VERIFIED`}
                  api={props.api}
                />
              )}
            </For>
          </>
        )}
      </Show>
      <Show when={reason()}>{(value) => <Row label="BLOCKED" value={value()} api={props.api} />}</Show>
      <box height={1} />
      <text fg={props.api.theme.current.textMuted}>
        I inspect • A approve • D deny • no plugin or MCP is activated.
      </text>
    </box>
  )
}

function Row(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={12} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

export function registerAstraExtensions(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client: AstraExtensionInventoryClient,
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraExtensionsView
          api={api}
          mode={authority.mode}
          client={client}
          returnRoute={parseReturnRoute(input.params?.returnRoute)}
        />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "astra.extensions.open",
        title: "Extensions",
        slashName: "extensions",
        category: "Astra",
        namespace: "palette",
        run() {
          api.route.navigate(routeName, { returnRoute: api.route.current })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

function parseReturnRoute(input: unknown): TuiRouteCurrent | undefined {
  if (!isRecord(input) || typeof input.name !== "string") return undefined
  if (!("params" in input)) return { name: input.name }
  if (!isRecord(input.params)) return undefined
  return { name: input.name, params: input.params }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
