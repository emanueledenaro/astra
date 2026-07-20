import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dlopen, ptr, toArrayBuffer } from "bun:ffi"
import type { ProjectCreationPreview, ProjectParentAuthority } from "@astra/domain/project-creation-control"
import type { ContentDigest } from "@astra/domain/operation-contract"
import { canonicalJson, digest } from "./controlled-write-authority"
import type { ProjectScaffoldTreeVerification } from "./project-creation-verifier"

export type ProjectScaffoldVerifierInternalDependencies = Readonly<{
  afterParentOpen?: () => Promise<void>
  beforeOpenEntry?: (relativePath: string) => Promise<void>
}>

/** Internal deterministic seam; the package export permanently binds the empty dependency set. */
export async function verifyProjectScaffoldTreeInternal(
  authority: ProjectParentAuthority,
  preview: ProjectCreationPreview,
  targetIdentity: Readonly<{ device: string; inode: string }>,
  dependencies: ProjectScaffoldVerifierInternalDependencies = {},
): Promise<ProjectScaffoldTreeVerification> {
  const first = await readTree(authority, preview, targetIdentity, dependencies)
  const second = await readTree(authority, preview, targetIdentity, dependencies)
  const snapshotDigest = digest(canonicalJson({ first, second }))
  if (!first.available || !second.available || canonicalJson(first) !== canonicalJson(second)) {
    const reason = !first.available
      ? first.reason
      : !second.available
        ? second.reason
        : "project_tree_unstable"
    return { status: "unknown", snapshotDigest, reason }
  }
  if (!treeIsExact(first, preview)) {
    return { status: "failed", snapshotDigest, reason: "project_tree_does_not_match_preview" }
  }
  return { status: "verified", snapshotDigest: expectedProjectScaffoldTreeDigest(preview), reason: null }
}

export function expectedProjectScaffoldTreeDigest(preview: ProjectCreationPreview): ContentDigest {
  return digest(
    canonicalJson({
      directories: expectedDirectories(preview.files.map((file) => file.path)),
      files: preview.files,
      targetPath: preview.targetPath,
    }),
  )
}

