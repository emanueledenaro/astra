import {
  computeGitRepositoryBaselineSnapshotDigest,
  parseGitRepositoryBaselineLimits,
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineBlockReason,
  type GitRepositoryBaselineCaptureResult,
  type GitRepositoryBaselineHead,
  type GitRepositoryBaselineLimits,
  type GitRepositoryBaselineRevalidationResult,
  type GitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshotAuthority,
} from "@astra/domain/git-repository-baseline"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import {
  inspectRepositoryBoundary,
  observeGit,
  observeGitRefs,
  prepareTrustedBinaries,
  runSandboxedGit,
  sameRepositoryIdentity,
  validatePreparedGit,
  type GitInspectorDependencies,
  type RepositoryIdentity,
  type TrustedBinaries,
} from "./inspect"
import { indexMatchesStatus, parseGitIndexOutput, parseGitStatusOutput, type ParsedGitIndexEntry } from "./parser"
import type { GitInspectionLimits } from "./types"

const noFollowAny = 0x20000000
const adapter = "astra.git-baseline.v1" as const
const adapterDigest = digestText(
  "astra.git-baseline-adapter.v1\0darwin-sandboxed-git\0workspace-read-allowlist\0double-git-observation\0double-raw-content-observation\0nofollow-any\0ignored-excluded\0external-config-unsupported\0metadata-executable-bits\0end-to-end-deadline\0bounded-inner-reads\0direct-git-directory-only",
)

export const defaultGitRepositoryBaselineLimits = {
  timeoutMs: 2_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  maxEntries: 25_000,
  maxBoundaryEntries: 250_000,
  maxBoundaryDurationMs: 15_000,
  maxGitBinaryBytes: 64 * 1024 * 1024,
  maxContentEntries: 25_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDurationMs: 60_000,
} as const satisfies GitRepositoryBaselineLimits

type BaselineHooks = Readonly<{
  afterInitialBoundary?: () => Promise<void>
  afterConfigPreflight?: () => Promise<void>
  afterFirstContentObservation?: () => Promise<void>
  beforeFileReadChunk?: () => Promise<void>
}>
type ContentBudget = {
  deadline: number
  entries: number
  traversalEntries: number
  bytes: number
  limits: GitRepositoryBaselineLimits
}
type InternalContent =
  | Readonly<{ path: string; state: "absent" }>
  | Readonly<{
      path: string
      state: "present"
      kind: "regular" | "symlink"
      executable: boolean
      byteLength: number
      contentDigest: `sha256:${string}`
    }>
type InternalMetadataFile = Readonly<{
  path: string
  executable: boolean
  byteLength: number
  contentDigest: `sha256:${string}`
  bytes: Uint8Array | null
}>

const productionDependencies: GitInspectorDependencies = {
  platform: process.platform,
  prepareTrustedBinaries,
  validatePreparedGit,
  runSandboxedGit,
}

export async function captureGitRepositoryBaseline(
  workspaceRoot: string,
  overrides: Partial<GitRepositoryBaselineLimits> = {},
): Promise<GitRepositoryBaselineCaptureResult> {
  return captureGitRepositoryBaselineWithHooks(workspaceRoot, overrides, {})
}

export async function captureGitRepositoryBaselineWithHooks(
  workspaceRoot: string,
  overrides: Partial<GitRepositoryBaselineLimits>,
  hooks: BaselineHooks,
): Promise<GitRepositoryBaselineCaptureResult> {
  const root = resolve(workspaceRoot)
  const parsedLimits = parseGitRepositoryBaselineLimits({ ...defaultGitRepositoryBaselineLimits, ...overrides })
  if (!parsedLimits.ok) return blocked(root, "invalid_limits")
  if (productionDependencies.platform !== "darwin") return blocked(root, "unsupported_platform")

  const deadline = performance.now() + parsedLimits.value.maxDurationMs
  const initial = await inspectRepositoryBoundary(
    workspaceRoot,
    parsedLimits.value,
    boundaryDeadline(parsedLimits.value, deadline),
  )
  if (!initial.ok) return blocked(root, initial.reason)
  if (performance.now() > deadline) return blocked(root, "content_time_limit_exceeded")
  const binaries = await productionDependencies
    .prepareTrustedBinaries(root, parsedLimits.value, deadline)
    .catch(() => null)
  if (performance.now() > deadline) return blocked(root, "content_time_limit_exceeded")
  if (!binaries) return blocked(root, "git_binary_untrusted")

  let result: GitRepositoryBaselineCaptureResult = blocked(root, "git_process_failed")
  let cleanupSucceeded = false
  try {
    result = await captureWithPreparedGit(root, parsedLimits.value, deadline, initial.identity, binaries, hooks).catch(
      () => blocked(root, "git_process_failed"),
    )
  } finally {
    cleanupSucceeded = await binaries.cleanup().catch(() => false)
  }
  if (!cleanupSucceeded) return blocked(root, "git_ephemeral_cleanup_failed")
  return performance.now() > deadline ? blocked(root, "content_time_limit_exceeded") : result
}

