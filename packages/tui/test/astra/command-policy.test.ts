import { describe, expect, test } from "bun:test"
import { isAstraSafeStartCommand } from "../../src/astra/command-policy"

describe("Astra Safe Start command policy", () => {
  test("keeps the explicitly governed Astra surface available", () => {
    expect(
      [
        "astra.git.open",
        "astra.git.inspect",
        "astra.git.close",
        "astra.extensions.open",
        "astra.extensions.close",
        "app.exit",
        "command.palette.show",
      ].every(isAstraSafeStartCommand),
    ).toBe(true)
  })

  test("rejects inherited commands that bypass the governed Astra surface", () => {
    expect(
      [
        "model.list",
        "provider.connect",
        "prompt.editor",
        "session.move",
        "session.new",
        "workspace.list",
        "mcp.list",
        "docs.open",
      ].some(isAstraSafeStartCommand),
    ).toBe(false)
  })

  test("does not trust an unreviewed command merely because it uses the Astra prefix", () => {
    expect(isAstraSafeStartCommand("astra.plugin.unreviewed")).toBe(false)
  })
})
