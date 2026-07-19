import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createAstraExtensionInventoryClient } from "../../tui/src/astra/extension-inventory-client"
import { inspectTrustedExtensionInventoryHelper, executeExtensionInventory } from "../../astra-runtime/src/extension-inventory-operation"
import { scanWorkspace } from "../../astra-runtime/src/workspace-preflight"
import { createAstraExtensionInventoryControl } from "../src/extension-inventory-control"
import { startAstraTuiControlServer } from "../src/tui-control-server"

const helperRoot = resolve(import.meta.dir, "../../../tools/astra-extension-inventory-native")
const helperPath = join(helperRoot, "build", "astra-extension-inventory")
const fixtures: string[] = []

beforeAll(() => {
  const build = Bun.spawnSync([join(helperRoot, "build.sh")], { stdout: "pipe", stderr: "pipe" })
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0)
})

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

test("read-only blocks locally without opening a control socket", async () => {
  const client = createAstraExtensionInventoryClient({}, randomUUID(), "read-only")
  expect(await client.prepare()).toMatchObject({ status: "blocked", reason: "activate_once_required" })
})

test("parent control blocks a child that falsely claims an active mode for a read-only session", async () => {
  const root = await temp("readonly")
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(join(workspace, "opencode.json"), "{}")
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(","))
  const control = createAstraExtensionInventoryControl(
    { status: "opened", mode: "read-only", report },
    {
      helper: await inspectTrustedExtensionInventoryHelper(helperPath),
      ledgerFilename: join(state, "operation.sqlite"),
      spoolFilename: join(state, "receipt.sqlite"),
    },
  )
  const server = await startAstraTuiControlServer({
    directory: state,
    workspaceRoot: report.root,
    sessionID: randomUUID(),
    extensionInventoryControl: control,
  })
  const hostileClient = createAstraExtensionInventoryClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
    server.sessionID,
    "activate-once",
  )
  try {
    expect(await hostileClient.prepare()).toMatchObject({ status: "blocked", reason: "activate_once_required" })
  } finally {
    hostileClient.dispose()
    await server.close()
  }
})

test("real private socket proves rejection has no root open or child and approval returns bounded inactive candidates", async () => {
  const root = await temp("wiring")
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(
    join(workspace, "opencode.jsonc"),
    '{"plugin":["safe-package","https://example.test/?token=PRIVATE_SECRET"],"mcp":{"local":{"command":"/bin/tool","args":["PRIVATE_SECRET"]}}}',
  )
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(","))
  const session = { status: "opened", mode: "activate-once", report } as const
  const helper = await inspectTrustedExtensionInventoryHelper(helperPath)
  let rootOpens = 0
  let children = 0
  const control = createAstraExtensionInventoryControl(session, {
    helper,
    ledgerFilename: join(state, "operation.sqlite"),
    spoolFilename: join(state, "receipt.sqlite"),
    execute(input) {
      return executeExtensionInventory(input, {
        onWorkspaceRootOpened: () => rootOpens++,
        onProcessEntered: () => children++,
      })
    },
  })
  const server = await startAstraTuiControlServer({
    directory: state,
    workspaceRoot: report.root,
    sessionID: randomUUID(),
    extensionInventoryControl: control,
  })
  const client = createAstraExtensionInventoryClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
    server.sessionID,
    "activate-once",
  )
  try {
    const rejectedPreview = await client.prepare()
    if (rejectedPreview.status !== "prepared") throw new Error("Missing rejection preview")
    expect(rejectedPreview.preview).toMatchObject({
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      helper: { kind: "astra_native_static_inventory" },
      verification: "not_verified",
    })
    expect(JSON.stringify(rejectedPreview)).not.toMatch(/helperPath|workspacePath|argv|PRIVATE_SECRET/)
    const held = `${workspace}-held`
    renameSync(workspace, held)
    expect(await client.decide(rejectedPreview.preview.proposalID, "reject")).toMatchObject({
      status: "denied_without_effect",
    })
    expect(rootOpens).toBe(0)
    expect(children).toBe(0)
    renameSync(held, workspace)

    const approvedPreview = await client.prepare()
    if (approvedPreview.status !== "prepared") throw new Error("Missing approval preview")
    const approved = await client.decide(approvedPreview.preview.proposalID, "approve")
    expect(approved).toMatchObject({ status: "completed_observed_not_verified", verification: "not_verified" })
    if (approved.status !== "completed_observed_not_verified") throw new Error("Missing inventory")
    expect(approved.candidates).toHaveLength(3)
    expect(approved.candidates.every((candidate) => candidate.state === "inactive" && candidate.verification === "not_verified")).toBe(true)
    expect(JSON.stringify(approved)).not.toContain("PRIVATE_SECRET")
    expect(rootOpens).toBe(1)
    expect(children).toBe(1)
    expect(readFileSync(join(state, "operation.sqlite"))).not.toContain("PRIVATE_SECRET")
  } finally {
    client.dispose()
    await server.close()
  }
})

test("approved timeout stays reconciliation-required, exact retry never re-executes, and server close remains bounded", async () => {
  const root = await temp("timeout")
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  mkdirSync(workspace)
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(join(workspace, "opencode.json"), "{}")
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(","))
  let executions = 0
  const control = createAstraExtensionInventoryControl(
    { status: "opened", mode: "activate-once", report },
    {
      helper: await inspectTrustedExtensionInventoryHelper(helperPath),
      ledgerFilename: join(state, "operation.sqlite"),
      spoolFilename: join(state, "receipt.sqlite"),
      async execute() {
        executions++
        return new Promise(() => {})
      },
    },
  )
  const server = await startAstraTuiControlServer(
    {
      directory: state,
      workspaceRoot: report.root,
      sessionID: randomUUID(),
      extensionInventoryControl: control,
    },
    {
      async inspectGitWorkspace() {
        throw new Error("not used")
      },
      extensionInventoryTimeoutMs: 20,
    },
  )
  const client = createAstraExtensionInventoryClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
    server.sessionID,
    "activate-once",
    250,
  )
  const prepared = await client.prepare()
  if (prepared.status !== "prepared") throw new Error("Missing timeout preview")
  const first = await client.decide(prepared.preview.proposalID, "approve")
  expect(first).toMatchObject({ status: "reconciliation_required", reason: "effect_in_progress_or_unknown" })
  const retried = await client.decide(prepared.preview.proposalID, "approve")
  expect(retried).toMatchObject({ status: "reconciliation_required", reason: "effect_in_progress_or_unknown" })
  expect(executions).toBe(1)
  await completeWithin(server.close(), 250)
  client.dispose()
})

async function temp(name: string) {
  const path = await mkdtemp(join("/tmp", `ax-${name}-`))
  fixtures.push(path)
  chmodSync(path, 0o700)
  return resolve(path)
}

async function completeWithin(operation: Promise<unknown>, milliseconds: number) {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Operation did not complete in time")), milliseconds)
    timer.unref?.()
  })
  return Promise.race([operation, timeout])
}
