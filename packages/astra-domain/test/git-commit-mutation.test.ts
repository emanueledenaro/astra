import { describe, expect, test } from "bun:test"
import {
  computeGitCommitProposalDigest,
  parseGitCommitDecision,
  parseGitCommitMessage,
  parseGitCommitPreview,
  type GitCommitPreviewAuthority,
} from "../src/git-commit-mutation"

describe("governed local Git commit contract", () => {
  test("accepts printable UTF-8 and multiline messages up to 4 KiB", () => {
    expect(parseGitCommitMessage("feat: ship Astra\n\nExplains perché.")).toEqual({
      ok: true,
      value: "feat: ship Astra\n\nExplains perché.",
    })
    expect(parseGitCommitMessage("x".repeat(4096)).ok).toBe(true)
  })

  test("rejects empty, oversized, CR and control-bearing messages", () => {
    for (const message of [
      "",
      " \n\t",
      "x".repeat(4097),
      "bad\rmessage",
      "bad\tmessage",
      "bad\0message",
      "bad\u001bmessage",
      "bad\u0085message",
      "bad\u202emessage",
      "bad\u200dmessage",
      "bad\u2028message",
      "bad\ud800message",
    ]) {
      expect(parseGitCommitMessage(message)).toEqual({ ok: false, reason: "invalid_commit_message" })
    }
  })

  test("binds every authority field into the proposal digest", () => {
    const authority = previewAuthority()
    const preview = { ...authority, proposalDigest: computeGitCommitProposalDigest(authority) }
    expect(parseGitCommitPreview(preview)).toEqual({ ok: true, value: preview })
    expect(parseGitCommitPreview({ ...preview, commitOID: "b".repeat(40) })).toEqual({
      ok: false,
      reason: "invalid_proposal_digest",
    })
  })

  test("rejects decisions not bound to the exact nonce and proposal", () => {
    expect(
      parseGitCommitDecision({
        schemaVersion: 1,
        operation: "git_commit_local",
        proposalDigest: `sha256:${"a".repeat(64)}`,
        nonce: "00000000-0000-4000-8000-000000000001",
        decision: "approved",
        decidedAt: "2026-07-18T10:00:01.000Z",
      }).ok,
    ).toBe(true)
    expect(
      parseGitCommitDecision({
        schemaVersion: 1,
        operation: "git_commit_local",
        proposalDigest: `sha256:${"a".repeat(64)}`,
        nonce: "not-a-nonce",
        decision: "approved",
        decidedAt: "2026-07-18T10:00:01.000Z",
      }).ok,
    ).toBe(false)
  })
})

function previewAuthority(): GitCommitPreviewAuthority {
  return {
    schemaVersion: 1,
    operation: "git_commit_local",
    boundary: "host_no_sandbox",
    boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    verification: "not_verified",
    workspaceRoot: "/tmp/repository",
    nonce: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-18T10:00:00.000Z",
    expiresAt: "2026-07-18T10:05:00.000Z",
    runtimeScratch: "/private/tmp/astra-git-commit-00000000-0000-4000-8000-000000000001",
    baselineSnapshotDigest: `sha256:${"1".repeat(64)}`,
    inventoryDigest: `sha256:${"2".repeat(64)}`,
    helper: {
      canonicalPath: "/opt/astra/astra-git-commit",
      device: "1",
      inode: "2",
      byteLength: 4096,
      contentDigest: `sha256:${"9".repeat(64)}`,
    },
    objectFormat: "sha1",
    branch: "durable-coordinator",
    ref: "refs/heads/durable-coordinator",
    expectedOldOID: "a".repeat(40),
    treeOID: "c".repeat(40),
    commitOID: "d".repeat(40),
    identity: { name: "Astra User", email: "astra@example.test" },
    timestamp: 1_752_836_400,
    timezone: "+0000",
    message: "feat: governed commit",
    treeObjects: [{ oid: "c".repeat(40), byteLength: 12, contentDigest: `sha256:${"3".repeat(64)}` }],
    commitObject: { byteLength: 200, contentDigest: `sha256:${"4".repeat(64)}` },
    repositoryWrites: [
      `.git/objects/${"c".repeat(2)}/${"c".repeat(38)}`,
      `.git/objects/${"d".repeat(2)}/${"d".repeat(38)}`,
      ".git/refs/heads/durable-coordinator",
      ".git/refs/heads/durable-coordinator.lock",
    ],
    scratchWrites: ["/private/tmp/astra-git-commit-00000000-0000-4000-8000-000000000001"],
    reflog: "absent_no_create",
    hooks: "disabled",
    editor: "disabled",
    signing: "disabled",
    credentials: "disabled",
    network: "not_requested_host_unrestricted",
    authorizationConsumption: "durable_operation_kernel_claim_required",
    preserves: { index: "required", worktree: "required", otherRefs: "required" },
    limitations: [
      "host_network_not_isolated",
      "orphan_objects_require_reconciliation",
    ],
  }
}
