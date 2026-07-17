import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitStageProgress } from "../../astra-domain/src/git-stage-control"
import { computeGitStageProposalDigest } from "../../astra-domain/src/git-stage-mutation"
import {
  captureGitRepositoryBaseline,
  captureGitStageInventory,
  inspectGitWorkspace,
  prepareGitStageSelected,
} from "@astra/git"
import { readDurableOperation } from "@astra/runtime/operation-ledger"
import { scanWorkspace } from "@astra/runtime/preflight"
import {
  createAstraGitStageControl,
  type AstraGitStageControl,
  type AstraGitStageControlDependencies,
} from "../src/git-stage-control"
import { createAstraGitStageControlHandler } from "../src/git-stage-control-handler"
import { createAstraGitStageClient } from "@opencode-ai/tui/astra/git-stage-client"
import { startAstraTuiControlServer } from "../src/tui-control-server"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("read-only inventory is blocked without durable or Git effects", async () => {
  const fixture = await makeFixture()
  const control = createAstraGitStageControl({ ...fixture.session, mode: "read-only" }, fixture.state)
  expect(await control.inventory(randomUUID())).toMatchObject({ status: "blocked", reason: "read_only" })
  expect(await stagedFiles(fixture.workspace)).toEqual([])
  expect(await exists(fixture.state.ledgerFilename)).toBeFalse()
  expect(await exists(fixture.state.spoolFilename)).toBeFalse()
}, 90_000)

test("parent creates opaque inventory and prepares only exact selected IDs", async () => {
  const fixture = await makeFixture()
  const control = createAstraGitStageControl(fixture.session, fixture.state)
  const inventoried = await control.inventory(randomUUID())
  if (inventoried.status !== "inventory") throw new Error(inventoried.reason)
  expect(inventoried.inventory).toMatchObject({
    boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    verification: "not_verified",
    baselineSnapshotDigest: fixture.session.repositoryBaseline.snapshotDigest,
  })
  expect(inventoried.inventory.candidates.map((candidate) => candidate.path)).toEqual(["tracked.txt", "untracked.txt"])
  expect(inventoried.inventory.candidates.every((candidate) => candidate.candidateID !== candidate.path)).toBeTrue()
  const selected = inventoried.inventory.candidates.find((candidate) => candidate.path === "tracked.txt")!

  expect(await control.prepare(randomUUID(), inventoried.inventory.inventoryID, [randomUUID()])).toMatchObject({
    status: "blocked",
    reason: "invalid_selection",
  })
  const prepared = await control.prepare(randomUUID(), inventoried.inventory.inventoryID, [selected.candidateID])
  if (prepared.status !== "prepared") throw new Error(prepared.reason)
  expect(prepared.preview.authority).toMatchObject({
    boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    selection: { candidateIDs: [selected.candidateID] },
    verification: "not_verified",
  })
  expect(prepared.preview.authority.repositoryWrites).toContain(".git/index")
  expect(prepared.preview.authority.repositoryWrites).toContain(".git/index.lock")
  expect(prepared.preview.authority.candidates.map((candidate) => candidate.path)).toEqual(["tracked.txt"])
  expect(await stagedFiles(fixture.workspace)).toEqual([])
}, 90_000)

test("parent rejects a recomputed prepare preview that changes an inventory candidate", async () => {
  const fixture = await makeFixture()
  const unavailable = async (): Promise<never> => {
    throw new Error("The tampered preview must not reach execution")
  }
  const dependencies = {
    now: Date.now,
    captureInventory: captureGitStageInventory,
    prepare(inventory, candidateIDs, now) {
      const prepared = prepareGitStageSelected(inventory, candidateIDs, now)
      if (prepared.status !== "ready") return prepared
      const candidate = prepared.preview.candidates[0]
      if (!candidate || candidate.after.state !== "object") throw new Error("Expected an upsert candidate")
      const tampered = {
        ...candidate,
        after: { ...candidate.after, contentDigest: `sha256:${"f".repeat(64)}` as const },
      }
      const { proposalDigest: _proposalDigest, ...base } = prepared.preview
      const authority = { ...base, candidates: [tampered] }
      return { status: "ready", preview: { ...authority, proposalDigest: computeGitStageProposalDigest(authority) } }
    },
    execute: unavailable,
    verify: unavailable,
    adapter: { execute: unavailable, verify: unavailable },
  } satisfies AstraGitStageControlDependencies
  const control = createAstraGitStageControl(fixture.session, fixture.state, dependencies)
  const inventoried = await control.inventory(randomUUID())
  if (inventoried.status !== "inventory") throw new Error(inventoried.reason)
  const candidate = inventoried.inventory.candidates.find((value) => value.path === "tracked.txt")!
  expect(await control.prepare(randomUUID(), inventoried.inventory.inventoryID, [candidate.candidateID])).toMatchObject(
    { status: "blocked", reason: "preparation_unavailable" },
  )
  expect(await stagedFiles(fixture.workspace)).toEqual([])
}, 90_000)

