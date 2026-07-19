import { describe, expect, test } from "bun:test"
import { renderHeader, renderWorkspaceReport, sanitizeTerminalText } from "../src/terminal"

describe("Astra terminal rendering", () => {
  test("neutralizes terminal controls and bidi overrides from workspace text", () => {
    const hostile = "safe\u001b[31m-red\nnext\u202eexe\u061c\u200f\u2060\u2028hidden"
    const rendered = sanitizeTerminalText(hostile)

    expect(rendered).not.toContain("\u001b")
    expect(rendered).not.toContain("\n")
    expect(rendered).not.toContain("\u202e")
    expect(rendered).not.toContain("\u061c")
    expect(rendered).not.toContain("\u200f")
    expect(rendered).not.toContain("\u2060")
    expect(rendered).not.toContain("\u2028")
    expect(rendered).toContain("\\u{1b}")
    expect(rendered).toContain("\\u{0a}")
    expect(rendered).toContain("\\u{202e}")
    expect(rendered).toContain("\\u{61c}")
    expect(rendered).toContain("\\u{200f}")
    expect(rendered).toContain("\\u{2060}")
    expect(rendered).toContain("\\u{2028}")
  })

  test("bounds untrusted terminal fields", () => {
    expect(Array.from(sanitizeTerminalText("x".repeat(400), 20))).toHaveLength(21)
    expect(sanitizeTerminalText("x".repeat(400), 20)).toEndWith("…")
  })

  test("renders the distinctive Lynx workspace gate", () => {
    expect(renderHeader().join("\n")).toContain("ASTRA // WORKSPACE GATE")
    expect(renderHeader().join("\n")).toContain("LYNX STATUS: WATCHING")
    expect(renderHeader().join("\n")).toContain("NO AUTO EXECUTION")
  })

  test("labels bounded static evidence and the Git metadata form without overclaiming", () => {
    const output = renderWorkspaceReport({
      root: "/workspace",
      identity: { device: "1", inode: "2" },
      securityDigest: "sha256:static",
      completeness: "complete",
      state: "awaiting_decision",
      surfaces: [{ kind: "git_metadata", path: ".git", entryKind: "symlink" }],
      blockers: [],
      scannedEntries: 1,
      scannedBytes: 0,
      limits: { maxEntries: 128, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxDurationMs: 1_000 },
    }).join("\n")

    expect(output).toContain("STATIC PREFLIGHT DIGEST  sha256:static")
    expect(output).toContain("bounded root metadata, selected regular files, and ancestor .git markers only")
    expect(output).toContain("GIT META   symlink • .git")
    expect(output).toContain("GIT BASELINE NOT INSPECTED")
    expect(output).not.toContain("SNAPSHOT")
  })
})
