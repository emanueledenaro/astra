import { describe, expect, test } from "bun:test"
import { parseGitControlInspectionSummary } from "../src/git-control-inspection"

describe("Git Control Plane inspection summary", () => {
  test("accepts a bounded read-only summary without workspace-controlled content", () => {
    expect(parseGitControlInspectionSummary(completeSummary)).toEqual({ ok: true, value: completeSummary })
  })

  test("accepts a fail-closed terminal summary", () => {
    const summary = {
      schemaVersion: 1,
      status: "blocked",
      mode: "bounded_read_only",
      verification: "not_verified",
      baseline: "not_captured",
      activationAllowed: false,
      submodules: "not_inspected",
      reason: "observation_changed",
    } as const

    expect(parseGitControlInspectionSummary(summary)).toEqual({ ok: true, value: summary })
  })

  test("rejects raw workspace data and stronger assurance", () => {
    expect(parseGitControlInspectionSummary({ ...completeSummary, files: ["\u001b]2;owned\u0007"] })).toEqual({
      ok: false,
      reason: "invalid_summary_shape",
    })
    expect(parseGitControlInspectionSummary({ ...completeSummary, workspaceRoot: "/tmp/other" })).toEqual({
      ok: false,
      reason: "invalid_summary_shape",
    })
    expect(parseGitControlInspectionSummary({ ...completeSummary, verification: "verified" })).toEqual({
      ok: false,
      reason: "invalid_summary_assurance",
    })
  })

  test("rejects malformed digests and inconsistent bounded counts", () => {
    expect(parseGitControlInspectionSummary({ ...completeSummary, reportDigest: "sha256:not-a-digest" })).toEqual({
      ok: false,
      reason: "invalid_summary_digest",
    })
    expect(
      parseGitControlInspectionSummary({
        ...completeSummary,
        counts: { ...completeSummary.counts, total: 0, staged: 1 },
      }),
    ).toEqual({ ok: false, reason: "invalid_summary_counts" })
    expect(
      parseGitControlInspectionSummary({
        ...completeSummary,
        counts: { ...completeSummary.counts, total: 10_001 },
      }),
    ).toEqual({ ok: false, reason: "invalid_summary_counts" })
  })
})

const completeSummary = {
  schemaVersion: 1,
  status: "complete",
  mode: "bounded_read_only",
  verification: "not_verified",
  baseline: "not_captured",
  activationAllowed: false,
  submodules: "not_inspected",
  counts: { total: 4, staged: 1, unstaged: 2, untracked: 1, conflicts: 0 },
  observationDigest: `sha256:${"a".repeat(64)}`,
  reportDigest: `sha256:${"b".repeat(64)}`,
} as const
