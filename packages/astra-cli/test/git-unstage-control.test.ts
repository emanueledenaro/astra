import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitUnstageProgress } from "@astra/domain/git-unstage-control"
import { captureGitRepositoryBaseline, inspectGitWorkspace } from "@astra/git"
import { readDurableOperation } from "@astra/runtime/operation-ledger"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraGitUnstageClient } from "@opencode-ai/tui/astra/git-unstage-client"
import { createAstraGitUnstageControl, type AstraGitUnstageControl } from "../src/git-unstage-control"
import {
  createAstraGitUnstageControlHandler,
  type AstraGitUnstageControlHandler,
} from "../src/git-unstage-control-handler"
import { serveAstraGitUnstageControlRequest } from "../src/git-unstage-control-server-hook"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("read-only and missing baseline preparation have no Git or durable-state effect", async () => {
  const fixture = await makeFixture()
  const readOnly = createAstraGitUnstageControl({ ...fixture.session, mode: "read-only" }, fixture.state)
  const noBaseline = createAstraGitUnstageControl(
    { status: "opened", mode: "activate-once", report: fixture.session.report },
    fixture.state,
  )

  expect(await readOnly.prepare(randomUUID())).toMatchObject({ status: "blocked", reason: "read_only" })
  expect(await noBaseline.prepare(randomUUID())).toMatchObject({ status: "blocked", reason: "git_baseline_required" })
  expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])
  expect(await exists(fixture.state.ledgerFilename)).toBeFalse()
  expect(await exists(fixture.state.spoolFilename)).toBeFalse()
}, 90_000)

test("previews exact resources and records rejection without changing the index", async () => {
  const fixture = await makeFixture()
  const control = createAstraGitUnstageControl(fixture.session, fixture.state)
  const requestId = randomUUID()
  const prepared = await control.prepare(requestId)
  expect(prepared.status).toBe("prepared")
  if (prepared.status !== "prepared") throw new Error(`Preparation blocked: ${prepared.reason}`)
  expect(prepared.preview.authority).toMatchObject({
    stagedCount: 1,
    boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    repositoryWrites: [".git/index", ".git/index.lock"],
    network: "not_requested_host_unrestricted",
    verification: "not_verified",
  })
  expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])

  const denied = await control.decide(randomUUID(), prepared.preview.proposalID, "reject")
  expect(denied).toMatchObject({ status: "denied_without_git_effect", proposalID: prepared.preview.proposalID })
  expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])
  if (denied.status !== "denied_without_git_effect") throw new Error("Missing durable denial")
  expect(await readDurableOperation(fixture.state.ledgerFilename, denied.operationID)).toMatchObject({
    state: "denied",
  })
}, 90_000)

test("claims authority, unstages once, observes, then verifies independently", async () => {
  const fixture = await makeFixture()
  const control = createAstraGitUnstageControl(fixture.session, fixture.state)
  const prepared = await control.prepare(randomUUID())
  if (prepared.status !== "prepared") throw new Error(`Preparation blocked: ${prepared.reason}`)
  const progress: GitUnstageProgress[] = []

  const executing = control.decide(randomUUID(), prepared.preview.proposalID, "approve", (value) =>
    progress.push(value),
  )
  const replay = await control.decide(randomUUID(), prepared.preview.proposalID, "approve")
  const result = await executing

  expect(replay).toMatchObject({ status: "blocked", reason: "proposal_consumed" })
  expect(progress.map((value) => value.status)).toEqual([
    "recording_authority",
    "host_adapter_validating",
    "effect_observed_not_verified",
    "verifying",
  ])
  expect(result).toMatchObject({ status: "verified", verification: "independent_post_state" })
  expect(await stagedFiles(fixture.workspace)).toEqual([])
  expect(await readFile(join(fixture.workspace, "tracked.txt"), "utf8")).toBe("changed\n")
}, 90_000)

test("handler rejects hostile scope and retains single-flight ownership until settlement", async () => {
  let finish!: (
    value: ReturnType<AstraGitUnstageControl["prepare"]> extends Promise<infer Result> ? Result : never,
  ) => void
  let calls = 0
  const control = {
    prepare() {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    decide(requestId, proposalID) {
      return Promise.resolve({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "unused" } as const)
    },
  } satisfies AstraGitUnstageControl
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const handler = createAstraGitUnstageControlHandler({ sessionID, token, control })
  const firstRequest = request(sessionID, token)

  expect(handler.dispatch({ ...firstRequest, token: "y".repeat(43) })).toEqual({ status: "rejected" })
  expect(handler.dispatch({ ...firstRequest, sessionID: randomUUID() })).toEqual({ status: "rejected" })
  expect(handler.dispatch({ ...firstRequest, workspaceRoot: "/tmp/attacker" })).toEqual({ status: "rejected" })
  expect(calls).toBe(0)
  const first = handler.dispatch(firstRequest)
  expect(first.status).toBe("accepted")
  const busy = handler.dispatch(request(sessionID, token))
  expect(busy.status).toBe("accepted")
  if (busy.status !== "accepted") throw new Error("Expected a busy terminal")
  expect(await busy.terminal).toMatchObject({ status: "blocked", reason: "control_busy" })
  expect(calls).toBe(1)

  finish({ schemaVersion: 1, requestId: firstRequest.requestId, status: "blocked", reason: "test_complete" })
  if (first.status !== "accepted") throw new Error("Expected first dispatch")
  expect(await first.terminal).toMatchObject({ reason: "test_complete" })
  const replay = handler.dispatch(firstRequest)
  if (replay.status !== "accepted") throw new Error("Expected replay terminal")
  expect(await replay.terminal).toMatchObject({ status: "blocked", reason: "request_replayed" })
})

test("runs the real TUI client through AF_UNIX, parent handler, Operation Kernel, and Git adapter", async () => {
  const fixture = await makeFixture()
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const handler = createAstraGitUnstageControlHandler({
    sessionID,
    token,
    control: createAstraGitUnstageControl(fixture.session, fixture.state),
  })
  const server = await socketServer(handler)
  const client = createAstraGitUnstageClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: token },
    sessionID,
    {
      expectedWorkspaceRoot: fixture.workspace,
      expectedBaselineSnapshotDigest: fixture.session.repositoryBaseline.snapshotDigest,
    },
  )

  try {
    const prepared = await client.prepare()
    if (prepared.status !== "prepared") throw new Error(`Preparation blocked: ${prepared.reason}`)
    const result = await client.decide(prepared.preview.proposalID, "approve")
    expect(result).toMatchObject({ status: "verified", verification: "independent_post_state" })
    expect(await stagedFiles(fixture.workspace)).toEqual([])
    expect(await readFile(join(fixture.workspace, "tracked.txt"), "utf8")).toBe("changed\n")
  } finally {
    client.dispose()
    await server.close()
  }
}, 90_000)

