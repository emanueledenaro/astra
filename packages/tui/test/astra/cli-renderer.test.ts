import { expect, test } from "bun:test"
import { ASTRA_ALTERNATE_SCREEN_RESET, prepareAstraTerminalRenderer } from "../../src/astra/cli-renderer"

test("resets the alternate viewport and disables unsupported Kitty input on Apple Terminal", () => {
  const writes: Array<string> = []
  let disabled = 0
  const renderer = { disableKittyKeyboard: () => disabled++ }

  expect(
    prepareAstraTerminalRenderer(renderer, {
      program: "Apple_Terminal",
      write: (value) => writes.push(value),
    }),
  ).toBe(renderer)
  expect(disabled).toBe(1)
  expect(writes).toEqual([ASTRA_ALTERNATE_SCREEN_RESET])
})

test("does not alter terminals that retain their native keyboard protocol", () => {
  const writes: Array<string> = []
  let disabled = 0
  const renderer = { disableKittyKeyboard: () => disabled++ }

  prepareAstraTerminalRenderer(renderer, {
    program: "iTerm.app",
    write: (value) => writes.push(value),
  })
  expect(disabled).toBe(0)
  expect(writes).toEqual([])
})
