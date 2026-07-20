import type { Stats } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import {
  parseProjectCreationTargetName,
  parseProjectParentAuthority,
  projectCreationLimits,
  sealProjectParentAuthority,
  type ProjectParentAuthority,
} from "@astra/domain/project-creation-control"

export type ProjectParentAuthorityBlockReason =
  | "parent_path_not_absolute"
  | "target_name_invalid"
  | "observed_at_invalid"
  | "parent_unreadable"
  | "parent_is_symlink"
  | "parent_not_directory"
  | "parent_not_canonical"
  | "parent_identity_changed"
  | "target_already_exists"
  | "target_unreadable"
  | "target_appeared"
  | "target_mismatch"
  | "authority_invalid"

export type ProjectParentAuthorityCaptureResult =
  | Readonly<{ status: "complete"; authority: ProjectParentAuthority }>
  | Readonly<{ status: "blocked"; reason: ProjectParentAuthorityBlockReason }>

export type ProjectParentAuthorityRevalidationResult =
  | Readonly<{ status: "current"; authority: ProjectParentAuthority }>
  | Readonly<{ status: "blocked"; reason: ProjectParentAuthorityBlockReason }>

type ProjectParentAuthorityFilesystem = Readonly<{
  lstat(path: string): Promise<Stats>
  realpath(path: string): Promise<string>
}>

const defaultFilesystem: ProjectParentAuthorityFilesystem = Object.freeze({
  lstat: (path: string) => lstat(path),
  realpath: (path: string) => realpath(path),
})

/** Captures only parent identity, canonicality, and direct-child absence through lstat and realpath. */
export async function captureProjectParentAuthority(
  parentPath: string,
  targetName: string,
  observedAt = new Date().toISOString(),
  filesystem: ProjectParentAuthorityFilesystem = defaultFilesystem,
): Promise<ProjectParentAuthorityCaptureResult> {
  if (!isAbsolute(parentPath)) return blocked("parent_path_not_absolute")
  const parsedName = parseProjectCreationTargetName(targetName)
  if (!parsedName.ok) return blocked("target_name_invalid")

  const firstParent = await inspectParent(parentPath, filesystem)
  if (!firstParent.ok) return blocked(firstParent.reason)
  const canonicalParent = await safeRealpath(parentPath, filesystem)
  if (!canonicalParent || canonicalParent !== parentPath) return blocked("parent_not_canonical")
  const targetPath = join(parentPath, parsedName.value)
  const firstTarget = await inspectTarget(targetPath, filesystem)
  if (firstTarget === "present") return blocked("target_already_exists")
  if (firstTarget === "unreadable") return blocked("target_unreadable")

  const finalParent = await inspectParent(parentPath, filesystem)
  if (!finalParent.ok || !sameIdentity(firstParent.facts, finalParent.facts)) {
    return blocked("parent_identity_changed")
  }
  if ((await safeRealpath(parentPath, filesystem)) !== parentPath) return blocked("parent_identity_changed")
  const finalTarget = await inspectTarget(targetPath, filesystem)
  if (finalTarget === "present") return blocked("target_already_exists")
  if (finalTarget === "unreadable") return blocked("target_unreadable")
  const sealedParent = await inspectParent(parentPath, filesystem)
  if (!sealedParent.ok || !sameIdentity(firstParent.facts, sealedParent.facts)) {
    return blocked("parent_identity_changed")
  }
  if ((await safeRealpath(parentPath, filesystem)) !== parentPath) return blocked("parent_identity_changed")

  const authority = sealProjectParentAuthority({
    schemaVersion: 1,
    parentPath,
    parentIdentity: identity(firstParent.facts),
    targetPath,
    targetName: parsedName.value,
    targetState: "absent",
    observedAt,
    limits: projectCreationLimits,
  })
  if (!authority.ok) {
    return blocked(authority.reason === "observed_at_invalid" ? "observed_at_invalid" : "authority_invalid")
  }
  return Object.freeze({ status: "complete", authority: authority.value })
}