export async function revalidateGitRepositoryBaseline(
  workspaceRoot: string,
  expected: GitRepositoryBaselineSnapshot,
): Promise<GitRepositoryBaselineRevalidationResult> {
  const expectedDigest = digestValue(expected?.snapshotDigest) ? expected.snapshotDigest : null
  if ((expected as { schemaVersion?: unknown })?.schemaVersion !== 1) {
    return { status: "blocked", expectedSnapshotDigest: expectedDigest, reason: "schema_unsupported" }
  }
  const parsed = parseGitRepositoryBaselineSnapshot(expected)
  if (!parsed.ok) return { status: "blocked", expectedSnapshotDigest: expectedDigest, reason: "invalid_snapshot" }
  if (parsed.value.observer.adapterDigest !== adapterDigest || parsed.value.observer.adapter !== adapter) {
    return {
      status: "blocked",
      expectedSnapshotDigest: parsed.value.snapshotDigest,
      reason: "adapter_policy_changed",
    }
  }

  const current = await captureGitRepositoryBaseline(workspaceRoot, parsed.value.limits)
  if (current.status === "blocked") {
    return { status: "blocked", expectedSnapshotDigest: parsed.value.snapshotDigest, reason: current.reason }
  }
  return {
    status: current.snapshot.snapshotDigest === parsed.value.snapshotDigest ? "current" : "stale",
    expectedSnapshotDigest: parsed.value.snapshotDigest,
    currentSnapshotDigest: current.snapshot.snapshotDigest,
  }
}

