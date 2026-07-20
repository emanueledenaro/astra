import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"

const appleTerminalProgram = "Apple_Terminal"

/** Clears only the active alternate-screen history and returns its viewport to the top. */
export const ASTRA_ALTERNATE_SCREEN_RESET = "\u001b[3J\u001b[H"

type AstraTerminalHost = Readonly<{
  program: string | undefined
  write: (value: string) => void
}>

type AstraCompatibleRenderer = Pick<CliRenderer, "disableKittyKeyboard">

/** Applies the compatibility boundary required by the built-in macOS Terminal. */
export function prepareAstraTerminalRenderer<Renderer extends AstraCompatibleRenderer>(
  renderer: Renderer,
  host: AstraTerminalHost = {
    program: process.env.TERM_PROGRAM,
    write: (value) => process.stdout.write(value),
  },
): Renderer {
  if (host.program !== appleTerminalProgram) return renderer
  renderer.disableKittyKeyboard()
  host.write(ASTRA_ALTERNATE_SCREEN_RESET)
  return renderer
}

/** Creates a fixed full-screen Astra renderer with predictable terminal ownership. */
export async function createAstraCliRenderer(config: CliRendererConfig = {}) {
  const renderer = await createCliRenderer({
    ...config,
    screenMode: "alternate-screen",
    clearOnShutdown: true,
  })
  return prepareAstraTerminalRenderer(renderer)
}
