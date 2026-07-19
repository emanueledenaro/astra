import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, type FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ExecutionCapabilityManifest } from "@astra/domain/execution-capability"
import { parseContentDigest, type ContentDigest } from "@astra/domain/operation-contract"
import type { SealedExecutableIdentity } from "./types"

const maxExecutableBytes = 256 * 1024 * 1024

export type ApprovedSource = Readonly<{
  handle: FileHandle
  path: string
  size: number
  digest: ContentDigest
  device: string
  inode: string
}>

export type PrivateRuntime = Readonly<{
  scratchPath: string
  executionDirectory: string
  sealedExecutable: SealedExecutableIdentity
  validate: () => Promise<boolean>
  cleanup: () => Promise<boolean>
}>

export type PrivateRuntimePreparation =
  | Readonly<{ ok: true; value: PrivateRuntime }>
  | Readonly<{
      ok: false
      reason: "runtime_scratch_unsafe" | "sealed_executable_failed" | "cleanup_failed"
      cleanupSucceeded: boolean
    }>

type PreparedParent = Readonly<{
  rollback: () => Promise<boolean>
}>

/** Opens and hashes the exact executable identity named by the approved capability. */
export async function openApprovedSource(
  expected: ExecutionCapabilityManifest["process"]["executable"],
): Promise<ApprovedSource | null> {
  if ((await realpath(expected.canonicalPath).catch(() => null)) !== expected.canonicalPath) return null
  const handle = await open(expected.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return null
  try {
    const facts = await handle.stat()
    const owner = process.getuid?.()
    if (
      owner === undefined ||
      !facts.isFile() ||
      facts.nlink !== 1 ||
      !Number.isSafeInteger(facts.size) ||
      facts.size < 1 ||
      facts.size > maxExecutableBytes ||
      (facts.mode & 0o111) === 0 ||
      (facts.mode & 0o022) !== 0 ||
      (facts.uid !== 0 && facts.uid !== owner) ||
      String(facts.dev) !== expected.device ||
      String(facts.ino) !== expected.inode
    ) {
      await handle.close()
      return null
    }
    const pathFacts = await lstat(expected.canonicalPath).catch(() => null)
    if (!pathFacts || pathFacts.isSymbolicLink() || !sameIdentity(pathFacts, facts)) {
      await handle.close()
      return null
    }
    const digest = await digestOpenedFile(handle, facts.size)
    if (digest !== expected.digest) {
      await handle.close()
      return null
    }
    return {
      handle,
      path: expected.canonicalPath,
      size: facts.size,
      digest,
      device: expected.device,
      inode: expected.inode,
    }
  } catch {
    await handle.close().catch(() => undefined)
    return null
  }
}

/** Creates an isolated scratch directory and a separately sealed executable copy after approval. */
export async function preparePrivateRuntime(
  source: ApprovedSource,
  scratchPath: string,
): Promise<PrivateRuntimePreparation> {
  const owner = process.getuid?.()
  if (owner === undefined) return preparationFailure("runtime_scratch_unsafe", true)
  const preparedParent = await prepareUnusedPrivateScratchParent(scratchPath, owner)
  if (!preparedParent.ok) return preparedParent
  const parent = dirname(scratchPath)
  let executionDirectory: string | null = null
  let scratchCreated = false
  try {
    await mkdir(scratchPath, { mode: 0o700 })
    scratchCreated = true
    await chmod(scratchPath, 0o700)
    executionDirectory = await mkdtemp(join(parent, "astra-seatbelt-exec-"))
    await chmod(executionDirectory, 0o700)
    const sealedPath = join(executionDirectory, "bun")
    const sealedExecutable = await sealSource(source, sealedPath, owner)
    if (!sealedExecutable || !(await revalidateApprovedSource(source))) throw new Error("source changed while sealing")
    const directoryFacts = await lstat(executionDirectory)
    if (!directoryFacts.isDirectory() || directoryFacts.uid !== owner || (directoryFacts.mode & 0o777) !== 0o700) {
      throw new Error("execution directory changed while sealing")
    }
    await chmod(executionDirectory, 0o500)
    const sealedDirectory = await lstat(executionDirectory)
    if (
      !sealedDirectory.isDirectory() ||
      sealedDirectory.isSymbolicLink() ||
      sealedDirectory.uid !== owner ||
      (sealedDirectory.mode & 0o777) !== 0o500 ||
      String(sealedDirectory.dev) !== String(directoryFacts.dev) ||
      String(sealedDirectory.ino) !== String(directoryFacts.ino)
    ) {
      throw new Error("execution directory changed while locking")
    }
    const cleanup = () => cleanupPrivateRuntime(scratchPath, executionDirectory!)
    const validate = () =>
      validatePrivateRuntime({
        scratchPath,
        executionDirectory: executionDirectory!,
        executionDirectoryDevice: String(sealedDirectory.dev),
        executionDirectoryInode: String(sealedDirectory.ino),
        sealedExecutable,
        sealedSize: source.size,
        owner,
      })
    return { ok: true, value: { scratchPath, executionDirectory, sealedExecutable, validate, cleanup } }
  } catch {
    const cleanupResults = [
      executionDirectory ? await cleanupDirectory(executionDirectory) : true,
      scratchCreated ? await cleanupDirectory(scratchPath) : true,
      await preparedParent.value.rollback(),
    ]
    const cleanupSucceeded = cleanupResults.every(Boolean)
    return cleanupSucceeded
      ? preparationFailure("sealed_executable_failed", true)
      : preparationFailure("cleanup_failed", false)
  }
}

async function sealSource(source: ApprovedSource, destinationPath: string, owner: number) {
  const destination = await open(
    destinationPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o700,
  )
  try {
    const copiedDigest = await copyOpenedFile(source.handle, destination, source.size)
    await destination.sync()
    await destination.chmod(0o500)
    const facts = await destination.stat()
    const readbackDigest = await digestOpenedFile(destination, source.size)
    if (
      !facts.isFile() ||
      facts.nlink !== 1 ||
      facts.size !== source.size ||
      facts.uid !== owner ||
      (facts.mode & 0o777) !== 0o500 ||
      copiedDigest !== source.digest ||
      readbackDigest !== source.digest
    ) {
      return null
    }
    return {
      canonicalPath: destinationPath,
      device: String(facts.dev),
      inode: String(facts.ino),
      digest: readbackDigest,
    } satisfies SealedExecutableIdentity
  } finally {
    await destination.close()
  }
}

async function revalidateApprovedSource(source: ApprovedSource) {
  const [facts, pathFacts, canonicalPath] = await Promise.all([
    source.handle.stat().catch(() => null),
    lstat(source.path).catch(() => null),
    realpath(source.path).catch(() => null),
  ])
  if (
    !facts?.isFile() ||
    !pathFacts?.isFile() ||
    pathFacts.isSymbolicLink() ||
    canonicalPath !== source.path ||
    String(facts.dev) !== source.device ||
    String(facts.ino) !== source.inode ||
    !sameIdentity(pathFacts, facts) ||
    facts.size !== source.size
  ) {
    return false
  }
  return (await digestOpenedFile(source.handle, source.size).catch(() => null)) === source.digest
}

async function prepareUnusedPrivateScratchParent(
  path: string,
  owner: number,
): Promise<Readonly<{ ok: true; value: PreparedParent }> | Extract<PrivateRuntimePreparation, { ok: false }>> {
  if (!(await pathIsAbsent(path))) return preparationFailure("runtime_scratch_unsafe", true)
  const parent = dirname(path)
  let facts = await lstat(parent).catch(() => null)
  let parentCreated = false
  let originalMode: number | null = null
  if (facts === null) {
    if (!(await pathIsAbsent(parent))) return preparationFailure("runtime_scratch_unsafe", true)
    const appState = dirname(parent)
    const appStateFacts = await lstat(appState).catch(() => null)
    if (
      (await realpath(appState).catch(() => null)) !== appState ||
      !appStateFacts?.isDirectory() ||
      appStateFacts.isSymbolicLink() ||
      appStateFacts.uid !== owner ||
      (appStateFacts.mode & 0o022) !== 0
    ) {
      return preparationFailure("runtime_scratch_unsafe", true)
    }
    try {
      await mkdir(parent, { mode: 0o700 })
      parentCreated = true
    } catch {
      return preparationFailure("runtime_scratch_unsafe", true)
    }
    facts = await lstat(parent).catch(() => null)
  }
  if (
    !facts ||
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    facts.uid !== owner ||
    (facts.mode & 0o022) !== 0 ||
    (await realpath(parent).catch(() => null)) !== parent
  ) {
    const cleanupSucceeded = parentCreated ? await removeCreatedParent(parent) : true
    return cleanupSucceeded
      ? preparationFailure("runtime_scratch_unsafe", true)
      : preparationFailure("cleanup_failed", false)
  }
  originalMode = facts.mode & 0o777
  if (originalMode !== 0o700) {
    try {
      await chmod(parent, 0o700)
    } catch {
      const cleanupSucceeded = parentCreated ? await removeCreatedParent(parent) : true
      return cleanupSucceeded
        ? preparationFailure("runtime_scratch_unsafe", true)
        : preparationFailure("cleanup_failed", false)
    }
  }
  const secured = await lstat(parent).catch(() => null)
  const valid = Boolean(
    secured?.isDirectory() &&
      !secured.isSymbolicLink() &&
      secured.uid === owner &&
      (secured.mode & 0o777) === 0o700 &&
      (await realpath(parent).catch(() => null)) === parent,
  )
  const rollback = async () => {
    if (parentCreated) return removeCreatedParent(parent)
    if (originalMode !== null && originalMode !== 0o700) {
      const current = await lstat(parent).catch(() => null)
      if (!current?.isDirectory() || current.isSymbolicLink() || current.uid !== owner) return false
      return chmod(parent, originalMode)
        .then(() => true)
        .catch(() => false)
    }
    return true
  }
  if (valid) return { ok: true, value: { rollback } }
  const cleanupSucceeded = await rollback()
  return cleanupSucceeded
    ? preparationFailure("runtime_scratch_unsafe", true)
    : preparationFailure("cleanup_failed", false)
}

async function copyOpenedFile(source: FileHandle, destination: FileHandle, size: number) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size))
  let position = 0
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position)
    const read = await source.read(buffer, 0, requested, position)
    if (read.bytesRead < 1) throw new Error("source ended while sealing")
    hash.update(buffer.subarray(0, read.bytesRead))
    let written = 0
    while (written < read.bytesRead) {
      const result = await destination.write(buffer, written, read.bytesRead - written, position + written)
      if (result.bytesWritten < 1) throw new Error("sealed copy could not be completed")
      written += result.bytesWritten
    }
    position += read.bytesRead
  }
  return contentDigest(hash.digest("hex"))
}

