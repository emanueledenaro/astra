import type {
  WorkspaceIdentity,
  WorkspacePreflightLimits,
  WorkspaceRiskSurface,
  WorkspaceTrustReport,
} from "@astra/domain/workspace-trust"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

export const defaultWorkspacePreflightLimits = {
  maxEntries: 128,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxDurationMs: 1_000,
} as const satisfies WorkspacePreflightLimits

const digestedFiles = new Set([
  ".env",
  ".git",
  ".gitmodules",
  ".mcp.json",
  ".npmrc",
  "AGENTS.md",
  "SKILL.md",
  "bunfig.toml",
  "opencode.json",
  "opencode.jsonc",
  "package.json",
])

export type WorkspaceRevalidation =
  | Readonly<{ matched: true; report: WorkspaceTrustReport }>
  | Readonly<{
      matched: false
      reason: "identity_changed" | "security_digest_changed" | "preflight_blocked" | "git_baseline_not_inspected"
      report: WorkspaceTrustReport
    }>

export type WorkspaceActivationCheck =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: "preflight_incomplete" | "git_baseline_not_inspected" }>

/**
 * Opens an untrusted workspace through bounded metadata reads only.
 *
 * This module is intentionally a separate composition root. Do not add normal
 * OpenCode bootstrap, process, network, Git, provider, extension, or mutation
 * dependencies here.
 */
export async function scanWorkspace(
  workspace: string,
  overrides: Partial<WorkspacePreflightLimits> = {},
): Promise<WorkspaceTrustReport> {
  const limits = { ...defaultWorkspacePreflightLimits, ...overrides }
  const root = resolve(workspace)
  if (!validLimits(limits)) return blockedReport(root, limits, "invalid_limits")
  const startedAt = performance.now()
  const rootFacts = await inspectRoot(root)
  if (!rootFacts.ok) return blockedReport(root, limits, rootFacts.reason)
  const physicalRoot = await safeRealpath(root)
  if (!physicalRoot) return blockedReport(root, limits, "workspace_physical_path_unreadable", rootFacts.identity)

  const names = await listRootNames(root, limits.maxEntries)
  if (!names.complete) {
    return blockedReport(root, limits, names.reason, rootFacts.identity, names.names.length)
  }

  const hash = createHash("sha256")
  hash.update("astra.workspace-security.v1\0")
  hash.update(rootFacts.identity.device + "\0" + rootFacts.identity.inode + "\0")
  hash.update(`physical-root\0${physicalRoot}\0`)

  const surfaces: Array<WorkspaceRiskSurface> = []
  const blockers: Array<string> = []
  let scannedBytes = 0

  const ancestorGit = await inspectAncestorGitMetadata(physicalRoot, startedAt, limits.maxDurationMs)
  if (!ancestorGit.complete) blockers.push(ancestorGit.reason)
  if (ancestorGit.complete && ancestorGit.surface) {
    surfaces.push(ancestorGit.surface)
    hash.update(`ancestor-git\0${ancestorGit.fingerprint}\0`)
  }

  for (const name of names.names.sort(compareBytes)) {
    if (performance.now() - startedAt > limits.maxDurationMs) {
      blockers.push("time_limit_exceeded")
      break
    }

    const path = join(root, name)
    const facts = await safeLstat(path)
    if (!facts) {
      blockers.push(`entry_unreadable:${name}`)
      break
    }

    const kind = entryKind(facts)
    hash.update(`${name}\0${kind}\0${facts.mode}\0${facts.size}\0${facts.mtimeMs}\0`)

    const risk = classifyRiskSurface(name, kind)
    if (risk) surfaces.push({ kind: risk, path: name, entryKind: kind })

    if (facts.isSymbolicLink()) {
      const target = await safeReadlink(path)
      if (target === null) blockers.push(`link_unreadable:${name}`)
      if (target !== null) hash.update(`link\0${target}\0`)
      continue
    }

    if (!facts.isFile() || !shouldDigest(name)) continue
    const remaining = limits.maxTotalBytes - scannedBytes
    const file = await digestBoundedFile(path, facts.dev, facts.ino, Math.min(limits.maxFileBytes, remaining))
    if (!file.complete) {
      blockers.push(`${file.reason}:${name}`)
      break
    }
    scannedBytes += file.bytes
    hash.update(`file\0${file.digest}\0${file.bytes}\0`)
  }

  const finalRoot = await inspectRoot(root)
  if (!finalRoot.ok || !sameIdentity(rootFacts.identity, finalRoot.identity)) blockers.push("root_identity_changed")
  const finalPhysicalRoot = await safeRealpath(root)
  if (finalPhysicalRoot !== physicalRoot) blockers.push("workspace_physical_path_changed")

  if (blockers.length > 0) {
    return {
      root,
      identity: rootFacts.identity,
      securityDigest: null,
      completeness: "incomplete",
      state: "preflight_blocked",
      surfaces,
      blockers,
      scannedEntries: names.names.length,
      scannedBytes,
      limits,
    }
  }

  return {
    root,
    identity: rootFacts.identity,
    securityDigest: `sha256:${hash.digest("hex")}`,
    completeness: "complete",
    state: "awaiting_decision",
    surfaces,
    blockers: [],
    scannedEntries: names.names.length,
    scannedBytes,
    limits,
  }
}

