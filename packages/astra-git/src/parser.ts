import type { GitBranch, GitConflict, GitInspectionBlockReason, GitPathState } from "./types"

export type ParsedGitStatus = Readonly<{
  branch: GitBranch
  staged: ReadonlyArray<GitPathState>
  unstaged: ReadonlyArray<GitPathState>
  untracked: ReadonlyArray<string>
  conflicts: ReadonlyArray<GitConflict>
  entryCount: number
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
      /^1 ([.MADRCUT]{2}) (N\.\.\.|S[.C][.M][.U]) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/u.exec(
        record,
      )
    if (ordinary) {
      const path = requirePath(ordinary[8])
      if (!path) return { ok: false, reason: "git_output_malformed" }
      const state = { path, index: ordinary[1]![0]!, worktree: ordinary[1]![1]! }
      if (state.index !== ".") staged.push(state)
      if (state.worktree !== ".") unstaged.push(state)
      continue
    }

    const unmerged =
      /^u (DD|AU|UD|UA|DU|AA|UU) (N\.\.\.|S[.C][.M][.U]) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/u.exec(
        record,
      )
    if (unmerged) {
      const path = requirePath(unmerged[10])
      if (!path) return { ok: false, reason: "git_output_malformed" }
      conflicts.push({ path, code: unmerged[1]! })
      continue
    }

    if (record.startsWith("? ")) {
      const path = requirePath(record.slice(2))
      if (!path) return { ok: false, reason: "git_output_malformed" }
      untracked.push(path)
      continue
    }

    return { ok: false, reason: "git_output_malformed" }
  }

  const branch = parseBranch(headers)
  if (!branch) return { ok: false, reason: "git_output_malformed" }
  return { ok: true, value: { branch, staged, unstaged, untracked, conflicts, entryCount } }
}

export function parseGitIndexOutput(
  output: Uint8Array,
  maxEntries: number,
  flags: "assume-unchanged" | "fsmonitor-valid" = "assume-unchanged",
): ParseResult<
  Readonly<{
    entryCount: number
    hasGitlink: boolean
    hasAssumeUnchanged: boolean
    hasSkipWorktree: boolean
    hasFsmonitorValid: boolean
  }>
> {
  const text = decode(output)
  if (text === null) return { ok: false, reason: "git_output_invalid_utf8" }
  if (text.length === 0) {
    return {
      ok: true,
      value: {
        entryCount: 0,
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
  for (const record of records) {
    const match = /^([HSMRCK?hsmrck]) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/u.exec(record)
    if (!match || !requirePath(match[5])) return { ok: false, reason: "git_output_malformed" }
    if (match[2] === "160000") hasGitlink = true
    if (match[1]!.toLowerCase() === "s") hasSkipWorktree = true
    if (flags === "assume-unchanged" && /^[a-z]$/u.test(match[1]!)) hasAssumeUnchanged = true
    if (flags === "fsmonitor-valid" && /^[a-z]$/u.test(match[1]!)) hasFsmonitorValid = true
  }
  return {
    ok: true,
    value: { entryCount: records.length, hasGitlink, hasAssumeUnchanged, hasSkipWorktree, hasFsmonitorValid },
  }
}

function parseBranch(headers: ReadonlyMap<string, string>): GitBranch | null {
  const oid = headers.get("branch.oid")
  const head = headers.get("branch.head")
  if (!oid || !head || !(/^([0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid) || oid === "(initial)")) return null
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
  if (!value || value.startsWith("/") || /[\u0000]/u.test(value)) return null
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) return null
  return value
}

function safeCount(value: string | undefined) {
  if (!value) return null
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}
