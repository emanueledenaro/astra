import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkspaceSearchProgress } from "@astra/domain/governed-workspace-search-control"
import {
  executeGovernedWorkspaceSearch,
  proposeGovernedWorkspaceSearch,
} from "@astra/runtime/governed-workspace-search"
import { readDurableOperation } from "@astra/runtime/operation-ledger"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraGovernedWorkspaceSearchClient } from "@opencode-ai/tui/astra/governed-workspace-search-client"
import {
  createAstraGovernedWorkspaceSearchControl,
  type AstraGovernedWorkspaceSearchControl,
  type AstraGovernedWorkspaceSearchControlDependencies,
} from "../src/governed-workspace-search-control"
import { createAstraGovernedWorkspaceSearchControlHandler } from "../src/governed-workspace-search-control-handler"
import { startAstraTuiControlServer } from "../src/tui-control-server"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("read-only preparation creates no process or durable state", async () => {
  const fixture = await makeFixture()
  const control = createAstraGovernedWorkspaceSearchControl({ ...fixture.session, mode: "read-only" }, fixture.state)

  expect(await control.prepare(randomUUID(), "needle")).toMatchObject({ status: "blocked", reason: "read_only" })
  expect(await exists(fixture.state.ledgerFilename)).toBeFalse()
  expect(await exists(fixture.state.spoolFilename)).toBeFalse()
  expect(await workspaceFiles(fixture.workspace)).toEqual(fixture.initialFiles)
})

test("real private-socket smoke proves rejection has no process and approval returns sanitized observed output", async () => {
  const fixture = await makeFixture()
  let entered = 0
  const dependencies = {
    now: Date.now,
    createID: randomUUID,
    propose: proposeGovernedWorkspaceSearch,
    execute: (input, onProcessEntered) =>
      executeGovernedWorkspaceSearch(input, {
        onProcessEntered() {
          entered++
          onProcessEntered?.()
        },
      }),
  } satisfies AstraGovernedWorkspaceSearchControlDependencies
  const control = createAstraGovernedWorkspaceSearchControl(fixture.session, fixture.state, dependencies)
  const socket = await startAstraTuiControlServer(
    {
      directory: fixture.authorityDirectory,
      workspaceRoot: fixture.workspace,
      sessionID: fixture.sessionID,
      governedWorkspaceSearchControl: control,
    },
    {
      async inspectGitWorkspace() {
        return null
      },
    },
  )
  const client = createAstraGovernedWorkspaceSearchClient(
    { ASTRA_CONTROL_SOCKET: socket.socketPath, ASTRA_CONTROL_TOKEN: socket.token },
    fixture.sessionID,
    { expectedWorkspaceRoot: fixture.workspace },
  )

  try {
    const rejectedPreview = await client.prepare("needle")
    if (rejectedPreview.status !== "prepared") throw new Error(`Search preparation blocked: ${rejectedPreview.reason}`)
    expect(rejectedPreview.preview).toMatchObject({
      executable: "/usr/bin/grep",
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      writes: [],
      verification: "not_verified",
    })
    const denied = await client.decide(rejectedPreview.preview.proposalID, "reject")
    expect(denied).toMatchObject({ status: "denied_without_effect", verification: "not_verified" })
    expect(entered).toBe(0)
    if (denied.status !== "denied_without_effect") throw new Error("Missing durable rejection")
    expect(await readDurableOperation(fixture.state.ledgerFilename, denied.operationID)).toMatchObject({
      state: "denied",
    })
    expect(await workspaceFiles(fixture.workspace)).toEqual(fixture.initialFiles)

    const prepared = await client.prepare("needle")
    if (prepared.status !== "prepared") throw new Error(`Search preparation blocked: ${prepared.reason}`)
    const progress: WorkspaceSearchProgress[] = []
    const completed = await client.decide(prepared.preview.proposalID, "approve", {
      onProgress: (value) => progress.push(value),
    })
    expect(progress.map((value) => value.status)).toEqual([
      "recording_authority",
      "executing_host",
      "effect_observed_not_verified",
    ])
    expect(completed).toMatchObject({
      status: "completed_observed_not_verified",
      verification: "not_verified",
      output: { outcome: "matches", outputLineCount: 1, truncated: false },
    })
    expect(entered).toBe(1)
    if (completed.status !== "completed_observed_not_verified") throw new Error("Missing observed search result")
    expect(completed.output.displayLines.join("\n")).toContain("needle")
    expect(/\p{C}/u.test(completed.output.displayLines.join(""))).toBeFalse()
    expect(JSON.stringify(completed)).not.toContain("\u001b]2;owned")
    expect(JSON.stringify(completed)).not.toContain('VERIFIED"')
    expect(await workspaceFiles(fixture.workspace)).toEqual(fixture.initialFiles)
  } finally {
    client.dispose()
    await socket.close()
  }
}, 30_000)

