import { createHash } from "node:crypto"
import {
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import { parseContentDigest, type ContentDigest } from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"

/** Derives the exact workspace or Git baseline bound to a controlled effect. */
export function makeControlledWriteBaselineAuthority(
  report: WorkspaceTrustReport,
  repositoryBaseline: GitRepositoryBaselineSnapshot | undefined,
) {
  const gitWorkspace = report.surfaces.some((surface) => surface.kind === "git_metadata")
  if (!gitWorkspace) {
    if (repositoryBaseline) throw new TypeError("A Git baseline cannot authorize a non-Git workspace")
    if (!report.securityDigest) throw new TypeError("A complete workspace baseline is required before dispatch")
    return {
      baselineDigest: report.securityDigest,
      repositorySnapshotDigest: null,
      repository: { kind: "non_git", markerDigest: report.securityDigest } as const,
    }
  }

  const parsed = parseGitRepositoryBaselineSnapshot(repositoryBaseline)
  if (!parsed.ok) throw new TypeError("A complete, valid Git baseline is required before dispatch")
  if (
    parsed.value.root.canonicalPath !== report.root ||
    parsed.value.root.device !== report.identity?.device ||
    parsed.value.root.inode !== report.identity.inode
  ) {
    throw new TypeError("The Git baseline and preflight refer to different workspace identities")
  }
  const repository = {
    kind: "git",
    schemaVersion: 1,
    snapshotDigest: parsed.value.snapshotDigest,
    observationDigest: parsed.value.observer.observationDigest,
    root: parsed.value.root,
    head: parsed.value.head,
    verification: parsed.value.verification,
  } as const
  return {
    baselineDigest: digest(
      canonicalJson({
        repositorySnapshotDigest: parsed.value.snapshotDigest,
        workspaceSecurityDigest: report.securityDigest,
      }),
    ),
    repositorySnapshotDigest: parsed.value.snapshotDigest,
    repository,
  }
}

export function deterministicUUID(seed: string, label: string): string {
  const bytes = createHash("sha256").update(seed).update("\0").update(label).digest().subarray(0, 16)
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x80
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function digest(input: string): ContentDigest {
  return requireContentDigest(`sha256:${createHash("sha256").update(input).digest("hex")}`)
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Operation facts must be canonical JSON")
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The controlled write digest is invalid")
  return parsed.value
}
