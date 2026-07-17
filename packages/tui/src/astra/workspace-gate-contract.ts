export type AstraWorkspaceMode = "read-only" | "activate-once" | "inspect-git" | "exit"

export type AstraWorkspaceGateView = Readonly<{
  workspace: string
  state: "awaiting-decision" | "working" | "blocked" | "stale"
  preflight: "complete" | "blocked"
  git: "not-required" | "not-inspected" | "inspecting" | "current" | "stale" | "blocked"
  activationAllowed: boolean
  scannedEntries: number
  scannedBytes: number
  surfaces: ReadonlyArray<Readonly<{ kind: string; path: string }>>
  blockers: ReadonlyArray<string>
  detail?: string
}>
