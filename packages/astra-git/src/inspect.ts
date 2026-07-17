import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdtemp, open, opendir, readlink, realpath, rm, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { indexMatchesStatus, parseGitIndexOutput, parseGitStatusOutput } from "./parser"
import type { GitInspectionBlocked, GitInspectionBlockReason, GitInspectionLimits, GitInspectionResult } from "./types"

export const defaultGitInspectionLimits = {
  timeoutMs: 2_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  maxEntries: 10_000,
  maxBoundaryEntries: 250_000,
  maxBoundaryDurationMs: 5_000,
  maxGitBinaryBytes: 64 * 1024 * 1024,
} as const satisfies GitInspectionLimits

type ExecutableIdentity = Readonly<{
  device: string
  inode: string
  size: number
  digest: `sha256:${string}`
  directoryDevice: string
  directoryInode: string
}>
type TrustedBinaries = Readonly<{
  gitPath: string
  sandboxPath: string
  gitIdentity: ExecutableIdentity
  cleanup: () => Promise<boolean>
}>
type RepositoryIdentity = Readonly<{
  rootDevice: string
  rootInode: string
  gitDevice: string
  gitInode: string
  metadataDigest: `sha256:${string}`
}>
type ProcessResult =
  | Readonly<{ ok: true; stdout: Uint8Array }>
  | Readonly<{ ok: false; reason: GitInspectionBlockReason; stdout?: Uint8Array; stderr?: Uint8Array }>

export type GitInspectorDependencies = Readonly<{
  platform: string
  prepareTrustedBinaries: (workspaceRoot: string, limits: GitInspectionLimits) => Promise<TrustedBinaries | null>
  validatePreparedGit: (binaries: TrustedBinaries, limits: GitInspectionLimits) => Promise<boolean>
  runSandboxedGit: (input: SandboxedGitInput) => Promise<ProcessResult>
}>

export type SandboxedGitInput = Readonly<{
  gitPath: string
  sandboxPath: string
  workspaceRoot: string
  command: "status" | "index-assume-unchanged" | "index-fsmonitor-valid"
  limits: GitInspectionLimits
}>

const sandboxProfile =
  '(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (literal "/dev/null")) (deny process-fork) (deny process-exec) (allow process-exec (literal (param "GIT_PATH")))'

export async function inspectGitWorkspace(
  workspaceRoot: string,
  overrides: Partial<GitInspectionLimits> = {},
): Promise<GitInspectionResult> {
  return inspectGitWorkspaceWithDependencies(workspaceRoot, overrides, {
    platform: process.platform,
    prepareTrustedBinaries,
    validatePreparedGit,
    runSandboxedGit,
  })
}

export async function inspectGitWorkspaceWithDependencies(
  workspaceRoot: string,
  overrides: Partial<GitInspectionLimits>,
  dependencies: GitInspectorDependencies,
): Promise<GitInspectionResult> {
  const root = resolve(workspaceRoot)
  const limits = { ...defaultGitInspectionLimits, ...overrides }
  if (dependencies.platform !== "darwin") return blocked(root, "unsupported_platform")
  if (!validLimits(limits)) return blocked(root, "invalid_limits")

  const initialDeadline = performance.now() + limits.maxBoundaryDurationMs
  const initial = await inspectRepositoryBoundary(workspaceRoot, limits, initialDeadline)
  if (!initial.ok) return blocked(root, initial.reason)
  if (performance.now() > initialDeadline) return blocked(root, "boundary_time_limit_exceeded")
  const binaries = await dependencies.prepareTrustedBinaries(root, limits).catch(() => null)
  if (!binaries) return blocked(root, "git_binary_untrusted")

  let result: GitInspectionResult = blocked(root, "git_process_failed")
  let cleanupSucceeded = false
  try {
    result = await inspectWithPreparedGit(root, limits, dependencies, initial.identity, binaries).catch(() =>
      blocked(root, "git_process_failed"),
    )
  } finally {
    cleanupSucceeded = await binaries.cleanup().catch(() => false)
  }
  return cleanupSucceeded ? result : blocked(root, "git_ephemeral_cleanup_failed")
}

