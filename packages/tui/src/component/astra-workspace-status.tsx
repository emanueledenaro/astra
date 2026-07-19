/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import { inspectAstraSessionAuthority } from "../astra/session-authority"

export type AstraWorkspaceMode = "read-only" | "activate-once"

export const ASTRA_GOVERNED_ACTION_HINT = "Inherited prompt disabled • ctrl+p opens governed actions"

export type AstraWorkspaceStatusView = Readonly<{
  mode: AstraWorkspaceMode
  label: string
  color: string
  boundaryLabel?: "HOST EXECUTION — NO SANDBOX"
}>

export function getAstraWorkspaceStatus(
  authority: AstraSessionAuthority | undefined,
): AstraWorkspaceStatusView | undefined {
  if (authority?.mode === "read-only") {
    return { mode: "read-only", label: "ASTRA  •  READ ONLY  •  EFFECTS DENIED", color: "#55e6c1" }
  }
  if (authority?.mode === "activate-once") {
    return {
      mode: "activate-once",
      label: "ASTRA  •  ACTIVE ONCE  •  GOVERNED EFFECTS ONLY",
      color: "#f0bd6a",
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    }
  }
  return undefined
}

export function AstraWorkspaceStatus(props: { authority?: AstraSessionAuthority }) {
  const inspected = props.authority
    ? { status: "valid" as const, authority: props.authority }
    : inspectAstraSessionAuthority()
  const status = getAstraWorkspaceStatus(inspected.status === "valid" ? inspected.authority : undefined)
  if (!status) return null

  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="column">
      <text fg={status.color}>{status.label}</text>
      {status.boundaryLabel ? <text fg="#ff6b6b">{status.boundaryLabel}</text> : null}
    </box>
  )
}