async function readTree(
  authority: ProjectParentAuthority,
  preview: ProjectCreationPreview,
  targetIdentity: Readonly<{ device: string; inode: string }>,
  dependencies: ProjectScaffoldVerifierInternalDependencies,
) {
  const parent = await open(
    authority.parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => null)
  if (!parent) return unavailable("parent_or_target_handle_unavailable")
  const library = openDirectoryLibrary()
  let targetFD = -1
  try {
    const parentBefore = await parent.stat()
    if (
      !parentBefore.isDirectory() ||
      String(parentBefore.dev) !== authority.parentIdentity.device ||
      String(parentBefore.ino) !== authority.parentIdentity.inode ||
      (await realpath(authority.parentPath).catch(() => null)) !== authority.parentPath
    ) {
      return unavailable("parent_or_target_identity_changed")
    }
    await dependencies.afterParentOpen?.()
    targetFD = library.symbols.openat(
      parent.fd,
      ptr(Buffer.from(`${authority.targetName}\0`)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
    )
    if (targetFD < 0) return unavailable("parent_or_target_handle_unavailable")
    const targetBefore = await Bun.file(targetFD).stat()
    const parentPathFacts = await lstat(authority.parentPath).catch(() => null)
    if (
      !targetBefore.isDirectory() ||
      String(targetBefore.dev) !== targetIdentity.device ||
      String(targetBefore.ino) !== targetIdentity.inode ||
      !parentPathFacts?.isDirectory() ||
      parentPathFacts.isSymbolicLink() ||
      String(parentPathFacts.dev) !== authority.parentIdentity.device ||
      String(parentPathFacts.ino) !== authority.parentIdentity.inode ||
      (await realpath(authority.parentPath).catch(() => null)) !== authority.parentPath
    ) {
      return unavailable("parent_or_target_identity_changed")
    }
    const entries = await readDirectory(
      targetFD,
      "",
      preview.limits.maxFiles * preview.limits.maxPathSegments + 1,
      library,
      dependencies,
    )
    const parentAfter = await parent.stat()
    const targetAfter = await Bun.file(targetFD).stat()
    const parentPathAfter = await lstat(authority.parentPath).catch(() => null)
    const reboundTargetFD = library.symbols.openat(
      parent.fd,
      ptr(Buffer.from(`${authority.targetName}\0`)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
    )
    if (reboundTargetFD < 0) return unavailable("parent_or_target_changed_during_read")
    let reboundTarget: Awaited<ReturnType<ReturnType<typeof Bun.file>["stat"]>>
    try {
      reboundTarget = await Bun.file(reboundTargetFD).stat()
    } finally {
      library.symbols.close(reboundTargetFD)
    }
    if (
      parentBefore.dev !== parentAfter.dev ||
      parentBefore.ino !== parentAfter.ino ||
      targetBefore.dev !== targetAfter.dev ||
      targetBefore.ino !== targetAfter.ino ||
      !parentPathAfter?.isDirectory() ||
      parentPathAfter.isSymbolicLink() ||
      parentBefore.dev !== parentPathAfter.dev ||
      parentBefore.ino !== parentPathAfter.ino ||
      targetBefore.dev !== reboundTarget.dev ||
      targetBefore.ino !== reboundTarget.ino ||
      (await realpath(authority.parentPath).catch(() => null)) !== authority.parentPath
    ) {
      return unavailable("parent_or_target_changed_during_read")
    }
    return { available: true as const, entries: entries.sort((left, right) => left.path.localeCompare(right.path)) }
  } catch (cause) {
    return unavailable(cause instanceof Error ? cause.message.slice(0, 128) : "tree_read_failed")
  } finally {
    if (targetFD >= 0) library.symbols.close(targetFD)
    library.close()
    await parent.close().catch(() => {})
  }
}

function openDirectoryLibrary() {
  if (process.platform !== "darwin") throw new TypeError("Descriptor-relative project verification requires macOS")
  return dlopen("/usr/lib/libSystem.B.dylib", {
    dup: { args: ["i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  })
}

async function readDirectory(
  directoryFD: number,
  relativeDirectory: string,
  remaining: number,
  library: ReturnType<typeof openDirectoryLibrary>,
  dependencies: ProjectScaffoldVerifierInternalDependencies,
): Promise<Array<TreeEntry>> {
  if (remaining < 1) throw new TypeError("Project tree exceeds the verification entry limit")
  const names = readDirectoryNames(directoryFD, remaining, library)
  const entries: Array<TreeEntry> = []
  for (const name of names) {
    if (entries.length >= remaining) throw new TypeError("Project tree exceeds the verification entry limit")
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
    await dependencies.beforeOpenEntry?.(relativePath)
    const nameBytes = Buffer.from(`${name}\0`)
    const childFD = library.symbols.openat(
      directoryFD,
      ptr(nameBytes),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    )
    if (childFD < 0) throw new TypeError(`Project entry ${relativePath} could not be opened without following links`)
    try {
      const file = Bun.file(childFD)
      const before = await file.stat()
      if (before.isDirectory()) {
        entries.push({ kind: "directory", path: relativePath, mode: before.mode & 0o777 })
        entries.push(
          ...(await readDirectory(
            childFD,
            relativePath,
            remaining - entries.length,
            library,
            dependencies,
          )),
        )
        const after = await file.stat()
        if (!sameIdentity(before, after)) throw new TypeError(`Project directory ${relativePath} changed during read`)
        continue
      }
      if (!before.isFile()) {
        entries.push({ kind: "unsupported", path: relativePath, mode: before.mode & 0o777 })
        continue
      }
      if (before.size > 64 * 1_024) throw new TypeError("Project file exceeds the verification byte limit")
      const bytes = new Uint8Array(await file.arrayBuffer())
      const after = await file.stat()
      if (!sameFile(before, after)) throw new TypeError(`Project file ${relativePath} changed during read`)
      entries.push({
        kind: "file",
        path: relativePath,
        mode: after.mode & 0o777,
        bytes: bytes.byteLength,
        contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      })
    } finally {
      library.symbols.close(childFD)
    }
  }
  return entries
}

function readDirectoryNames(
  directoryFD: number,
  maximumNames: number,
  library: ReturnType<typeof openDirectoryLibrary>,
) {
  const duplicate = library.symbols.dup(directoryFD)
  if (duplicate < 0) throw new TypeError("Project directory descriptor could not be duplicated")
  const directory = library.symbols.fdopendir(duplicate)
  if (!directory) {
    library.symbols.close(duplicate)
    throw new TypeError("Project directory descriptor could not be enumerated")
  }
  const names: Array<string> = []
  try {
    while (true) {
      const entry = library.symbols.readdir(directory)
      if (!entry) break
      const bytes = Buffer.from(toArrayBuffer(entry, 0, 1_045))
      const nameLength = bytes.readUInt16LE(18)
      if (nameLength < 1 || nameLength > 1_023) throw new TypeError("Project directory entry name is invalid")
      const nameBytes = bytes.subarray(21, 21 + nameLength)
      const name = nameBytes.toString("utf8")
      if (name === "." || name === "..") continue
      if (
        name.includes("/") ||
        name.includes("\0") ||
        !Buffer.from(name, "utf8").equals(nameBytes)
      ) {
        throw new TypeError("Project directory entry name is unsafe")
      }
      if (names.length >= maximumNames) throw new TypeError("Project tree exceeds the verification entry limit")
      names.push(name)
    }
  } finally {
    library.symbols.closedir(directory)
  }
  return names.sort()
}

type TreeEntry =
  | Readonly<{ kind: "directory" | "unsupported"; path: string; mode: number }>
  | Readonly<{ kind: "file"; path: string; mode: number; bytes: number; contentDigest: string }>

function treeIsExact(
  snapshot: Readonly<{ available: true; entries: ReadonlyArray<TreeEntry> }>,
  preview: ProjectCreationPreview,
) {
  const directories = snapshot.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path)
  const files = snapshot.entries.filter((entry): entry is Extract<TreeEntry, { kind: "file" }> => entry.kind === "file")
  if (snapshot.entries.some((entry) => entry.kind === "unsupported")) return false
  if (canonicalJson(directories.sort()) !== canonicalJson(expectedDirectories(preview.files.map((file) => file.path)))) {
    return false
  }
  if (files.length !== preview.files.length) return false
  return files.every((file, index) => {
    const expected = [...preview.files].sort((left, right) => left.path.localeCompare(right.path))[index]
    return (
      expected !== undefined &&
      file.path === expected.path &&
      file.bytes === expected.bytes &&
      file.contentDigest === expected.contentDigest &&
      (file.mode & 0o111) === 0
    )
  })
}

function expectedDirectories(paths: ReadonlyArray<string>) {
  const directories = new Set<string>()
  paths.forEach((path) => {
    const segments = path.split("/")
    segments.slice(0, -1).forEach((_segment, index) => directories.add(segments.slice(0, index + 1).join("/")))
  })
  return [...directories].sort()
}

function sameIdentity(left: Awaited<ReturnType<ReturnType<typeof Bun.file>["stat"]>>, right: typeof left) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function sameFile(left: Awaited<ReturnType<ReturnType<typeof Bun.file>["stat"]>>, right: typeof left) {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function unavailable(reason: string) {
  return { available: false as const, reason }
}