async function captureWithPreparedGit(
  root: string,
  limits: GitRepositoryBaselineLimits,
  deadline: number,
  initialIdentity: RepositoryIdentity,
  binaries: TrustedBinaries,
  hooks: BaselineHooks,
): Promise<GitRepositoryBaselineCaptureResult> {
  await hooks.afterInitialBoundary?.()
  const firstConfig = await inspectLocalGitConfig(root, limits, deadline, hooks)
  if (!firstConfig.ok) return blocked(root, firstConfig.reason)
  await hooks.afterConfigPreflight?.()
  if (performance.now() > deadline) return blocked(root, "content_time_limit_exceeded")
  const firstGit = await observeAllGit(root, limits, binaries, deadline)
  if (!firstGit.ok) return blocked(root, firstGit.reason)
  const firstParsed = parseObservation(firstGit, limits.maxEntries)
  if (!firstParsed.ok) return blocked(root, firstParsed.reason)
  const firstContent = await captureAllContent(root, limits, deadline, firstParsed.value, hooks)
  if (!firstContent.ok) return blocked(root, firstContent.reason)
  if (firstConfig.value.contentDigest !== firstContent.value.configDigest) {
    return blocked(root, "metadata_content_changed")
  }

  await hooks.afterFirstContentObservation?.()
  const middle = await inspectRepositoryBoundary(root, limits, boundaryDeadline(limits, deadline))
  if (!middle.ok) return blocked(root, middle.reason)
  if (!sameRepositoryIdentity(initialIdentity, middle.identity)) return blocked(root, "workspace_identity_changed")

  const secondConfig = await inspectLocalGitConfig(root, limits, deadline, hooks)
  if (!secondConfig.ok) return blocked(root, secondConfig.reason)
  await hooks.afterConfigPreflight?.()
  if (performance.now() > deadline) return blocked(root, "content_time_limit_exceeded")
  const secondGit = await observeAllGit(root, limits, binaries, deadline)
  if (!secondGit.ok) return blocked(root, secondGit.reason)
  const secondParsed = parseObservation(secondGit, limits.maxEntries)
  if (!secondParsed.ok) return blocked(root, secondParsed.reason)
  const secondContent = await captureAllContent(root, limits, deadline, secondParsed.value, hooks)
  if (!secondContent.ok) return blocked(root, secondContent.reason)
  if (secondConfig.value.contentDigest !== secondContent.value.configDigest) {
    return blocked(root, "metadata_content_changed")
  }
  const final = await inspectRepositoryBoundary(root, limits, boundaryDeadline(limits, deadline))
  if (!final.ok) return blocked(root, final.reason)
  if (!sameRepositoryIdentity(initialIdentity, final.identity)) return blocked(root, "workspace_identity_changed")
  if (performance.now() > deadline) return blocked(root, "content_time_limit_exceeded")

  if (!sameGitObservation(firstGit, secondGit)) return blocked(root, "observation_changed")
  if (firstContent.value.canonicalDigest !== secondContent.value.canonicalDigest) {
    return blocked(root, "content_observation_changed")
  }

  const gitDirectory = join(root, ".git")
  const draft = {
    schemaVersion: 1 as const,
    mode: "bounded_read_only" as const,
    durability: "ephemeral" as const,
    verification: "not_verified" as const,
    contentPolicy: {
      tracked: "raw_content_type_and_executable" as const,
      untracked: "raw_content_type_and_executable" as const,
      symlinks: "raw_link_text_no_follow" as const,
      ignored: "excluded" as const,
      specialFiles: "blocked" as const,
    },
    root: {
      canonicalPath: root,
      device: initialIdentity.rootDevice,
      inode: initialIdentity.rootInode,
    },
    gitDirectory: {
      canonicalPath: gitDirectory,
      device: initialIdentity.gitDevice,
      inode: initialIdentity.gitInode,
    },
    commonDirectory: {
      canonicalPath: gitDirectory,
      device: initialIdentity.gitDevice,
      inode: initialIdentity.gitInode,
    },
    head: firstContent.value.head,
    refs: {
      digest: firstParsed.value.refsDigest,
      count: firstParsed.value.refs.length,
    },
    index: {
      digest: firstParsed.value.indexDigest,
      metadataDigest: firstContent.value.indexMetadataDigest,
      entryCount: firstParsed.value.indexEntries.length,
    },
    worktree: {
      digest: firstContent.value.worktreeDigest,
      ignored: "excluded" as const,
      trackedPaths: firstContent.value.tracked.length,
      untrackedPaths: firstContent.value.untracked.length,
      contentEntries: [...firstContent.value.tracked, ...firstContent.value.untracked].filter(
        (value) => value.state === "present",
      ).length,
      totalBytes: [...firstContent.value.tracked, ...firstContent.value.untracked].reduce(
        (total, value) => total + (value.state === "present" ? value.byteLength : 0),
        0,
      ),
    },
    metadata: {
      digest: firstContent.value.metadataDigest,
      fileCount: firstContent.value.metadataFiles.length,
      totalBytes: firstContent.value.metadataFiles.reduce((total, value) => total + value.byteLength, 0),
      externalConfig: "unsupported" as const,
    },
    observer: {
      adapter,
      adapterDigest,
      gitBinaryDigest: binaries.gitIdentity.digest,
      observationDigest: digestBytes(
        new TextEncoder().encode("astra.git-baseline-observation.v1\0"),
        firstGit.status,
        firstGit.indexAssumeUnchanged,
        firstGit.indexFsmonitorValid,
        firstGit.refs,
      ),
    },
    limits,
  } satisfies GitRepositoryBaselineSnapshotAuthority
  const snapshot = {
    ...draft,
    snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(draft),
  }
  if (!parseGitRepositoryBaselineSnapshot(snapshot).ok) return blocked(root, "invalid_snapshot")
  return { status: "complete", snapshot }
}

