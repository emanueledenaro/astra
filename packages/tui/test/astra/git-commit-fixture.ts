import {
  computeGitCommitProposalDigest,
  gitCommitBoundaryLabel,
  gitCommitLimitations,
  type GitCommitPreviewAuthority,
} from "../../../astra-domain/src/git-commit-mutation"
import type {
  GitCommitDecisionResult,
  GitCommitPrepareResult,
  GitCommitProgress,
} from "../../../astra-domain/src/git-commit-control"

export const proposalID = "50000000-0000-4000-8000-000000000005"
export const operationID = "60000000-0000-4000-8000-000000000006"
export const receiptID = "70000000-0000-4000-8000-000000000007"
export const commitMessage = "feat: exact governed commit"
const nonce = "80000000-0000-4000-8000-000000000008"
const workspaceRoot = "/Users/example/astra-project"
const oldOID = "1".repeat(40)
const treeOID = "2".repeat(40)
export const commitOID = "3".repeat(40)

const previewAuthority = {
  schemaVersion: 1,
  operation: "git_commit_local",
  boundary: "host_no_sandbox",
  boundaryLabel: gitCommitBoundaryLabel,
  verification: "not_verified",
  workspaceRoot,
  nonce,
  createdAt: "2027-01-01T12:00:00.000Z",
  expiresAt: "2027-01-01T12:05:00.000Z",
  runtimeScratch: `/private/tmp/astra-git-commit-${nonce}`,
  baselineSnapshotDigest: digest("a"),
  inventoryDigest: digest("b"),
  helper: {
    canonicalPath: "/usr/local/libexec/astra-git-commit",
    device: "1",
    inode: "2",
    byteLength: 4096,
    contentDigest: digest("c"),
  },
  objectFormat: "sha1",
  branch: "main",
  ref: "refs/heads/main",
  expectedOldOID: oldOID,
  treeOID,
  commitOID,
  identity: { name: "Astra Test", email: "astra@example.invalid" },
  timestamp: 1_798_761_600,
  timezone: "+0000",
  message: commitMessage,
  treeObjects: [{ oid: treeOID, byteLength: 64, contentDigest: digest("d") }],
  commitObject: { byteLength: 256, contentDigest: digest("e") },
  repositoryWrites: [
    `.git/objects/${treeOID.slice(0, 2)}/${treeOID.slice(2)}`,
    `.git/objects/${commitOID.slice(0, 2)}/${commitOID.slice(2)}`,
    ".git/refs/heads/main",
    ".git/refs/heads/main.lock",
  ],
  scratchWrites: [`/private/tmp/astra-git-commit-${nonce}`],
  reflog: "absent_no_create",
  hooks: "disabled",
  editor: "disabled",
  signing: "disabled",
  credentials: "disabled",
  network: "not_requested_host_unrestricted",
  authorizationConsumption: "durable_operation_kernel_claim_required",
  preserves: { index: "required", worktree: "required", otherRefs: "required" },
  limitations: gitCommitLimitations,
} as const satisfies GitCommitPreviewAuthority

export const commitPreview = { ...previewAuthority, proposalDigest: computeGitCommitProposalDigest(previewAuthority) }

export function preparedResult(requestId = "a0000000-0000-4000-8000-00000000000a"): GitCommitPrepareResult {
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: { schemaVersion: 1, action: "Commit staged", proposalID, authority: commitPreview },
  }
}

export function progress(
  status: GitCommitProgress["status"],
  requestId = "b0000000-0000-4000-8000-00000000000b",
): GitCommitProgress {
  const binding = { schemaVersion: 1, requestId, proposalID, proposalDigest: commitPreview.proposalDigest } as const
  if (status !== "effect_observed_not_verified") return { ...binding, status, verification: "not_verified" }
  return { ...binding, status, verification: "not_verified", operationID, receiptID, commitOID }
}

export function deniedResult(requestId = "b0000000-0000-4000-8000-00000000000b"): GitCommitDecisionResult {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    proposalDigest: commitPreview.proposalDigest,
    status: "denied_without_git_effect",
    operationID,
  }
}

export function verifiedResult(requestId = "b0000000-0000-4000-8000-00000000000b"): GitCommitDecisionResult {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    proposalDigest: commitPreview.proposalDigest,
    status: "verified",
    verification: "independent_commit_bytes_and_repository_state",
    operationID,
    receiptID,
    commitOID,
  }
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}
