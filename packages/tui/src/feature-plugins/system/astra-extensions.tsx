/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { useBindings } from "../../keymap"

const routeName = "astra-extensions"

export function AstraExtensionsView(props: {
  api: TuiPluginApi
  mode: AstraSessionAuthority["mode"]
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 78)

  const close = () => {
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  useBindings(() => ({
    commands: [
      {
        name: "astra.extensions.close",
        title: "Close Astra Extensions",
        category: "Astra",
        run: close,
      },
    ],
    bindings: [{ key: "escape", cmd: "astra.extensions.close", desc: "Close Astra Extensions" }],
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
      <Row label="STATE" value="NOT INSPECTED • NOT VERIFIED" api={props.api} />
      <Row label="INVENTORY" value="STATIC POLICY ONLY" api={props.api} />
      <Row
        label="DISCOVERY"
        value={compact() ? "NONE • no init, scan, or execution" : "NONE — no initialization, scanning, or execution"}
        api={props.api}
      />
      <box height={1} />
      <Row label="SKILLS" value="PLANNED • ACTIVATE ONCE" api={props.api} />
      <Show when={!compact()}>
        <Row label="" value="exact manifest preview and explicit approval required" api={props.api} />
      </Show>
      <Row
        label="REMOTE MCP"
        value={
          compact() ? "BLOCKED • Operation Kernel required" : "BLOCKED — every call must pass the Operation Kernel"
        }
        api={props.api}
      />
      <Row
        label="LOCAL MCP"
        value={compact() ? "BLOCKED • isolation pending" : "BLOCKED — isolation deferred to hardening"}
        api={props.api}
      />
      <Row
        label="PLUGINS"
        value={compact() ? "BLOCKED • isolation pending" : "BLOCKED — external plugins require isolation and hardening"}
        api={props.api}
      />
      <box height={1} />
      <text fg={props.api.theme.current.textMuted}>
        This surface makes no filesystem, process, network, or client request.
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

export function registerAstraExtensions(api: TuiPluginApi, authority: AstraSessionAuthority) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraExtensionsView
          api={api}
          mode={authority.mode}
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