async function observeAllGit(root: string, limits: GitInspectionLimits, binaries: TrustedBinaries, deadline: number) {
  const observation = await observeGit(productionDependencies, binaries, root, limits, deadline).catch(
    () => ({ ok: false, reason: "git_process_failed" }) as const,
  )
  if (performance.now() > deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
  if (!observation.ok) return observation
  const refs = await observeGitRefs(productionDependencies, binaries, root, limits, deadline).catch(
    () => ({ ok: false, reason: "git_process_failed" }) as const,
  )
  if (performance.now() > deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
  if (!refs.ok) return refs
  return { ...observation, refs: refs.stdout } as const
}

function parseObservation(
  observation: Extract<Awaited<ReturnType<typeof observeAllGit>>, { ok: true }>,
  maxEntries: number,
) {
  const status = parseGitStatusOutput(observation.status, maxEntries)
  if (!status.ok) return status
  const indexAssumeUnchanged = parseGitIndexOutput(observation.indexAssumeUnchanged, maxEntries, "assume-unchanged")
  if (!indexAssumeUnchanged.ok) return indexAssumeUnchanged
  const indexFsmonitorValid = parseGitIndexOutput(observation.indexFsmonitorValid, maxEntries, "fsmonitor-valid")
  if (!indexFsmonitorValid.ok) return indexFsmonitorValid
  if (indexAssumeUnchanged.value.hasAssumeUnchanged) {
    return { ok: false, reason: "git_index_assume_unchanged" } as const
  }
  if (indexAssumeUnchanged.value.hasSkipWorktree) return { ok: false, reason: "git_index_skip_worktree" } as const
  if (indexFsmonitorValid.value.hasFsmonitorValid) return { ok: false, reason: "git_index_fsmonitor_valid" } as const
  if (indexAssumeUnchanged.value.hasGitlink || indexFsmonitorValid.value.hasGitlink) {
    return { ok: false, reason: "submodules_uninspected" } as const
  }
  if (!indexMatchesStatus(status.value, indexAssumeUnchanged.value, indexFsmonitorValid.value)) {
    return { ok: false, reason: "git_index_observation_mismatch" } as const
  }
  const refs = parseRefs(observation.refs, status.value.oidLength, maxEntries)
  if (!refs.ok) return refs
  const indexEntries = [...indexAssumeUnchanged.value.entries].sort(compareIndexEntries)
  return {
    ok: true,
    value: {
      status: status.value,
      indexEntries,
      indexDigest: digestText(
        `astra.git-logical-index.v1\0${indexEntries
          .map((entry) => `${entry.path}\0${entry.stage}\0${entry.mode}\0${entry.oid}\0`)
          .join("")}`,
      ),
      refs: refs.value,
      refsDigest: digestText(
        `astra.git-refs.v1\0${refs.value.map((value) => `${value.name}\0${value.oid}\0`).join("")}`,
      ),
      oidLength: status.value.oidLength ?? indexAssumeUnchanged.value.oidLength,
    },
  } as const
}

function parseRefs(output: Uint8Array, expectedOidLength: 40 | 64 | null, maxEntries: number) {
  const text = decode(output)
  if (text === null) return { ok: false, reason: "git_output_invalid_utf8" } as const
  if (text.length === 0) return { ok: true, value: [] } as const
  if (!text.endsWith("\n")) return { ok: false, reason: "git_refs_malformed" } as const
  const values: Array<Readonly<{ name: string; oid: string }>> = []
  const names = new Set<string>()
  for (const record of text.slice(0, -1).split("\n")) {
    if (values.length >= maxEntries) return { ok: false, reason: "git_entry_limit_exceeded" } as const
    const separator = record.indexOf("\0")
    const name = record.slice(0, separator)
    const oid = record.slice(separator + 1)
    if (
      separator < 1 ||
      names.has(name) ||
      !safeRef(name) ||
      !objectId(oid) ||
      (expectedOidLength !== null && oid.length !== expectedOidLength)
    ) {
      return { ok: false, reason: "git_refs_malformed" } as const
    }
    names.add(name)
    values.push({ name, oid })
  }
  values.sort((left, right) => comparePaths(left.name, right.name))
  return { ok: true, value: values } as const
}

async function captureAllContent(
  root: string,
  limits: GitRepositoryBaselineLimits,
  deadline: number,
  observation: Extract<ReturnType<typeof parseObservation>, { ok: true }>["value"],
  hooks: BaselineHooks,
) {
  const budget = contentBudget(limits, deadline)
  const metadata = await captureMetadata(root, budget, hooks)
  if (!metadata.ok) return metadata
  const indexBytes = metadata.value.files.find((value) => value.path === "index")?.bytes ?? null
  const indexFormat = validateIndexFile(indexBytes, observation.indexEntries.length, observation.oidLength)
  if (!indexFormat.ok) return indexFormat
  const head = parseHead(metadata.value.files, observation.status.branch, observation.refs)
  if (!head.ok) return head

  const trackedPaths = [...new Set(observation.indexEntries.map((entry) => entry.path))].sort(comparePaths)
  const tracked = await capturePathList(root, trackedPaths, budget, hooks)
  if (!tracked.ok) return tracked
  const untracked = await capturePathList(root, observation.status.untracked, budget, hooks)
  if (!untracked.ok) return untracked
  const worktreeDigest = digestText(
    `astra.git-raw-worktree.v1\0${[...tracked.value, ...untracked.value].map(encodeContent).join("")}`,
  )
  const metadataDigest = digestText(
    `astra.git-relevant-metadata.v1\0${metadata.value.files
      .map((value) => `${value.path}\0${value.executable}\0${value.byteLength}\0${value.contentDigest}\0`)
      .join("")}`,
  )
  const indexMetadataDigest =
    metadata.value.files.find((value) => value.path === "index")?.contentDigest ??
    digestText("astra.git-index.absent.v1")
  return {
    ok: true,
    value: {
      head: head.value,
      tracked: tracked.value,
      untracked: untracked.value,
      worktreeDigest,
      metadataFiles: metadata.value.files,
      metadataDigest,
      configDigest: localGitConfigDigest(metadata.value.files),
      indexMetadataDigest,
      canonicalDigest: digestText(
        `astra.git-captured-content.v1\0${worktreeDigest}\0${metadataDigest}\0${indexMetadataDigest}\0${JSON.stringify(head.value)}`,
      ),
    },
  } as const
}

async function captureMetadata(root: string, budget: ContentBudget, hooks: BaselineHooks) {
  const gitRoot = join(root, ".git")
  const paths = new Set(["HEAD", "config", "index", "packed-refs", "shallow", "info/attributes", "info/exclude"])
  for (const path of [
    "config.worktree",
    "MERGE_HEAD",
    "MERGE_MODE",
    "MERGE_MSG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "ORIG_HEAD",
    "FETCH_HEAD",
  ]) {
    paths.add(path)
  }
  for (const directory of ["refs", "hooks"]) {
    const collected = await collectFiles(gitRoot, directory, budget)
    if (!collected.ok) return collected
    for (const path of collected.value) paths.add(path)
  }
  const files: Array<InternalMetadataFile> = []
  for (const path of [...paths].sort(comparePaths)) {
    const retainBytes = ["HEAD", "config", "config.worktree", "index"].includes(path)
    const content = await capturePath(gitRoot, path, budget, retainBytes, hooks)
    if (!content.ok) return content
    if (content.value.state === "absent") continue
    if (content.value.kind !== "regular") return { ok: false, reason: "content_special_file" } as const
    files.push({ ...content.value, bytes: retainBytes ? content.bytes : null })
  }
  const configPolicy = validateLocalGitConfigs(files)
  if (!configPolicy.ok) return configPolicy
  return { ok: true, value: { files } } as const
}

async function inspectLocalGitConfig(
  root: string,
  limits: GitRepositoryBaselineLimits,
  deadline: number,
  hooks: BaselineHooks,
) {
  const budget = contentBudget(limits, deadline)
  const files: Array<InternalMetadataFile> = []
  for (const path of ["config", "config.worktree"]) {
    const content = await capturePath(join(root, ".git"), path, budget, true, hooks)
    if (!content.ok) return content
    if (content.value.state === "absent") {
      if (path === "config") return { ok: false, reason: "content_path_unreadable" } as const
      continue
    }
    if (content.value.kind !== "regular" || !content.bytes) {
      return { ok: false, reason: "content_special_file" } as const
    }
    files.push({ ...content.value, bytes: content.bytes })
  }
  const configPolicy = validateLocalGitConfigs(files)
  if (!configPolicy.ok) return configPolicy
  return { ok: true, value: { contentDigest: localGitConfigDigest(files) } } as const
}

function validateLocalGitConfigs(files: ReadonlyArray<InternalMetadataFile>) {
  if (!files.some((file) => file.path === "config")) {
    return { ok: false, reason: "content_path_unreadable" } as const
  }
  for (const file of files.filter((candidate) => candidate.path === "config" || candidate.path === "config.worktree")) {
    if (!file.bytes) return { ok: false, reason: "content_path_unreadable" } as const
    const configText = decode(file.bytes)
    if (configText === null) return { ok: false, reason: "git_output_invalid_utf8" } as const
    if (/^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/imu.test(configText) || /^\s*include(?:if)?\./imu.test(configText)) {
      return { ok: false, reason: "git_config_include_unsupported" } as const
    }
  }
  return { ok: true } as const
}

function localGitConfigDigest(files: ReadonlyArray<InternalMetadataFile>) {
  const values = files
    .filter((file) => file.path === "config" || file.path === "config.worktree")
    .sort((left, right) => comparePaths(left.path, right.path))
  return digestText(
    `astra.git-local-config-set.v1\0${values
      .map((file) => `${file.path}\0${file.executable}\0${file.byteLength}\0${file.contentDigest}\0`)
      .join("")}`,
  )
}

function contentBudget(limits: GitRepositoryBaselineLimits, deadline: number): ContentBudget {
  return { deadline, entries: 0, traversalEntries: 0, bytes: 0, limits }
}

async function collectFiles(root: string, relativeDirectory: string, budget: ContentBudget) {
  const absolute = join(root, relativeDirectory)
  const facts = await lstatOptional(absolute)
  if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
  if (!facts.ok) return facts
  if (!facts.value) return { ok: true, value: [] } as const
  if (!facts.value.isDirectory() || facts.value.isSymbolicLink()) {
    return { ok: false, reason: "content_special_file" } as const
  }
  const files: Array<string> = []
  const pending = [relativeDirectory]
  while (pending.length > 0) {
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    const current = pending.pop()!
    const directory = await safeRealpath(join(root, current))
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (directory !== join(root, current)) return { ok: false, reason: "content_intermediate_symlink" } as const
    const handle = await safeOpendir(directory)
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (!handle) return { ok: false, reason: "content_path_unreadable" } as const
    try {
      for await (const entry of handle) {
        const limit = reserveTraversalEntry(budget)
        if (limit) return { ok: false, reason: limit } as const
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(path)
          continue
        }
        if (!entry.isFile()) return { ok: false, reason: "content_special_file" } as const
        files.push(path)
      }
    } catch {
      return { ok: false, reason: "content_path_unreadable" } as const
    }
  }
  files.sort(comparePaths)
  return { ok: true, value: files } as const
}

async function capturePathList(
  root: string,
  paths: ReadonlyArray<string>,
  budget: ContentBudget,
  hooks: BaselineHooks,
) {
  const values: Array<InternalContent> = []
  for (const path of paths) {
    const content = await capturePath(root, path, budget, false, hooks)
    if (!content.ok) return content
    values.push(content.value)
  }
  return { ok: true, value: values } as const
}

async function capturePath(
  root: string,
  path: string,
  budget: ContentBudget,
  retainBytes: boolean,
  hooks: BaselineHooks,
) {
  if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
  if (!safeLogicalPath(path)) return { ok: false, reason: "content_path_traversal" } as const
  const parents = path.split("/").slice(0, -1)
  let parent = root
  for (const part of parents) {
    parent = join(parent, part)
    const facts = await lstatOptional(parent)
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (!facts.ok) return facts
    if (!facts.value?.isDirectory() || facts.value.isSymbolicLink()) {
      return { ok: false, reason: "content_intermediate_symlink" } as const
    }
    const physicalParent = await safeRealpath(parent)
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (physicalParent !== parent) return { ok: false, reason: "content_intermediate_symlink" } as const
  }

  const absolute = join(root, path)
  if (!inside(root, absolute)) return { ok: false, reason: "content_path_traversal" } as const
  const before = await lstatOptional(absolute, true)
  if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
  if (!before.ok) return before
  if (!before.value) return { ok: true, value: { path, state: "absent" as const }, bytes: null } as const
  const limit = reserveEntry(budget, Number(before.value.size))
  if (limit) return { ok: false, reason: limit } as const

  if (before.value.isSymbolicLink()) {
    const target = await readlinkBuffer(absolute)
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (!target) return { ok: false, reason: "content_path_unreadable" } as const
    if (target.byteLength !== Number(before.value.size))
      return { ok: false, reason: "content_identity_changed" } as const
    const after = await lstatOptional(absolute, true)
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (!after.ok || !after.value || !sameFacts(before.value, after.value)) {
      return { ok: false, reason: "content_identity_changed" } as const
    }
    return {
      ok: true,
      value: {
        path,
        state: "present" as const,
        kind: "symlink" as const,
        executable: false,
        byteLength: target.byteLength,
        contentDigest: digestBytes(target),
      },
      bytes: retainBytes ? target : null,
    } as const
  }
  if (!before.value.isFile()) return { ok: false, reason: "content_special_file" } as const

  const handle = await openRegularNoFollow(absolute)
  if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
  if (!handle) return { ok: false, reason: "content_path_unreadable" } as const
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (!sameFacts(before.value, openedBefore)) return { ok: false, reason: "content_identity_changed" } as const
    const read = await readOpenedFile(handle, Number(openedBefore.size), budget.deadline, hooks.beforeFileReadChunk)
    if (!read.ok) return read
    const bytes = read.value
    const openedAfter = await handle.stat({ bigint: true })
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    const after = await lstatOptional(absolute, true)
    if (performance.now() > budget.deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (!after.ok || !after.value || !sameFacts(openedBefore, openedAfter) || !sameFacts(openedAfter, after.value)) {
      return { ok: false, reason: "content_identity_changed" } as const
    }
    return {
      ok: true,
      value: {
        path,
        state: "present" as const,
        kind: "regular" as const,
        executable: (Number(openedAfter.mode) & 0o111) !== 0,
        byteLength: bytes.byteLength,
        contentDigest: digestBytes(bytes),
      },
      bytes: retainBytes ? bytes : null,
    } as const
  } finally {
    await handle.close()
  }
}

function reserveEntry(budget: ContentBudget, bytes: number): GitRepositoryBaselineBlockReason | null {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "content_path_unreadable"
  if (bytes > budget.limits.maxFileBytes) return "content_file_limit_exceeded"
  budget.entries += 1
  if (budget.entries > budget.limits.maxContentEntries) return "content_entry_limit_exceeded"
  budget.bytes += bytes
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > budget.limits.maxTotalBytes) {
    return "content_total_limit_exceeded"
  }
  if (performance.now() > budget.deadline) return "content_time_limit_exceeded"
  return null
}

