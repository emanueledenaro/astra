/** @jsxImportSource @opentui/solid */

import { astraProviderConnectExitCode } from "@astra/domain/tui-handoff"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/** Registers the Astra-owned provider setup handoff under the familiar /connect command. */
export function registerAstraProviderConnect(api: TuiPluginApi, authority: AstraSessionAuthority) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "astra.provider.connect",
        title: "Connect Anthropic provider",
        slashName: "connect",
        category: "Provider",
        namespace: "palette",
        run() {
          if (authority.mode !== "activate-once") {
            api.ui.dialog.replace(() => (
              <api.ui.DialogAlert
                title="Provider connection blocked"
                message="This workspace is read-only. Restart Astra and choose Activate once before changing the global OpenCode credential store. No credential was changed."
              />
            ))
            return
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogConfirm
              title="Connect Anthropic"
              message={[
                "Astra will temporarily close this interface and ask for your API key with hidden input.",
                "",
                "WRITE: global OpenCode credential store",
                "NETWORK: none during credential setup",
                "SECRET: held by the trusted parent only; never sent to chat, AI, plugins, or MCP",
                "AUDIT: setup handoff only; durable Operation receipt is not implemented yet",
                "",
                "After setup, Astra will reopen this same workspace session.",
              ].join("\n")}
              onConfirm={() => requestProviderConnectHandoff(api)}
            />
          ))
        },
      },
    ],
  })
}

export function requestProviderConnectHandoff(api: Pick<TuiPluginApi, "renderer" | "ui">) {
  api.ui.dialog.clear()
  process.exitCode = astraProviderConnectExitCode
  api.renderer.destroy()
}