test("rejection is durable and produces no Git index effect", async () => {
  const fixture = await preparedFixture()
  const denied = await fixture.control.decide(randomUUID(), fixture.proposalID, "reject")
  expect(denied).toMatchObject({ status: "denied_without_git_effect", proposalID: fixture.proposalID })
  expect(await stagedFiles(fixture.workspace)).toEqual([])
  if (denied.status !== "denied_without_git_effect") throw new Error("Missing durable denial")
  expect(await readDurableOperation(fixture.state.ledgerFilename, denied.operationID)).toMatchObject({
    state: "denied",
  })
}, 90_000)

test("selected Stage reaches an exact receipt-bound independently verified terminal", async () => {
  const fixture = await preparedFixture()
  const progress: GitStageProgress[] = []
  const terminal = await fixture.control.decide(randomUUID(), fixture.proposalID, "approve", (value) =>
    progress.push(value),
  )
  expect(progress.map((value) => value.status)).toEqual([
    "recording_authority",
    "host_adapter_validating",
    "effect_observed_not_verified",
    "verifying",
  ])
  expect(terminal).toMatchObject({
    status: "verified",
    verification: "independent_selected_index_and_preservation",
    proposalID: fixture.proposalID,
  })
  if (terminal.status !== "verified") throw new Error(JSON.stringify(terminal))
  expect(terminal.receiptID).toMatch(/^[0-9a-f-]{36}$/)
  expect(terminal.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])
  expect(await untrackedFiles(fixture.workspace)).toContain("untracked.txt")
}, 120_000)

test("TUI client rejects without effect then stages one exact path through the private server", async () => {
  const fixture = await makeFixture()
  const sessionID = randomUUID()
  const stageControl = createAstraGitStageControl(fixture.session, fixture.state)
  const server = await startAstraTuiControlServer({
    directory: fixture.root,
    workspaceRoot: fixture.workspace,
    sessionID,
    gitStageControl: stageControl,
  })
  const client = createAstraGitStageClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
    sessionID,
    {
      expectedWorkspaceRoot: fixture.workspace,
      expectedBaselineSnapshotDigest: fixture.session.repositoryBaseline.snapshotDigest,
    },
  )

  try {
    const firstInventory = await client.inventory()
    if (firstInventory.status !== "inventory") throw new Error(firstInventory.reason)
    const firstCandidate = firstInventory.inventory.candidates.find((candidate) => candidate.path === "tracked.txt")
    if (!firstCandidate) throw new Error("Missing tracked candidate")
    const rejectedPreview = await client.prepare(firstInventory.inventory.inventoryID, [firstCandidate.candidateID])
    if (rejectedPreview.status !== "prepared") throw new Error(rejectedPreview.reason)
    expect(await client.decide(rejectedPreview.preview.proposalID, "reject")).toMatchObject({
      status: "denied_without_git_effect",
    })
    expect(await stagedFiles(fixture.workspace)).toEqual([])

    const secondInventory = await client.inventory()
    if (secondInventory.status !== "inventory") throw new Error(secondInventory.reason)
    const selected = secondInventory.inventory.candidates.find((candidate) => candidate.path === "tracked.txt")
    if (!selected) throw new Error("Missing tracked candidate after rejection")
    const approvedPreview = await client.prepare(secondInventory.inventory.inventoryID, [selected.candidateID])
    if (approvedPreview.status !== "prepared") throw new Error(approvedPreview.reason)
    expect(await client.decide(approvedPreview.preview.proposalID, "approve")).toMatchObject({
      status: "verified",
      verification: "independent_selected_index_and_preservation",
    })
    expect(await stagedFiles(fixture.workspace)).toEqual(["tracked.txt"])
    expect(await untrackedFiles(fixture.workspace)).toContain("untracked.txt")
  } finally {
    client.dispose()
    await server.close()
  }
}, 180_000)

