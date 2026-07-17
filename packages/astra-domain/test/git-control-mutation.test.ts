import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  computeGitUnstageAllProposalDigest,
  gitUnstageAllBoundaryLabel,
  gitUnstageAllLimitations,
  parseGitUnstageAllObservation,
  parseGitUnstageAllDecision,
  parseGitUnstageAllPreview,
  type GitUnstageAllPreviewAuthority,
} from "../src/git-control-mutation"

describe("Git Control Plane mutation contract", () => {
  test("accepts exact repository-index and private-scratch write sets", () => {
    expect(parseGitUnstageAllPreview(preview)).toEqual({ ok: true, value: preview })
    const detachedAuthority = {
      ...authority,
      baseline: { ...authority.baseline, head: { kind: "detached" as const, oid: "b".repeat(40) } },
    }
    const detached = {
      ...detachedAuthority,
      proposalDigest: computeGitUnstageAllProposalDigest(detachedAuthority),
    }
    expect(parseGitUnstageAllPreview(detached)).toEqual({ ok: true, value: detached })
  })

  test("rejects stronger assurance, expanded writes, tampering, and extra fields", () => {
    expect(parseGitUnstageAllPreview({ ...preview, verification: "verified" })).toEqual({
      ok: false,
      reason: "invalid_preview_value",
    })
    const expandedRepository = {
      ...authority,
      repositoryWrites: [".git/index", ".git/index.lock", "tracked.txt"],
    }
    expect(
      parseGitUnstageAllPreview({
        ...expandedRepository,
        proposalDigest: proposalDigest(expandedRepository),
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_preview_value",
    })
    const misboundScratch = {
      ...authority,
      scratchWrites: [authority.runtimeScratch, `${authority.runtimeScratch}/index`, "/tmp/other/index.lock"],
    }
    expect(
      parseGitUnstageAllPreview({
        ...misboundScratch,
        proposalDigest: proposalDigest(misboundScratch),
      }),
    ).toEqual({ ok: false, reason: "invalid_preview_value" })
    expect(parseGitUnstageAllPreview({ ...preview, stagedCount: 2 })).toEqual({
      ok: false,
      reason: "invalid_proposal_digest",
    })
    expect(parseGitUnstageAllPreview({ ...preview, command: "git add ." })).toEqual({
      ok: false,
      reason: "invalid_preview_shape",
    })
  })

  test("keeps process observation explicitly not verified", () => {
    const observation = {
      schemaVersion: 1,
      operation: "git_unstage_all",
      status: "effect_observed",
      verification: "not_verified",
      proposalDigest: preview.proposalDigest,
      beforeSnapshotDigest: digest("a"),
      afterSnapshotDigest: digest("b"),
      afterIndexDigest: digest("c"),
      afterIndexMetadataDigest: digest("d"),
      processObservationDigest: digest("e"),
      scratchCleanup: "observed_absent_before_return",
      limitations: gitUnstageAllLimitations,
    } as const

    expect(parseGitUnstageAllObservation(observation)).toEqual({ ok: true, value: observation })
    expect(parseGitUnstageAllObservation({ ...observation, verification: "verified" })).toEqual({
      ok: false,
      reason: "invalid_observation_value",
    })
  })

  test("binds an exact decision to the displayed proposal", () => {
    const decision = {
      schemaVersion: 1,
      operation: "git_unstage_all",
      proposalDigest: preview.proposalDigest,
      nonce: preview.nonce,
      decision: "approved",
      decidedAt: "2026-07-17T12:00:01.000Z",
    } as const
    expect(parseGitUnstageAllDecision(decision)).toEqual({ ok: true, value: decision })
    expect(parseGitUnstageAllDecision({ ...decision, extra: true })).toEqual({
      ok: false,
      reason: "invalid_decision_shape",
    })
  })
})

const authority = {
  schemaVersion: 1,
  operation: "git_unstage_all",
  boundary: "host_no_sandbox",
  boundaryLabel: gitUnstageAllBoundaryLabel,
  verification: "not_verified",
  workspaceRoot: "/tmp/astra-fixture",
  nonce: "b31db7fe-cb82-4c7b-9f32-45fe7af4692b",
  createdAt: "2026-07-17T12:00:00.000Z",
  expiresAt: "2026-07-17T12:05:00.000Z",
  runtimeScratch: "/tmp/astra-git-unstage-b31db7fe-cb82-4c7b-9f32-45fe7af4692b",
  stagedCount: 1,
  baseline: {
    snapshotDigest: digest("a"),
    rootIdentity: { device: "1", inode: "2" },
    gitIdentity: { device: "1", inode: "3" },
    indexDigest: digest("b"),
    indexMetadataDigest: digest("c"),
    indexIdentity: { device: "1", inode: "4", size: 256 },
    head: { kind: "symbolic", symbolicRef: "refs/heads/main", oid: "a".repeat(40) },
    refsDigest: digest("d"),
    worktreeDigest: digest("e"),
  },
  inspection: { observationDigest: digest("f"), reportDigest: digest("1") },
  executableDigest: digest("2"),
  invocation: {
    argumentsDigest: digest("3"),
    environmentDigest: digest("4"),
    timeoutMs: 5_000,
    maxStdoutBytes: 16_384,
    maxStderrBytes: 16_384,
  },
  repositoryWrites: [".git/index", ".git/index.lock"],
  scratchWrites: [
    "/tmp/astra-git-unstage-b31db7fe-cb82-4c7b-9f32-45fe7af4692b",
    "/tmp/astra-git-unstage-b31db7fe-cb82-4c7b-9f32-45fe7af4692b/index",
    "/tmp/astra-git-unstage-b31db7fe-cb82-4c7b-9f32-45fe7af4692b/index.lock",
  ],
  scratchCleanup: "required_before_return",
  authorizationConsumption: "durable_operation_kernel_claim_required",
  preserves: { worktree: "required", head: "required", refs: "required", objectStore: "not_observed" },
  network: "not_requested_host_unrestricted",
  splitIndex: {
    config: "absent",
    sharedIndexFiles: "absent",
    indexExtension: "rejected_by_baseline",
    invocation: "forced_disabled",
  },
  limitations: gitUnstageAllLimitations,
} as const satisfies GitUnstageAllPreviewAuthority

const preview = { ...authority, proposalDigest: computeGitUnstageAllProposalDigest(authority) } as const

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function proposalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`astra.git-unstage-all-preview.v1\0${JSON.stringify(value)}`).digest("hex")}`
}