function reserveTraversalEntry(budget: ContentBudget): GitRepositoryBaselineBlockReason | null {
  budget.traversalEntries += 1
  if (budget.traversalEntries > budget.limits.maxBoundaryEntries) return "boundary_entry_limit_exceeded"
  if (performance.now() > budget.deadline) return "content_time_limit_exceeded"
  return null
}

function validateIndexFile(bytes: Uint8Array | null, expectedEntries: number, oidLength: 40 | 64 | null) {
  if (!bytes) {
    return expectedEntries === 0
      ? ({ ok: true } as const)
      : ({ ok: false, reason: "git_index_observation_mismatch" } as const)
  }
  if (oidLength === null || bytes.byteLength < 12 + oidLength / 2) {
    return { ok: false, reason: "git_index_format_unsupported" } as const
  }
  const buffer = Buffer.from(bytes)
  if (buffer.subarray(0, 4).toString("ascii") !== "DIRC") {
    return { ok: false, reason: "git_index_format_unsupported" } as const
  }
  const version = buffer.readUInt32BE(4)
  const entryCount = buffer.readUInt32BE(8)
  if (version !== 2 && version !== 3) {
    return { ok: false, reason: "git_index_format_unsupported" } as const
  }
  const checksumBytes = oidLength / 2
  const contentEnd = buffer.byteLength - checksumBytes
  const checksum = createHash(oidLength === 40 ? "sha1" : "sha256")
    .update(buffer.subarray(0, contentEnd))
    .digest()
  if (!checksum.equals(buffer.subarray(contentEnd)))
    return { ok: false, reason: "git_index_format_unsupported" } as const

  let offset = 12
  for (let index = 0; index < entryCount; index += 1) {
    const flagsOffset = offset + 40 + checksumBytes
    if (flagsOffset + 2 > contentEnd) return { ok: false, reason: "git_index_format_unsupported" } as const
    const flags = buffer.readUInt16BE(flagsOffset)
    const extended = (flags & 0x4000) !== 0
    if (extended && version !== 3) return { ok: false, reason: "git_index_format_unsupported" } as const
    const nameStart = flagsOffset + 2 + (extended ? 2 : 0)
    const nameEnd = buffer.indexOf(0, nameStart)
    if (nameEnd < nameStart || nameEnd >= contentEnd)
      return { ok: false, reason: "git_index_format_unsupported" } as const
    const length = nameEnd + 1 - offset
    offset += (length + 7) & ~7
  }
  const allowed = new Set(["TREE", "REUC", "UNTR", "EOIE", "IEOT"])
  while (offset < contentEnd) {
    if (offset + 8 > contentEnd) return { ok: false, reason: "git_index_format_unsupported" } as const
    const signature = buffer.subarray(offset, offset + 4).toString("ascii")
    const size = buffer.readUInt32BE(offset + 4)
    if (!allowed.has(signature)) return { ok: false, reason: "git_index_extension_unsupported" } as const
    offset += 8 + size
    if (offset > contentEnd) return { ok: false, reason: "git_index_format_unsupported" } as const
  }
  if (entryCount !== expectedEntries) {
    return { ok: false, reason: "git_index_observation_mismatch" } as const
  }
  return offset === contentEnd
    ? ({ ok: true } as const)
    : ({ ok: false, reason: "git_index_format_unsupported" } as const)
}

