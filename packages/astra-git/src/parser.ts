import type {
  GitBranch,
  GitConflict,
  GitDiffEndpoint,
  GitDiffEntry,
  GitDiffObjectLocation,
  GitInspectionBlockReason,
  GitPathState,
} from "./types"

export type ParsedGitStatus = Readonly<{
  branch: GitBranch
  staged: ReadonlyArray<GitPathState>
  unstaged: ReadonlyArray<GitPathState>
  untracked: ReadonlyArray<string>
  conflicts: ReadonlyArray<GitConflict>
  stagedDiff: ReadonlyArray<GitDiffEntry>
  unstagedDiff: ReadonlyArray<GitDiffEntry>
  conflictIndexEntries: ReadonlyArray<ParsedGitIndexEntry>
  oidLength: 40 | 64 | null
  entryCount: number
}>

export type ParsedGitIndexEntry = Readonly<{
  path: string
  mode: string
  oid: string
  stage: 0 | 1 | 2 | 3
}>

export type ParsedGitIndex = Readonly<{
  entryCount: number
  entries: ReadonlyArray<ParsedGitIndexEntry>
  oidLength: 40 | 64 | null
  hasGitlink: boolean
  hasAssumeUnchanged: boolean
  hasSkipWorktree: boolean
  hasFsmonitorValid: boolean
}>

export type ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: GitInspectionBlockReason }>

