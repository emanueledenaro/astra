/** @jsxImportSource @opentui/solid */

import { astraProviderConnectExitCode } from "@astra/domain/tui-handoff"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { expect, test } from "bun:test"
import { isAstraSafeStartCommand } from "../../../src/astra/command-policy"
import { registerAstraProviderConnect } from "../../../src/feature-plugins/system/astra-provider-connect"

test("registers /connect as an explicit trusted-parent handoff", () => {
  let command: Command | undefined
  let confirmation: Confirmation | undefined
  let destroyed = 0
  const previousExitCode = process.exitCode
  const api = fakeApi({
    register(value) {
      command = value
    },
    confirm(value) {
      confirmation = value
    },
    destroy() {
      destroyed++
    },
  })

  try {
    registerAstraProviderConnect(api, authority)
    expect(command?.name).toBe("astra.provider.connect")
    expect(command?.slashName).toBe("connect")
    expect(isAstraSafeStartCommand("astra.provider.connect")).toBeTrue()

    command?.run({} as Parameters<Command["run"]>[0])
    expect(confirmation?.message).toContain("global OpenCode credential store")
    expect(confirmation?.message).toContain("trusted parent only")
    expect(confirmation?.message).toContain("durable Operation receipt is not implemented yet")
    expect(destroyed).toBe(0)
    confirmation?.onConfirm?.()
    expect(process.exitCode).toBe(astraProviderConnectExitCode)
    expect(destroyed).toBe(1)
  } finally {
    process.exitCode = previousExitCode ?? 0
  }
})

test("read-only blocks provider credential changes without a handoff", () => {
  let command: Command | undefined
  let alert = ""
  let destroyed = 0
  const api = fakeApi({
    register(value) {
      command = value
    },
    alert(message) {
      alert = message
    },
    destroy() {
      destroyed++
    },
  })

  registerAstraProviderConnect(api, { ...authority, mode: "read-only" })
  command?.run({} as Parameters<Command["run"]>[0])
  expect(alert).toContain("read-only")
  expect(alert).toContain("No credential was changed")
  expect(destroyed).toBe(0)
})

type Command = NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
type Confirmation = Readonly<{ message: string; onConfirm?: () => void }>

function fakeApi(callbacks: {
  register: (command: Command) => void
  confirm?: (confirmation: Confirmation) => void
  alert?: (message: string) => void
  destroy: () => void
}) {
  return {
    keymap: {
      registerLayer(layer: Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]) {
        layer.commands?.forEach(callbacks.register)
        return () => {}
      },
    },
    renderer: { destroy: callbacks.destroy },
    ui: {
      DialogAlert(props: { message: string }) {
        callbacks.alert?.(props.message)
        return null
      },
      DialogConfirm(props: Confirmation) {
        callbacks.confirm?.(props)
        return null
      },
      dialog: {
        clear() {},
        replace(render: () => unknown) {
          render()
        },
      },
    },
  } as unknown as TuiPluginApi
}

const authority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-19T18:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/tmp/astra-provider-connect",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"a".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const satisfies AstraSessionAuthority