function parseHead(
  files: ReadonlyArray<InternalMetadataFile>,
  branch: Readonly<{ oid: string | null; head: string | null }>,
  refs: ReadonlyArray<Readonly<{ name: string; oid: string }>>,
) {
  const bytes = files.find((value) => value.path === "HEAD")?.bytes
  if (!bytes) return { ok: false, reason: "git_head_mismatch" } as const
  const value = decode(bytes)
  if (!value || !value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    return { ok: false, reason: "git_head_mismatch" } as const
  }
  const head = value.slice(0, -1)
  if (head.startsWith("ref: ")) {
    const symbolicRef = head.slice(5)
    if (!safeRef(symbolicRef)) return { ok: false, reason: "git_head_mismatch" } as const
    if (branch.oid === null) {
      if (branch.head === null || symbolicRef !== `refs/heads/${branch.head}`) {
        return { ok: false, reason: "git_head_mismatch" } as const
      }
      return { ok: true, value: { kind: "unborn", symbolicRef } as GitRepositoryBaselineHead } as const
    }
    const reference = refs.find((candidate) => candidate.name === symbolicRef)
    if (
      !reference ||
      reference.oid !== branch.oid ||
      branch.head === null ||
      symbolicRef !== `refs/heads/${branch.head}`
    ) {
      return { ok: false, reason: "git_head_mismatch" } as const
    }
    return { ok: true, value: { kind: "symbolic", symbolicRef, oid: branch.oid } as GitRepositoryBaselineHead } as const
  }
  if (!objectId(head) || branch.head !== null || branch.oid !== head) {
    return { ok: false, reason: "git_head_mismatch" } as const
  }
  return { ok: true, value: { kind: "detached", oid: head } as GitRepositoryBaselineHead } as const
}