async function inspectWithPreparedGit(
  root: string,
  limits: GitInspectionLimits,
  dependencies: GitInspectorDependencies,
  initialIdentity: RepositoryIdentity,
  binaries: TrustedBinaries,
): Promise<GitInspectionResult> {
  const first = await observe(dependencies, binaries, root, limits).catch(
    () => ({ ok: false, reason: "git_process_failed" }) as const,
  )
  if (!first.ok) return blocked(root, first.reason)
  const middle = await inspectRepositoryBoundary(root, limits)
  if (!middle.ok) return blocked(root, middle.reason)
  if (!sameIdentity(initialIdentity, middle.identity)) return blocked(root, "workspace_identity_changed")

  const second = await observe(dependencies, binaries, root, limits).catch(
    () => ({ ok: false, reason: "git_process_failed" }) as const,
  )
  if (!second.ok) return blocked(root, second.reason)
  const final = await inspectRepositoryBoundary(root, limits)
  if (!final.ok) return blocked(root, final.reason)
  if (!sameIdentity(initialIdentity, final.identity)) return blocked(root, "workspace_identity_changed")
  if (
    !equalBytes(first.status, second.status) ||
    !equalBytes(first.indexAssumeUnchanged, second.indexAssumeUnchanged) ||
    !equalBytes(first.indexFsmonitorValid, second.indexFsmonitorValid)
  ) {
    return blocked(root, "observation_changed")
  }

  const parsedStatus = parseGitStatusOutput(first.status, limits.maxEntries)
  if (!parsedStatus.ok) return blocked(root, parsedStatus.reason)
  const parsedAssumeUnchanged = parseGitIndexOutput(first.indexAssumeUnchanged, limits.maxEntries, "assume-unchanged")
  if (!parsedAssumeUnchanged.ok) return blocked(root, parsedAssumeUnchanged.reason)
  const parsedFsmonitor = parseGitIndexOutput(first.indexFsmonitorValid, limits.maxEntries, "fsmonitor-valid")
  if (!parsedFsmonitor.ok) return blocked(root, parsedFsmonitor.reason)
  if (parsedAssumeUnchanged.value.hasAssumeUnchanged) return blocked(root, "git_index_assume_unchanged")
  if (parsedAssumeUnchanged.value.hasSkipWorktree) return blocked(root, "git_index_skip_worktree")
  if (parsedFsmonitor.value.hasFsmonitorValid) return blocked(root, "git_index_fsmonitor_valid")
  if (parsedAssumeUnchanged.value.hasGitlink || parsedFsmonitor.value.hasGitlink) {
    return blocked(root, "submodules_uninspected")
  }
  if (!indexMatchesStatus(parsedStatus.value, parsedAssumeUnchanged.value, parsedFsmonitor.value)) {
    return blocked(root, "git_index_observation_mismatch")
  }

  const outputDigest = digestBytes(
    new TextEncoder().encode("astra.git-observation.v3\0"),
    first.status,
    new TextEncoder().encode("\0index-assume-unchanged\0"),
    first.indexAssumeUnchanged,
    new TextEncoder().encode("\0index-fsmonitor-valid\0"),
    first.indexFsmonitorValid,
  )
  const report = {
    status: "complete" as const,
    mode: "bounded_read_only" as const,
    baseline: "not_captured" as const,
    activationAllowed: false as const,
    verification: "not_verified" as const,
    submodules: "not_inspected" as const,
    workspaceRoot: root,
    branch: parsedStatus.value.branch,
    staged: parsedStatus.value.staged,
    unstaged: parsedStatus.value.unstaged,
    untracked: parsedStatus.value.untracked,
    conflicts: parsedStatus.value.conflicts,
    entryCount: parsedStatus.value.entryCount,
    outputDigest,
    diff: {
      source: "status_porcelain_v2" as const,
      format: "metadata_only" as const,
      renames: "disabled" as const,
      durability: "ephemeral" as const,
      verification: "not_verified" as const,
      untrackedContent: "not_inspected" as const,
      conflictContent: "not_inspected" as const,
      observationDigest: outputDigest,
      staged: parsedStatus.value.stagedDiff,
      unstaged: parsedStatus.value.unstagedDiff,
    },
  }
  return {
    ...report,
    reportDigest: digestBytes(new TextEncoder().encode("astra.git-report.v3\0" + JSON.stringify(report))),
  }
}

