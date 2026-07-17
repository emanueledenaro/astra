export const operationStates = [
  "proposed",
  "awaiting_approval",
  "authorized",
  "dispatch_pending",
  "dispatched",
  "effect_observed",
  "verifying",
  "reconciliation_required",
  "rolling_back",
  "succeeded",
  "denied",
  "cancelled",
  "failed",
  "rolled_back",
  "inconclusive",
] as const

export type OperationState = (typeof operationStates)[number]

export const activeOperationStates = [
  "proposed",
  "awaiting_approval",
  "authorized",
  "dispatch_pending",
  "dispatched",
  "effect_observed",
  "verifying",
  "reconciliation_required",
  "rolling_back",
] as const satisfies ReadonlyArray<OperationState>

export const terminalOperationStates = [
  "succeeded",
  "denied",
  "cancelled",
  "failed",
  "rolled_back",
  "inconclusive",
] as const satisfies ReadonlyArray<OperationState>

export const operationEvents = [
  "operation.admitted",
  "policy.ask",
  "policy.allow",
  "policy.deny",
  "operation.cancelled",
  "proposal.invalidated",
  "approval.granted",
  "approval.rejected",
  "approval.invalidated",
  "dispatch.requested",
  "authorization.invalidated",
  "executor.accepted",
  "dispatch.proved_unclaimed",
  "dispatch.cancelled_unclaimed",
  "authorization.invalidated_unclaimed",
  "dispatch.claim_unknown",
  "effect.observed",
  "execution.failed_without_effect",
  "cancellation.completed_without_effect",
  "effect.unknown",
  "verification.started",
  "verification.unavailable_or_stale",
  "verification.snapshot_invalidated",
  "recovery.operation_linked",
  "verification.passed",
  "verification.failed",
  "verification.failed_with_recovery_link",
  "verification.unknown",
  "verification.evidence_invalidated",
  "probe.confirmed_effect",
  "probe.proved_no_effect_and_retry_authorized",
  "probe.proved_no_effect",
  "probe.proved_no_effect_after_cancel",
  "ambiguity.closed",
  "recovery.verified",
  "recovery.failed_known_state",
  "recovery.unknown",
  "policy.invalidated",
  "cancellation.requested",
  "authorization.revoked_after_acceptance",
  "execution.timeout_observed",
  "lease.lost",
  "reconciliation.probe_recorded",
  "lease.renewed",
  "reconciliation.owner_note_recorded",
  "reconciliation.deadline_changed",
  "recovery.progress_recorded",
] as const

export type OperationEvent = (typeof operationEvents)[number]

export type OperationTransition = Readonly<{
  from: OperationState | null
  event: OperationEvent
  to: OperationState
}>

export const operationTransitions = [
  { from: null, event: "operation.admitted", to: "proposed" },
  { from: "proposed", event: "policy.ask", to: "awaiting_approval" },
  { from: "proposed", event: "policy.allow", to: "authorized" },
  { from: "proposed", event: "policy.deny", to: "denied" },
  { from: "proposed", event: "operation.cancelled", to: "cancelled" },
  { from: "proposed", event: "proposal.invalidated", to: "cancelled" },
  { from: "awaiting_approval", event: "approval.granted", to: "authorized" },
  { from: "awaiting_approval", event: "approval.rejected", to: "denied" },
  { from: "awaiting_approval", event: "operation.cancelled", to: "cancelled" },
  { from: "awaiting_approval", event: "approval.invalidated", to: "cancelled" },
  { from: "authorized", event: "dispatch.requested", to: "dispatch_pending" },
  { from: "authorized", event: "operation.cancelled", to: "cancelled" },
  { from: "authorized", event: "authorization.invalidated", to: "cancelled" },
  { from: "dispatch_pending", event: "executor.accepted", to: "dispatched" },
  { from: "dispatch_pending", event: "dispatch.proved_unclaimed", to: "authorized" },
  { from: "dispatch_pending", event: "dispatch.cancelled_unclaimed", to: "cancelled" },
  { from: "dispatch_pending", event: "authorization.invalidated_unclaimed", to: "cancelled" },
  { from: "dispatch_pending", event: "dispatch.claim_unknown", to: "reconciliation_required" },
  { from: "dispatched", event: "effect.observed", to: "effect_observed" },
  { from: "dispatched", event: "execution.failed_without_effect", to: "failed" },
  { from: "dispatched", event: "cancellation.completed_without_effect", to: "cancelled" },
  { from: "dispatched", event: "effect.unknown", to: "reconciliation_required" },
  { from: "effect_observed", event: "verification.started", to: "verifying" },
  { from: "effect_observed", event: "verification.unavailable_or_stale", to: "reconciliation_required" },
  { from: "effect_observed", event: "verification.snapshot_invalidated", to: "reconciliation_required" },
  { from: "effect_observed", event: "recovery.operation_linked", to: "rolling_back" },
  { from: "verifying", event: "verification.passed", to: "succeeded" },
  { from: "verifying", event: "verification.failed", to: "failed" },
  { from: "verifying", event: "verification.failed_with_recovery_link", to: "rolling_back" },
  { from: "verifying", event: "verification.unknown", to: "reconciliation_required" },
  { from: "verifying", event: "verification.evidence_invalidated", to: "reconciliation_required" },
  { from: "reconciliation_required", event: "probe.confirmed_effect", to: "effect_observed" },
  {
    from: "reconciliation_required",
    event: "probe.proved_no_effect_and_retry_authorized",
    to: "authorized",
  },
  { from: "reconciliation_required", event: "probe.proved_no_effect", to: "failed" },
  { from: "reconciliation_required", event: "probe.proved_no_effect_after_cancel", to: "cancelled" },
  { from: "reconciliation_required", event: "recovery.operation_linked", to: "rolling_back" },
  { from: "reconciliation_required", event: "ambiguity.closed", to: "inconclusive" },
  { from: "rolling_back", event: "recovery.verified", to: "rolled_back" },
  { from: "rolling_back", event: "recovery.failed_known_state", to: "failed" },
  { from: "rolling_back", event: "recovery.unknown", to: "reconciliation_required" },
  { from: "proposed", event: "policy.invalidated", to: "proposed" },
  { from: "dispatched", event: "cancellation.requested", to: "dispatched" },
  { from: "dispatched", event: "authorization.revoked_after_acceptance", to: "dispatched" },
  { from: "dispatched", event: "execution.timeout_observed", to: "dispatched" },
  { from: "dispatched", event: "lease.lost", to: "dispatched" },
  {
    from: "reconciliation_required",
    event: "reconciliation.probe_recorded",
    to: "reconciliation_required",
  },
  { from: "reconciliation_required", event: "lease.renewed", to: "reconciliation_required" },
  {
    from: "reconciliation_required",
    event: "reconciliation.owner_note_recorded",
    to: "reconciliation_required",
  },
  {
    from: "reconciliation_required",
    event: "reconciliation.deadline_changed",
    to: "reconciliation_required",
  },
  { from: "rolling_back", event: "recovery.progress_recorded", to: "rolling_back" },
] as const satisfies ReadonlyArray<OperationTransition>

