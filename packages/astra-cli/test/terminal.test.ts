import { describe, expect, test } from "bun:test"
import { renderHeader, sanitizeTerminalText } from "../src/terminal"

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
})
