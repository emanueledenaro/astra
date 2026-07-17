import { sanitizeTerminalText } from "./terminal"

export type GitBaselineViewState =
  | Readonly<{ status: "not-captured" }>
  | Readonly<{ status: "capturing" }>
  | Readonly<{
      status: "current"
      expectedSnapshotDigest: string
      currentSnapshotDigest: string
    }>
  | Readonly<{
      status: "stale"
      expectedSnapshotDigest: string
      currentSnapshotDigest: string
    }>
  | Readonly<{ status: "blocked"; reason: string }>

/** Renders Git baseline observation state without implying trust or verification. */
export function renderGitBaselineView(state: GitBaselineViewState): ReadonlyArray<string> {
  if (state.status === "not-captured") return ["GIT BASELINE  NOT CAPTURED • NOT VERIFIED"]
  if (state.status === "capturing") return ["GIT BASELINE  CAPTURING • BOUNDED READ ONLY • NOT VERIFIED"]
  if (state.status === "blocked") {
    return [`GIT BASELINE  BLOCKED • ${sanitizeTerminalText(state.reason)} • NOT VERIFIED`]
  }
  if (state.status === "current" && state.expectedSnapshotDigest !== state.currentSnapshotDigest) {
    return ["GIT BASELINE  BLOCKED • inconsistent current digests • NOT VERIFIED"]
  }
  if (state.status === "stale" && state.expectedSnapshotDigest === state.currentSnapshotDigest) {
    return ["GIT BASELINE  BLOCKED • inconsistent stale digests • NOT VERIFIED"]
  }
  return [
    `GIT BASELINE  ${state.status.toUpperCase()} • expected ${sanitizeTerminalText(state.expectedSnapshotDigest)} • observed ${sanitizeTerminalText(state.currentSnapshotDigest)} • NOT VERIFIED`,
  ]
}