async function observe(
  dependencies: GitInspectorDependencies,
  binaries: TrustedBinaries,
  workspaceRoot: string,
  limits: GitInspectionLimits,
) {
  if (!(await dependencies.validatePreparedGit(binaries, limits))) {
    return { ok: false, reason: "git_ephemeral_identity_changed" } as const
  }
  const status = await dependencies.runSandboxedGit({ ...binaries, workspaceRoot, command: "status", limits })
  if (!status.ok) return status
  if (!(await dependencies.validatePreparedGit(binaries, limits))) {
    return { ok: false, reason: "git_ephemeral_identity_changed" } as const
  }
  const indexAssumeUnchanged = await dependencies.runSandboxedGit({
    ...binaries,
    workspaceRoot,
    command: "index-assume-unchanged",
    limits,
  })
  if (!indexAssumeUnchanged.ok) return indexAssumeUnchanged
  if (!(await dependencies.validatePreparedGit(binaries, limits))) {
    return { ok: false, reason: "git_ephemeral_identity_changed" } as const
  }
  const indexFsmonitorValid = await dependencies.runSandboxedGit({
    ...binaries,
    workspaceRoot,
    command: "index-fsmonitor-valid",
    limits,
  })
  if (!indexFsmonitorValid.ok) {
    if (
      indexFsmonitorValid.stdout &&
      (indexFsmonitorValid.reason === "git_process_stderr" || indexFsmonitorValid.reason === "git_process_failed")
    ) {
      const parsed = parseGitIndexOutput(indexFsmonitorValid.stdout, limits.maxEntries, "fsmonitor-valid")
      if (parsed.ok && parsed.value.hasFsmonitorValid) {
        return { ok: false, reason: "git_index_fsmonitor_valid" } as const
      }
    }
    if (indexFsmonitorValid.stderr && decodeText(indexFsmonitorValid.stderr)?.includes("fsmonitor")) {
      return { ok: false, reason: "git_index_fsmonitor_uninspectable" } as const
    }
    return indexFsmonitorValid
  }
  return {
    ok: true,
    status: status.stdout,
    indexAssumeUnchanged: indexAssumeUnchanged.stdout,
    indexFsmonitorValid: indexFsmonitorValid.stdout,
  } as const
}

export async function prepareTrustedBinaries(
  workspaceRoot: string,
  limits: GitInspectionLimits,
): Promise<TrustedBinaries | null> {
  const developerLink = "/var/db/xcode_select_link"
  const linkFacts = await safeLstat(developerLink)
  if (!linkFacts?.isSymbolicLink() || !trustedOwnerAndMode(linkFacts.uid, linkFacts.mode)) return null
  const target = await safeReadlink(developerLink)
  if (!target || !isAbsolute(target)) return null
  const developerPath = await safeRealpath(target)
  if (!developerPath) return null
  const developerFacts = await safeLstat(developerPath)
  if (!developerFacts?.isDirectory() || !trustedOwnerAndMode(developerFacts.uid, developerFacts.mode)) return null

  const sourcePath = await safeRealpath(join(developerPath, "usr", "bin", "git"))
  if (!sourcePath) return null
  const sandboxPath = await trustedSystemExecutable("/usr/bin/sandbox-exec")
  if (!sandboxPath) return null
  const source = await openTrustedGitSource(sourcePath, limits.maxGitBinaryBytes)
  if (!source) return null
  try {
    return await sealOpenedGitSource(source.handle, source.size, workspaceRoot, sandboxPath)
  } finally {
    await source.handle.close()
  }
}

