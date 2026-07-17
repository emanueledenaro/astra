import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { isWorkspaceOpenCodeSkillPath } from "@astra/domain/extension-capability"

export const defaultSkillInventoryLimits = {
  maxCandidates: 32,
  maxEntries: 256,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxDurationMs: 1_000,
} as const satisfies SkillInventoryLimits

export type SkillInventoryLimits = Readonly<{
  maxCandidates: number
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDurationMs: number
}>

export type SkillInventoryCandidate = Readonly<{
  candidateID: `sha256:${string}`
  name: string
  description: string | null
  descriptionTrust: "untrusted_workspace_metadata"
  relativePath: string
  fileIdentity: Readonly<{ device: string; inode: string }>
  fileDigest: `sha256:${string}`
  fileBytes: number
  instructionsDigest: `sha256:${string}`
  instructionsBytes: number
  descriptionDigest: `sha256:${string}`
}>

export type SkillInventoryBlockReason =
  | "invalid_limits"
  | "unsupported_platform"
  | "workspace_unavailable"
  | "workspace_identity_changed"
  | "skill_root_symlink"
  | "skill_inventory_unreadable"
  | "entry_limit_exceeded"
  | "candidate_limit_exceeded"
  | "file_limit_exceeded"
  | "total_byte_limit_exceeded"
  | "time_limit_exceeded"
  | "skill_file_changed"
  | "skill_file_invalid"
  | "duplicate_skill_name"

export type SkillInventoryResult =
  | Readonly<{
      status: "complete"
      workspace: Readonly<{ root: string; device: string; inode: string }>
      candidates: ReadonlyArray<SkillInventoryCandidate>
      scannedEntries: number
      scannedBytes: number
      limits: SkillInventoryLimits
      verification: "not_verified"
    }>
  | Readonly<{
      status: "blocked"
      workspaceRoot: string
      reason: SkillInventoryBlockReason
      verification: "not_verified"
      limits: SkillInventoryLimits
    }>

export type ExactSkillInstructions = Readonly<{
  candidate: SkillInventoryCandidate
  instructions: string
  trust: "untrusted_instruction_data"
}>

type ScanState = {
  root: string
  physicalRoot: string
  workspace: { root: string; device: string; inode: string }
  startedAt: number
  limits: SkillInventoryLimits
  scannedEntries: number
  scannedBytes: number
  candidates: SkillInventoryCandidate[]
}

class SkillInventoryBlocked extends Error {
  constructor(readonly reason: SkillInventoryBlockReason) {
    super(reason)
    this.name = "SkillInventoryBlocked"
  }
}

/**
 * Explicitly inventories only workspace-local OpenCode SKILL.md files.
 * It reads no resource file and has no process, network, config, or write path.
 */
export async function inspectWorkspaceSkills(
  workspaceRoot: string,
  overrides: Partial<SkillInventoryLimits> = {},
): Promise<SkillInventoryResult> {
  const root = resolve(workspaceRoot)
  const limits = Object.freeze({ ...defaultSkillInventoryLimits, ...overrides })
  if (!validLimits(limits)) return blocked(root, limits, "invalid_limits")
  if (process.platform !== "darwin") return blocked(root, limits, "unsupported_platform")

  try {
    const workspace = await inspectWorkspaceRoot(root)
    if (!workspace) return blocked(root, limits, "workspace_unavailable")
    const physicalRoot = await realpath(root)
    const state: ScanState = {
      root,
      physicalRoot,
      workspace,
      startedAt: performance.now(),
      limits,
      scannedEntries: 0,
      scannedBytes: 0,
      candidates: [],
    }
    for (const base of [".opencode/skill", ".opencode/skills"] as const) {
      await scanOptionalSkillRoot(state, base)
    }
    const finalWorkspace = await inspectWorkspaceRoot(root)
    if (!finalWorkspace || !sameIdentity(workspace, finalWorkspace)) {
      throw new SkillInventoryBlocked("workspace_identity_changed")
    }
    const names = new Set<string>()
    for (const candidate of state.candidates) {
      if (names.has(candidate.name)) throw new SkillInventoryBlocked("duplicate_skill_name")
      names.add(candidate.name)
    }
    return Object.freeze({
      status: "complete",
      workspace: Object.freeze({ ...workspace }),
      candidates: Object.freeze(
        state.candidates
          .toSorted((left, right) => compareBytes(left.relativePath, right.relativePath))
          .map(freezeCandidate),
      ),
      scannedEntries: state.scannedEntries,
      scannedBytes: state.scannedBytes,
      limits,
      verification: "not_verified",
    })
  } catch (cause) {
    return blocked(root, limits, cause instanceof SkillInventoryBlocked ? cause.reason : "skill_inventory_unreadable")
  }
}

