import { describe, expect, test } from "bun:test"
import { LYNX_SEQUENCES, lynxFrame, type LynxPresentationState } from "../../src/component/lynx-model"

const states: LynxPresentationState[] = [
  "initializing",
  "idle",
  "read-only",
  "awaiting-decision",
  "working",
  "retrying",
  "blocked",
  "success",
  "uncertain",
  "error",
]

describe("Lynx presentation", () => {
  test("provides a textual label for every state", () => {
    for (const state of states) {
      const frame = lynxFrame(state, "compact", 0, false)
      expect(frame.label.length).toBeGreaterThan(0)
      expect(frame.label).not.toContain("VERIFIED")
    }
  })

  test("keeps full pixel-art frames aligned", () => {
    for (const state of states) {
      const frame = lynxFrame(state, "full", 0, false)
      expect(frame.lines).toHaveLength(7)
      expect(new Set(frame.lines.map((line) => Array.from(line).length))).toEqual(new Set([30]))
    }
  })

  test("animates only the typing paws when work is active", () => {
    const first = lynxFrame("working", "full", 0, true)
    const second = lynxFrame("working", "full", 1, true)
    expect(second.lines).not.toEqual(first.lines)
    expect(second.lines.filter((line, index) => line !== first.lines[index])).toHaveLength(1)
  })

  test("uses one stable frame when motion is disabled", () => {
    expect(lynxFrame("working", "compact", 0, false)).toEqual(lynxFrame("working", "compact", 1, false))
  })

  test("does not animate non-working states", () => {
    for (const state of states.filter((state) => state !== "working")) {
      expect(lynxFrame(state, "full", 0, true)).toEqual(lynxFrame(state, "full", 1, true))
    }
  })

  test("keeps provider retry separate from uncertain operation outcomes", () => {
    expect(lynxFrame("retrying", "compact", 0, false).label).toBe("Retrying")
    expect(lynxFrame("uncertain", "compact", 0, false).label).toBe("Uncertain")
  })

  test("defines illustrated frame sequences without claiming asset files exist", () => {
    const sequences = states.map((state) => LYNX_SEQUENCES[state].illustrated)
    expect(sequences.every((sequence) => sequence.frames.length > 0)).toBe(true)
    expect(sequences.flatMap((sequence) => sequence.frames).every((frame) => frame.id.length > 0)).toBe(true)
    expect(LYNX_SEQUENCES.success.illustrated.playback).toBe("once-hold")
  })

  test("keeps terminal motion data-driven and limited to typing", () => {
    expect(LYNX_SEQUENCES.working.terminal.frames.full).toHaveLength(2)
    expect(LYNX_SEQUENCES.working.terminal.frameDurationMs).toBe(220)
    expect(
      states
        .filter((state) => state !== "working")
        .every((state) => LYNX_SEQUENCES[state].terminal.frames.full.length === 1),
    ).toBe(true)
  })
})
