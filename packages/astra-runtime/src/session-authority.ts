import { createHash, timingSafeEqual } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseAstraSessionAuthority, type AstraSessionAuthority } from "@astra/domain/session-authority"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import { revalidateGitRepositoryBaseline } from "@astra/git"
import { scanWorkspace } from "./workspace-preflight"

const maximumAuthorityBytes = 1024 * 1024
const maximumAuthorityAgeMs = 10 * 60 * 1000
const maximumClockSkewMs = 30 * 1000

export type AstraSessionAuthorityState =
  | Readonly<{ status: "inactive" }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "valid"; authority: AstraSessionAuthority }>

export type AstraRevalidatedSessionAuthorityState =
  | Exclude<AstraSessionAuthorityState, { status: "valid" }>
  | Readonly<{ status: "valid"; authority: AstraSessionAuthority; report: WorkspaceTrustReport }>

/**
 * Loads the private, fail-closed authority created by the Astra workspace gate.
 * Environment values only locate and bind the file; they are never accepted as
 * authority-bearing workspace state on their own.
 */
export function inspectAstraSessionAuthority(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedRoot = process.cwd(),
  now = Date.now(),
): AstraSessionAuthorityState {
  if (environment.ASTRA_SAFE_START !== "1" && environment.OPENCODE_CLIENT !== "astra") {
    return { status: "inactive" }
  }
  if (environment.ASTRA_SAFE_START !== "1" || environment.OPENCODE_CLIENT !== "astra") {
    return { status: "invalid", reason: "astra_process_binding_missing" }
  }

  const path = environment.ASTRA_SESSION_AUTHORITY_FILE
  const expectedDigest = environment.ASTRA_SESSION_AUTHORITY_DIGEST
  if (!path || !expectedDigest || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    return { status: "invalid", reason: "authority_reference_invalid" }
  }

  let descriptor: number | undefined
  try {
    const parent = lstatSync(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink() || !ownedPrivately(parent.uid, parent.mode)) {
      return { status: "invalid", reason: "authority_directory_insecure" }
    }

    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const facts = fstatSync(descriptor)
    if (
      !facts.isFile() ||
      facts.nlink !== 1 ||
      !ownedPrivately(facts.uid, facts.mode) ||
      facts.size < 2 ||
      facts.size > maximumAuthorityBytes
    ) {
      return { status: "invalid", reason: "authority_file_insecure" }
    }

    const bytes = readFileSync(descriptor)
    const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    if (!sameDigest(actualDigest, expectedDigest)) {
      return { status: "invalid", reason: "authority_digest_mismatch" }
    }

    const parsed = parseAstraSessionAuthority(JSON.parse(bytes.toString("utf8")))
    if (!parsed.ok) return { status: "invalid", reason: parsed.reason }
    if (resolve(parsed.value.workspace.root) !== resolve(expectedRoot)) {
      return { status: "invalid", reason: "authority_workspace_mismatch" }
    }

    const issuedAt = Date.parse(parsed.value.issuedAt)
    if (issuedAt > now + maximumClockSkewMs || now - issuedAt > maximumAuthorityAgeMs) {
      return { status: "invalid", reason: "authority_expired" }
    }
    return { status: "valid", authority: parsed.value }
  } catch {
    return { status: "invalid", reason: "authority_unreadable" }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Rechecks filesystem and Git facts in the child process before OpenCode admission. */
export async function revalidateAstraSessionAuthority(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedRoot = process.cwd(),
  now = Date.now(),
): Promise<AstraRevalidatedSessionAuthorityState> {
  const inspected = inspectAstraSessionAuthority(environment, expectedRoot, now)
  if (inspected.status !== "valid") return inspected

  const authority = inspected.authority
  const report = await scanWorkspace(authority.workspace.root)
  if (
    report.completeness !== "complete" ||
    !report.identity ||
    !report.securityDigest ||
    report.identity.device !== authority.workspace.identity.device ||
    report.identity.inode !== authority.workspace.identity.inode ||
    report.securityDigest !== authority.workspace.securityDigest
  ) {
    return { status: "invalid", reason: "authority_workspace_stale" }
  }

  const hasGitMetadata = report.surfaces.some((surface) => surface.kind === "git_metadata")
  if (authority.mode === "activate-once" && hasGitMetadata && !authority.repositoryBaseline) {
    return { status: "invalid", reason: "authority_git_baseline_missing" }
  }
  if (authority.repositoryBaseline) {
    const current = await revalidateGitRepositoryBaseline(report.root, authority.repositoryBaseline)
    if (
      current.status !== "current" ||
      current.expectedSnapshotDigest !== authority.repositoryBaseline.snapshotDigest ||
      current.currentSnapshotDigest !== authority.repositoryBaseline.snapshotDigest
    ) {
      return { status: "invalid", reason: "authority_git_baseline_stale" }
    }
  }

  return { status: "valid", authority, report }
}

function ownedPrivately(uid: number, mode: number) {
  const currentUID = typeof process.getuid === "function" ? process.getuid() : undefined
  return currentUID !== undefined && uid === currentUID && (mode & 0o077) === 0
}

function sameDigest(actual: string, expected: string) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
