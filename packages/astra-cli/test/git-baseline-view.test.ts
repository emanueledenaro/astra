import { describe, expect, test } from "bun:test"
import { renderGitBaselineView, type GitBaselineViewState } from "../src/git-baseline-view"

const firstDigest = `sha256:${"1".repeat(64)}`
const secondDigest = `sha256:${"2".repeat(64)}`

describe("Git baseline view", () => {
  test.each<GitBaselineViewState>([
    { status: "not-captured" },
    { status: "capturing" },
    { status: "current", expectedSnapshotDigest: firstDigest, currentSnapshotDigest: firstDigest },
    { status: "stale", expectedSnapshotDigest: firstDigest, currentSnapshotDigest: secondDigest },
    { status: "blocked", reason: "bounded capture unavailable" },
  ])("always discloses NOT VERIFIED for $status", (state) => {
    const output = renderGitBaselineView(state).join("\n")

    expect(output).toContain("NOT VERIFIED")
    expect(output).not.toMatch(/\bVERIFIED\b(?!\s*$)/)
    expect(output).not.toContain("TRUSTED")
    expect(output).not.toContain("ACTIVATED")
  })

  test("renders current and stale as digest observations only", () => {
    expect(
      renderGitBaselineView({
        status: "current",
        expectedSnapshotDigest: firstDigest,
        currentSnapshotDigest: firstDigest,
      }),
    ).toEqual([`GIT BASELINE  CURRENT • expected ${firstDigest} • observed ${firstDigest} • NOT VERIFIED`])
    expect(
      renderGitBaselineView({
        status: "stale",
        expectedSnapshotDigest: firstDigest,
        currentSnapshotDigest: secondDigest,
      }),
    ).toEqual([`GIT BASELINE  STALE • expected ${firstDigest} • observed ${secondDigest} • NOT VERIFIED`])
  })

  test("fails closed for inconsistent result tuples", () => {
    expect(
      renderGitBaselineView({
        status: "current",
        expectedSnapshotDigest: firstDigest,
        currentSnapshotDigest: secondDigest,
      }),
    ).toEqual(["GIT BASELINE  BLOCKED • inconsistent current digests • NOT VERIFIED"])
    expect(
      renderGitBaselineView({
        status: "stale",
        expectedSnapshotDigest: firstDigest,
        currentSnapshotDigest: firstDigest,
      }),
    ).toEqual(["GIT BASELINE  BLOCKED • inconsistent stale digests • NOT VERIFIED"])
  })

  test("sanitizes blocked reasons before terminal output", () => {
    const output = renderGitBaselineView({ status: "blocked", reason: "bad\u001b[31m\nreason" }).join("\n")

    expect(output).not.toContain("\u001b")
    expect(output).not.toContain("\nreason")
    expect(output).toContain("NOT VERIFIED")
  })
})
