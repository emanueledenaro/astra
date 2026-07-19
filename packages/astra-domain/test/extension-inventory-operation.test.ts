import { describe, expect, test } from "bun:test"
import {
  computeExtensionInventoryCapabilityDigest,
  extensionInventoryAllowlist,
  extensionInventoryBoundaryLabel,
  extensionInventoryLimits,
  extensionInventoryResourceClasses,
  parseExtensionInventoryProposal,
  parseExtensionInventoryReport,
  type ExtensionInventoryProposal,
} from "../src/extension-inventory-operation"
import { parseContentDigest } from "../src/operation-contract"

describe("extension inventory operation contracts", () => {
  test("binds the exact pre-consent helper, FD 3, allowlist, resources, and limits", () => {
    const proposal = fixtureProposal()
    const parsed = parseExtensionInventoryProposal(proposal)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.workspace.descriptor).toEqual({
      childFD: 3,
      flags: ["O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW"],
      validation: "device_and_inode_after_durable_claim",
    })
    expect(parsed.value.allowlist).toEqual(extensionInventoryAllowlist)
    expect(parsed.value.resourceClasses).toEqual(extensionInventoryResourceClasses)
    expect(parsed.value.limits).toEqual(extensionInventoryLimits)
    expect(parsed.value.boundaryLabel).toBe(extensionInventoryBoundaryLabel)
  })

  test("rejects authority drift, path expansion, extra fields, and accessors", () => {
    const proposal = fixtureProposal()
    expect(parseExtensionInventoryProposal({ ...proposal, helper: { ...proposal.helper, digest: `sha256:${"f".repeat(64)}` } }).ok).toBe(false)
    expect(parseExtensionInventoryProposal({ ...proposal, workspace: { ...proposal.workspace, canonicalPath: "/tmp/../escape" } }).ok).toBe(false)
    expect(parseExtensionInventoryProposal({ ...proposal, extra: true }).ok).toBe(false)
    const hostile = { ...proposal }
    Object.defineProperty(hostile, "helper", { enumerable: true, get: () => proposal.helper })
    expect(parseExtensionInventoryProposal(hostile).ok).toBe(false)
    const hostileFlags = [...proposal.workspace.descriptor.flags]
    Object.defineProperty(hostileFlags, "hidden", { enumerable: true, get: () => "O_WRONLY" })
    expect(
      parseExtensionInventoryProposal({
        ...proposal,
        workspace: { ...proposal.workspace, descriptor: { ...proposal.workspace.descriptor, flags: hostileFlags } },
      }).ok,
    ).toBe(false)
  })

  test("accepts only redacted inactive and not-verified candidates", () => {
    const report = {
      schemaVersion: 1,
      status: "complete",
      candidates: [
        {
          candidateID: `sha256:${"1".repeat(64)}`,
          kind: "mcp",
          displayName: "safe-server",
          source: "config",
          sourcePath: ".mcp.json",
          referenceClass: "process",
          referenceDigest: `sha256:${"2".repeat(64)}`,
          state: "inactive",
          verification: "not_verified",
        },
      ],
      sourceFileCount: 1,
      sourceByteCount: 2,
      candidateCounts: { plugins: 0, mcp: 1 },
      state: "inactive",
      verification: "not_verified",
      redaction: "secrets_removed",
    }
    expect(parseExtensionInventoryReport(report).ok).toBe(true)
    expect(parseExtensionInventoryReport({ ...report, candidates: [{ ...report.candidates[0], displayName: "token\nleak" }] }).ok).toBe(false)
    expect(parseExtensionInventoryReport({ ...report, candidates: [{ ...report.candidates[0], state: "active" }] }).ok).toBe(false)
    expect(parseExtensionInventoryReport({ ...report, candidateCounts: { plugins: 1, mcp: 0 } }).ok).toBe(false)
  })
})

function fixtureProposal(): ExtensionInventoryProposal {
  const withoutDigest = {
    schemaVersion: 1,
    operationID: "10000000-0000-4000-8000-000000000001",
    policyAskedAt: "2026-07-17T10:00:00.000Z",
    authorizationExpiresAt: "2026-07-17T10:05:00.000Z",
    session: { mode: "activate-once", trust: "trusted_once" },
    boundary: "host_no_sandbox",
    boundaryLabel: extensionInventoryBoundaryLabel,
    workspace: {
      canonicalPath: "/tmp/workspace",
      identity: { device: "1", inode: "2" },
      securityDigest: contentDigest("b"),
      descriptor: {
        childFD: 3,
        flags: ["O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW"],
        validation: "device_and_inode_after_durable_claim",
      },
    },
    helper: {
      canonicalPath: "/tmp/astra-extension-inventory",
      device: "3",
      inode: "4",
      size: 123,
      digest: contentDigest("a"),
    },
    allowlist: extensionInventoryAllowlist,
    resourceClasses: extensionInventoryResourceClasses,
    limits: extensionInventoryLimits,
    guarantees: {
      automaticInitialization: "none",
      parsing: "static_json_jsonc_only",
      substitutions: "forbidden",
      imports: "forbidden",
      activation: "none",
      rawBytes: "private_parent_pipe_only",
      helperExecution: "private_verified_snapshot_after_claim",
      rejection: "no_workspace_open_no_child",
    },
  } as const
  return { ...withoutDigest, capabilityDigest: computeExtensionInventoryCapabilityDigest(withoutDigest) }
}

function contentDigest(character: string) {
  const parsed = parseContentDigest(`sha256:${character.repeat(64)}`)
  if (!parsed.ok) throw new Error("Invalid test digest")
  return parsed.value
}