export function parseGitStatusOutput(output: Uint8Array, maxEntries: number): ParseResult<ParsedGitStatus> {
  const text = decode(output)
  if (text === null) return { ok: false, reason: "git_output_invalid_utf8" }
  if (!text.endsWith("\0")) return { ok: false, reason: "git_output_malformed" }

  const records = text.slice(0, -1).split("\0")
  const headers = new Map<string, string>()
  const staged: Array<GitPathState> = []
  const unstaged: Array<GitPathState> = []
  const untracked: Array<string> = []
  const conflicts: Array<GitConflict> = []
  const stagedDiff: Array<GitDiffEntry> = []
  const unstagedDiff: Array<GitDiffEntry> = []
  const paths = new Set<string>()
  const oidLengths = new Set<number>()
  const conflictIndexEntries: Array<ParsedGitIndexEntry> = []
  let entryCount = 0

  for (const record of records) {
    if (record.startsWith("# ")) {
      if (entryCount > 0) return { ok: false, reason: "git_output_malformed" }
      const separator = record.indexOf(" ", 2)
      if (separator < 0) return { ok: false, reason: "git_output_malformed" }
      const key = record.slice(2, separator)
      const value = record.slice(separator + 1)
      if (!knownHeader(key) || headers.has(key) || !safeHeaderValue(value)) {
        return { ok: false, reason: "git_output_malformed" }
      }
      headers.set(key, value)
      continue
    }

    entryCount += 1
    if (entryCount > maxEntries) return { ok: false, reason: "git_entry_limit_exceeded" }

    const ordinary =
      /^1 ([.MADT]{2}) (N\.\.\.|S[.C][.M][.U]) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/u.exec(
        record,
      )
    if (ordinary) {
      const path = requirePath(ordinary[8])
      if (!path || paths.has(path)) return { ok: false, reason: "git_output_malformed" }
      paths.add(path)
      if (ordinary[2] !== "N...") return { ok: false, reason: "submodules_uninspected" }
      if ([ordinary[3], ordinary[4], ordinary[5]].includes("160000")) {
        return { ok: false, reason: "submodules_uninspected" }
      }
      if (ordinary[6]!.length !== ordinary[7]!.length) return { ok: false, reason: "git_output_malformed" }
      oidLengths.add(ordinary[6]!.length)
      oidLengths.add(ordinary[7]!.length)
      const head = objectEndpoint("head", ordinary[3]!, ordinary[6]!)
      const index = objectEndpoint("index", ordinary[4]!, ordinary[7]!)
      const worktree = worktreeEndpoint(ordinary[5]!)
      if (!head || !index || !worktree) return { ok: false, reason: "git_output_malformed" }
      const state = { path, index: ordinary[1]![0]!, worktree: ordinary[1]![1]! }
      if (state.index !== ".") {
        const entry = diffEntry(path, state.index, head, index)
        if (!entry) return { ok: false, reason: "git_output_malformed" }
        staged.push(state)
        stagedDiff.push(entry)
      }
      if (state.worktree !== ".") {
        const entry = diffEntry(path, state.worktree, index, worktree)
        if (!entry) return { ok: false, reason: "git_output_malformed" }
        unstaged.push(state)
        unstagedDiff.push(entry)
      }
      continue
    }

    const unmerged =
      /^u (DD|AU|UD|UA|DU|AA|UU) (N\.\.\.|S[.C][.M][.U]) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/u.exec(
        record,
      )
    if (unmerged) {
      const path = requirePath(unmerged[10])
      if (!path || paths.has(path)) return { ok: false, reason: "git_output_malformed" }
      paths.add(path)
      if (unmerged[2] !== "N...") return { ok: false, reason: "submodules_uninspected" }
      if ([unmerged[3], unmerged[4], unmerged[5], unmerged[6]].includes("160000")) {
        return { ok: false, reason: "submodules_uninspected" }
      }
      if (
        unmerged[7]!.length !== unmerged[8]!.length ||
        unmerged[7]!.length !== unmerged[9]!.length ||
        !validObjectEndpoint(unmerged[3]!, unmerged[7]!) ||
        !validObjectEndpoint(unmerged[4]!, unmerged[8]!) ||
        !validObjectEndpoint(unmerged[5]!, unmerged[9]!)
      ) {
        return { ok: false, reason: "git_output_malformed" }
      }
      const stages = [
        indexEntry(path, 1, unmerged[3]!, unmerged[7]!),
        indexEntry(path, 2, unmerged[4]!, unmerged[8]!),
        indexEntry(path, 3, unmerged[5]!, unmerged[9]!),
      ].filter((entry): entry is ParsedGitIndexEntry => entry !== null)
      if (!sameStages(stages, expectedConflictStages(unmerged[1]!))) {
        return { ok: false, reason: "git_output_malformed" }
      }
      conflictIndexEntries.push(...stages)
      oidLengths.add(unmerged[7]!.length)
      oidLengths.add(unmerged[8]!.length)
      oidLengths.add(unmerged[9]!.length)
      conflicts.push({ path, code: unmerged[1]! })
      continue
    }

    if (record.startsWith("? ")) {
      const path = requirePath(record.slice(2))
      if (!path || paths.has(path)) return { ok: false, reason: "git_output_malformed" }
      paths.add(path)
      untracked.push(path)
      continue
    }

    return { ok: false, reason: "git_output_malformed" }
  }

  const branch = parseBranch(headers)
  if (!branch) return { ok: false, reason: "git_output_malformed" }
  if (branch.oid) oidLengths.add(branch.oid.length)
  if (oidLengths.size > 1) return { ok: false, reason: "git_output_malformed" }
  staged.sort(comparePathEntries)
  unstaged.sort(comparePathEntries)
  untracked.sort(comparePaths)
  conflicts.sort(comparePathEntries)
  stagedDiff.sort(comparePathEntries)
  unstagedDiff.sort(comparePathEntries)
  return {
    ok: true,
    value: {
      branch,
      staged,
      unstaged,
      untracked,
      conflicts,
      stagedDiff,
      unstagedDiff,
      conflictIndexEntries,
      oidLength: requireOidLength(oidLengths),
      entryCount,
    },
  }
}

