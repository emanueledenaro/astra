import type { OpenTuiKeymap } from "../keymap"

const approvedCommands = new Set([
  "app.exit",
  "astra.extensions.close",
  "astra.extensions.open",
  "astra.git.close",
  "astra.git.inspect",
  "astra.git.open",
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
