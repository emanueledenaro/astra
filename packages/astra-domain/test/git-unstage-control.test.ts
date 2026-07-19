import { expect, test } from "bun:test"
import {
  computeGitUnstageAllProposalDigest,
  gitUnstageAllBoundaryLabel,
  gitUnstageAllLimitations,
} from "../src/git-control-mutation"
import {
  parseGitUnstageControlPreview,
  parseGitUnstageDecisionRequest,
  parseGitUnstageDecisionResult,
  parseGitUnstagePrepareRequest,
  parseGitUnstageProgress,
} from "../src/git-unstage-control"

test("accepts only path-free authenticated prepare and decision requests", () => {
  const prepare = request("git-unstage.prepare")
  expect(parseGitUnstagePrepareRequest(prepare)).toEqual({ ok: true, value: prepare })
  expect(parseGitUnstagePrepareRequest({ ...prepare, workspaceRoot: "/tmp/attacker" })).toMatchObject({ ok: false })

  const decision = { ...request("git-unstage.decide"), proposalID, decision: "approve" } as const
  expect(parseGitUnstageDecisionRequest(decision)).toEqual({ ok: true, value: decision })
  expect(parseGitUnstageDecisionRequest({ ...decision, argv: ["reset"] })).toMatchObject({ ok: false })
  expect(
    parseGitUnstageDecisionRequest({ ...decision, requestId: "00000000-0000-0000-8000-000000000001" }),
  ).toMatchObject({ ok: false })
})

test("binds the displayed exact resources to the underlying Git authority", () => {
  const preview = { schemaVersion: 1, action: "Unstage all", proposalID, authority } as const
  expect(parseGitUnstageControlPreview(preview)).toEqual({ ok: true, value: preview })
  expect(parseGitUnstageControlPreview({ ...preview, authority: { ...authority, stagedCount: 2 } })).toMatchObject({
    ok: false,
  })
})

test("requires progress and terminal receipts to carry the exact proposal binding", () => {
  const binding = {
    schemaVersion: 1,
    requestId,
    proposalID,
    proposalDigest: authority.proposalDigest,
  } as const
  const observed = {
    ...binding,
    status: "effect_observed_not_verified",
    verification: "not_verified",
    operationID,
    receiptID,
    snapshotDigest: digest("8"),
  } as const
  expect(parseGitUnstageProgress(observed)).toEqual({ ok: true, value: observed })
  expect(parseGitUnstageProgress({ ...observed, receiptID: "not-a-receipt" })).toMatchObject({ ok: false })

  const verified = {
    ...binding,
    status: "verified",
    verification: "independent_post_state",
    operationID,
    receiptID,
    snapshotDigest: observed.snapshotDigest,
  } as const
  expect(parseGitUnstageDecisionResult(verified)).toEqual({ ok: true, value: verified })
  expect(parseGitUnstageDecisionResult({ ...verified, verification: "command_exit_zero" })).toMatchObject({ ok: false })
})

function request<const Method extends "git-unstage.prepare" | "git-unstage.decide">(method: Method) {
  return { schemaVersion: 1, method, requestId, sessionID, token: "x".repeat(43) } as const
}

const requestId = "00000000-0000-8000-8000-000000000001"
const sessionID = "10000000-0000-4000-8000-000000000001"
const proposalID = "20000000-0000-4000-8000-000000000002"
const operationID = "30000000-0000-4000-8000-000000000003"
const receiptID = "40000000-0000-4000-8000-000000000004"
const authorityWithoutDigest = {
  schemaVersion: 1,
  operation: "git_unstage_all",
  boundary: "host_no_sandbox",
  boundaryLabel: gitUnstageAllBoundaryLabel,
  verification: "not_verified",
  workspaceRoot: "/tmp/astra-fixture",
  nonce: "50000000-0000-4000-8000-000000000005",
  createdAt: "2026-07-17T12:00:00.000Z",
  expiresAt: "2026-07-17T12:05:00.000Z",
  runtimeScratch: "/private/tmp/astra-git-unstage-50000000-0000-4000-8000-000000000005",
  stagedCount: 1,
  baseline: {
    snapshotDigest: digest("a"),
    rootIdentity: { device: "1", inode: "2" },
    gitIdentity: { device: "1", inode: "3" },
    indexDigest: digest("b"),
    indexMetadataDigest: digest("c"),
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
    "/private/tmp/astra-git-unstage-50000000-0000-4000-8000-000000000005",
    "/private/tmp/astra-git-unstage-50000000-0000-4000-8000-000000000005/index",
    "/private/tmp/astra-git-unstage-50000000-0000-4000-8000-000000000005/index.lock",
  ],
  sealedExecutableScratch: {
    root: "/private/tmp",
    directoryPrefix: "astra-git-exec-",
    executableName: "git",
    lifecycle: "created_after_claim_cleanup_required_before_return",
    purposes: ["baseline_revalidation", "operation_execution", "post_state_observation", "independent_verification"],
  },
  scratchCleanup: "required_before_return",
  authorizationConsumption: "durable_operation_kernel_claim_required",
  preserves: { worktree: "required", head: "required", refs: "required", objectStore: "not_observed" },
  network: "not_requested_host_unrestricted",
  splitIndex: {
    config: "validated_after_claim",
    sharedIndexFiles: "validated_after_claim",
    indexExtension: "rejected_by_baseline",
    invocation: "forced_disabled",
  },
  limitations: gitUnstageAllLimitations,
} as const
const authority = {
  ...authorityWithoutDigest,
  proposalDigest: computeGitUnstageAllProposalDigest(authorityWithoutDigest),
} as const

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}