export function parseGitIndexOutput(
  output: Uint8Array,
  maxEntries: number,
  flags: "assume-unchanged" | "fsmonitor-valid" = "assume-unchanged",
): ParseResult<ParsedGitIndex> {
  const text = decode(output)
  if (text === null) return { ok: false, reason: "git_output_invalid_utf8" }
  if (text.length === 0) {
    return {
      ok: true,
      value: {
        entryCount: 0,
        entries: [],
        oidLength: null,
        hasGitlink: false,
        hasAssumeUnchanged: false,
        hasSkipWorktree: false,
        hasFsmonitorValid: false,
      },
    }
  }
  if (!text.endsWith("\0")) return { ok: false, reason: "git_output_malformed" }

  const records = text.slice(0, -1).split("\0")
  if (records.length > maxEntries) return { ok: false, reason: "git_entry_limit_exceeded" }
  let hasGitlink = false
  let hasAssumeUnchanged = false
  let hasSkipWorktree = false
  let hasFsmonitorValid = false
  const entries: Array<ParsedGitIndexEntry> = []
  const keys = new Set<string>()
  const oidLengths = new Set<number>()
  for (const record of records) {
    const match = /^([HSMRCK?hsmrck]) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/u.exec(record)
    const path = requirePath(match?.[5])
    if (!match || !path || match[2] === "000000" || !validObjectEndpoint(match[2]!, match[3]!)) {
      return { ok: false, reason: "git_output_malformed" }
    }
    oidLengths.add(match[3]!.length)
    const stage = parseStage(match[4]!)
    if (stage === null) return { ok: false, reason: "git_output_malformed" }
    const key = `${stage}\0${path}`
    if (keys.has(key)) return { ok: false, reason: "git_output_malformed" }
    keys.add(key)
    entries.push({ path, mode: match[2]!, oid: match[3]!, stage })
    if (match[2] === "160000") hasGitlink = true
    if (match[1]!.toLowerCase() === "s") hasSkipWorktree = true
    if (flags === "assume-unchanged" && /^[a-z]$/u.test(match[1]!)) hasAssumeUnchanged = true
    if (flags === "fsmonitor-valid" && /^[a-z]$/u.test(match[1]!)) hasFsmonitorValid = true
  }
  if (oidLengths.size > 1) return { ok: false, reason: "git_output_malformed" }
  return {
    ok: true,
    value: {
      entryCount: records.length,
      entries,
      oidLength: requireOidLength(oidLengths),
      hasGitlink,
      hasAssumeUnchanged,
      hasSkipWorktree,
      hasFsmonitorValid,
    },
  }
}

export function indexMatchesStatus(
  status: ParsedGitStatus,
  assumeUnchanged: ParsedGitIndex,
  fsmonitorValid: ParsedGitIndex,
) {
  if (!sameIndexEntries(assumeUnchanged.entries, fsmonitorValid.entries)) return false
  const oidLengths = [status.oidLength, assumeUnchanged.oidLength, fsmonitorValid.oidLength].filter(
    (value): value is 40 | 64 => value !== null,
  )
  if (new Set(oidLengths).size > 1) return false
  const entries = new Map<string, Array<ParsedGitIndexEntry>>()
  for (const entry of assumeUnchanged.entries) {
    const current = entries.get(entry.path) ?? []
    current.push(entry)
    entries.set(entry.path, current)
  }

  for (const path of status.untracked) if (entries.has(path)) return false
  const conflictPaths = new Set(status.conflicts.map((conflict) => conflict.path))
  for (const entry of assumeUnchanged.entries) {
    if (entry.stage !== 0 && !conflictPaths.has(entry.path)) return false
  }
  for (const conflict of status.conflicts) {
    const expected = status.conflictIndexEntries.filter((entry) => entry.path === conflict.path)
    if (!sameIndexEntries(entries.get(conflict.path) ?? [], expected)) return false
  }
  for (const entry of [...status.stagedDiff, ...status.unstagedDiff]) {
    const endpoint = entry.after.location === "index" ? entry.after : entry.before
    if (endpoint.location !== "index") return false
    const indexed = entries.get(entry.path) ?? []
    if (endpoint.state === "absent") {
      if (indexed.length > 0) return false
      continue
    }
    if (
      endpoint.state !== "object" ||
      indexed.length !== 1 ||
      indexed[0]?.stage !== 0 ||
      indexed[0].mode !== endpoint.mode ||
      indexed[0].oid !== endpoint.oid
    ) {
      return false
    }
  }
  return true
}

function parseBranch(headers: ReadonlyMap<string, string>): GitBranch | null {
  const oid = headers.get("branch.oid")
  const head = headers.get("branch.head")
  if (!oid || !head || (!(/^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid) && !/^0+$/u.test(oid)) && oid !== "(initial)")) {
    return null
  }
  const upstream = headers.get("branch.upstream") ?? null
  const aheadBehind = headers.get("branch.ab")
  if ((upstream === null) !== (aheadBehind === undefined)) return null
  const counts = aheadBehind ? /^\+([0-9]+) -([0-9]+)$/u.exec(aheadBehind) : null
  if (aheadBehind && !counts) return null
  const ahead = counts ? safeCount(counts[1]) : null
  const behind = counts ? safeCount(counts[2]) : null
  if (counts && (ahead === null || behind === null)) return null
  const stashValue = headers.get("stash")
  const stashCount = stashValue === undefined ? 0 : safeCount(stashValue)
  if (stashCount === null) return null
  return {
    oid: oid === "(initial)" ? null : oid,
    head: head === "(detached)" ? null : head,
    upstream,
    ahead,
    behind,
    stashCount,
    aheadBehindScope: "local_ref_only",
  }
}

