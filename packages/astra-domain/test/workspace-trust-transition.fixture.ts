import type { WorkspaceTrustEvent, WorkspaceTrustState, WorkspaceTrustTransition } from "../src/workspace-trust"

export const expectedWorkspaceTrustStates = [
  "UNTRUSTED",
  "PREFLIGHT_BLOCKED",
  "AWAITING_DECISION",
  "TRUSTED_ONCE",
  "STALE",
] as const satisfies ReadonlyArray<WorkspaceTrustState>

export const expectedWorkspaceTrustEvents = [
  "workspace.opened",
  "preflight.completed",
  "preflight.blocked",
  "decision.read_only",
  "decision.exit",
  "decision.activate_once",
  "process.ended",
  "snapshot.drifted",
] as const satisfies ReadonlyArray<WorkspaceTrustEvent>

// This fixture intentionally restates the ASTRA-0049 topology independently.
export const expectedWorkspaceTrustTransitions = [
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