async function openTrustedGitSource(path: string, maxBytes: number) {
  const handle = await openNoFollow(path, constants.O_RDONLY)
  if (!handle) return null
  const facts = await handle.stat()
  if (
    !facts.isFile() ||
    !trustedOwnerAndMode(facts.uid, facts.mode) ||
    (facts.mode & 0o111) === 0 ||
    !Number.isSafeInteger(facts.size) ||
    facts.size < 1 ||
    facts.size > maxBytes
  ) {
    await handle.close()
    return null
  }
  return { handle, size: facts.size }
}

async function sealOpenedGitSource(
  source: FileHandle,
  size: number,
  workspaceRoot: string,
  sandboxPath: string,
): Promise<TrustedBinaries | null> {
  const owner = process.getuid?.()
  if (owner === undefined) return null
  const parent = await selectEphemeralParent(workspaceRoot)
  if (!parent) return null
  const directory = await mkdtemp(join(parent, "astra-git-exec-"))
  const gitPath = join(directory, "git")
  const cleanup = () => cleanupEphemeralDirectory(directory)

  try {
    await chmod(directory, 0o700)
    const sealed = await createSealedExecutable(source, gitPath, size)
    const directoryFacts = await lstat(directory)
    if (
      !sealed.facts.isFile() ||
      sealed.facts.size !== size ||
      (sealed.facts.mode & 0o777) !== 0o500 ||
      sealed.facts.uid !== owner ||
      sealed.digest !== sealed.copiedDigest ||
      !directoryFacts.isDirectory() ||
      directoryFacts.uid !== owner
    ) {
      await cleanup()
      return null
    }
    await chmod(directory, 0o500)
    return {
      gitPath,
      sandboxPath,
      gitIdentity: {
        device: String(sealed.facts.dev),
        inode: String(sealed.facts.ino),
        size,
        digest: sealed.digest,
        directoryDevice: String(directoryFacts.dev),
        directoryInode: String(directoryFacts.ino),
      },
      cleanup,
    }
  } catch {
    await cleanup()
    return null
  }
}

async function createSealedExecutable(source: FileHandle, gitPath: string, size: number) {
  const destination = await open(
    gitPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o700,
  )
  try {
    const digest = await copyOpenedExecutable(source, destination, size)
    await destination.sync()
    await destination.chmod(0o500)
    const facts = await destination.stat()
    const copiedDigest = await digestOpenedFile(destination, size)
    return { digest, facts, copiedDigest }
  } finally {
    await destination.close()
  }
}

export async function copyOpenedExecutable(source: FileHandle, destination: FileHandle, size: number) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size))
  let position = 0
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position)
    const read = await source.read(buffer, 0, requested, position)
    if (read.bytesRead < 1) throw new Error("The Git source changed while it was copied")
    hash.update(buffer.subarray(0, read.bytesRead))
    let written = 0
    while (written < read.bytesRead) {
      const result = await destination.write(buffer, written, read.bytesRead - written, position + written)
      if (result.bytesWritten < 1) throw new Error("The sealed Git copy could not be completed")
      written += result.bytesWritten
    }
    position += read.bytesRead
  }
  return `sha256:${hash.digest("hex")}` as const
}

async function digestOpenedFile(handle: FileHandle, size: number) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size))
  let position = 0
  while (position < size) {
    const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - position), position)
    if (read.bytesRead < 1) return null
    hash.update(buffer.subarray(0, read.bytesRead))
    position += read.bytesRead
  }
  return `sha256:${hash.digest("hex")}` as const
}

