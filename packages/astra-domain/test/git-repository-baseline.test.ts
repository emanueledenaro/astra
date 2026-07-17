import { describe, expect, test } from "bun:test"
import {
  computeGitRepositoryBaselineSnapshotDigest,
  parseGitRepositoryBaselineCaptureResult,
  parseGitRepositoryBaselineLimits,
  parseGitRepositoryBaselineRevalidationResult,
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshotAuthority,
} from "../src/git-repository-baseline"

const digest = `sha256:${"a".repeat(64)}` as const

const limits = {
  timeoutMs: 2_000,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 16_384,
  maxEntries: 25_000,
  maxBoundaryEntries: 250_000,
  maxBoundaryDurationMs: 5_000,
  maxGitBinaryBytes: 67_108_864,
  maxContentEntries: 25_000,
  maxFileBytes: 33_554_432,
  maxTotalBytes: 268_435_456,
  maxDurationMs: 30_000,
} as const

const snapshotAuthority = {
  schemaVersion: 1,
  mode: "bounded_read_only",
  durability: "ephemeral",
  verification: "not_verified",
  contentPolicy: {
    tracked: "raw_content_type_and_executable",
    untracked: "raw_content_type_and_executable",
    symlinks: "raw_link_text_no_follow",
    ignored: "excluded",
    specialFiles: "blocked",
  },
  root: { canonicalPath: "/workspace", device: "1", inode: "2" },
  gitDirectory: { canonicalPath: "/workspace/.git", device: "1", inode: "3" },
  commonDirectory: { canonicalPath: "/workspace/.git", device: "1", inode: "3" },
  head: { kind: "symbolic", symbolicRef: "refs/heads/main", oid: "1".repeat(40) },
  refs: { digest, count: 1 },
  index: {
    digest,
    metadataDigest: digest,
    entryCount: 1,
  },
  worktree: {
    digest,
    ignored: "excluded",
    trackedPaths: 1,
    untrackedPaths: 0,
    contentEntries: 1,
    totalBytes: 8,
  },
  metadata: {
    digest,
    fileCount: 1,
    totalBytes: 21,
    externalConfig: "unsupported",
  },
  observer: {
    adapter: "astra.git-baseline.v1",
    adapterDigest: digest,
    gitBinaryDigest: digest,
    observationDigest: digest,
  },
  limits,
} as const satisfies GitRepositoryBaselineSnapshotAuthority

const snapshot = {
  ...snapshotAuthority,
  snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(snapshotAuthority),
} as const satisfies GitRepositoryBaselineSnapshot

describe("Git repository baseline contracts", () => {
  test("strictly parses complete limits and rejects unknown or relaxed values", () => {
    expect(parseGitRepositoryBaselineLimits(limits)).toEqual({ ok: true, value: limits })
    expect(parseGitRepositoryBaselineLimits({ ...limits, maxFileBytes: 0 })).toEqual({
      ok: false,
      reason: "invalid_limits",
    })
    expect(parseGitRepositoryBaselineLimits({ ...limits, extra: 1 })).toEqual({
      ok: false,
      reason: "invalid_limits",
    })
  })

  test("strictly parses a complete snapshot and rejects partial or forged shapes", () => {
    const parsed = parseGitRepositoryBaselineSnapshot(snapshot)
    expect(parsed).toEqual({ ok: true, value: snapshot })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.value).not.toBe(snapshot)
    expect(parsed.value.worktree).not.toBe(snapshot.worktree)
    expect(parseGitRepositoryBaselineSnapshot({ ...snapshot, verification: "verified" })).toEqual({
      ok: false,
      reason: "invalid_snapshot",
    })
    expect(parseGitRepositoryBaselineSnapshot({ ...snapshot, snapshotDigest: "sha256:short" })).toEqual({
      ok: false,
      reason: "invalid_snapshot",
    })
    expect(parseGitRepositoryBaselineSnapshot({ ...snapshot, partial: true })).toEqual({
      ok: false,
      reason: "invalid_snapshot",
    })
    expect(
      parseGitRepositoryBaselineSnapshot({
        ...snapshot,
        worktree: { ...snapshot.worktree, totalBytes: snapshot.worktree.totalBytes + 1 },
      }),
    ).toEqual({ ok: false, reason: "invalid_snapshot" })
  })

  test("parses capture and revalidation outcomes without a verified state", () => {
    expect(parseGitRepositoryBaselineCaptureResult({ status: "complete", snapshot })).toEqual({
      ok: true,
      value: { status: "complete", snapshot },
    })
    expect(
      parseGitRepositoryBaselineRevalidationResult({
        status: "stale",
        expectedSnapshotDigest: digest,
        currentSnapshotDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toMatchObject({ ok: true, value: { status: "stale" } })
    expect(parseGitRepositoryBaselineRevalidationResult({ status: "verified", snapshot })).toEqual({
      ok: false,
      reason: "invalid_result",
    })
    expect(
      parseGitRepositoryBaselineRevalidationResult({
        status: "current",
        expectedSnapshotDigest: digest,
        currentSnapshotDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toEqual({ ok: false, reason: "invalid_result" })
    expect(
      parseGitRepositoryBaselineRevalidationResult({
        status: "stale",
        expectedSnapshotDigest: digest,
        currentSnapshotDigest: digest,
      }),
    ).toEqual({ ok: false, reason: "invalid_result" })
  })
})
