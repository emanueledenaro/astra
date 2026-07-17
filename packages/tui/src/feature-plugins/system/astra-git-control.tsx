/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"

const routeName = "astra-git-control"

export type AstraGitControlPlaneState = Readonly<{
  workspace: string
  mode: "read-only" | "activate-once"
}>

export function AstraGitControlPlaneView(props: {
  api: TuiPluginApi
  state: AstraGitControlPlaneState
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 72)
  const workspaceWidth = createMemo(() => Math.max(16, dimensions().width - 14))

  const close = () => {
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  useBindings(() => ({
    commands: [
      {
        name: "astra.git.close",
        title: "Close Git Control Plane",
        category: "Astra",
        run: close,
      },
    ],
    bindings: [{ key: "escape", cmd: "astra.git.close", desc: "Close Git Control Plane" }],
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
        <text fg={props.api.theme.current.text}>Git Control Plane</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>esc</text>
      </box>
      <text fg={props.api.theme.current.warning}>HOST EXECUTION — NO SANDBOX</text>
      <box height={1} />
      <Row label="WORKSPACE" value={Locale.truncateLeft(props.state.workspace, workspaceWidth())} api={props.api} />
      <Row label="MODE" value={props.state.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row label="STATE" value="NOT INSPECTED • NOT VERIFIED" api={props.api} />
      <Row label="INSPECT" value="required before Git data is available" api={props.api} />
      <Show when={compact()}>
        <Row label="MUTATIONS" value="unavailable" api={props.api} />
        <Row label="" value="Operation Kernel adapter required" api={props.api} />
        <Row label="PUSH" value="UNAVAILABLE" api={props.api} />
        <Row label="" value="separate authorization required" api={props.api} />
      </Show>
      <Show when={!compact()}>
        <Row label="MUTATIONS" value="unavailable until the Operation Kernel adapter exists" api={props.api} />
        <Row label="PUSH" value="UNAVAILABLE — separate authorization required" api={props.api} />
      </Show>
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

export function registerAstraGitControlPlane(api: TuiPluginApi, authority: AstraSessionAuthority) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraGitControlPlaneView
          api={api}
          state={{ workspace: authority.workspace.root, mode: authority.mode }}
          returnRoute={parseReturnRoute(input.params?.returnRoute)}
        />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "astra.git.open",
        title: "Git Control Plane",
        slashName: "git",
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