export async function validatePreparedGit(binaries: TrustedBinaries, limits: GitInspectionLimits) {
  const owner = process.getuid?.()
  if (owner === undefined) return false
  const directoryFacts = await safeLstat(dirname(binaries.gitPath))
  if (
    !directoryFacts?.isDirectory() ||
    String(directoryFacts.dev) !== binaries.gitIdentity.directoryDevice ||
    String(directoryFacts.ino) !== binaries.gitIdentity.directoryInode ||
    (directoryFacts.mode & 0o777) !== 0o500 ||
    directoryFacts.uid !== owner
  ) {
    return false
  }
  const handle = await openNoFollow(binaries.gitPath, constants.O_RDONLY)
  if (!handle) return false
  try {
    const facts = await handle.stat()
    if (
      !facts.isFile() ||
      facts.size !== binaries.gitIdentity.size ||
      facts.size > limits.maxGitBinaryBytes ||
      String(facts.dev) !== binaries.gitIdentity.device ||
      String(facts.ino) !== binaries.gitIdentity.inode ||
      (facts.mode & 0o777) !== 0o500 ||
      facts.uid !== owner
    ) {
      return false
    }
    return (await digestOpenedFile(handle, facts.size)) === binaries.gitIdentity.digest
  } finally {
    await handle.close()
  }
}

async function trustedSystemExecutable(candidate: string) {
  const path = await safeRealpath(candidate)
  if (path !== candidate || !isAbsolute(path) || path.includes("\0")) return null
  const rootFacts = await safeLstat("/")
  if (!rootFacts?.isDirectory() || !trustedOwnerAndMode(rootFacts.uid, rootFacts.mode)) return null
  const parts = path.split("/").filter(Boolean)
  let current = "/"
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const facts = await safeLstat(current)
    if (!facts || !trustedOwnerAndMode(facts.uid, facts.mode) || facts.isSymbolicLink()) return null
    if (index < parts.length - 1 && !facts.isDirectory()) return null
    if (index === parts.length - 1 && (!facts.isFile() || (facts.mode & 0o111) === 0)) return null
  }
  return path
}

async function selectEphemeralParent(workspaceRoot: string) {
  for (const candidate of [tmpdir(), "/private/tmp", "/tmp"]) {
    const path = await safeRealpath(candidate)
    const facts = path ? await safeLstat(path) : null
    if (path && facts?.isDirectory() && !isWithin(workspaceRoot, path)) return path
  }
  return null
}

async function cleanupEphemeralDirectory(directory: string) {
  try {
    await chmod(directory, 0o700)
    await rm(directory, { recursive: true })
    return true
  } catch {
    return false
  }
}

function isWithin(root: string, candidate: string) {
  const path = relative(root, candidate)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export async function runSandboxedGit(input: SandboxedGitInput): Promise<ProcessResult> {
  const invocation = buildSandboxInvocation(input)
  const child = Bun.spawn([...invocation.arguments], {
    env: invocation.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, input.limits.timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(child.stdout, input.limits.maxStdoutBytes, () => child.kill("SIGKILL")),
    readBounded(child.stderr, input.limits.maxStderrBytes, () => child.kill("SIGKILL")),
  ])
  clearTimeout(timeout)

  if (timedOut) return { ok: false, reason: "git_process_timeout" }
  if (!stdout.ok) return { ok: false, reason: "git_stdout_limit_exceeded" }
  if (!stderr.ok) return { ok: false, reason: "git_stderr_limit_exceeded" }
  if (exitCode !== 0) {
    if (decodeText(stderr.bytes)?.startsWith("sandbox-exec:")) {
      return { ok: false, reason: "sandbox_profile_rejected" }
    }
    return { ok: false, reason: "git_process_failed", stdout: stdout.bytes, stderr: stderr.bytes }
  }
  if (stderr.bytes.byteLength > 0) {
    return { ok: false, reason: "git_process_stderr", stdout: stdout.bytes, stderr: stderr.bytes }
  }
  return { ok: true, stdout: stdout.bytes }
}

export function buildSandboxInvocation(input: SandboxedGitInput) {
  return {
    arguments: [
      input.sandboxPath,
      "-D",
      `GIT_PATH=${input.gitPath}`,
      "-p",
      sandboxProfile,
      input.gitPath,
      ...gitArguments(input.workspaceRoot, input.command),
    ],
    environment: sanitizedGitEnvironment(),
  } as const
}

function gitArguments(workspaceRoot: string, command: SandboxedGitInput["command"]) {
  const common = [
    "--no-pager",
    "--no-lazy-fetch",
    "--no-optional-locks",
    "--no-replace-objects",
    `--git-dir=${join(workspaceRoot, ".git")}`,
    `--work-tree=${workspaceRoot}`,
    ...(command === "index-fsmonitor-valid" ? [] : ["-c", "core.fsmonitor=false"]),
    "-c",
    "core.preloadIndex=false",
    "-c",
    "core.filemode=true",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "core.editor=true",
    "-c",
    "sequence.editor=true",
    "-c",
    "core.pager=cat",
    "-c",
    "pager.status=false",
    "-c",
    "diff.external=",
    "-c",
    "interactive.diffFilter=",
    "-c",
    "submodule.recurse=false",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "advice.detachedHead=false",
    "-c",
    "advice.statusHints=false",
  ]
  if (command === "index-assume-unchanged") {
    return [...common, "ls-files", "--full-name", "--stage", "-v", "-z", "--", ":(top)"]
  }
  if (command === "index-fsmonitor-valid") {
    return [...common, "ls-files", "--full-name", "--stage", "-f", "-z", "--", ":(top)"]
  }
  return [
    ...common,
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--show-stash",
    "--ahead-behind",
    "--untracked-files=all",
    "--ignore-submodules=all",
    "--no-renames",
  ]
}

function sanitizedGitEnvironment() {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ADVICE: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onLimit: () => void) {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) return { ok: true, bytes: Buffer.concat(chunks, length) } as const
    length += next.value.byteLength
    if (length > limit) {
      onLimit()
      return { ok: false } as const
    }
    chunks.push(next.value)
  }
}

