import {
  computeGitUnstageAllProposalDigest,
  gitUnstageAllBoundaryLabel,
  gitUnstageAllLimitations,
} from "@astra/domain/git-control-mutation"
import {
  computeGitRepositoryBaselineSnapshotDigest,
  type GitRepositoryBaselineSnapshotAuthority,
} from "@astra/domain/git-repository-baseline"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type {
  GitUnstageDecisionResult,
  GitUnstagePrepareResult,
  GitUnstageProgress,
} from "@astra/domain/git-unstage-control"

export const sessionID = "10000000-0000-4000-8000-000000000001"
export const prepareRequestID = "00000000-0000-8000-8000-000000000001"
export const decisionRequestID = "00000000-0000-8000-8000-000000000002"
export const proposalID = "20000000-0000-4000-8000-000000000002"
export const operationID = "30000000-0000-4000-8000-000000000003"
export const receiptID = "40000000-0000-4000-8000-000000000004"

const baselineAuthority = {
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
  root: { canonicalPath: "/Users/example/astra-project", device: "1", inode: "2" },
  gitDirectory: { canonicalPath: "/Users/example/astra-project/.git", device: "1", inode: "3" },
  commonDirectory: { canonicalPath: "/Users/example/astra-project/.git", device: "1", inode: "3" },
  head: { kind: "symbolic", symbolicRef: "refs/heads/main", oid: "a".repeat(40) },
  refs: { digest: digest("d"), count: 1 },
  index: { digest: digest("b"), metadataDigest: digest("c"), entryCount: 2 },
  worktree: {
    digest: digest("e"),
    ignored: "excluded",
    trackedPaths: 2,
    untrackedPaths: 0,
    contentEntries: 2,
    totalBytes: 16,
  },
  metadata: { digest: digest("6"), fileCount: 1, totalBytes: 21, externalConfig: "unsupported" },
  observer: {
    adapter: "astra.git-baseline.v1",
    adapterDigest: digest("7"),
    gitBinaryDigest: digest("2"),
    observationDigest: digest("f"),
  },
  limits: {
    timeoutMs: 2_000,
    maxStdoutBytes: 1_048_576,
    maxStderrBytes: 16_384,
    maxEntries: 25_000,
    maxBoundaryEntries: 250_000,
    maxBoundaryDurationMs: 15_000,
    maxGitBinaryBytes: 67_108_864,
    maxContentEntries: 25_000,
    maxFileBytes: 33_554_432,
    maxTotalBytes: 268_435_456,
    maxDurationMs: 30_000,
  },
} as const satisfies GitRepositoryBaselineSnapshotAuthority

export const activeAuthority = {
  schemaVersion: 1,
  sessionID,
  issuedAt: "2026-07-17T12:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/Users/example/astra-project",
    identity: { device: "1", inode: "2" },
    securityDigest: digest("9"),
  },
  repositoryBaseline: {
    ...baselineAuthority,
    snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(baselineAuthority),
  },
} as const satisfies AstraSessionAuthority

const authorityWithoutDigest = {
  schemaVersion: 1,
  operation: "git_unstage_all",
  boundary: "host_no_sandbox",
  boundaryLabel: gitUnstageAllBoundaryLabel,
  verification: "not_verified",
  workspaceRoot: "/Users/example/astra-project",
  nonce: "50000000-0000-4000-8000-000000000005",
  createdAt: "2026-07-17T12:00:00.000Z",
  expiresAt: "2026-07-17T12:05:00.000Z",
  runtimeScratch: "/private/tmp/astra-git-unstage-50000000-0000-4000-8000-000000000005",
  stagedCount: 2,
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

export const gitAuthority = {
  ...authorityWithoutDigest,
  proposalDigest: computeGitUnstageAllProposalDigest(authorityWithoutDigest),
} as const

export function preparedResult(requestId = prepareRequestID) {
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: { schemaVersion: 1, action: "Unstage all", proposalID, authority: gitAuthority },
  } as const satisfies GitUnstagePrepareResult
}

export function progress(status: GitUnstageProgress["status"], requestId = decisionRequestID): GitUnstageProgress {
  const binding = {
    schemaVersion: 1,
    requestId,
    proposalID,
    proposalDigest: gitAuthority.proposalDigest,
  } as const
  if (status !== "effect_observed_not_verified") {
    return { ...binding, status, verification: "not_verified" }
  }
  return {
    ...binding,
    status,
    verification: "not_verified",
    operationID,
    receiptID,
    snapshotDigest: digest("8"),
  }
}

export function verifiedResult(requestId = decisionRequestID): GitUnstageDecisionResult {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    proposalDigest: gitAuthority.proposalDigest,
    status: "verified",
    verification: "independent_post_state",
    operationID,
    receiptID,
    snapshotDigest: digest("8"),
  }
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}
