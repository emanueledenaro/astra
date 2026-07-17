export const workspaceTrustStates = [
  "UNTRUSTED",
  "PREFLIGHT_BLOCKED",
  "AWAITING_DECISION",
  "TRUSTED_ONCE",
  "STALE",
] as const

export type WorkspaceTrustState = (typeof workspaceTrustStates)[number]

export const workspaceTrustEvents = [
  "workspace.opened",
  "preflight.completed",
  "preflight.blocked",
  "decision.read_only",
  "decision.exit",
  "decision.activate_once",
  "process.ended",
  "snapshot.drifted",
] as const

export type WorkspaceTrustEvent = (typeof workspaceTrustEvents)[number]

export type WorkspaceTrustTransition = Readonly<{
  from: WorkspaceTrustState | null
  event: WorkspaceTrustEvent
  to: WorkspaceTrustState
}>

export const workspaceTrustTransitions = [
  { from: null, event: "workspace.opened", to: "UNTRUSTED" },
  { from: "UNTRUSTED", event: "preflight.completed", to: "AWAITING_DECISION" },
  { from: "UNTRUSTED", event: "preflight.blocked", to: "PREFLIGHT_BLOCKED" },
  { from: "PREFLIGHT_BLOCKED", event: "preflight.completed", to: "AWAITING_DECISION" },
  { from: "PREFLIGHT_BLOCKED", event: "decision.read_only", to: "UNTRUSTED" },
  { from: "PREFLIGHT_BLOCKED", event: "decision.exit", to: "UNTRUSTED" },
  { from: "AWAITING_DECISION", event: "decision.read_only", to: "UNTRUSTED" },
  { from: "AWAITING_DECISION", event: "decision.exit", to: "UNTRUSTED" },
  { from: "AWAITING_DECISION", event: "decision.activate_once", to: "TRUSTED_ONCE" },
  { from: "AWAITING_DECISION", event: "snapshot.drifted", to: "STALE" },
  { from: "TRUSTED_ONCE", event: "process.ended", to: "UNTRUSTED" },
  { from: "TRUSTED_ONCE", event: "snapshot.drifted", to: "STALE" },
  { from: "STALE", event: "preflight.completed", to: "AWAITING_DECISION" },
  { from: "STALE", event: "preflight.blocked", to: "PREFLIGHT_BLOCKED" },
] as const satisfies ReadonlyArray<WorkspaceTrustTransition>

export type AcceptedWorkspaceTrustTransition = Readonly<{
  accepted: true
  from: WorkspaceTrustState | null
  event: WorkspaceTrustEvent
  state: WorkspaceTrustState
}>

export type RejectedWorkspaceTrustTransition = Readonly<{
  accepted: false
  code: "illegal_transition"
  state: WorkspaceTrustState | null
  event: WorkspaceTrustEvent
}>

export type WorkspaceTrustTransitionResult = AcceptedWorkspaceTrustTransition | RejectedWorkspaceTrustTransition

export type WorkspaceIdentity = Readonly<{
  device: string
  inode: string
}>

export type WorkspaceRiskSurface = Readonly<{
  kind: string
  path: string
  entryKind: "directory" | "file" | "symlink" | "other"
}>

export type WorkspacePreflightLimits = Readonly<{
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDurationMs: number
}>

export type WorkspaceTrustReport = Readonly<{
  root: string
  identity: WorkspaceIdentity | null
  securityDigest: string | null
  completeness: "complete" | "incomplete"
  state: "awaiting_decision" | "preflight_blocked"
  surfaces: ReadonlyArray<WorkspaceRiskSurface>
  blockers: ReadonlyArray<string>
  scannedEntries: number
  scannedBytes: number
  limits: WorkspacePreflightLimits
}>

const transitionIndex: ReadonlyMap<string, WorkspaceTrustState> = new Map(
  workspaceTrustTransitions.map((transition) => [`${transition.from}\0${transition.event}`, transition.to] as const),
)

/**
 * Projects one already-validated workspace trust event onto the open context.
 *
 * This function proves structural legality only. Before emitting
 * `decision.activate_once`, the runtime must revalidate the bounded static
 * workspace identity and security digest represented by the preflight report.
 */
export function projectWorkspaceTrustEvent(
  state: WorkspaceTrustState | null,
  event: WorkspaceTrustEvent,
): WorkspaceTrustTransitionResult {
  const nextState = transitionIndex.get(`${state}\0${event}`)
  if (!nextState) {
    return { accepted: false, code: "illegal_transition", state, event }
  }

  return { accepted: true, from: state, event, state: nextState }
}