type BoundaryBudget = { deadline: number; entries: number; maxEntries: number }

async function inspectRepositoryBoundary(
  workspaceRoot: string,
  limits: GitInspectionLimits,
  deadline = performance.now() + limits.maxBoundaryDurationMs,
) {
  const budget: BoundaryBudget = { deadline, entries: 0, maxEntries: limits.maxBoundaryEntries }
  if (deadlineExceeded(budget)) return { ok: false, reason: "boundary_time_limit_exceeded" } as const
  if (!isAbsolute(workspaceRoot)) return { ok: false, reason: "workspace_path_not_absolute" } as const
  if (resolve(workspaceRoot) !== workspaceRoot) return { ok: false, reason: "workspace_not_canonical" } as const
  const rootFacts = await safeLstat(workspaceRoot)
  if (!rootFacts) return { ok: false, reason: "workspace_unreadable" } as const
  if (rootFacts.isSymbolicLink()) return { ok: false, reason: "workspace_not_canonical" } as const
  if (!rootFacts.isDirectory()) return { ok: false, reason: "workspace_not_directory" } as const
  const physicalRoot = await safeRealpath(workspaceRoot)
  if (physicalRoot !== workspaceRoot) return { ok: false, reason: "workspace_not_canonical" } as const

  const rootNames = await readNames(workspaceRoot, budget)
  if (!rootNames.ok) return rootNames
  const gitNames = rootNames.names.filter((name) => name.toLowerCase() === ".git")
  if (gitNames.length === 0) return { ok: false, reason: "git_metadata_missing" } as const
  if (gitNames.length !== 1 || gitNames[0] !== ".git")
    return { ok: false, reason: "git_metadata_case_variant" } as const
  const gitFacts = await safeLstat(join(workspaceRoot, ".git"))
  if (!gitFacts?.isDirectory()) return { ok: false, reason: "git_metadata_not_directory" } as const

  const ancestor = await hasAncestorGit(workspaceRoot, budget)
  if (!ancestor.ok) return ancestor
  if (ancestor.present) return { ok: false, reason: "ancestor_git_repository" } as const

  const metadata = await scanGitMetadata(join(workspaceRoot, ".git"), budget)
  if (!metadata.ok) return metadata
  const nested = await hasNestedGit(workspaceRoot, budget)
  if (!nested.ok) return nested
  if (nested.present) return { ok: false, reason: "nested_git_repository" } as const
  if (deadlineExceeded(budget)) return { ok: false, reason: "boundary_time_limit_exceeded" } as const
  return {
    ok: true,
    identity: {
      rootDevice: String(rootFacts.dev),
      rootInode: String(rootFacts.ino),
      gitDevice: String(gitFacts.dev),
      gitInode: String(gitFacts.ino),
      metadataDigest: metadata.digest,
    },
  } as const
}

