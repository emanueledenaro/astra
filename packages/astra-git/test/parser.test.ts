import { describe, expect, test } from "bun:test"
import { parseGitIndexOutput, parseGitStatusOutput } from "../src/parser"

const hash = "0123456789abcdef0123456789abcdef01234567"

describe("Git porcelain parser", () => {
  test("separates staged, unstaged, untracked, and conflicted paths", () => {
    const output = bytes(
      `# branch.oid ${hash}\0` +
        "# branch.head main\0" +
        "# branch.upstream origin/main\0" +
        "# branch.ab +2 -3\0" +
        "# stash 1\0" +
        `1 MM N... 100644 100644 100644 ${hash} ${hash} staged-and-modified.txt\0` +
        `1 M. N... 100644 100644 100644 ${hash} ${hash} staged.txt\0` +
        `1 .M N... 100644 100644 100644 ${hash} ${hash} unstaged.txt\0` +
        "? untracked file.txt\0" +
        `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict.txt\0`,
    )

    const result = parseGitStatusOutput(output, 10)

    expect(result).toEqual({
      ok: true,
      value: {
        branch: {
          oid: hash,
          head: "main",
          upstream: "origin/main",
          ahead: 2,
          behind: 3,
          stashCount: 1,
          aheadBehindScope: "local_ref_only",
        },
        staged: [
          { path: "staged-and-modified.txt", index: "M", worktree: "M" },
          { path: "staged.txt", index: "M", worktree: "." },
        ],
        unstaged: [
          { path: "staged-and-modified.txt", index: "M", worktree: "M" },
          { path: "unstaged.txt", index: ".", worktree: "M" },
        ],
        untracked: ["untracked file.txt"],
        conflicts: [{ path: "conflict.txt", code: "UU" }],
        entryCount: 5,
      },
    })
  })

  test("supports unborn and detached branches", () => {
    expect(parseGitStatusOutput(bytes("# branch.oid (initial)\0# branch.head main\0"), 1)).toMatchObject({
      ok: true,
      value: { branch: { oid: null, head: "main" } },
    })
    expect(parseGitStatusOutput(bytes(`# branch.oid ${hash}\0# branch.head (detached)\0`), 1)).toMatchObject({
      ok: true,
      value: { branch: { oid: hash, head: null } },
    })
  })

  test("fails closed for malformed, duplicate, unknown, invalid UTF-8, and excessive records", () => {
    const cases = [
      bytes(`# branch.oid ${hash}\0# branch.oid ${hash}\0# branch.head main\0`),
      bytes(`# branch.oid ${hash}\0# branch.head main\0# future.header value\0`),
      bytes(`# branch.oid ${hash}\0# branch.head main`),
      Uint8Array.of(0xff, 0),
      bytes(`# branch.oid ${hash}\0# branch.head main\0? one\0? two\0`),
      bytes([`# branch.oid ${hash}\0# branch.head main\0`, "2 unexpected-record\0"].join("")),
    ]
    for (const output of cases) expect(parseGitStatusOutput(output, 1).ok).toBeFalse()
  })

  test("detects gitlinks and rejects malformed index records", () => {
    expect(parseGitIndexOutput(bytes(`H 160000 ${hash} 0\tpackages/dependency\0`), 2)).toEqual({
      ok: true,
      value: {
        entryCount: 1,
        hasGitlink: true,
        hasAssumeUnchanged: false,
        hasSkipWorktree: false,
        hasFsmonitorValid: false,
      },
    })
    expect(parseGitIndexOutput(bytes(`H 100644 ${hash} 0 packages/missing-tab\0`), 2).ok).toBeFalse()
    expect(parseGitIndexOutput(bytes([`H 100644 ${hash} 0\tone\0`, `H 100644 ${hash} 0\ttwo\0`].join("")), 1)).toEqual({
      ok: false,
      reason: "git_entry_limit_exceeded",
    })
  })

  test("detects index flags that can hide worktree changes", () => {
    expect(parseGitIndexOutput(bytes(`h 100644 ${hash} 0\tassumed\0S 100644 ${hash} 0\tskipped\0`), 4)).toMatchObject({
      ok: true,
      value: { hasAssumeUnchanged: true, hasSkipWorktree: true, hasFsmonitorValid: false },
    })
    expect(parseGitIndexOutput(bytes(`h 100644 ${hash} 0\tvalid\0`), 4, "fsmonitor-valid")).toMatchObject({
      ok: true,
      value: { hasAssumeUnchanged: false, hasFsmonitorValid: true },
    })
  })
})

function bytes(value: string) {
  return new TextEncoder().encode(value)
}