async function digestOpenedFile(handle: FileHandle, size: number) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size))
  let position = 0
  while (position < size) {
    const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - position), position)
    if (read.bytesRead < 1) throw new Error("file ended while hashing")
    hash.update(buffer.subarray(0, read.bytesRead))
    position += read.bytesRead
  }
  return contentDigest(hash.digest("hex"))
}

async function cleanupPrivateRuntime(scratchPath: string, executionDirectory: string) {
  const results = await Promise.all([cleanupDirectory(executionDirectory), cleanupDirectory(scratchPath)])
  return results.every(Boolean)
}

async function validatePrivateRuntime(
  input: Readonly<{
    scratchPath: string
    executionDirectory: string
    executionDirectoryDevice: string
    executionDirectoryInode: string
    sealedExecutable: SealedExecutableIdentity
    sealedSize: number
    owner: number
  }>,
) {
  const [scratchFacts, directoryFacts, scratchCanonical, directoryCanonical] = await Promise.all([
    lstat(input.scratchPath).catch(() => null),
    lstat(input.executionDirectory).catch(() => null),
    realpath(input.scratchPath).catch(() => null),
    realpath(input.executionDirectory).catch(() => null),
  ])
  if (
    scratchCanonical !== input.scratchPath ||
    !scratchFacts?.isDirectory() ||
    scratchFacts.isSymbolicLink() ||
    scratchFacts.uid !== input.owner ||
    (scratchFacts.mode & 0o777) !== 0o700 ||
    directoryCanonical !== input.executionDirectory ||
    !directoryFacts?.isDirectory() ||
    directoryFacts.isSymbolicLink() ||
    directoryFacts.uid !== input.owner ||
    (directoryFacts.mode & 0o777) !== 0o500 ||
    String(directoryFacts.dev) !== input.executionDirectoryDevice ||
    String(directoryFacts.ino) !== input.executionDirectoryInode
  ) {
    return false
  }
  const handle = await open(input.sealedExecutable.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => null,
  )
  if (!handle) return false
  try {
    const facts = await handle.stat()
    const pathFacts = await lstat(input.sealedExecutable.canonicalPath).catch(() => null)
    if (
      !facts.isFile() ||
      facts.nlink !== 1 ||
      facts.size !== input.sealedSize ||
      facts.uid !== input.owner ||
      (facts.mode & 0o777) !== 0o500 ||
      String(facts.dev) !== input.sealedExecutable.device ||
      String(facts.ino) !== input.sealedExecutable.inode ||
      !pathFacts?.isFile() ||
      pathFacts.isSymbolicLink() ||
      !sameIdentity(pathFacts, facts)
    ) {
      return false
    }
    return (await digestOpenedFile(handle, input.sealedSize)) === input.sealedExecutable.digest
  } catch {
    return false
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function cleanupDirectory(path: string) {
  try {
    await chmod(path, 0o700)
    await rm(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

function sameIdentity(left: Readonly<{ dev: number; ino: number }>, right: Readonly<{ dev: number; ino: number }>) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function pathIsAbsent(path: string) {
  try {
    await lstat(path)
    return false
  } catch (error) {
    return isNotFound(error)
  }
}

async function removeCreatedParent(path: string) {
  return rmdir(path)
    .then(() => true)
    .catch(() => false)
}

function preparationFailure(
  reason: Extract<PrivateRuntimePreparation, { ok: false }>["reason"],
  cleanupSucceeded: boolean,
) {
  return { ok: false, reason, cleanupSucceeded } as const
}

function contentDigest(hex: string) {
  const parsed = parseContentDigest(`sha256:${hex}`)
  if (!parsed.ok) throw new Error("computed an invalid content digest")
  return parsed.value
}
