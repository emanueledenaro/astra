import { describe, expect, test } from "bun:test"
import {
  allowRemoteTuiCommandDispatch,
  dispatchRemoteTuiCommand,
  isAstraSafeStartCommand,
} from "../../src/astra/command-policy"

describe("Astra Safe Start command policy", () => {
  test("rejects every remote command dispatch while Safe Start is active", () => {
    const dispatched: string[] = []
    expect(allowRemoteTuiCommandDispatch(true)).toBe(false)
    expect(allowRemoteTuiCommandDispatch(false)).toBe(true)
    expect(
      dispatchRemoteTuiCommand({
        astraSafeStart: true,
        eventWorkspace: "/workspace",
        currentWorkspace: "/workspace",
        command: "astra.write.approve",
        dispatch: (command) => dispatched.push(command),
      }),
    ).toBe(false)
    expect(dispatched).toEqual([])
  })

  test("keeps the explicitly governed Astra surface available", () => {
    expect(
      [
        "astra.git.open",
        "astra.git.inspect",
        "astra.git.close",
        "astra.extensions.open",
        "astra.extensions.close",
        "astra.write.open",
        "astra.write.prepare",
        "astra.write.approve",
        "astra.write.reject",
        "astra.write.close",
        "astra.skill.open",
        "astra.skill.inventory",
        "astra.skill.prepare",
        "astra.skill.close",
        "astra.search.open",
        "astra.search.query",
        "astra.search.close",
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
    expect(isAstraSafeStartCommand("astra.skill.approve")).toBe(false)
    expect(isAstraSafeStartCommand("astra.skill.reject")).toBe(false)
    expect(isAstraSafeStartCommand("astra.search.approve")).toBe(false)
    expect(isAstraSafeStartCommand("astra.search.reject")).toBe(false)
  })
})
