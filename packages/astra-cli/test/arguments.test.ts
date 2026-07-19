import { describe, expect, test } from "bun:test"
import { parseAstraArguments } from "../src/arguments"

describe("Astra command targets", () => {
  test("selects No Workspace mode when no argument is provided", () => {
    expect(parseAstraArguments([])).toEqual({ ok: true, target: { kind: "no-workspace" } })
  })

  test("selects System Mode only for the exact system command", () => {
    expect(parseAstraArguments(["system"])).toEqual({ ok: true, target: { kind: "system" } })
  })

  test("preserves direct workspace paths without resolving or inspecting them", () => {
    expect(parseAstraArguments(["."])).toEqual({
      ok: true,
      target: { kind: "workspace", path: ".", source: "direct" },
    })
    expect(parseAstraArguments(["/work/astra"])).toEqual({
      ok: true,
      target: { kind: "workspace", path: "/work/astra", source: "direct" },
    })
  })

  test("preserves the explicit open compatibility alias", () => {
    expect(parseAstraArguments(["open", "/work/astra"])).toEqual({
      ok: true,
      target: { kind: "workspace", path: "/work/astra", source: "open-alias" },
    })
  })

  test("rejects extra System Mode arguments and flags", () => {
    expect(parseAstraArguments(["system", "."])).toEqual({
      ok: false,
      reason: "The `system` command does not accept arguments or flags.",
    })
    expect(parseAstraArguments(["system", "--unsafe"])).toEqual({
      ok: false,
      reason: "The `system` command does not accept arguments or flags.",
    })
    expect(parseAstraArguments(["system", "--"])).toEqual({
      ok: false,
      reason: "The `system` command does not accept arguments or flags.",
    })
  })

  test("rejects flags and ambiguous workspace arguments", () => {
    expect(parseAstraArguments(["--unsafe"])).toEqual({
      ok: false,
      reason: "Expected no argument, `system`, a workspace path, or `open <path>`.",
    })
    expect(parseAstraArguments(["/one", "/two"])).toEqual({
      ok: false,
      reason: "A direct workspace target accepts exactly one path.",
    })
    expect(parseAstraArguments(["open"])).toEqual({
      ok: false,
      reason: "The `open` command requires exactly one workspace path.",
    })
    expect(parseAstraArguments(["open", "--unsafe"])).toEqual({
      ok: false,
      reason: "The `open` command requires exactly one workspace path.",
    })
  })
})
