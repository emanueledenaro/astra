import { describe, expect, test } from "bun:test"
import {
  computeGitStageInventoryDigest,
  computeGitStageProposalDigest,
  gitStageBoundaryLabel,
  gitStageLimitations,
  parseGitStageDecision,
  parseGitStageInventory,
  parseGitStageObservation,
  parseGitStagePreview,
  type GitStageInventoryAuthority,
  type GitStagePreviewAuthority,
} from "../src/git-stage-mutation"

const zeroDigest = `sha256:${"0".repeat(64)}` as const
const oneDigest = `sha256:${"1".repeat(64)}` as const
const oid = "a".repeat(40)
const candidateID = "11111111-1111-4111-8111-111111111111"
const nonce = "22222222-2222-4222-8222-222222222222"

function inventory() {
  const authority = {
    schemaVersion: 1,
    workspaceRoot: "/tmp/workspace",
    baselineSnapshotDigest: zeroDigest,
    inspectionObservationDigest: oneDigest,
    inspectionReportDigest: zeroDigest,
    objectFormat: "sha1",
    indexEntries: [{ path: "src/a.ts", mode: "100644", oid: "b".repeat(40) }],
    candidates: [
      {
        candidateID,
        path: "src/a.ts",
        action: "upsert",
        before: { state: "object", mode: "100644", oid: "b".repeat(40) },
        after: { state: "object", mode: "100644", oid, byteLength: 3, contentDigest: oneDigest },
        objectPath: `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
      },
    ],
  } as const satisfies GitStageInventoryAuthority
  return { ...authority, inventoryDigest: computeGitStageInventoryDigest(authority) }
}

function preview() {
  const source = inventory()
  const authority = {
    schemaVersion: 1,
    operation: "git_stage_paths",
    boundary: "host_no_sandbox",
    boundaryLabel: gitStageBoundaryLabel,
    verification: "not_verified",
    workspaceRoot: source.workspaceRoot,
    nonce,
    createdAt: "2026-07-17T10:00:00.000Z",
    expiresAt: "2026-07-17T10:05:00.000Z",
    runtimeScratch: `/private/tmp/astra-git-stage-${nonce}`,
    inventoryDigest: source.inventoryDigest,
    baselineSnapshotDigest: source.baselineSnapshotDigest,
    selection: { kind: "selected", candidateIDs: [candidateID] },
    candidates: source.candidates,
    repositoryWrites: [".git/index", ".git/index.lock", source.candidates[0].objectPath].sort(),
    scratchWrites: [`/private/tmp/astra-git-stage-${nonce}`],
    authorizationConsumption: "durable_operation_kernel_claim_required",
    hooks: "disabled",
    filters: "raw_no_filters_transforming_attributes_blocked",
    network: "not_requested_host_unrestricted",
    preserves: { worktree: "required", head: "required", refs: "required", nonSelectedIndexEntries: "required" },
    limitations: gitStageLimitations,
  } as const satisfies GitStagePreviewAuthority
  return { ...authority, proposalDigest: computeGitStageProposalDigest(authority) }
}

describe("Git stage mutation contracts", () => {
  test("accepts exact inventory and preview authorities", () => {
    expect(parseGitStageInventory(inventory()).ok).toBeTrue()
    expect(parseGitStagePreview(preview()).ok).toBeTrue()
  })

  test("rejects candidate, resource, and digest tampering", () => {
    const source = preview()
    expect(parseGitStagePreview({ ...source, proposalDigest: zeroDigest }).ok).toBeFalse()
    expect(parseGitStagePreview({ ...source, repositoryWrites: [".git/index", ".git/index.lock"] }).ok).toBeFalse()
    expect(
      parseGitStagePreview({
        ...source,
        candidates: [{ ...source.candidates[0], objectPath: ".git/objects/aa/escape" }],
      }).ok,
    ).toBeFalse()
    expect(parseGitStageInventory({ ...inventory(), inventoryDigest: oneDigest }).ok).toBeFalse()
  })

  test("parses exact decisions and observations and rejects extra fields", () => {
    const source = preview()
    const decision = {
      schemaVersion: 1,
      operation: "git_stage_paths",
      proposalDigest: source.proposalDigest,
      nonce,
      decision: "approved",
      decidedAt: "2026-07-17T10:01:00.000Z",
    } as const
    expect(parseGitStageDecision(decision).ok).toBeTrue()
    expect(parseGitStageDecision({ ...decision, authority: "extra" }).ok).toBeFalse()

    const observation = {
      schemaVersion: 1,
      operation: "git_stage_paths",
      status: "effect_observed",
      verification: "not_verified",
      proposalDigest: source.proposalDigest,
      beforeSnapshotDigest: zeroDigest,
      afterSnapshotDigest: oneDigest,
      afterIndexDigest: zeroDigest,
      afterIndexMetadataDigest: oneDigest,
      objectOIDs: [oid],
      limitations: gitStageLimitations,
    } as const
    expect(parseGitStageObservation(observation).ok).toBeTrue()
    expect(parseGitStageObservation({ ...observation, verified: true }).ok).toBeFalse()
  })
})