/** Repeats the same read-only facts and fails closed when the parent or target changed. */
export async function revalidateProjectParentAuthority(
  input: unknown,
  filesystem: ProjectParentAuthorityFilesystem = defaultFilesystem,
): Promise<ProjectParentAuthorityRevalidationResult> {
  const parsed = parseProjectParentAuthority(input)
  if (!parsed.ok) return blocked(parsed.reason === "target_path_mismatch" ? "target_mismatch" : "authority_invalid")
  const authority = parsed.value
  if (join(authority.parentPath, authority.targetName) !== authority.targetPath) return blocked("target_mismatch")

  const firstParent = await inspectParent(authority.parentPath, filesystem)
  if (!firstParent.ok) return blocked(firstParent.reason)
  if (!sameAuthorityIdentity(firstParent.facts, authority)) return blocked("parent_identity_changed")
  if ((await safeRealpath(authority.parentPath, filesystem)) !== authority.parentPath) {
    return blocked("parent_not_canonical")
  }
  const firstTarget = await inspectTarget(authority.targetPath, filesystem)
  if (firstTarget === "present") return blocked("target_appeared")
  if (firstTarget === "unreadable") return blocked("target_unreadable")

  const finalParent = await inspectParent(authority.parentPath, filesystem)
  if (
    !finalParent.ok ||
    !sameIdentity(firstParent.facts, finalParent.facts) ||
    !sameAuthorityIdentity(finalParent.facts, authority)
  ) {
    return blocked("parent_identity_changed")
  }
  if ((await safeRealpath(authority.parentPath, filesystem)) !== authority.parentPath) {
    return blocked("parent_identity_changed")
  }
  const finalTarget = await inspectTarget(authority.targetPath, filesystem)
  if (finalTarget === "present") return blocked("target_appeared")
  if (finalTarget === "unreadable") return blocked("target_unreadable")
  const sealedParent = await inspectParent(authority.parentPath, filesystem)
  if (
    !sealedParent.ok ||
    !sameIdentity(firstParent.facts, sealedParent.facts) ||
    !sameAuthorityIdentity(sealedParent.facts, authority)
  ) {
    return blocked("parent_identity_changed")
  }
  if ((await safeRealpath(authority.parentPath, filesystem)) !== authority.parentPath) {
    return blocked("parent_identity_changed")
  }
  return Object.freeze({ status: "current", authority })
}

async function inspectParent(
  path: string,
  filesystem: ProjectParentAuthorityFilesystem,
): Promise<
  | Readonly<{ ok: true; facts: Stats }>
  | Readonly<{ ok: false; reason: "parent_unreadable" | "parent_is_symlink" | "parent_not_directory" }>
> {
  const facts = await safeLstat(path, filesystem)
  if (!facts) return { ok: false, reason: "parent_unreadable" }
  if (facts.isSymbolicLink()) return { ok: false, reason: "parent_is_symlink" }
  if (!facts.isDirectory()) return { ok: false, reason: "parent_not_directory" }
  return { ok: true, facts }
}

async function inspectTarget(
  path: string,
  filesystem: ProjectParentAuthorityFilesystem,
): Promise<"absent" | "present" | "unreadable"> {
  try {
    await filesystem.lstat(path)
    return "present"
  } catch (cause) {
    return errorCode(cause) === "ENOENT" ? "absent" : "unreadable"
  }
}

async function safeLstat(path: string, filesystem: ProjectParentAuthorityFilesystem) {
  return filesystem.lstat(path).catch(() => null)
}

async function safeRealpath(path: string, filesystem: ProjectParentAuthorityFilesystem) {
  return filesystem.realpath(path).catch(() => null)
}

function identity(facts: Stats) {
  return Object.freeze({ device: String(facts.dev), inode: String(facts.ino) })
}

function sameIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameAuthorityIdentity(facts: Stats, authority: ProjectParentAuthority) {
  return String(facts.dev) === authority.parentIdentity.device && String(facts.ino) === authority.parentIdentity.inode
}

function errorCode(input: unknown) {
  if (typeof input !== "object" || input === null) return null
  const descriptor = Object.getOwnPropertyDescriptor(input, "code")
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : null
}

function blocked(reason: ProjectParentAuthorityBlockReason) {
  return Object.freeze({ status: "blocked", reason })
}