function sameGitObservation(
  left: Extract<Awaited<ReturnType<typeof observeAllGit>>, { ok: true }>,
  right: Extract<Awaited<ReturnType<typeof observeAllGit>>, { ok: true }>,
) {
  return (
    equalBytes(left.status, right.status) &&
    equalBytes(left.indexAssumeUnchanged, right.indexAssumeUnchanged) &&
    equalBytes(left.indexFsmonitorValid, right.indexFsmonitorValid) &&
    equalBytes(left.refs, right.refs)
  )
}

function compareIndexEntries(left: ParsedGitIndexEntry, right: ParsedGitIndexEntry) {
  return comparePaths(left.path, right.path) || left.stage - right.stage
}

function comparePaths(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function encodeContent(value: InternalContent) {
  if (value.state === "absent") return `${value.path}\0absent\0`
  return `${value.path}\0${value.kind}\0${value.executable}\0${value.byteLength}\0${value.contentDigest}\0`
}

function safeLogicalPath(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  )
}

function safeRef(value: string) {
  return (
    /^refs\/[A-Za-z0-9][^\u0000-\u0020\u007f~^:?*[\\]*$/u.test(value) && !value.includes("..") && !value.endsWith(".")
  )
}

function objectId(value: string) {
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) && !/^0+$/u.test(value)
}

