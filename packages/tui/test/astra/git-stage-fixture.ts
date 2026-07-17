import {
  gitStageBoundaryLabel,
  gitStageLimitations,
  computeGitStageInventoryDigest,
  computeGitStageProposalDigest,
  type GitStageInventoryAuthority,
  type GitStagePreviewAuthority,
} from "../../../astra-domain/src/git-stage-mutation"
import type {
  GitStageDecisionResult,
  GitStageInventoryResult,
  GitStagePrepareResult,
  GitStageProgress,
} from "../../../astra-domain/src/git-stage-control"

export const sessionID = "10000000-0000-4000-8000-000000000001"
export const inventoryID = "20000000-0000-4000-8000-000000000002"
export const trackedCandidateID = "30000000-0000-4000-8000-000000000003"
export const untrackedCandidateID = "40000000-0000-4000-8000-000000000004"
export const proposalID = "50000000-0000-4000-8000-000000000005"
export const operationID = "60000000-0000-4000-8000-000000000006"
export const receiptID = "70000000-0000-4000-8000-000000000007"
const workspaceRoot = "/Users/example/astra-project"
const baselineSnapshotDigest = digest("a")
const oldOID = "1".repeat(40)
const trackedOID = "2".repeat(40)
const untrackedOID = "3".repeat(40)

const inventoryAuthority = {
  schemaVersion: 1,
  workspaceRoot,
  baselineSnapshotDigest,
  inspectionObservationDigest: digest("b"),
  inspectionReportDigest: digest("c"),
  objectFormat: "sha1",
  indexEntries: [{ path: "tracked.ts", mode: "100644", oid: oldOID }],
  candidates: [
    {
      candidateID: untrackedCandidateID,
      path: "new.ts",
      action: "upsert",
      before: { state: "absent" },
      after: { state: "object", mode: "100644", oid: untrackedOID, byteLength: 4, contentDigest: digest("d") },
      objectPath: `.git/objects/${untrackedOID.slice(0, 2)}/${untrackedOID.slice(2)}`,
    },
    {
      candidateID: trackedCandidateID,
      path: "tracked.ts",
      action: "upsert",
      before: { state: "object", mode: "100644", oid: oldOID },
      after: { state: "object", mode: "100644", oid: trackedOID, byteLength: 7, contentDigest: digest("e") },
      objectPath: `.git/objects/${trackedOID.slice(0, 2)}/${trackedOID.slice(2)}`,
    },
  ],
} as const satisfies GitStageInventoryAuthority

const inventoryDigest = computeGitStageInventoryDigest(inventoryAuthority)
const nonce = "80000000-0000-4000-8000-000000000008"
const previewAuthority = {
  schemaVersion: 1,
  operation: "git_stage_paths",
  boundary: "host_no_sandbox",
  boundaryLabel: gitStageBoundaryLabel,
  verification: "not_verified",
  workspaceRoot,
  nonce,
  createdAt: "2027-01-01T12:00:00.000Z",
  expiresAt: "2027-01-01T12:05:00.000Z",
  runtimeScratch: `/private/tmp/astra-git-stage-${nonce}`,
  inventoryDigest,
  baselineSnapshotDigest,
  selection: { kind: "selected", candidateIDs: [trackedCandidateID] },
  candidates: [inventoryAuthority.candidates[1]],
  repositoryWrites: [".git/index", ".git/index.lock", `.git/objects/${trackedOID.slice(0, 2)}/${trackedOID.slice(2)}`],
  scratchWrites: [`/private/tmp/astra-git-stage-${nonce}`],
  authorizationConsumption: "durable_operation_kernel_claim_required",
  hooks: "disabled",
  filters: "raw_no_filters_transforming_attributes_blocked",
  network: "not_requested_host_unrestricted",
  preserves: { worktree: "required", head: "required", refs: "required", nonSelectedIndexEntries: "required" },
  limitations: gitStageLimitations,
} as const satisfies GitStagePreviewAuthority

export const stagePreview = { ...previewAuthority, proposalDigest: computeGitStageProposalDigest(previewAuthority) }

export function inventoryResult(requestId = "90000000-0000-4000-8000-000000000009"): GitStageInventoryResult {
  return {
    schemaVersion: 1,
    requestId,
    status: "inventory",
    inventory: {
      schemaVersion: 1,
      action: "Stage selected",
      inventoryID,
      inventoryDigest,
      baselineSnapshotDigest,
      boundaryLabel: gitStageBoundaryLabel,
      verification: "not_verified",
      expiresAt: "2027-01-01T12:05:00.000Z",
      candidates: [
        { candidateID: untrackedCandidateID, path: "new.ts", change: "add" },
        { candidateID: trackedCandidateID, path: "tracked.ts", change: "modify" },
      ],
      limitations: gitStageLimitations,
    },
  }
}

export function preparedResult(requestId = "a0000000-0000-4000-8000-00000000000a"): GitStagePrepareResult {
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: { schemaVersion: 1, action: "Stage selected", proposalID, authority: stagePreview },
  }
}

export function transitionTamperedPreparedResult(
  requestId = "a0000000-0000-4000-8000-00000000000a",
): GitStagePrepareResult {
  const candidate = { ...inventoryAuthority.candidates[1], before: { state: "absent" } as const }
  const authority = {
    ...previewAuthority,
    candidates: [candidate],
  } as const satisfies GitStagePreviewAuthority
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      schemaVersion: 1,
      action: "Stage selected",
      proposalID,
      authority: { ...authority, proposalDigest: computeGitStageProposalDigest(authority) },
    },
  }
}

export function progress(
  status: GitStageProgress["status"],
  requestId = "b0000000-0000-4000-8000-00000000000b",
): GitStageProgress {
  const binding = { schemaVersion: 1, requestId, proposalID, proposalDigest: stagePreview.proposalDigest } as const
  if (status !== "effect_observed_not_verified") return { ...binding, status, verification: "not_verified" }
  return { ...binding, status, verification: "not_verified", operationID, receiptID, snapshotDigest: digest("f") }
}

export function verifiedResult(requestId = "b0000000-0000-4000-8000-00000000000b"): GitStageDecisionResult {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    proposalDigest: stagePreview.proposalDigest,
    status: "verified",
    verification: "independent_selected_index_and_preservation",
    operationID,
    receiptID,
    snapshotDigest: digest("f"),
  }
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}
