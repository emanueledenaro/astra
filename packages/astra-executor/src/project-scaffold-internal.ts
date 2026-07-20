import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { dlopen, ptr } from "bun:ffi"
import {
  makeProjectCreationPreview,
  parseProjectCreationDraft,
  parseProjectCreationPreview,
  parseProjectParentAuthority,
} from "@astra/domain/project-creation-control"
import type {
  ProjectScaffoldClaimProposal,
  ProjectScaffoldExecutionResult,
  ProjectScaffoldInput,
} from "./project-scaffold"

const renameExclusive = 0x00000004

export type ProjectScaffoldInternalDependencies = Readonly<{
  beforePublish?: () => Promise<void>
  cleanupStaging?: (path: string) => Promise<void>
}>

export async function executeProjectScaffoldInternal(
  input: ProjectScaffoldInput,
  claimProposal: ProjectScaffoldClaimProposal,
  dependencies: ProjectScaffoldInternalDependencies = {},
): Promise<ProjectScaffoldExecutionResult> {
  const binding = requireBinding(input)
  const claim = await claimProposal({
    proposalDigest: binding.preview.proposalDigest,
    authorityDigest: binding.authority.observationDigest,
    targetPath: binding.authority.targetPath,
  })
  if (claim !== "claimed") return noEffect(binding.preview.proposalDigest, `durable_claim_${claim}`)
  if (!(await parentAndTargetStillAuthorised(binding))) {
    return noEffect(binding.preview.proposalDigest, "parent_or_target_changed_before_staging")
  }

  let staging: string | null = null
  let stagingIdentity: Readonly<{ device: string; inode: string }> | null = null
  let published = false
  try {
    staging = await mkdtemp(join(binding.authority.parentPath, ".astra-scaffold-"))
    const stagingFacts = await lstat(staging)
    stagingIdentity = { device: String(stagingFacts.dev), inode: String(stagingFacts.ino) }
    if (
      dirname(staging) !== binding.authority.parentPath ||
      !stagingFacts.isDirectory() ||
      stagingFacts.isSymbolicLink() ||
      String(stagingFacts.dev) !== binding.authority.parentIdentity.device
    ) {
      throw new TypeError("The private scaffold staging directory is not bound to the authorised parent")
    }

    const directories = new Set<string>([staging])
    for (const file of binding.draft.files) {
      const segments = file.path.split("/")
      let current = staging
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment)
        if (directories.has(current)) continue
        await mkdir(current, { mode: 0o700 })
        const facts = await lstat(current)
        if (!facts.isDirectory() || facts.isSymbolicLink()) throw new TypeError("Unsafe scaffold directory")
        directories.add(current)
      }
      const target = join(staging, file.path)
      const handle = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(Buffer.from(file.content, "utf8"))
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    await syncDirectories([...directories].sort((left, right) => right.length - left.length))
    await dependencies.beforePublish?.()
    if (!(await parentAndTargetStillAuthorised(binding))) {
      const removed = await proveStagingRemoved(binding, staging, stagingIdentity, dependencies)
      staging = null
      return removed
        ? noEffect(binding.preview.proposalDigest, "parent_or_target_changed_before_publish")
        : unknown(binding.preview.proposalDigest, "staging_cleanup_unproved")
    }
    if (!publishExclusive(staging, binding.authority.targetPath)) {
      const removed = await proveStagingRemoved(binding, staging, stagingIdentity, dependencies)
      staging = null
      return removed
        ? noEffect(binding.preview.proposalDigest, "exclusive_publish_rejected")
        : unknown(binding.preview.proposalDigest, "staging_cleanup_unproved")
    }
    published = true
    staging = null
    await syncDirectories([binding.authority.parentPath])
    const target = await lstat(binding.authority.targetPath)
    if (!target.isDirectory() || target.isSymbolicLink()) {
      return unknown(binding.preview.proposalDigest, "published_target_identity_unavailable")
    }
    return Object.freeze({
      status: "effect_observed",
      observationDigest: digest("astra.project-scaffold.observed.v1", {
        proposalDigest: binding.preview.proposalDigest,
        targetIdentity: { device: String(target.dev), inode: String(target.ino) },
      }),
      targetIdentity: Object.freeze({ device: String(target.dev), inode: String(target.ino) }),
    })
  } catch (cause) {
    if (published) return unknown(binding.preview.proposalDigest, errorName(cause))
    const removed = staging
      ? await proveStagingRemoved(binding, staging, stagingIdentity, dependencies)
      : await parentAndTargetStillAuthorised(binding)
    return removed && (await parentAndTargetStillAuthorised(binding))
      ? noEffect(binding.preview.proposalDigest, errorName(cause))
      : unknown(binding.preview.proposalDigest, errorName(cause))
  }
}