function inside(root: string, path: string) {
  const candidate = relative(root, path)
  return candidate !== "" && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !candidate.startsWith("/")
}

async function openRegularNoFollow(path: string) {
  try {
    return await open(path, constants.O_RDONLY | noFollowAny)
  } catch {
    return null
  }
}

async function readOpenedFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  deadline: number,
  beforeChunk?: () => Promise<void>,
) {
  if (!Number.isSafeInteger(size) || size < 0) {
    return { ok: false, reason: "content_identity_changed" } as const
  }
  const bytes = Buffer.allocUnsafe(size)
  let position = 0
  while (position < size) {
    if (performance.now() > deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    await beforeChunk?.()
    if (performance.now() > deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    const requested = Math.min(64 * 1024, size - position)
    const read = await handle.read(bytes, position, requested, position)
    if (performance.now() > deadline) return { ok: false, reason: "content_time_limit_exceeded" } as const
    if (read.bytesRead < 1) return { ok: false, reason: "content_identity_changed" } as const
    position += read.bytesRead
  }
  return { ok: true, value: bytes } as const
}

async function readlinkBuffer(path: string) {
  try {
    return await readlink(path, { encoding: "buffer" })
  } catch {
    return null
  }
}

async function lstatOptional(path: string, bigint = false) {
  try {
    return { ok: true, value: bigint ? await lstat(path, { bigint: true }) : await lstat(path) } as const
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, value: null } as const
    return { ok: false, reason: "content_path_unreadable" } as const
  }
}

async function safeRealpath(path: string) {
  try {
    return await realpath(path)
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

function sameFacts(
  left: Readonly<{
    dev: bigint | number
    ino: bigint | number
    mode: bigint | number
    size: bigint | number
    mtimeMs: bigint | number
    ctimeMs: bigint | number
  }>,
  right: Readonly<{
    dev: bigint | number
    ino: bigint | number
    mode: bigint | number
    size: bigint | number
    mtimeMs: bigint | number
    ctimeMs: bigint | number
  }>,
) {
  return (
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    String(left.mode) === String(right.mode) &&
    String(left.size) === String(right.size) &&
    String(left.mtimeMs) === String(right.mtimeMs) &&
    String(left.ctimeMs) === String(right.ctimeMs)
  )
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null
}

function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return Buffer.from(left).equals(Buffer.from(right))
}

function digestBytes(...chunks: ReadonlyArray<Uint8Array>): `sha256:${string}` {
  const hash = createHash("sha256")
  for (const chunk of chunks) hash.update(chunk)
  return `sha256:${hash.digest("hex")}`
}

function digestText(value: string) {
  return digestBytes(new TextEncoder().encode(value))
}

function digestValue(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function boundaryDeadline(limits: GitRepositoryBaselineLimits, overallDeadline: number) {
  return Math.min(overallDeadline, performance.now() + limits.maxBoundaryDurationMs)
}

function blocked(root: string, reason: GitRepositoryBaselineBlockReason): GitRepositoryBaselineCaptureResult {
  return {
    status: "blocked",
    mode: "bounded_read_only",
    durability: "ephemeral",
    verification: "not_verified",
    workspaceRoot: root,
    reason,
  }
}