async function hasAncestorGit(workspaceRoot: string, budget: BoundaryBudget) {
  const parents = workspaceRoot.split("/").slice(1, -1)
  let current = "/"
  for (const part of parents) {
    if (deadlineExceeded(budget)) return { ok: false, reason: "boundary_time_limit_exceeded" } as const
    current = join(current, part)
    const names = await readNames(current, budget)
    if (!names.ok) return names
    if (names.names.some((name) => name.toLowerCase() === ".git")) return { ok: true, present: true } as const
  }
  return { ok: true, present: false } as const
}

async function hasNestedGit(workspaceRoot: string, budget: BoundaryBudget) {
  const pending = [workspaceRoot]
  while (pending.length > 0) {
    if (deadlineExceeded(budget)) return { ok: false, reason: "boundary_time_limit_exceeded" } as const
    const directory = pending.pop()!
    const physical = await safeRealpath(directory)
    if (!physical || physical !== directory || !isWithin(workspaceRoot, physical)) {
      return { ok: false, reason: "boundary_unreadable" } as const
    }
    const handle = await safeOpendir(directory)
    if (!handle) return { ok: false, reason: "boundary_unreadable" } as const
    try {
      for await (const entry of handle) {
        const limit = consumeBoundaryEntry(budget)
        if (limit) return { ok: false, reason: limit } as const
        if (directory === workspaceRoot && entry.name === ".git") continue
        if (entry.name.toLowerCase() === ".git") return { ok: true, present: true } as const
        if (entry.isDirectory()) {
          pending.push(join(directory, entry.name))
          continue
        }
        if (entry.isFile() || entry.isSymbolicLink()) continue
        const child = join(directory, entry.name)
        const facts = await safeLstat(child)
        if (!facts) return { ok: false, reason: "boundary_unreadable" } as const
        if (facts.isDirectory()) pending.push(child)
      }
    } catch {
      return { ok: false, reason: "boundary_unreadable" } as const
    }
  }
  return { ok: true, present: false } as const
}

async function scanGitMetadata(gitRoot: string, budget: BoundaryBudget) {
  const hash = createHash("sha256")
  hash.update("astra.git-metadata-identity.v1\0")
  const pending = [gitRoot]
  while (pending.length > 0) {
    if (deadlineExceeded(budget)) return { ok: false, reason: "boundary_time_limit_exceeded" } as const
    const directory = pending.pop()!
    const physical = await safeRealpath(directory)
    if (!physical || physical !== directory || !isWithin(gitRoot, physical)) {
      return { ok: false, reason: "git_metadata_symlink" } as const
    }
    const before = await safeLstat(directory)
    if (!before?.isDirectory()) return { ok: false, reason: "git_metadata_symlink" } as const
    const handle = await safeOpendir(directory)
    if (!handle) return { ok: false, reason: "boundary_unreadable" } as const
    try {
      for await (const entry of handle) {
        const limit = consumeBoundaryEntry(budget)
        if (limit) return { ok: false, reason: limit } as const
        const relativeDirectory = relative(gitRoot, directory)
        const caseVariant = expectedMetadataName(relativeDirectory, entry.name)
        if (caseVariant && caseVariant !== entry.name) {
          return { ok: false, reason: "git_metadata_case_variant" } as const
        }
        if (relativeDirectory === "" && entry.name === "commondir") {
          return { ok: false, reason: "git_commondir_unsupported" } as const
        }
        if (relativeDirectory === "" && entry.name === "worktrees") {
          return { ok: false, reason: "git_worktree_metadata_unsupported" } as const
        }
        if (relativeDirectory === "" && entry.name === "modules") {
          return { ok: false, reason: "git_modules_metadata_unsupported" } as const
        }
        if (relativeDirectory === join("objects", "info") && isAlternatesName(entry.name)) {
          return { ok: false, reason: "git_alternates_unsupported" } as const
        }

        const child = join(directory, entry.name)
        const facts = await safeLstat(child)
        if (!facts) return { ok: false, reason: "boundary_unreadable" } as const
        if (facts.isSymbolicLink()) return { ok: false, reason: "git_metadata_symlink" } as const
        const childRelative = relative(gitRoot, child)
        hash.update(`${childRelative}\0${facts.dev}\0${facts.ino}\0${facts.mode}\0${facts.size}\0${facts.mtimeMs}\0`)
        if (facts.isDirectory()) pending.push(child)
      }
    } catch {
      return { ok: false, reason: "boundary_unreadable" } as const
    }
    const after = await safeLstat(directory)
    if (!after?.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      return { ok: false, reason: "git_metadata_identity_changed" } as const
    }
  }
  return { ok: true, digest: `sha256:${hash.digest("hex")}` as const } as const
}

