/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import {
  getOpencodeModeStack,
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useCommandSlashes,
} from "../src/keymap"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("legacy page key aliases compile as page keys", async () => {
  const sequences: Record<string, string[][]> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig({
      messages_page_up: "pgup",
      messages_page_down: "pgdown",
    })
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      bindings: config.keybinds.gather("session", ["session.page.up", "session.page.down"]),
    })
    const bindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: ["session.page.up", "session.page.down"],
    })
    sequences.up =
      bindings.get("session.page.up")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    sequences.down =
      bindings.get("session.page.down")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(sequences).toEqual({
      up: [["pageup"]],
      down: [["pagedown"]],
    })
  } finally {
    app.renderer.destroy()
  }
})

test("mode-less bindings stay active when opencode mode changes", async () => {
  const counts: Record<string, Record<string, number>> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offGlobal = keymap.registerLayer({
      commands: [
        { name: "session.list", run() {} },
        { name: "session.new", run() {} },
        { name: "session.page.up", run() {} },
        { name: "session.first", run() {} },
      ],
      bindings: config.keybinds.gather("test.global", [
        "session.list",
        "session.new",
        "session.page.up",
        "session.first",
      ]),
    })
    const offBase = keymap.registerLayer({
      mode: OPENCODE_BASE_MODE,
      commands: [{ name: "model.list", run() {} }],
      bindings: config.keybinds.gather("test.base", ["model.list"]),
    })
    const activeCounts = () =>
      Object.fromEntries(
        Array.from(
          keymap.getCommandBindings({
            visibility: "active",
            commands: ["session.list", "session.new", "session.page.up", "session.first", "model.list"],
          }),
          ([command, bindings]) => [command, bindings.length],
        ),
      )

    counts.base = activeCounts()
    const popQuestion = getOpencodeModeStack(keymap).push("question")
    counts.question = activeCounts()
    popQuestion()
    const popAutocomplete = getOpencodeModeStack(keymap).push("autocomplete")
    counts.autocomplete = activeCounts()
    popAutocomplete()

    onCleanup(() => {
      offBase()
      offGlobal()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(counts).toEqual({
      base: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 1 },
      question: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 0 },
      autocomplete: {
        "session.list": 1,
        "session.new": 1,
        "session.page.up": 2,
        "session.first": 2,
        "model.list": 0,
      },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("Astra Safe Start rejects inherited keybinding, remote, and slash command paths", async () => {
  const calls = { model: 0, provider: 0, git: 0, exit: 0 }
  let dispatch!: (command: string) => ReturnType<ReturnType<typeof createDefaultOpenTuiKeymap>["dispatchCommand"]>
  let registered: string[] = []
  let slashes!: ReturnType<typeof useCommandSlashes>

  function SlashProbe() {
    slashes = useCommandSlashes()
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config, { astraSafeStart: true })
    const offLayer = keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "model.list",
          slashName: "models",
          run() {
            calls.model++
          },
        },
        {
          namespace: "palette",
          name: "provider.connect",
          slashName: "connect",
          run() {
            calls.provider++
          },
        },
        {
          namespace: "palette",
          name: "astra.git.open",
          slashName: "git",
          run() {
            calls.git++
          },
        },
        {
          namespace: "palette",
          name: "app.exit",
          slashName: "exit",
          run() {
            calls.exit++
          },
        },
      ],
      bindings: [
        { key: "ctrl+m", cmd: "model.list" },
        { key: "ctrl+g", cmd: "astra.git.open" },
        { key: "ctrl+x", cmd: "app.exit" },
      ],
    })
    registered = keymap.getCommands({ visibility: "registered" }).map((command) => command.name)
    dispatch = (command) => keymap.dispatchCommand(command)

    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <SlashProbe />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(registered).not.toContain("model.list")
    expect(registered).not.toContain("provider.connect")
    expect(registered).toContain("astra.git.open")
    expect(registered).toContain("app.exit")

    const remote = dispatch("provider.connect")
    expect(remote).toMatchObject({ ok: false, reason: "rejected" })
    expect(calls.provider).toBe(0)

    app.mockInput.pressKey("m", { ctrl: true })
    app.mockInput.pressKey("g", { ctrl: true })
    app.mockInput.pressKey("x", { ctrl: true })
    expect(calls).toEqual({ model: 0, provider: 0, git: 1, exit: 1 })

    const slashEntries = slashes()
    expect(slashEntries.some((entry) => entry.display === "/models")).toBe(false)
    expect(slashEntries.some((entry) => entry.display === "/connect")).toBe(false)
    const git = slashEntries.find((entry) => entry.display === "/git")
    expect(git).toBeDefined()
    git?.onSelect()
    expect(calls.git).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("OpenCode keeps inherited commands when Astra Safe Start is inactive", async () => {
  let calls = 0
  let result!: ReturnType<ReturnType<typeof createDefaultOpenTuiKeymap>["dispatchCommand"]>

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const offKeymap = registerOpencodeKeymap(keymap, renderer, createResolvedKeymapConfig())
    const offLayer = keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "model.list",
          run() {
            calls++
          },
        },
      ],
    })
    result = keymap.dispatchCommand("model.list")
    onCleanup(() => {
      offLayer()
      offKeymap()
    })
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(result).toMatchObject({ ok: true })
    expect(calls).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