/** Re-reads one exact candidate and returns only its approved instruction body. */
export async function readExactWorkspaceSkill(
  workspaceRoot: string,
  expected: SkillInventoryCandidate,
  limits: SkillInventoryLimits = defaultSkillInventoryLimits,
): Promise<ExactSkillInstructions | null> {
  if (!validLimits(limits) || !isWorkspaceOpenCodeSkillPath(expected.relativePath)) return null
  const root = resolve(workspaceRoot)
  const workspace = await inspectWorkspaceRoot(root)
  if (!workspace) return null
  const physicalRoot = await realpath(root).catch(() => null)
  if (!physicalRoot) return null
  try {
    const loaded = await readCandidate(
      {
        root,
        physicalRoot,
        workspace,
        startedAt: performance.now(),
        limits,
        scannedEntries: 0,
        scannedBytes: 0,
        candidates: [],
      },
      expected.relativePath,
    )
    if (!sameCandidate(expected, loaded.candidate)) return null
    return Object.freeze({
      candidate: freezeCandidate(loaded.candidate),
      instructions: loaded.instructions,
      trust: "untrusted_instruction_data",
    })
  } catch {
    return null
  }
}

async function scanOptionalSkillRoot(state: ScanState, base: string) {
  checkDuration(state)
  const basePath = join(state.root, ...base.split("/"))
  const facts = await optionalLstat(basePath)
  if (!facts) return
  if (facts.isSymbolicLink()) throw new SkillInventoryBlocked("skill_root_symlink")
  if (!facts.isDirectory()) throw new SkillInventoryBlocked("skill_inventory_unreadable")
  await scanDirectory(state, base)
}

async function scanDirectory(state: ScanState, relativeDirectory: string) {
  checkDuration(state)
  const directoryPath = join(state.root, ...relativeDirectory.split("/"))
  const before = await lstat(directoryPath).catch(() => null)
  if (!before?.isDirectory() || before.isSymbolicLink()) {
    throw new SkillInventoryBlocked("skill_inventory_unreadable")
  }
  const physicalDirectory = await realpath(directoryPath).catch(() => null)
  if (!physicalDirectory || !within(state.physicalRoot, physicalDirectory)) {
    throw new SkillInventoryBlocked("skill_inventory_unreadable")
  }

  const directory = await opendir(directoryPath).catch(() => null)
  if (!directory) throw new SkillInventoryBlocked("skill_inventory_unreadable")
  const entries = []
  try {
    for await (const entry of directory) {
      checkDuration(state)
      state.scannedEntries += 1
      if (state.scannedEntries > state.limits.maxEntries) throw new SkillInventoryBlocked("entry_limit_exceeded")
      entries.push(entry)
    }
  } catch (cause) {
    if (cause instanceof SkillInventoryBlocked) throw cause
    throw new SkillInventoryBlocked("skill_inventory_unreadable")
  }
  entries.sort((left, right) => compareBytes(left.name, right.name))

  for (const entry of entries) {
    checkDuration(state)
    if (entry.name.includes("/") || entry.name.includes("\0") || entry.name === "." || entry.name === "..") {
      throw new SkillInventoryBlocked("skill_inventory_unreadable")
    }
    const childRelative = `${relativeDirectory}/${entry.name}`
    const childPath = join(state.root, ...childRelative.split("/"))
    const facts = await lstat(childPath).catch(() => null)
    if (!facts) throw new SkillInventoryBlocked("skill_inventory_unreadable")
    if (facts.isSymbolicLink()) {
      if (entry.name === "SKILL.md") throw new SkillInventoryBlocked("skill_root_symlink")
      continue
    }
    if (facts.isDirectory()) {
      await scanDirectory(state, childRelative)
      continue
    }
    if (!facts.isFile() || entry.name !== "SKILL.md") continue
    if (!isWorkspaceOpenCodeSkillPath(childRelative)) continue
    const loaded = await readCandidate(state, childRelative)
    state.scannedBytes += loaded.candidate.fileBytes
    if (state.scannedBytes > state.limits.maxTotalBytes) {
      throw new SkillInventoryBlocked("total_byte_limit_exceeded")
    }
    state.candidates.push(loaded.candidate)
    if (state.candidates.length > state.limits.maxCandidates) {
      throw new SkillInventoryBlocked("candidate_limit_exceeded")
    }
  }

  const after = await lstat(directoryPath).catch(() => null)
  const finalPhysicalDirectory = await realpath(directoryPath).catch(() => null)
  if (!after || !sameStat(before, after) || finalPhysicalDirectory !== physicalDirectory) {
    throw new SkillInventoryBlocked("skill_file_changed")
  }
}