function decode(output: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output)
  } catch {
    return null
  }
}

function knownHeader(value: string) {
  return (
    value === "branch.oid" ||
    value === "branch.head" ||
    value === "branch.upstream" ||
    value === "branch.ab" ||
    value === "stash"
  )
}

function safeHeaderValue(value: string) {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function requirePath(value: string | undefined) {
  if (!value || value.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(value)) return null
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) return null
  return value
}

function objectEndpoint(location: GitDiffObjectLocation, mode: string, oid: string): GitDiffEndpoint | null {
  if (!validObjectEndpoint(mode, oid)) return null
  if (mode === "000000") return { location, state: "absent" }
  return { location, state: "object", mode, oid }
}

function worktreeEndpoint(mode: string): GitDiffEndpoint | null {
  if (!supportedMode(mode) || mode === "160000") return null
  if (mode === "000000") return { location: "worktree", state: "absent" }
  return { location: "worktree", state: "unhashed", mode }
}

function validObjectEndpoint(mode: string, oid: string) {
  const absentMode = mode === "000000"
  const absentObject = /^0+$/u.test(oid)
  return supportedMode(mode) && (absentMode ? absentObject : !absentObject)
}

function supportedMode(mode: string) {
  return mode === "000000" || mode === "100644" || mode === "100755" || mode === "120000" || mode === "160000"
}

function sameIndexEntries(left: ReadonlyArray<ParsedGitIndexEntry>, right: ReadonlyArray<ParsedGitIndexEntry>) {
  if (left.length !== right.length) return false
  const encoded = (entry: ParsedGitIndexEntry) => `${entry.stage}\0${entry.path}\0${entry.mode}\0${entry.oid}`
  const rightEntries = new Set(right.map(encoded))
  return left.every((entry) => rightEntries.has(encoded(entry)))
}

function parseStage(value: string): 0 | 1 | 2 | 3 | null {
  if (value === "0") return 0
  if (value === "1") return 1
  if (value === "2") return 2
  if (value === "3") return 3
  return null
}

function indexEntry(path: string, stage: 1 | 2 | 3, mode: string, oid: string): ParsedGitIndexEntry | null {
  if (mode === "000000") return null
  return { path, stage, mode, oid }
}

function expectedConflictStages(code: string): ReadonlyArray<1 | 2 | 3> {
  if (code === "DD") return [1]
  if (code === "AU") return [2]
  if (code === "UD") return [1, 2]
  if (code === "UA") return [3]
  if (code === "DU") return [1, 3]
  if (code === "AA") return [2, 3]
  if (code === "UU") return [1, 2, 3]
  return []
}

function sameStages(entries: ReadonlyArray<ParsedGitIndexEntry>, stages: ReadonlyArray<1 | 2 | 3>) {
  return entries.length === stages.length && entries.every((entry, index) => entry.stage === stages[index])
}

function requireOidLength(lengths: ReadonlySet<number>): 40 | 64 | null {
  const value = [...lengths][0]
  if (value === 40 || value === 64) return value
  return null
}

function comparePathEntries(left: Readonly<{ path: string }>, right: Readonly<{ path: string }>) {
  return comparePaths(left.path, right.path)
}

function comparePaths(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function diffEntry(path: string, code: string, before: GitDiffEndpoint, after: GitDiffEndpoint): GitDiffEntry | null {
  if (code === "A" && before.state === "absent" && after.state !== "absent") {
    return { path, change: "added", before, after }
  }
  if (code === "D" && before.state !== "absent" && after.state === "absent") {
    return { path, change: "deleted", before, after }
  }
  if (code === "M" && before.state !== "absent" && after.state !== "absent") {
    return { path, change: "modified", before, after }
  }
  if (code === "T" && before.state !== "absent" && after.state !== "absent") {
    return { path, change: "type_changed", before, after }
  }
  return null
}

function safeCount(value: string | undefined) {
  if (!value) return null
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}
