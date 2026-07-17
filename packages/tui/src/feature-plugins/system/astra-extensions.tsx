/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useBindings } from "../../keymap"
import type { AstraExtensionInventoryClient } from "../../astra/extension-inventory-client"
import type { AstraMcpActivationClient } from "../../astra/mcp-activation-client"
import type {
  ExtensionInventoryControlDecisionResult,
  ExtensionInventoryControlPreview,
} from "@astra/domain/extension-inventory-control"
import type {
  McpActivationControlDecisionResult,
  McpActivationControlPreview,
  McpActivationControlProgress,
} from "@astra/domain/mcp-activation-control"

const routeName = "astra-extensions"

export function AstraExtensionsView(props: {
  api: TuiPluginApi
  mode: AstraSessionAuthority["mode"]
  client: AstraExtensionInventoryClient
  mcpClient: AstraMcpActivationClient
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
  const [mcpPreview, setMcpPreview] = createSignal<McpActivationControlPreview>()
  const [mcpProgress, setMcpProgress] = createSignal<McpActivationControlProgress>()
  const [mcpResult, setMcpResult] = createSignal<McpActivationControlDecisionResult>()
  const [mcpStatus, setMcpStatus] = createSignal<"idle" | "preparing" | "awaiting_decision" | "connecting" | "active" | "stopping" | "reconciliation_required">("idle")
  const completed = createMemo(() => {
    const terminal = result()
    return terminal?.status === "completed_observed_not_verified" ? terminal : undefined
  })

  const close = async () => {
    if (mcpStatus() === "active" || mcpStatus() === "connecting" || mcpStatus() === "stopping") {
      const authority = mcpPreview()
      if (authority && (mcpStatus() === "active" || mcpStatus() === "connecting")) {
        setMcpStatus("stopping")
        await props.mcpClient.stop(authority.proposalID).catch(() => undefined)
      }
      setReason("stop_requested_waiting_for_terminal")
      return
    }
    if (status() === "executing" || status() === "reconciliation_required" || mcpStatus() === "reconciliation_required") {
      setReason("effect_in_progress_or_unknown")
      return
    }
    props.client.dispose()
    props.mcpClient.dispose()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  const prepareMcp = async () => {
    const terminal = completed()
    const candidates = terminal?.candidates.filter((entry) => entry.kind === "mcp" && entry.referenceClass === "remote") ?? []
    if (candidates.length === 0 || mcpStatus() !== "idle") {
      setReason(candidates.length > 0 ? "mcp_control_busy" : "no_eligible_remote_mcp")
      return
    }
    setMcpStatus("preparing")
    setReason(undefined)
    let prepared: Awaited<ReturnType<AstraMcpActivationClient["prepare"]>> | null = null
    for (const candidate of candidates) {
      prepared = await props.mcpClient.prepare(candidate.candidateID).catch(() => null)
      if (!prepared || prepared.status === "prepared" || prepared.reason !== "candidate_ineligible") break
    }
    if (!prepared || prepared.status === "blocked") {
      setReason(prepared?.status === "blocked" ? prepared.reason : "control_unavailable")
      setMcpStatus("idle")
      return
    }
    setMcpPreview(prepared.preview)
    setMcpStatus("awaiting_decision")
  }

  const decideMcp = async (decision: "approve" | "reject") => {
    const authority = mcpPreview()
    if (!authority || mcpStatus() !== "awaiting_decision") return
    setMcpStatus(decision === "approve" ? "connecting" : "stopping")
    const terminal = await props.mcpClient.decide(authority.proposalID, decision, (active) => {
      setMcpProgress(active)
      setMcpStatus("active")
    })
    setMcpResult(terminal)
    setMcpProgress(undefined)
    setMcpStatus(terminal.status === "reconciliation_required" ? "reconciliation_required" : "idle")
    if (terminal.status === "blocked" || terminal.status === "reconciliation_required" || terminal.status === "failed_without_effect") setReason(terminal.reason)
    if (terminal.status !== "reconciliation_required") setMcpPreview(undefined)
  }

  const stopMcp = async () => {
    const authority = mcpPreview()
    if (!authority || mcpStatus() !== "active") return
    setMcpStatus("stopping")
    const result = await props.mcpClient.stop(authority.proposalID).catch(() => null)
    if (!result || result.status === "blocked") {
      setReason(result?.status === "blocked" ? result.reason : "control_unavailable")
      setMcpStatus("reconciliation_required")
    }
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

  onCleanup(() => {
    props.client.dispose()
    const authority = mcpPreview()
    if (authority && (mcpStatus() === "active" || mcpStatus() === "connecting" || mcpStatus() === "stopping")) {
      void props.mcpClient.stop(authority.proposalID).catch(() => undefined).finally(() => props.mcpClient.dispose())
      return
    }
    props.mcpClient.dispose()
  })

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
      { name: "astra.extensions.mcp.prepare", title: "Activate MCP", category: "Astra", run: prepareMcp },
      { name: "astra.extensions.mcp.approve", title: "Approve MCP Activation", category: "Astra", run: () => decideMcp("approve") },
      { name: "astra.extensions.mcp.deny", title: "Deny MCP Activation", category: "Astra", run: () => decideMcp("reject") },
      { name: "astra.extensions.mcp.stop", title: "Stop MCP", category: "Astra", run: stopMcp },
    ],
    bindings: [
      { key: "escape", cmd: "astra.extensions.close", desc: "Close Astra Extensions" },
      { key: "i", cmd: "astra.extensions.inventory", desc: "Inspect Extensions" },
      { key: "a", cmd: "astra.extensions.approve", desc: "Approve Extension Inventory" },
      { key: "d", cmd: "astra.extensions.deny", desc: "Deny Extension Inventory" },
      { key: "m", cmd: "astra.extensions.mcp.prepare", desc: "Activate eligible MCP" },
      { key: "shift+a", cmd: "astra.extensions.mcp.approve", desc: "Approve MCP Activation" },
      { key: "shift+d", cmd: "astra.extensions.mcp.deny", desc: "Deny MCP Activation" },
      { key: "s", cmd: "astra.extensions.mcp.stop", desc: "Stop MCP" },
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
      <Show when={mcpPreview()}>
        {(authority) => (
          <>
            <box height={1} />
            <text fg={props.api.theme.current.warning}>MCP ACTIVATION • {mcpStatus().toUpperCase()} • NOT VERIFIED</text>
            <Row label="CANDIDATE" value={`${authority().displayName} • ${authority().candidateID.slice(7, 15)}`} api={props.api} />
            <Row label="SOURCE" value={authority().sourcePath} api={props.api} />
            <Row label="DESTINATION" value={`${authority().destination} • EXACT DESTINATION`} api={props.api} />
            <Row label="NETWORK" value={authority().networkLabel} api={props.api} />
            <Row label="REQUESTS" value={authority().requestBudget.join(" → ")} api={props.api} />
            <Row label="LEASE" value={authority().leaseExpiresAt} api={props.api} />
            <Row label="SHARING" value="NO CREDENTIALS • NO WORKSPACE ROOT • INSTRUCTIONS WITHHELD" api={props.api} />
            <Row label="TOOLS" value="CATALOG ONLY • INVOCATION FORBIDDEN" api={props.api} />
            <Show when={mcpProgress()}>{(active) => <Row label="ACTIVE" value={`${active().catalogCount} tools observed • S stop`} api={props.api} />}</Show>
            <Show when={mcpStatus() === "awaiting_decision"}><text fg={props.api.theme.current.warning}>Shift+A approve • Shift+D deny</text></Show>
          </>
        )}
      </Show>
      <Show when={mcpResult()}>
        {(terminal) => <Row label="MCP RESULT" value={describeMcpResult(terminal())} api={props.api} />}
      </Show>
      <Show when={reason()}>{(value) => <Row label="BLOCKED" value={value()} api={props.api} />}</Show>
      <box height={1} />
      <text fg={props.api.theme.current.textMuted}>
        I inspect • A/D inventory • M activate eligible MCP • Shift+A/D consent • S stop.
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

function describeMcpResult(result: McpActivationControlDecisionResult) {
  return `${result.status.toUpperCase()}${result.status === "completed_observed_not_verified" ? ` • ${result.catalogCount} tools` : ""} • NOT VERIFIED`
}

export function registerAstraExtensions(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client: AstraExtensionInventoryClient,
  mcpClient: AstraMcpActivationClient,
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraExtensionsView
          api={api}
          mode={authority.mode}
          client={client}
          mcpClient={mcpClient}
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