export type AcceptedOperationTransition = Readonly<{
  accepted: true
  from: OperationState | null
  event: OperationEvent
  state: OperationState
}>

export type RejectedOperationTransition = Readonly<{
  accepted: false
  code: "illegal_transition" | "terminal_state"
  state: OperationState | null
  event: OperationEvent
}>

export type OperationTransitionResult = AcceptedOperationTransition | RejectedOperationTransition

export type OperationSemanticKey =
  | "PLANNING"
  | "AWAITING_APPROVAL"
  | "READY"
  | "DISPATCHING"
  | "RUNNING"
  | "EFFECT_OBSERVED"
  | "VERIFYING"
  | "RECONCILIATION_REQUIRED"
  | "RECOVERING"
  | "VERIFIED"
  | "DENIED"
  | "CANCELLED"
  | "FAILED"
  | "ROLLED_BACK"
  | "INCONCLUSIVE"

const terminalStateSet = new Set<OperationState>(terminalOperationStates)
const activeStateSet = new Set<OperationState>(activeOperationStates)
const transitionIndex: ReadonlyMap<string, OperationState> = new Map(
  operationTransitions.map((transition) => [`${transition.from}\0${transition.event}`, transition.to] as const),
)
const semanticKeys = {
  proposed: "PLANNING",
  awaiting_approval: "AWAITING_APPROVAL",
  authorized: "READY",
  dispatch_pending: "DISPATCHING",
  dispatched: "RUNNING",
  effect_observed: "EFFECT_OBSERVED",
  verifying: "VERIFYING",
  reconciliation_required: "RECONCILIATION_REQUIRED",
  rolling_back: "RECOVERING",
  succeeded: "VERIFIED",
  denied: "DENIED",
  cancelled: "CANCELLED",
  failed: "FAILED",
  rolled_back: "ROLLED_BACK",
  inconclusive: "INCONCLUSIVE",
} as const satisfies Readonly<Record<OperationState, OperationSemanticKey>>

/**
 * Projects one already-accepted domain event onto an Operation state.
 *
 * This function proves structural legality only. The package that owns an
 * event must validate its required evidence before calling this projector.
 */
export function projectOperationEvent(state: OperationState | null, event: OperationEvent): OperationTransitionResult {
  if (state !== null && terminalStateSet.has(state)) {
    return { accepted: false, code: "terminal_state", state, event }
  }

  const nextState = transitionIndex.get(`${state}\0${event}`)
  if (!nextState) {
    return { accepted: false, code: "illegal_transition", state, event }
  }

  return { accepted: true, from: state, event, state: nextState }
}

export function isActiveOperationState(state: OperationState): boolean {
  return activeStateSet.has(state)
}

export function isTerminalOperationState(state: OperationState): boolean {
  return terminalStateSet.has(state)
}

export function operationSemanticKey(state: OperationState): OperationSemanticKey {
  return semanticKeys[state]
}