export async function revalidateWorkspaceSnapshot(report: WorkspaceTrustReport): Promise<WorkspaceRevalidation> {
  const current = await revalidateWorkspacePreflight(report)
  if (!current.matched) return current
  const activation = checkWorkspaceActivation(current.report)
  if (!activation.allowed) {
    const reason = activation.reason === "preflight_incomplete" ? "preflight_blocked" : activation.reason
    return { matched: false, reason, report: current.report }
  }
  return current
}

/** Revalidates bounded static facts without granting workspace activation. */
export async function revalidateWorkspacePreflight(report: WorkspaceTrustReport): Promise<WorkspaceRevalidation> {
  const current = await scanWorkspace(report.root, report.limits)
  if (current.completeness !== "complete" || !current.identity || !current.securityDigest) {
    return { matched: false, reason: "preflight_blocked", report: current }
  }
  if (!report.identity || !sameIdentity(report.identity, current.identity)) {
    return { matched: false, reason: "identity_changed", report: current }
  }
  if (report.securityDigest !== current.securityDigest) {
    return { matched: false, reason: "security_digest_changed", report: current }
  }
  return { matched: true, report: current }
}

/**
 * Separates a useful static report from authority to activate the workspace.
 * Git workspaces remain readable but cannot activate until a real baseline is
 * inspected by a later Git-aware increment.
 */
export function checkWorkspaceActivation(report: WorkspaceTrustReport): WorkspaceActivationCheck {
  if (report.completeness !== "complete" || !report.identity || !report.securityDigest) {
    return { allowed: false, reason: "preflight_incomplete" }
  }
  if (report.surfaces.some((surface) => surface.kind === "git_metadata")) {
    return { allowed: false, reason: "git_baseline_not_inspected" }
  }
  return { allowed: true }
}

function blockedReport(
  root: string,
  limits: WorkspacePreflightLimits,
  blocker: string,
  identity: WorkspaceIdentity | null = null,
  scannedEntries = 0,
): WorkspaceTrustReport {
  return {
    root,
    identity,
    securityDigest: null,
    completeness: "incomplete",
    state: "preflight_blocked",
    surfaces: [],
    blockers: [blocker],
    scannedEntries,
    scannedBytes: 0,
    limits,
  }
}

async function inspectRoot(root: string) {
  const facts = await safeLstat(root)
  if (!facts) return { ok: false, reason: "workspace_unreadable" } as const
  if (facts.isSymbolicLink()) return { ok: false, reason: "workspace_root_is_link" } as const
  if (!facts.isDirectory()) return { ok: false, reason: "workspace_root_not_directory" } as const
  return {
    ok: true,
    identity: { device: String(facts.dev), inode: String(facts.ino) },
  } as const
}

async function listRootNames(root: string, maxEntries: number) {
  const names: Array<string> = []
  try {
    const directory = await opendir(root)
    for await (const entry of directory) {
      if (names.length === maxEntries) return { complete: false, names, reason: "entry_limit_exceeded" } as const
      names.push(entry.name)
    }
    return { complete: true, names } as const
  } catch {
    return { complete: false, names, reason: "workspace_inventory_unreadable" } as const
  }
}

