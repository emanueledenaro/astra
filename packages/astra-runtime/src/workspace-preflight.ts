import type {
  WorkspaceIdentity,
  WorkspacePreflightLimits,
  WorkspaceRiskSurface,
  WorkspaceTrustReport,
} from "@astra/domain/workspace-trust"
import { createHash } from "node:crypto"
import { lstat, open, opendir, readlink } from "node:fs/promises"
import { join, resolve } from "node:path"

export const defaultWorkspacePreflightLimits = {
  maxEntries: 128,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxDurationMs: 1_000,
} as const satisfies WorkspacePreflightLimits

const digestedFiles = new Set([
  ".env",
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
      reason: "identity_changed" | "security_digest_changed" | "preflight_blocked"
      report: WorkspaceTrustReport
    }>

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

  const names = await listRootNames(root, limits.maxEntries)
  if (!names.complete) {
    return blockedReport(root, limits, names.reason, rootFacts.identity, names.names.length)
  }

  const hash = createHash("sha256")
  hash.update("astra.workspace-security.v1\0")
  hash.update(rootFacts.identity.device + "\0" + rootFacts.identity.inode + "\0")

  const surfaces: Array<WorkspaceRiskSurface> = []
  const blockers: Array<string> = []
  let scannedBytes = 0

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

    const risk = classifyRiskSurface(name, facts.isSymbolicLink())
    if (risk) surfaces.push({ kind: risk, path: name })

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

async function digestBoundedFile(path: string, expectedDevice: number, expectedInode: number, maxBytes: number) {
  if (maxBytes <= 0) return { complete: false, reason: "total_byte_limit_exceeded" } as const

  const handle = await open(path, "r").catch(() => null)
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

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity) {
  return left.device === right.device && left.inode === right.inode
}

function shouldDigest(name: string) {
  return digestedFiles.has(name) || name.startsWith(".env.")
}

function classifyRiskSurface(name: string, symbolicLink: boolean): string | null {
  if (symbolicLink) return "symbolic_link"
  if (name === ".git") return "git_metadata"
  if (name === ".gitmodules") return "git_external_reference"
  if (name === ".opencode" || name === "opencode.json" || name === "opencode.jsonc") {
    return "opencode_configuration"
  }
  if (name === ".mcp.json") return "mcp_configuration"
  if (name === "package.json" || name === "bunfig.toml" || name === ".npmrc") return "package_configuration"
  if (name === "AGENTS.md") return "repository_instructions"
  if (name === "SKILL.md") return "skill_instructions"
  if (name === ".vscode" || name === ".idea") return "editor_configuration"
  if (name === ".env" || name.startsWith(".env.")) return "environment_file"
  if (name === ".envrc" || name === "Makefile" || name === "mise.toml") return "host_execution_configuration"
  return null
}

function entryKind(facts: Awaited<ReturnType<typeof lstat>>) {
  if (facts.isSymbolicLink()) return "link"
  if (facts.isDirectory()) return "directory"
  if (facts.isFile()) return "file"
  return "other"
}

function compareBytes(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function validLimits(limits: WorkspacePreflightLimits) {
  return [limits.maxEntries, limits.maxFileBytes, limits.maxTotalBytes, limits.maxDurationMs].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  )
}