async function readNames(path: string, budget: BoundaryBudget) {
  const handle = await safeOpendir(path)
  if (!handle) return { ok: false, reason: "boundary_unreadable" } as const
  const names: Array<string> = []
  try {
    for await (const entry of handle) {
      const limit = consumeBoundaryEntry(budget)
      if (limit) return { ok: false, reason: limit } as const
      names.push(entry.name)
    }
    return { ok: true, names } as const
  } catch {
    return { ok: false, reason: "boundary_unreadable" } as const
  }
}

function expectedMetadataName(relativeDirectory: string, name: string) {
  const expected =
    relativeDirectory === ""
      ? [
          "HEAD",
          "config",
          "index",
          "objects",
          "refs",
          "logs",
          "hooks",
          "info",
          "packed-refs",
          "shallow",
          "commondir",
          "worktrees",
          "modules",
        ]
      : relativeDirectory === "objects"
        ? ["info", "pack"]
        : relativeDirectory === join("objects", "info")
          ? ["alternates", "http-alternates"]
          : []
  return expected.find((value) => value.toLowerCase() === name.toLowerCase()) ?? null
}

function isAlternatesName(name: string) {
  return name === "alternates" || name === "http-alternates"
}

function consumeBoundaryEntry(budget: BoundaryBudget): GitInspectionBlockReason | null {
  if (deadlineExceeded(budget)) return "boundary_time_limit_exceeded"
  budget.entries += 1
  return budget.entries > budget.maxEntries ? "boundary_entry_limit_exceeded" : null
}

function deadlineExceeded(budget: BoundaryBudget) {
  return performance.now() > budget.deadline
}

function validLimits(limits: GitInspectionLimits) {
  return Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
}

function blocked(workspaceRoot: string, reason: GitInspectionBlockReason): GitInspectionBlocked {
  return {
    status: "blocked",
    mode: "bounded_read_only",
    baseline: "not_captured",
    activationAllowed: false,
    verification: "not_verified",
    submodules: "not_inspected",
    workspaceRoot,
    reason,
  }
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity) {
  return (
    left.rootDevice === right.rootDevice &&
    left.rootInode === right.rootInode &&
    left.gitDevice === right.gitDevice &&
    left.gitInode === right.gitInode &&
    left.metadataDigest === right.metadataDigest
  )
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return Buffer.from(left).equals(Buffer.from(right))
}

function digestBytes(...chunks: ReadonlyArray<Uint8Array>): `sha256:${string}` {
  const hash = createHash("sha256")
  for (const chunk of chunks) hash.update(chunk)
  return `sha256:${hash.digest("hex")}`
}

function trustedOwnerAndMode(uid: number, mode: number) {
  return uid === 0 && (mode & 0o022) === 0
}

function decodeText(value: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    return null
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path)
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

async function safeReadlink(path: string) {
  try {
    return await readlink(path)
  } catch {
    return null
  }
}

async function safeOpendir(path: string) {
  try {
    return await opendir(path)
  } catch {
    return null
  }
}

async function openNoFollow(path: string, flags: number) {
  try {
    return await open(path, flags | constants.O_NOFOLLOW)
  } catch {
    return null
  }
}