async function readCandidate(state: ScanState, relativePath: string) {
  checkDuration(state)
  const path = join(state.root, ...relativePath.split("/"))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) throw new SkillInventoryBlocked("skill_inventory_unreadable")
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new SkillInventoryBlocked("skill_file_invalid")
    }
    if (before.size <= 0 || before.size > state.limits.maxFileBytes) {
      throw new SkillInventoryBlocked("file_limit_exceeded")
    }
    const physicalFile = await realpath(`/dev/fd/${handle.fd}`).catch(() => null)
    if (!physicalFile || !within(state.physicalRoot, physicalFile)) {
      throw new SkillInventoryBlocked("skill_inventory_unreadable")
    }
    const observedRelativePath = relative(state.physicalRoot, physicalFile).split(sep).join("/")
    if (observedRelativePath !== relativePath) throw new SkillInventoryBlocked("skill_file_changed")

    const bytes = new Uint8Array(before.size + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      checkDuration(state)
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || !sameStat(before, after)) throw new SkillInventoryBlocked("skill_file_changed")
    if (offset > state.limits.maxFileBytes) throw new SkillInventoryBlocked("file_limit_exceeded")
    const file = bytes.subarray(0, offset)
    const text = decodeSkillFile(file)
    const parsed = parseSkillDocument(text)
    const instructionsBytes = Buffer.byteLength(parsed.instructions)
    const candidate = {
      candidateID: digest(
        canonicalJson({
          relativePath,
          device: String(before.dev),
          inode: String(before.ino),
          fileDigest: digest(file),
          instructionsDigest: digest(parsed.instructions),
        }),
      ),
      name: parsed.name,
      description: parsed.description,
      descriptionTrust: "untrusted_workspace_metadata",
      relativePath,
      fileIdentity: { device: String(before.dev), inode: String(before.ino) },
      fileDigest: digest(file),
      fileBytes: offset,
      instructionsDigest: digest(parsed.instructions),
      instructionsBytes,
      descriptionDigest: digest(parsed.description ?? ""),
    } as const satisfies SkillInventoryCandidate
    return { candidate, instructions: parsed.instructions }
  } finally {
    await handle.close()
  }
}

function parseSkillDocument(input: string) {
  if (input.includes("\r") || !input.startsWith("---\n")) throw new SkillInventoryBlocked("skill_file_invalid")
  const end = input.indexOf("\n---\n", 4)
  if (end < 0 || end > 8 * 1024) throw new SkillInventoryBlocked("skill_file_invalid")
  const metadata = input.slice(4, end).split("\n")
  const values = new Map<string, string>()
  for (const line of metadata) {
    if (!line.trim()) continue
    const match = /^([A-Za-z0-9_-]+):[ ]*(.*)$/u.exec(line)
    if (!match?.[1] || match[2] === undefined || values.has(match[1])) {
      throw new SkillInventoryBlocked("skill_file_invalid")
    }
    values.set(match[1], scalar(match[2]))
  }
  const name = values.get("name")
  const description = values.get("description") || null
  const instructions = input.slice(end + 5).trim()
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) || !instructions) {
    throw new SkillInventoryBlocked("skill_file_invalid")
  }
  if (description && (description.length > 240 || /[\p{Cc}\p{Cf}]/u.test(description))) {
    throw new SkillInventoryBlocked("skill_file_invalid")
  }
  return { name, description, instructions }
}

function scalar(input: string) {
  const value = input.trim()
  if (!value) return ""
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== "string") throw new Error()
      return parsed
    } catch {
      throw new SkillInventoryBlocked("skill_file_invalid")
    }
  }
  if (value.startsWith("'") || value.includes(" #") || value === ">" || value === "|") {
    throw new SkillInventoryBlocked("skill_file_invalid")
  }
  return value
}

async function inspectWorkspaceRoot(root: string) {
  const facts = await lstat(root).catch(() => null)
  if (!facts?.isDirectory() || facts.isSymbolicLink()) return null
  return { root, device: String(facts.dev), inode: String(facts.ino) }
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return null
    throw cause
  }
}

function sameCandidate(left: SkillInventoryCandidate, right: SkillInventoryCandidate) {
  return canonicalJson(left) === canonicalJson(right)
}

function sameIdentity(
  left: Readonly<{ device: string; inode: string }>,
  right: Readonly<{ device: string; inode: string }>,
) {
  return left.device === right.device && left.inode === right.inode
}

function sameStat(
  left: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number }>,
) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function within(root: string, candidate: string) {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

function checkDuration(state: ScanState) {
  if (performance.now() - state.startedAt > state.limits.maxDurationMs) {
    throw new SkillInventoryBlocked("time_limit_exceeded")
  }
}

function validLimits(input: SkillInventoryLimits) {
  return (
    positive(input.maxCandidates, 128) &&
    positive(input.maxEntries, 4_096) &&
    positive(input.maxFileBytes, 65_536) &&
    positive(input.maxTotalBytes, 262_144) &&
    positive(input.maxDurationMs, 10_000)
  )
}

function positive(input: number, maximum: number) {
  return Number.isSafeInteger(input) && input > 0 && input <= maximum
}

function decodeSkillFile(input: Uint8Array) {
  if (input.includes(0)) throw new SkillInventoryBlocked("skill_file_invalid")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input)
  } catch {
    throw new SkillInventoryBlocked("skill_file_invalid")
  }
}

function digest(input: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Skill inventory facts must be canonical JSON")
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function compareBytes(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function freezeCandidate(candidate: SkillInventoryCandidate): SkillInventoryCandidate {
  Object.freeze(candidate.fileIdentity)
  return Object.freeze(candidate)
}

function blocked(root: string, limits: SkillInventoryLimits, reason: SkillInventoryBlockReason): SkillInventoryResult {
  return Object.freeze({ status: "blocked", workspaceRoot: root, reason, verification: "not_verified", limits })
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}