test("handler authenticates, rejects caller scope, and keeps single-flight until the parent task settles", async () => {
  let finish!: (result: Awaited<ReturnType<AstraGovernedWorkspaceSearchControl["prepare"]>>) => void
  let calls = 0
  const control = {
    prepare() {
      calls++
      return new Promise<Awaited<ReturnType<AstraGovernedWorkspaceSearchControl["prepare"]>>>((resolve) => {
        finish = resolve
      })
    },
    decide(requestId, proposalID) {
      return Promise.resolve({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "unused" } as const)
    },
  } satisfies AstraGovernedWorkspaceSearchControl
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const handler = createAstraGovernedWorkspaceSearchControlHandler({ sessionID, token, control })
  const firstRequest = prepareRequest(sessionID, token)

  expect(handler.dispatch({ ...firstRequest, token: "y".repeat(43) })).toEqual({ status: "rejected" })
  expect(handler.dispatch({ ...firstRequest, workspaceRoot: "/tmp/caller-selected" })).toEqual({ status: "rejected" })
  expect(handler.dispatch({ ...firstRequest, argv: ["sh", "-c", "echo no"] })).toEqual({ status: "rejected" })
  expect(calls).toBe(0)

  const first = handler.dispatch(firstRequest)
  expect(first.status).toBe("accepted")
  const busy = handler.dispatch(prepareRequest(sessionID, token))
  if (busy.status !== "accepted") throw new Error("Expected an accepted busy terminal")
  expect(await busy.terminal).toMatchObject({ status: "blocked", reason: "control_busy" })
  expect(calls).toBe(1)

  finish({ schemaVersion: 1, requestId: firstRequest.requestId, status: "blocked", reason: "test_complete" })
  if (first.status !== "accepted") throw new Error("Expected the first task")
  expect(await first.terminal).toMatchObject({ reason: "test_complete" })
  const replay = handler.dispatch(firstRequest)
  if (replay.status !== "accepted") throw new Error("Expected replay terminal")
  expect(await replay.terminal).toMatchObject({ status: "blocked", reason: "request_replayed" })
})

test("client disconnect does not release parent ownership before the task settles", async () => {
  const fixture = await makeFixture()
  let finish!: (result: Awaited<ReturnType<AstraGovernedWorkspaceSearchControl["prepare"]>>) => void
  let firstRequestID = ""
  let calls = 0
  const control = {
    prepare(requestId) {
      calls++
      if (calls > 1) {
        return Promise.resolve({ schemaVersion: 1, requestId, status: "blocked", reason: "after_settlement" } as const)
      }
      firstRequestID = requestId
      return new Promise<Awaited<ReturnType<AstraGovernedWorkspaceSearchControl["prepare"]>>>((resolve) => {
        finish = resolve
      })
    },
    decide(requestId, proposalID) {
      return Promise.resolve({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "unused" } as const)
    },
  } satisfies AstraGovernedWorkspaceSearchControl
  const server = await startAstraTuiControlServer(
    {
      directory: fixture.authorityDirectory,
      workspaceRoot: fixture.workspace,
      sessionID: fixture.sessionID,
      governedWorkspaceSearchControl: control,
    },
    {
      async inspectGitWorkspace() {
        return null
      },
    },
  )
  const client = createAstraGovernedWorkspaceSearchClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
    fixture.sessionID,
  )
  const disconnected = await openAcceptedRequest(server.socketPath, prepareRequest(fixture.sessionID, server.token))

  try {
    disconnected.destroy()
    expect(await client.prepare("needle")).toMatchObject({ status: "blocked", reason: "control_busy" })
    expect(calls).toBe(1)
    finish({ schemaVersion: 1, requestId: firstRequestID, status: "blocked", reason: "task_complete" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await client.prepare("needle")).toMatchObject({ status: "blocked", reason: "after_settlement" })
    expect(calls).toBe(2)
  } finally {
    disconnected.destroy()
    client.dispose()
    await server.close()
  }
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-search-control-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const authorityDirectory = await mkdtemp(join("/tmp", "astra-search-socket-"))
  roots.push(authorityDirectory)
  await mkdir(workspace)
  await chmod(authorityDirectory, 0o700)
  await writeFile(join(workspace, "package.json"), "{}\n")
  await writeFile(join(workspace, "source.txt"), "prefix needle suffix\u001b]2;owned\u0007\n")
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error("Workspace preflight failed")
  return {
    root,
    workspace,
    authorityDirectory,
    sessionID: randomUUID(),
    initialFiles: await workspaceFiles(workspace),
    state: {
      ledgerFilename: join(root, "state", "operations.sqlite"),
      spoolFilename: join(root, "state", "receipts.sqlite"),
    },
    session: { status: "opened", mode: "activate-once", report } as const,
  }
}

function prepareRequest(sessionID: string, token: string) {
  return {
    schemaVersion: 1,
    method: "search.prepare",
    requestId: randomUUID(),
    sessionID,
    token,
    query: "needle",
  } as const
}

async function workspaceFiles(workspace: string) {
  const names = (await readdir(workspace)).sort()
  return Promise.all(names.map(async (name) => [name, await readFile(join(workspace, name), "utf8")] as const))
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function openAcceptedRequest(socketPath: string, request: Readonly<Record<string, unknown>>) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffered = ""
    socket.setEncoding("utf8")
    socket.once("error", reject)
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      try {
        const message: unknown = JSON.parse(buffered.slice(0, newline))
        if (typeof message === "object" && message !== null && "type" in message && message.type === "accepted")
          resolve(socket)
        else reject(new Error("Expected accepted frame"))
      } catch (error) {
        reject(error)
      }
    })
  })
}