test("handler rejects path injection and binds single-flight terminals", async () => {
  let finish!: (value: Awaited<ReturnType<AstraGitStageControl["inventory"]>>) => void
  let calls = 0
  const control = {
    inventory() {
      calls++
      return new Promise<Awaited<ReturnType<AstraGitStageControl["inventory"]>>>((resolve) => {
        finish = resolve
      })
    },
    prepare(requestId) {
      return Promise.resolve({ schemaVersion: 1, requestId, status: "blocked", reason: "unused" } as const)
    },
    decide(requestId, proposalID) {
      return Promise.resolve({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "unused" } as const)
    },
  } satisfies AstraGitStageControl
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const handler = createAstraGitStageControlHandler({ sessionID, token, control })
  const inventoryRequest = {
    schemaVersion: 1,
    method: "git-stage.inventory",
    requestId: randomUUID(),
    sessionID,
    token,
  } as const

  expect(handler.dispatch({ ...inventoryRequest, workspaceRoot: "/tmp/attacker" })).toEqual({ status: "rejected" })
  expect(handler.dispatch({ ...inventoryRequest, token: "y".repeat(43) })).toEqual({ status: "rejected" })
  const first = handler.dispatch(inventoryRequest)
  expect(first.status).toBe("accepted")
  const busy = handler.dispatch({ ...inventoryRequest, requestId: randomUUID() })
  if (busy.status !== "accepted") throw new Error("Expected busy terminal")
  expect(await busy.terminal).toMatchObject({ status: "blocked", reason: "control_busy" })
  expect(calls).toBe(1)

  finish({ schemaVersion: 1, requestId: inventoryRequest.requestId, status: "blocked", reason: "test_complete" })
  if (first.status !== "accepted") throw new Error("Expected accepted inventory")
  expect(await first.terminal).toMatchObject({ status: "blocked", reason: "test_complete" })

  const injected = {
    schemaVersion: 1,
    method: "git-stage.prepare",
    requestId: randomUUID(),
    sessionID,
    token,
    inventoryID: randomUUID(),
    candidateIDs: [randomUUID()],
    path: "src/attacker.ts",
  } as const
  expect(handler.dispatch(injected)).toEqual({ status: "rejected" })
}, 30_000)

async function preparedFixture() {
  const fixture = await makeFixture()
  const control = createAstraGitStageControl(fixture.session, fixture.state)
  const inventoried = await control.inventory(randomUUID())
  if (inventoried.status !== "inventory") throw new Error(inventoried.reason)
  const candidate = inventoried.inventory.candidates.find((value) => value.path === "tracked.txt")!
  const prepared = await control.prepare(randomUUID(), inventoried.inventory.inventoryID, [candidate.candidateID])
  if (prepared.status !== "prepared") throw new Error(prepared.reason)
  return { ...fixture, control, proposalID: prepared.preview.proposalID }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-git-stage-control-"))
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
  await writeFile(join(workspace, "untracked.txt"), "new\n")
  const report = await scanWorkspace(workspace)
  const captured = await captureGitRepositoryBaseline(workspace, {
    timeoutMs: 10_000,
    maxBoundaryDurationMs: 30_000,
    maxDurationMs: 60_000,
  })
  const inspection = await inspectGitWorkspace(workspace, { timeoutMs: 10_000, maxBoundaryDurationMs: 30_000 })
  if (report.completeness !== "complete" || captured.status !== "complete" || inspection.status !== "complete") {
    throw new Error(`Fixture failed: ${JSON.stringify({ report, captured, inspection })}`)
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

async function stagedFiles(workspace: string) {
  const output = await git(workspace, ["diff", "--cached", "--name-only"])
  return output.trim() ? output.trim().split("\n") : []
}

async function untrackedFiles(workspace: string) {
  const output = await git(workspace, ["ls-files", "--others", "--exclude-standard"])
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

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
