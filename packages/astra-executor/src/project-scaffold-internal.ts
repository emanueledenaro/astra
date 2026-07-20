import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dlopen, ptr, toArrayBuffer } from "bun:ffi"
import {
  makeProjectCreationPreview,
  parseProjectCreationDraft,
  parseProjectCreationPreview,
  parseProjectParentAuthority,
  type ProjectCreationDraft,
  type ProjectCreationPreview,
  type ProjectParentAuthority,
} from "@astra/domain/project-creation-control"

const renameExclusive = 0x00000004
const removeDirectory = 0x00000080
const noEntry = 2
const symbolicLinkLoop = 62
const maximumCleanupEntries = 1_024

export type ProjectScaffoldInput = Readonly<{
  authority: ProjectParentAuthority
  draft: ProjectCreationDraft
  preview: ProjectCreationPreview
}>

export type ProjectScaffoldDurableClaim = Readonly<{
  proposalDigest: string
  authorityDigest: string
  targetPath: string
}>

export type ProjectScaffoldClaimResult = "claimed" | "already_claimed" | "unavailable"

export type ProjectScaffoldExecutionResult =
  | Readonly<{
      status: "effect_observed"
      observationDigest: `sha256:${string}`
      targetIdentity: Readonly<{ device: string; inode: string }>
    }>
  | Readonly<{
      status: "failed_without_effect"
      reason: string
      proofDigest: `sha256:${string}`
    }>
  | Readonly<{
      status: "effect_unknown"
      reason: string
      observationDigest: `sha256:${string}`
    }>

export type ProjectScaffoldClaimProposal = (
  claim: ProjectScaffoldDurableClaim,
) => Promise<ProjectScaffoldClaimResult>

export type ProjectScaffoldInternalDependencies = Readonly<{
  afterParentPinned?: () => Promise<void>
  afterStagingCreatedBeforeOpen?: (context: Readonly<{ stagingName: string }>) => Promise<void>
  beforePublish?: (context: Readonly<{ stagingName: string }>) => Promise<void>
  stagingName?: string
}>

