import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanWorkspace } from "@astra/runtime/preflight"
import { executeHostCommand, proposeHostCommand } from "@astra/runtime/host-command"
import { createAstraHostCommandClient } from "@opencode-ai/tui/astra/host-command-client"
import { createAstraHostCommandControl, type AstraHostCommandControlDependencies } from "../src/host-command-control"
import { startAstraTuiControlServer } from "../src/tui-control-server"
import type { AstraWorkspaceSessionResult } from "../src/workspace-session"

const roots: string[] = []

afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

describe("Astra governed shell control", () => {
  test("previews exact unrestricted authority, rejects without effect, then runs one observed command", async () => {
    const workspace = await temporaryDirectory("astra-shell-workspace-")
    const state = await temporaryDirectory("astra-shell-state-")
    await writeFile(join(workspace, "package.json"), "{}\n")
    const session = await openedSession(workspace)
    const control = createAstraHostCommandControl(session, {
      ledgerFilename: join(state, "operations.sqlite"),
      spoolFilename: join(state, "receipts.sqlite"),
    })

    const rejected = await control.prepare(crypto.randomUUID(), "printf rejected")
    expect(rejected.status).toBe("prepared")
    if (rejected.status !== "prepared") throw new Error(rejected.reason)
    expect(rejected.preview).toMatchObject({
      executable: "/bin/zsh",
      argvPrefix: ["-f", "-c"],
      filesystem: "host_unrestricted",
      network: "host_unrestricted",
      verification: "not_verified",
    })
    expect(await control.decide(crypto.randomUUID(), rejected.preview.proposalID, "reject")).toMatchObject({
      status: "denied_without_effect",
    })

    const prepared = await control.prepare(crypto.randomUUID(), "printf 'astra-shell-ready\\n'")
    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error(prepared.reason)
    const progress: string[] = []
    const result = await control.decide(crypto.randomUUID(), prepared.preview.proposalID, "approve", (value) =>
      progress.push(value.status),
    )
    expect(progress).toEqual(["recording_authority", "executing_host", "effect_observed_not_verified"])
    expect(result).toMatchObject({
      status: "completed_observed_not_verified",
      verification: "not_verified",
      output: { exitCode: 0, stdoutLines: ["astra-shell-ready"], stderrLines: [] },
    })
    expect(JSON.stringify(result)).not.toContain("VERIFIED")
  })

  test("private socket rejects without dispatch and returns bound observed output after approval", async () => {
    const workspace = await temporaryDirectory("astra-shell-socket-workspace-")
    const state = await temporaryDirectory("astra-shell-socket-state-")
    const authorityDirectory = await temporarySocketDirectory()
    await chmod(authorityDirectory, 0o700)
    await writeFile(join(workspace, "package.json"), "{}\n")
    const session = await openedSession(workspace)
    let entered = 0
    const dependencies = {
      now: Date.now,
      createID: () => crypto.randomUUID(),
      propose: proposeHostCommand,
      execute: (input, onProcessEntered) =>
        executeHostCommand(input, {
          onProcessEntered() {
            entered++
            onProcessEntered?.()
          },
        }),
    } satisfies AstraHostCommandControlDependencies
    const control = createAstraHostCommandControl(
      session,
      { ledgerFilename: join(state, "operations.sqlite"), spoolFilename: join(state, "receipts.sqlite") },
      dependencies,
    )
    const sessionID = crypto.randomUUID()
    const server = await startAstraTuiControlServer(
      { directory: authorityDirectory, workspaceRoot: workspace, sessionID, hostCommandControl: control },
      {
        async inspectGitWorkspace() {
          return null
        },
      },
    )
    const client = createAstraHostCommandClient(
      { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
      sessionID,
      { expectedWorkspaceRoot: workspace },
    )

    try {
      const rejected = await client.prepare("printf rejected")
      if (rejected.status !== "prepared") throw new Error(rejected.reason)
      expect(await client.decide(rejected.preview.proposalID, "reject")).toMatchObject({
        status: "denied_without_effect",
      })
      expect(entered).toBe(0)

      const prepared = await client.prepare("printf 'astra-private-socket\\n'")
      if (prepared.status !== "prepared") throw new Error(prepared.reason)
      const progress: string[] = []
      const result = await client.decide(prepared.preview.proposalID, "approve", {
        onProgress: (value) => progress.push(value.status),
      })
      expect(progress).toEqual(["recording_authority", "executing_host", "effect_observed_not_verified"])
      expect(result).toMatchObject({
        status: "completed_observed_not_verified",
        verification: "not_verified",
        output: { exitCode: 0, stdoutLines: ["astra-private-socket"] },
      })
      expect(entered).toBe(1)
    } finally {
      client.dispose()
      await server.close()
    }
  }, 30_000)
})

async function openedSession(workspace: string) {
  const report = await scanWorkspace(workspace)
  return {
    status: "opened",
    mode: "activate-once",
    report,
  } as Extract<AstraWorkspaceSessionResult, { status: "opened" }>
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function temporarySocketDirectory() {
  const root = await mkdtemp(join("/tmp", "as-hc-"))
  roots.push(root)
  return root
}
