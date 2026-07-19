import { parseExactRecord } from "./operation-contract-validation"

const maximumObservedEntries = 10_000
const digestPattern = /^sha256:[0-9a-f]{64}$/

export const gitControlInspectionBlockReasons = [
  "unsupported_platform",
  "workspace_unavailable",
  "repository_unsupported",
  "git_unavailable",
  "inspection_limit_reached",
  "inspection_timed_out",
  "observation_changed",
  "inspection_failed",
  "control_busy",
  "control_limit_reached",
  "request_replayed",
] as const

export type GitControlInspectionBlockReason = (typeof gitControlInspectionBlockReasons)[number]

export type GitControlInspectionCounts = Readonly<{
  total: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
}>

type GitControlInspectionCommon = Readonly<{
  schemaVersion: 1
  mode: "bounded_read_only"
  verification: "not_verified"
  baseline: "not_captured"
  activationAllowed: false
  submodules: "not_inspected"
}>

export type GitControlInspectionCompleteSummary = GitControlInspectionCommon &
  Readonly<{
    status: "complete"
    counts: GitControlInspectionCounts
    observationDigest: `sha256:${string}`
    reportDigest: `sha256:${string}`
  }>

export type GitControlInspectionBlockedSummary = GitControlInspectionCommon &
  Readonly<{
    status: "blocked"
    reason: GitControlInspectionBlockReason
  }>

export type GitControlInspectionSummary = GitControlInspectionCompleteSummary | GitControlInspectionBlockedSummary

export type GitControlInspectionSummaryParseResult =
  | Readonly<{ ok: true; value: GitControlInspectionSummary }>
  | Readonly<{
      ok: false
      reason:
        | "invalid_summary_shape"
        | "invalid_summary_assurance"
        | "invalid_summary_counts"
        | "invalid_summary_digest"
        | "invalid_summary_reason"
    }>

/** Accepts only the bounded summary rendered by the Astra Git Control Plane. */
export function parseGitControlInspectionSummary(input: unknown): GitControlInspectionSummaryParseResult {
  const broad = parseExactRecord(input, [
    "schemaVersion",
    "status",
    "mode",
    "verification",
    "baseline",
    "activationAllowed",
    "submodules",
    "counts",
    "observationDigest",
    "reportDigest",
    "reason",
  ])
  if (!broad.ok) return rejected("invalid_summary_shape")
  const fields =
    broad.value.status === "complete"
      ? [
          "schemaVersion",
          "status",
          "mode",
          "verification",
          "baseline",
          "activationAllowed",
          "submodules",
          "counts",
          "observationDigest",
          "reportDigest",
        ]
      : ["schemaVersion", "status", "mode", "verification", "baseline", "activationAllowed", "submodules", "reason"]
  const record = exactRecord(input, fields)
  if (!record) return rejected("invalid_summary_shape")
  if (
    record.schemaVersion !== 1 ||
    record.mode !== "bounded_read_only" ||
    record.verification !== "not_verified" ||
    record.baseline !== "not_captured" ||
    record.activationAllowed !== false ||
    record.submodules !== "not_inspected"
  ) {
    return rejected("invalid_summary_assurance")
  }

  if (record.status === "complete") return parseCompleteSummary(record)
  if (record.status === "blocked") return parseBlockedSummary(record)
  return rejected("invalid_summary_shape")
}

function parseCompleteSummary(input: Readonly<Record<string, unknown>>): GitControlInspectionSummaryParseResult {
  const counts = exactRecord(input.counts, ["total", "staged", "unstaged", "untracked", "conflicts"])
  if (!counts) return rejected("invalid_summary_counts")
  const total = counts.total
  const staged = counts.staged
  const unstaged = counts.unstaged
  const untracked = counts.untracked
  const conflicts = counts.conflicts
  if (
    !isBoundedCount(total) ||
    !isBoundedCount(staged) ||
    !isBoundedCount(unstaged) ||
    !isBoundedCount(untracked) ||
    !isBoundedCount(conflicts) ||
    total < Math.max(staged, unstaged, untracked, conflicts)
  ) {
    return rejected("invalid_summary_counts")
  }
  if (!isDigest(input.observationDigest) || !isDigest(input.reportDigest)) {
    return rejected("invalid_summary_digest")
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      status: "complete",
      mode: "bounded_read_only",
      verification: "not_verified",
      baseline: "not_captured",
      activationAllowed: false,
      submodules: "not_inspected",
      counts: {
        total,
        staged,
        unstaged,
        untracked,
        conflicts,
      },
      observationDigest: input.observationDigest,
      reportDigest: input.reportDigest,
    },
  }
}

function parseBlockedSummary(input: Readonly<Record<string, unknown>>): GitControlInspectionSummaryParseResult {
  const reason = gitControlInspectionBlockReasons.find((candidate) => candidate === input.reason)
  if (!reason) return rejected("invalid_summary_reason")
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      status: "blocked",
      mode: "bounded_read_only",
      verification: "not_verified",
      baseline: "not_captured",
      activationAllowed: false,
      submodules: "not_inspected",
      reason,
    },
  }
}

function exactRecord(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  if (!parsed.ok || fields.some((field) => !Object.hasOwn(parsed.value, field))) return null
  return parsed.value
}

function isBoundedCount(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= maximumObservedEntries
}

function isDigest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}

function rejected(reason: Exclude<GitControlInspectionSummaryParseResult, { ok: true }>["reason"]) {
  return { ok: false as const, reason }
}