/** Internal effect seam. Only the durable runtime coordinator may bind its claim callback. */
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

  const library = openScaffoldLibrary()
  const parent = await open(
    binding.authority.parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => null)
  if (!parent) {
    library.close()
    return noEffect(binding.preview.proposalDigest, "authorised_parent_handle_unavailable")
  }

  let stagingName: string | null = null
  let stagingFD = -1
  let stagingIdentity: Readonly<{ device: string; inode: string }> | null = null
  let published = false
  try {
    if (!(await parentAndTargetStillAuthorised(parent, binding, library))) {
      return noEffect(binding.preview.proposalDigest, "parent_or_target_changed_before_staging")
    }
    await dependencies.afterParentPinned?.()
    if (!(await parentAndTargetStillAuthorised(parent, binding, library))) {
      return noEffect(binding.preview.proposalDigest, "parent_or_target_changed_before_staging")
    }

    const createdStaging = await createStagingDirectory(
      parent.fd,
      library,
      dependencies.stagingName,
      (createdName) => {
        stagingName = createdName
      },
    )
    stagingName = createdStaging.name
    stagingIdentity = createdStaging.identity
    await dependencies.afterStagingCreatedBeforeOpen?.({ stagingName })
    stagingFD = openDirectoryAt(parent.fd, stagingName, library)
    if (stagingFD < 0) throw new TypeError("The private scaffold staging directory could not be pinned")
    const stagingFacts = await Bun.file(stagingFD).stat()
    if (
      !stagingFacts.isDirectory() ||
      String(stagingFacts.dev) !== binding.authority.parentIdentity.device ||
      String(stagingFacts.dev) !== stagingIdentity.device ||
      String(stagingFacts.ino) !== stagingIdentity.inode
    ) {
      throw new TypeError("The private scaffold staging directory is not bound to the authorised parent")
    }

    await createBoundedFiles(stagingFD, binding.draft, library)
    await dependencies.beforePublish?.({ stagingName })
    if (!(await parentAndTargetStillAuthorised(parent, binding, library))) {
      const removed = await proveStagingRemoved(parent, binding, stagingName, stagingIdentity, library)
      stagingName = null
      return removed
        ? noEffect(binding.preview.proposalDigest, "parent_or_target_changed_before_publish")
        : unknown(binding.preview.proposalDigest, "staging_cleanup_unproved")
    }
    if (!publishExclusiveAt(parent.fd, stagingName, binding.authority.targetName, library)) {
      const removed = await proveStagingRemoved(parent, binding, stagingName, stagingIdentity, library)
      stagingName = null
      return removed
        ? noEffect(binding.preview.proposalDigest, "exclusive_publish_rejected")
        : unknown(binding.preview.proposalDigest, "staging_cleanup_unproved")
    }
    published = true
    stagingName = null
    syncDescriptor(parent.fd, library)
    const targetFD = openDirectoryAt(parent.fd, binding.authority.targetName, library)
    if (targetFD < 0) return unknown(binding.preview.proposalDigest, "published_target_identity_unavailable")
    try {
      const target = await Bun.file(targetFD).stat()
      if (!target.isDirectory()) {
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
    } finally {
      library.symbols.close(targetFD)
    }
  } catch (cause) {
    if (published) return unknown(binding.preview.proposalDigest, errorName(cause))
    const removed = stagingName
      ? await proveStagingRemoved(parent, binding, stagingName, stagingIdentity, library)
      : await parentAndTargetStillAuthorised(parent, binding, library)
    return removed && (await parentHandleStillAuthorised(parent, binding))
      ? noEffect(binding.preview.proposalDigest, errorName(cause))
      : unknown(binding.preview.proposalDigest, errorName(cause))
  } finally {
    if (stagingFD >= 0) library.symbols.close(stagingFD)
    await parent.close().catch(() => {})
    library.close()
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

async function createStagingDirectory(
  parentFD: number,
  library: ReturnType<typeof openScaffoldLibrary>,
  fixedName?: string,
  recordCreated: (name: string) => void = () => {},
) {
  const candidates = fixedName
    ? [fixedName]
    : Array.from({ length: 8 }, () => `.astra-scaffold-${randomBytes(16).toString("hex")}`)
  for (const name of candidates) {
    if (!/^\.astra-scaffold-[0-9a-f]{32}$/.test(name)) throw new TypeError("Invalid internal staging name")
    if (library.symbols.mkdirat(parentFD, cString(name), 0o700) === 0) {
      recordCreated(name)
      return { name, identity: identityAt(parentFD, name, library) }
    }
    if (lastErrno(library) !== 17) throw new TypeError("The private scaffold staging directory could not be created")
  }
  throw new TypeError("No private scaffold staging name is available")
}

function identityAt(parentFD: number, name: string, library: ReturnType<typeof openScaffoldLibrary>) {
  // The unguessable name is not disclosed before mkdirat and fstatat follows immediately. A same-UID process
  // that enumerates and replaces it between those syscalls remains part of the trusted host-user boundary.
  const stat = Buffer.alloc(144)
  if (library.symbols.fstatat(parentFD, cString(name), ptr(stat), 0x0020) !== 0) {
    throw new TypeError("The private scaffold staging identity could not be observed")
  }
  return Object.freeze({ device: String(stat.readUInt32LE(0)), inode: stat.readBigUInt64LE(8).toString() })
}

async function createBoundedFiles(
  stagingFD: number,
  draft: ProjectCreationDraft,
  library: ReturnType<typeof openScaffoldLibrary>,
) {
  const directories = new Map<string, number>([["", stagingFD]])
  try {
    for (const file of draft.files) {
      const segments = file.path.split("/")
      let relativeDirectory = ""
      let directoryFD = stagingFD
      for (const segment of segments.slice(0, -1)) {
        relativeDirectory = relativeDirectory ? `${relativeDirectory}/${segment}` : segment
        const existing = directories.get(relativeDirectory)
        if (existing !== undefined) {
          directoryFD = existing
          continue
        }
        if (library.symbols.mkdirat(directoryFD, cString(segment), 0o700) !== 0 && lastErrno(library) !== 17) {
          throw new TypeError("A scaffold directory could not be created")
        }
        const childFD = openDirectoryAt(directoryFD, segment, library)
        if (childFD < 0) throw new TypeError("A scaffold directory could not be pinned")
        const facts = await Bun.file(childFD).stat()
        if (!facts.isDirectory()) {
          library.symbols.close(childFD)
          throw new TypeError("A scaffold path component is not a directory")
        }
        directories.set(relativeDirectory, childFD)
        directoryFD = childFD
      }
      const filename = segments.at(-1)
      if (!filename) throw new TypeError("A scaffold file name is missing")
      const fileFD = library.symbols.openat(
        directoryFD,
        cString(filename),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      if (fileFD < 0) throw new TypeError("A scaffold file could not be created exclusively")
      try {
        if (library.symbols.fchmod(fileFD, 0o600) !== 0) {
          throw new TypeError("A scaffold file mode could not be restricted")
        }
        writeAll(fileFD, Buffer.from(file.content, "utf8"), library)
        syncDescriptor(fileFD, library)
      } finally {
        library.symbols.close(fileFD)
      }
    }
    for (const descriptor of [...directories.values()].reverse()) syncDescriptor(descriptor, library)
  } finally {
    for (const [path, descriptor] of [...directories.entries()].reverse()) {
      if (path) library.symbols.close(descriptor)
    }
  }
}

function writeAll(fd: number, bytes: Buffer, library: ReturnType<typeof openScaffoldLibrary>) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = Number(library.symbols.write(fd, ptr(bytes, offset), bytes.byteLength - offset))
    if (written <= 0) throw new TypeError("A scaffold file could not be written completely")
    offset += written
  }
}

async function parentAndTargetStillAuthorised(
  parent: Awaited<ReturnType<typeof open>>,
  binding: ReturnType<typeof requireBinding>,
  library: ReturnType<typeof openScaffoldLibrary>,
) {
  if (!(await parentHandleStillAuthorised(parent, binding))) return false
  return targetStateAt(parent.fd, binding.authority.targetName, library) === "absent"
}

async function parentHandleStillAuthorised(
  parent: Awaited<ReturnType<typeof open>>,
  binding: ReturnType<typeof requireBinding>,
) {
  const facts = await parent.stat().catch(() => null)
  const pathFacts = await lstat(binding.authority.parentPath).catch(() => null)
  return Boolean(
    facts?.isDirectory() &&
      pathFacts?.isDirectory() &&
      !pathFacts.isSymbolicLink() &&
      String(facts.dev) === binding.authority.parentIdentity.device &&
      String(facts.ino) === binding.authority.parentIdentity.inode &&
      String(pathFacts.dev) === binding.authority.parentIdentity.device &&
      String(pathFacts.ino) === binding.authority.parentIdentity.inode &&
      (await realpath(binding.authority.parentPath).catch(() => null)) === binding.authority.parentPath,
  )
}

function targetStateAt(parentFD: number, targetName: string, library: ReturnType<typeof openScaffoldLibrary>) {
  const descriptor = library.symbols.openat(
    parentFD,
    cString(targetName),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0,
  )
  if (descriptor >= 0) {
    library.symbols.close(descriptor)
    return "present" as const
  }
  return lastErrno(library) === noEntry ? ("absent" as const) : ("unavailable" as const)
}

function publishExclusiveAt(
  parentFD: number,
  sourceName: string,
  targetName: string,
  library: ReturnType<typeof openScaffoldLibrary>,
) {
  return (
    library.symbols.renameatx_np(
      parentFD,
      cString(sourceName),
      parentFD,
      cString(targetName),
      renameExclusive,
    ) === 0
  )
}

async function proveStagingRemoved(
  parent: Awaited<ReturnType<typeof open>>,
  binding: ReturnType<typeof requireBinding>,
  stagingName: string,
  identity: Readonly<{ device: string; inode: string }> | null,
  library: ReturnType<typeof openScaffoldLibrary>,
) {
  if (!identity || !(await parentHandleStillAuthorised(parent, binding))) return false
  const stagingFD = openDirectoryAt(parent.fd, stagingName, library)
  if (stagingFD < 0) return false
  try {
    const facts = await Bun.file(stagingFD).stat()
    if (
      !facts.isDirectory() ||
      String(facts.dev) !== identity.device ||
      String(facts.ino) !== identity.inode
    ) {
      return false
    }
    const budget = { remaining: maximumCleanupEntries }
    if (!(await removeDirectoryContents(stagingFD, library, budget))) return false
  } catch {
    return false
  } finally {
    library.symbols.close(stagingFD)
  }
  if (library.symbols.unlinkat(parent.fd, cString(stagingName), removeDirectory) !== 0) return false
  syncDescriptor(parent.fd, library)
  return (
    targetStateAt(parent.fd, stagingName, library) === "absent" &&
    (await parentHandleStillAuthorised(parent, binding))
  )
}

async function removeDirectoryContents(
  directoryFD: number,
  library: ReturnType<typeof openScaffoldLibrary>,
  budget: { remaining: number },
): Promise<boolean> {
  const names = readDirectoryNames(directoryFD, library, budget)
  for (const name of names) {
    const childFD = library.symbols.openat(
      directoryFD,
      cString(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    )
    if (childFD < 0) {
      if (lastErrno(library) !== symbolicLinkLoop || library.symbols.unlinkat(directoryFD, cString(name), 0) !== 0) {
        return false
      }
      continue
    }
    let directory = false
    try {
      const facts = await Bun.file(childFD).stat()
      directory = facts.isDirectory()
      if (directory && !(await removeDirectoryContents(childFD, library, budget))) return false
    } finally {
      library.symbols.close(childFD)
    }
    if (library.symbols.unlinkat(directoryFD, cString(name), directory ? removeDirectory : 0) !== 0) return false
  }
  syncDescriptor(directoryFD, library)
  return true
}

function readDirectoryNames(
  directoryFD: number,
  library: ReturnType<typeof openScaffoldLibrary>,
  budget: { remaining: number },
) {
  const duplicate = library.symbols.dup(directoryFD)
  if (duplicate < 0) throw new TypeError("A scaffold directory descriptor could not be duplicated")
  const directory = library.symbols.fdopendir(duplicate)
  if (!directory) {
    library.symbols.close(duplicate)
    throw new TypeError("A scaffold directory descriptor could not be enumerated")
  }
  const names: Array<string> = []
  try {
    while (true) {
      const entry = library.symbols.readdir(directory)
      if (!entry) break
      const bytes = Buffer.from(toArrayBuffer(entry, 0, 1_045))
      const nameLength = bytes.readUInt16LE(18)
      if (nameLength < 1 || nameLength > 1_023) throw new TypeError("A scaffold directory entry name is invalid")
      const nameBytes = bytes.subarray(21, 21 + nameLength)
      const name = nameBytes.toString("utf8")
      if (name === "." || name === "..") continue
      if (name.includes("/") || name.includes("\0") || !Buffer.from(name, "utf8").equals(nameBytes)) {
        throw new TypeError("A scaffold directory entry name is unsafe")
      }
      if (budget.remaining < 1) throw new TypeError("Scaffold cleanup exceeded its entry limit")
      budget.remaining -= 1
      names.push(name)
    }
  } finally {
    library.symbols.closedir(directory)
  }
  return names
}

function openDirectoryAt(parentFD: number, name: string, library: ReturnType<typeof openScaffoldLibrary>) {
  return library.symbols.openat(
    parentFD,
    cString(name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0,
  )
}

function syncDescriptor(fd: number, library: ReturnType<typeof openScaffoldLibrary>) {
  if (library.symbols.fsync(fd) !== 0) throw new TypeError("A scaffold filesystem boundary could not be synced")
}

function openScaffoldLibrary() {
  if (process.platform !== "darwin") throw new TypeError("Descriptor-relative scaffold publication requires macOS")
  return dlopen("/usr/lib/libSystem.B.dylib", {
    __error: { args: [], returns: "ptr" },
    close: { args: ["i32"], returns: "i32" },
    dup: { args: ["i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    fchmod: { args: ["i32", "u32"], returns: "i32" },
    fstatat: { args: ["i32", "ptr", "ptr", "i32"], returns: "i32" },
    fsync: { args: ["i32"], returns: "i32" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
    renameatx_np: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    write: { args: ["i32", "ptr", "usize"], returns: "i64" },
  })
}

function lastErrno(library: ReturnType<typeof openScaffoldLibrary>) {
  const address = library.symbols.__error()
  if (!address) return -1
  return Buffer.from(toArrayBuffer(address, 0, 4)).readInt32LE(0)
}

function cString(input: string) {
  return ptr(Buffer.from(`${input}\0`))
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