test("AF_UNIX read-only and rejection paths never change the Git index", async () => {
  const fixture = await makeFixture()
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const readOnly = createAstraGitUnstageControlHandler({
    sessionID,
    token,
    control: createAstraGitUnstageControl({ ...fixture.session, mode: "read-only" }, fixture.state),
  })
  const readOnlyServer = await socketServer(readOnly)
  const readOnlyClient = createAstraGitUnstageClient(
    { ASTRA_CONTROL_SOCKET: readOnlyServer.socketPath, ASTRA_CONTROL_TOKEN: token },
    sessionID,
  )
  try {
    expect(await readOnlyClient.prepare()).toMatchObject({ status: "blocked", reason: "read_only" })
    expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])
  } finally {
    readOnlyClient.dispose()
    await readOnlyServer.close()
  }

  const activeSessionID = randomUUID()
  const activeToken = "y".repeat(43)
  const active = createAstraGitUnstageControlHandler({
    sessionID: activeSessionID,
    token: activeToken,
    control: createAstraGitUnstageControl(fixture.session, fixture.state),
  })
  const activeServer = await socketServer(active)
  const activeClient = createAstraGitUnstageClient(
    { ASTRA_CONTROL_SOCKET: activeServer.socketPath, ASTRA_CONTROL_TOKEN: activeToken },
    activeSessionID,
  )
  try {
    const prepared = await activeClient.prepare()
    if (prepared.status !== "prepared") throw new Error(`Preparation blocked: ${prepared.reason}`)
    expect(await activeClient.decide(prepared.preview.proposalID, "reject")).toMatchObject({
      status: "denied_without_git_effect",
    })
    expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])
  } finally {
    activeClient.dispose()
    await activeServer.close()
  }
}, 90_000)

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-git-control-"))
  roots.push(root)
  const workspacePath = join(root, "workspace")
  await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  await writeFile(join(workspace, "tracked.txt"), "initial\n")
  await git(workspace, ["init", "-q"])
  await git(workspace, ["config", "user.email", "astra@example.invalid"])
  await git(workspace, ["config", "user.name", "Astra Test"])
  await git(workspace, ["add", "tracked.txt"])
  await git(workspace, ["commit", "-qm", "initial"])
  await writeFile(join(workspace, "tracked.txt"), "changed\n")
  await git(workspace, ["add", "tracked.txt"])
  const report = await scanWorkspace(workspace)
  const captured = await captureGitRepositoryBaseline(workspace, {
    timeoutMs: 10_000,
    maxBoundaryDurationMs: 30_000,
    maxDurationMs: 60_000,
  })
  const inspection = await inspectGitWorkspace(workspace, {
    timeoutMs: 10_000,
    maxBoundaryDurationMs: 30_000,
  })
  if (report.completeness !== "complete" || captured.status !== "complete" || inspection.status !== "complete") {
    throw new Error(`Fixture baseline failed: ${JSON.stringify({ report, captured, inspection })}`)
  }
  return {
    root,
    workspace,
    state: {
      ledgerFilename: join(root, "state", "operations.sqlite"),
      spoolFilename: join(root, "state", "receipts.sqlite"),
    },
    session: {
      status: "opened",
      mode: "activate-once",
      report,
      repositoryBaseline: captured.snapshot,
      repositoryInspection: inspection,
    } as const,
  }
}

async function socketServer(handler: AstraGitUnstageControlHandler) {
  const socketPath = join("/tmp", `astra-unstage-${randomUUID()}.sock`)
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let buffered = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      let candidate: unknown
      try {
        candidate = JSON.parse(line)
      } catch {
        socket.destroy()
        return
      }
      void serveAstraGitUnstageControlRequest(socket, candidate, handler).catch(() => socket.destroy())
    })
  })
  await listen(server, socketPath)
  await chmod(socketPath, 0o600)
  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
      await rm(socketPath, { force: true })
    },
  }
}

async function stagedFiles(workspace: string) {
  const output = await git(workspace, ["diff", "--cached", "--name-only"])
  return output.trim() ? output.trim().split("\n") : []
}

async function git(workspace: string, args: string[]) {
  const process = Bun.spawn(["/usr/bin/git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Git failed: ${stderr}`)
  return stdout
}

function request(sessionID: string, token: string) {
  return { schemaVersion: 1, method: "git-unstage.prepare", requestId: randomUUID(), sessionID, token } as const
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
