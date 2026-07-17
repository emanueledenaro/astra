import type { OpenTuiKeymap } from "../keymap"

const approvedCommands = new Set([
  "app.exit",
  "astra.chat.approve",
  "astra.chat.close",
  "astra.chat.compose",
  "astra.chat.model",
  "astra.chat.open",
  "astra.chat.reject",
  "astra.chat.reset",
  "astra.extensions.close",
  "astra.extensions.open",
  "astra.git.close",
  "astra.git.inspect",
  "astra.git.open",
  "astra.git.unstage.close",
  "astra.git.unstage.open",
  "astra.git.unstage.prepare",
  "astra.skill.close",
  "astra.skill.inventory",
  "astra.skill.open",
  "astra.skill.prepare",
  "astra.write.approve",
  "astra.write.close",
  "astra.write.open",
  "astra.write.prepare",
  "astra.write.reject",
  "command.palette.show",
])

/** Returns the deliberately small command surface exposed by Astra Safe Start. */
export function isAstraSafeStartCommand(command: string) {
  return approvedCommands.has(command)
}

/**
 * Safe Start commands are a local user surface. Server events, plugins, and
 * other remote publishers must never trigger an Astra command, including an
 * approval or rejection.
 */
export function allowRemoteTuiCommandDispatch(astraSafeStart: boolean) {
  return !astraSafeStart
}

export function dispatchRemoteTuiCommand(input: Readonly<{
  astraSafeStart: boolean
  eventWorkspace: string | undefined
  currentWorkspace: string | undefined
  command: string
  dispatch: (command: string) => void
}>) {
  if (input.eventWorkspace !== input.currentWorkspace) return false
  if (!allowRemoteTuiCommandDispatch(input.astraSafeStart)) return false
  input.dispatch(input.command)
  return true
}

/**
 * Removes every unapproved user command before it reaches the keymap catalog.
 * Non-palette commands are local UI mechanics such as dialog navigation and
 * text editing; they remain available so the governed surface stays usable.
 */
export function registerAstraSafeStartCommandPolicy(keymap: OpenTuiKeymap) {
  const blocked = new Set<string>()
  const unregisterTransformer = keymap.prependCommandTransformer((command, context) => {
    if (command.namespace !== "palette" || isAstraSafeStartCommand(command.name)) return
    blocked.add(command.name)
    context.skipOriginal()
  })
  const unregisterResolver = keymap.prependCommandResolver((command) => {
    if (!blocked.has(command)) return undefined
    return {
      name: command,
      run: () => ({ ok: false as const, reason: "rejected" as const }),
    }
  })

  return () => {
    unregisterResolver()
    unregisterTransformer()
    blocked.clear()
  }
}