function requireBinding(input: ProjectScaffoldInput) {
  const authority = parseProjectParentAuthority(input.authority)
  if (!authority.ok) throw new TypeError(`Invalid project authority: ${authority.reason}`)
  const draft = parseProjectCreationDraft(input.draft)
  if (!draft.ok) throw new TypeError(`Invalid project draft: ${draft.reason}`)
  const preview = parseProjectCreationPreview(input.preview)
  if (!preview.ok) throw new TypeError(`Invalid project preview: ${preview.reason}`)
  const expected = makeProjectCreationPreview(
    authority.value,
    draft.value,
    preview.value.createdAt,
    preview.value.nonce,
    preview.value.expiresAt,
  )
  if (JSON.stringify(expected) !== JSON.stringify(preview.value)) {
    throw new TypeError("The project scaffold does not match the approved preview")
  }
  return Object.freeze({ authority: authority.value, draft: draft.value, preview: preview.value })
}

async function parentAndTargetStillAuthorised(input: ReturnType<typeof requireBinding>) {
  const parent = await lstat(input.authority.parentPath).catch(() => null)
  if (
    !parent?.isDirectory() ||
    parent.isSymbolicLink() ||
    String(parent.dev) !== input.authority.parentIdentity.device ||
    String(parent.ino) !== input.authority.parentIdentity.inode ||
    (await realpath(input.authority.parentPath).catch(() => null)) !== input.authority.parentPath
  ) {
    return false
  }
  return (await lstat(input.authority.targetPath).catch((cause) => (isNodeError(cause, "ENOENT") ? null : false))) === null
}

function publishExclusive(source: string, target: string) {
  if (process.platform !== "darwin") throw new TypeError("Exclusive scaffold publication requires macOS")
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    renamex_np: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  })
  try {
    const sourceBytes = Buffer.from(`${source}\0`)
    const targetBytes = Buffer.from(`${target}\0`)
    return library.symbols.renamex_np(ptr(sourceBytes), ptr(targetBytes), renameExclusive) === 0
  } finally {
    library.close()
  }
}

async function syncDirectories(paths: ReadonlyArray<string>) {
  for (const path of paths) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

async function cleanupStaging(path: string) {
  if (!path.includes("/.astra-scaffold-")) throw new TypeError("Refusing to clean a non-scaffold path")
  await rm(path, { recursive: true, force: false })
}

async function proveStagingRemoved(
  binding: ReturnType<typeof requireBinding>,
  path: string,
  identity: Readonly<{ device: string; inode: string }> | null,
  dependencies: ProjectScaffoldInternalDependencies,
) {
  if (!identity) return false
  const before = await lstat(path).catch(() => null)
  if (!before || String(before.dev) !== identity.device || String(before.ino) !== identity.inode) return false
  await (dependencies.cleanupStaging ?? cleanupStaging)(path).catch(() => {})
  const parent = await lstat(binding.authority.parentPath).catch(() => null)
  if (
    !parent?.isDirectory() ||
    parent.isSymbolicLink() ||
    String(parent.dev) !== binding.authority.parentIdentity.device ||
    String(parent.ino) !== binding.authority.parentIdentity.inode ||
    (await realpath(binding.authority.parentPath).catch(() => null)) !== binding.authority.parentPath
  ) {
    return false
  }
  return (await lstat(path).catch((cause) => (isNodeError(cause, "ENOENT") ? null : false))) === null
}

function noEffect(proposalDigest: string, reason: string): ProjectScaffoldExecutionResult {
  return Object.freeze({
    status: "failed_without_effect",
    reason,
    proofDigest: digest("astra.project-scaffold.no-effect.v1", { proposalDigest, reason }),
  })
}

function unknown(proposalDigest: string, reason: string): ProjectScaffoldExecutionResult {
  return Object.freeze({
    status: "effect_unknown",
    reason,
    observationDigest: digest("astra.project-scaffold.unknown.v1", { proposalDigest, reason }),
  })
}

function digest(domain: string, input: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${domain}\0${JSON.stringify(input)}`).digest("hex")}`
}

function errorName(cause: unknown) {
  return cause instanceof Error && cause.message.length > 0 ? cause.message.slice(0, 256) : "scaffold_adapter_failed"
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}