async function inspectAncestorGitMetadata(root: string, startedAt: number, maxDurationMs: number) {
  const firstParent = dirname(root)
  if (firstParent === root) return { complete: true, surface: null } as const

  let current = firstParent
  while (true) {
    if (performance.now() - startedAt > maxDurationMs) {
      return { complete: false, reason: "ancestor_git_scan_time_limit_exceeded" } as const
    }

    const marker = join(current, ".git")
    const result = await inspectOptionalPath(marker)
    if (result.state === "unreadable") {
      return { complete: false, reason: "ancestor_git_metadata_unreadable" } as const
    }
    if (result.state === "present") {
      const kind = entryKind(result.facts)
      return {
        complete: true,
        surface: {
          kind: "git_metadata",
          path: relative(root, marker),
          entryKind: kind,
        } satisfies WorkspaceRiskSurface,
        fingerprint: [
          relative(root, marker),
          kind,
          result.facts.dev,
          result.facts.ino,
          result.facts.mode,
          result.facts.size,
          result.facts.mtimeMs,
        ].join("\0"),
      } as const
    }

    const parent = dirname(current)
    if (parent === current) return { complete: true, surface: null } as const
    current = parent
  }
}

async function inspectOptionalPath(path: string) {
  try {
    return { state: "present", facts: await lstat(path) } as const
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent" } as const
    return { state: "unreadable" } as const
  }
}

async function digestBoundedFile(path: string, expectedDevice: number, expectedInode: number, maxBytes: number) {
  if (maxBytes <= 0) return { complete: false, reason: "total_byte_limit_exceeded" } as const

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return { complete: false, reason: "file_unreadable" } as const
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== expectedDevice || before.ino !== expectedInode) {
      return { complete: false, reason: "file_identity_changed" } as const
    }
    if (before.size > maxBytes) return { complete: false, reason: "file_byte_limit_exceeded" } as const

    const bytes = new Uint8Array(maxBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }

    const after = await handle.stat()
    if (offset > maxBytes) return { complete: false, reason: "file_byte_limit_exceeded" } as const
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || offset !== before.size) {
      return { complete: false, reason: "file_changed_during_read" } as const
    }

    return {
      complete: true,
      bytes: offset,
      digest: createHash("sha256").update(bytes.subarray(0, offset)).digest("hex"),
    } as const
  } catch {
    return { complete: false, reason: "file_read_failed" } as const
  } finally {
    await handle.close()
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function safeReadlink(path: string) {
  try {
    return await readlink(path)
  } catch {
    return null
  }
}

async function safeRealpath(path: string) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity) {
  return left.device === right.device && left.inode === right.inode
}

function shouldDigest(name: string) {
  const normalized = name.toLowerCase()
  return digestedFiles.has(normalized) || normalized.startsWith(".env.")
}

function classifyRiskSurface(name: string, kind: WorkspaceRiskSurface["entryKind"]): string | null {
  const normalized = name.toLowerCase()
  if (normalized === ".git") return "git_metadata"
  if (kind === "symlink") return "symbolic_link"
  if (normalized === ".gitmodules") return "git_external_reference"
  if (normalized === ".opencode" || normalized === "opencode.json" || normalized === "opencode.jsonc") {
    return "opencode_configuration"
  }
  if (normalized === ".mcp.json") return "mcp_configuration"
  if (normalized === "package.json" || normalized === "bunfig.toml" || normalized === ".npmrc") {
    return "package_configuration"
  }
  if (normalized === "agents.md") return "repository_instructions"
  if (normalized === "skill.md") return "skill_instructions"
  if (normalized === ".vscode" || normalized === ".idea") return "editor_configuration"
  if (normalized === ".env" || normalized.startsWith(".env.")) return "environment_file"
  if (normalized === ".envrc" || normalized === "makefile" || normalized === "mise.toml") {
    return "host_execution_configuration"
  }
  return null
}

function entryKind(facts: Awaited<ReturnType<typeof lstat>>) {
  if (facts.isSymbolicLink()) return "symlink"
  if (facts.isDirectory()) return "directory"
  if (facts.isFile()) return "file"
  return "other"
}

function compareBytes(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

function validLimits(limits: WorkspacePreflightLimits) {
  return [limits.maxEntries, limits.maxFileBytes, limits.maxTotalBytes, limits.maxDurationMs].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  )
}
