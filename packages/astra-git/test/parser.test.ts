import { describe, expect, test } from "bun:test"
import { indexMatchesStatus, parseGitIndexOutput, parseGitStatusOutput } from "../src/parser"

const hash = "0123456789abcdef0123456789abcdef01234567"
const zero = "0".repeat(40)

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
        conflictIndexEntries: [
          { path: "conflict.txt", stage: 1, mode: "100644", oid: hash },
          { path: "conflict.txt", stage: 2, mode: "100644", oid: hash },
          { path: "conflict.txt", stage: 3, mode: "100644", oid: hash },
        ],
        oidLength: 40,
        stagedDiff: [
          {
            path: "staged-and-modified.txt",
            change: "modified",
            before: { location: "head", state: "object", mode: "100644", oid: hash },
            after: { location: "index", state: "object", mode: "100644", oid: hash },
          },
          {
            path: "staged.txt",
            change: "modified",
            before: { location: "head", state: "object", mode: "100644", oid: hash },
            after: { location: "index", state: "object", mode: "100644", oid: hash },
          },
        ],
        unstagedDiff: [
          {
            path: "staged-and-modified.txt",
            change: "modified",
            before: { location: "index", state: "object", mode: "100644", oid: hash },
            after: { location: "worktree", state: "unhashed", mode: "100644" },
          },
          {
            path: "unstaged.txt",
            change: "modified",
            before: { location: "index", state: "object", mode: "100644", oid: hash },
            after: { location: "worktree", state: "unhashed", mode: "100644" },
          },
        ],
        entryCount: 5,
      },
    })
  })

  test("models added, deleted, and type-changed endpoints without hashing worktree content", () => {
    const output = bytes(
      `# branch.oid ${hash}\0` +
        "# branch.head main\0" +
        `1 A. N... 000000 100644 100644 ${zero} ${hash} added.txt\0` +
        `1 D. N... 100644 000000 000000 ${hash} ${zero} deleted-from-index.txt\0` +
        `1 .D N... 100644 100644 000000 ${hash} ${hash} deleted-from-worktree.txt\0` +
        `1 .T N... 100644 100644 120000 ${hash} ${hash} changed-type.txt\0`,
    )

    const result = parseGitStatusOutput(output, 10)

    expect(result).toMatchObject({
      ok: true,
      value: {
        stagedDiff: [
          {
            path: "added.txt",
            change: "added",
            before: { location: "head", state: "absent" },
            after: { location: "index", state: "object", mode: "100644", oid: hash },
          },
          {
            path: "deleted-from-index.txt",
            change: "deleted",
            before: { location: "head", state: "object", mode: "100644", oid: hash },
            after: { location: "index", state: "absent" },
          },
        ],
        unstagedDiff: [
          {
            path: "changed-type.txt",
            change: "type_changed",
            before: { location: "index", state: "object", mode: "100644", oid: hash },
            after: { location: "worktree", state: "unhashed", mode: "120000" },
          },
          {
            path: "deleted-from-worktree.txt",
            change: "deleted",
            before: { location: "index", state: "object", mode: "100644", oid: hash },
            after: { location: "worktree", state: "absent" },
          },
        ],
      },
    })
  })

  test("fails closed for inconsistent object endpoints and historical gitlinks", () => {
    const cases = [
      bytes(
        [`# branch.oid ${hash}\0# branch.head main\0`, `1 A. N... 000000 100644 100644 ${hash} ${hash} bad.txt\0`].join(
          "",
        ),
      ),
      bytes(
        [
          `# branch.oid ${hash}\0# branch.head main\0`,
          `1 M. N... 160000 100644 100644 ${hash} ${hash} submodule.txt\0`,
        ].join(""),
      ),
      bytes(
        `# branch.oid ${hash}\0# branch.head main\0` +
          `1 M. N... 100644 100644 100644 ${hash} ${hash}${hash.slice(0, 24)} mixed-hash.txt\0`,
      ),
    ]

    for (const output of cases) expect(parseGitStatusOutput(output, 10).ok).toBeFalse()
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
        entries: [{ path: "packages/dependency", mode: "160000", oid: hash, stage: 0 }],
        oidLength: 40,
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

  test("rejects duplicate and control-character paths plus unsupported modes", () => {
    const cases = [
      bytes(`# branch.oid ${hash}\0# branch.head main\0? duplicate.txt\0? duplicate.txt\0`),
      bytes(`# branch.oid ${hash}\0# branch.head main\0? line\nbreak.txt\0`),
      bytes(
        [
          `# branch.oid ${hash}\0# branch.head main\0`,
          `1 M. N... 100664 100664 100664 ${hash} ${hash} bad-mode.txt\0`,
        ].join(""),
      ),
      bytes(`H 100644 ${hash} 0\tduplicate.txt\0H 100644 ${hash} 0\tduplicate.txt\0`),
      bytes(`H 000000 ${zero} 0\tabsent.txt\0`),
    ]

    for (const output of cases) {
      const result = output[0] === 72 ? parseGitIndexOutput(output, 10) : parseGitStatusOutput(output, 10)
      expect(result.ok).toBeFalse()
    }
  })

  test("normalizes report order instead of exposing Git traversal order", () => {
    const result = parseGitStatusOutput(
      bytes(`# branch.oid ${hash}\0# branch.head main\0? z-last.txt\0? a-first.txt\0`),
      10,
    )

    expect(result).toMatchObject({ ok: true, value: { untracked: ["a-first.txt", "z-last.txt"] } })
  })

  test("cross-checks conflict stages and one object format across status and index", () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98"
    const conflict = parseGitStatusOutput(
      bytes(
        `# branch.oid ${hash}\0# branch.head main\0` +
          `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict.txt\0`,
      ),
      10,
    )
    const mismatchedConflict = parseGitIndexOutput(
      bytes(
        `H 100644 ${other} 1\tconflict.txt\0` +
          `H 100644 ${other} 2\tconflict.txt\0` +
          `H 100644 ${other} 3\tconflict.txt\0`,
      ),
      10,
    )
    if (!conflict.ok || !mismatchedConflict.ok) throw new Error("The conflict fixtures must parse")
    expect(indexMatchesStatus(conflict.value, mismatchedConflict.value, mismatchedConflict.value)).toBeFalse()

    const sha256 = "0123456789abcdef".repeat(4)
    const cleanSha256 = parseGitStatusOutput(bytes(`# branch.oid ${sha256}\0# branch.head main\0`), 10)
    const sha1Index = parseGitIndexOutput(bytes(`H 100644 ${hash} 0\ttracked.txt\0`), 10)
    if (!cleanSha256.ok || !sha1Index.ok) throw new Error("The object-format fixtures must parse")
    expect(indexMatchesStatus(cleanSha256.value, sha1Index.value, sha1Index.value)).toBeFalse()

    const cleanSha1 = parseGitStatusOutput(bytes(`# branch.oid ${hash}\0# branch.head main\0`), 10)
    const unexplainedStage = parseGitIndexOutput(bytes(`H 100644 ${hash} 1\tconflict.txt\0`), 10)
    if (!cleanSha1.ok || !unexplainedStage.ok) throw new Error("The unexplained-stage fixtures must parse")
    expect(indexMatchesStatus(cleanSha1.value, unexplainedStage.value, unexplainedStage.value)).toBeFalse()
  })

  test("rejects an all-zero branch object instead of treating it as a commit", () => {
    expect(parseGitStatusOutput(bytes(`# branch.oid ${zero}\0# branch.head main\0`), 10).ok).toBeFalse()
  })
})

function bytes(value: string) {
  return new TextEncoder().encode(value)
}
