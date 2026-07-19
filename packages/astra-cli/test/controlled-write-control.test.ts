import { afterAll, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDurableOperation } from "@astra/runtime/operation-ledger"
import { demoMarkerName } from "@astra/runtime/controlled-write-plan"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraControlledWriteControl } from "../src/controlled-write-control"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("read-only blocks preparation without workspace or state effects", async () => {
  const fixture = await makeFixture("read-only")
  const control = createAstraControlledWriteControl(fixture.session, fixture.state)

  expect(await control.prepare()).toEqual({ status: "blocked", reason: "read_only" })
  expect(await exists(join(fixture.workspace, demoMarkerName))).toBeFalse()
  expect(await exists(fixture.state.ledgerFilename)).toBeFalse()
  expect(await exists(fixture.state.spoolFilename)).toBeFalse()
})

test("prepares an immutable host preview and records rejection without a workspace effect", async () => {
  const fixture = await makeFixture("activate-once")
  const control = createAstraControlledWriteControl(fixture.session, fixture.state)

  const prepared = await control.prepare()
  expect(prepared.status).toBe("awaiting_approval")
  if (prepared.status !== "awaiting_approval") throw new Error("Expected a controlled-write preview")
  expect(prepared.preview).toMatchObject({
    executionBoundary: "HOST EXECUTION — NO SANDBOX",
    target: demoMarkerName,
    resource: `workspace:${demoMarkerName}`,
    effect: "create_only",
    network: "host_unrestricted_not_isolated",
  })
  expect(Object.isFrozen(prepared.preview)).toBeTrue()
  expect(await exists(join(fixture.workspace, demoMarkerName))).toBeFalse()
  expect(await exists(fixture.state.ledgerFilename)).toBeFalse()

  const denied = await control.decide(prepared.preview.proposalID, "reject")
  expect(denied).toMatchObject({ status: "denied_without_workspace_effect", operationID: prepared.preview.operationID })
  expect(await exists(join(fixture.workspace, demoMarkerName))).toBeFalse()
  expect(await readDurableOperation(fixture.state.ledgerFilename, prepared.preview.operationID)).toMatchObject({
    state: "denied",
  })
})

test("approves exactly once and verifies the create-only marker independently", async () => {
  const fixture = await makeFixture("activate-once")
  const control = createAstraControlledWriteControl(fixture.session, fixture.state)
  const prepared = await control.prepare()
  if (prepared.status !== "awaiting_approval") throw new Error(`Preparation blocked: ${prepared.reason}`)
  const progress: string[] = []

  const approved = control.decide(prepared.preview.proposalID, "approve", (state) => progress.push(state.status))
  const replay = await control.decide(prepared.preview.proposalID, "approve")
  const result = await approved

  expect(replay).toEqual({ status: "blocked", reason: "proposal_consumed" })
  expect(progress).toEqual([
    "recording_authority",
    "host_adapter_validating",
    "effect_observed_not_verified",
    "verifying",
  ])
  expect(result).toMatchObject({ status: "verified", operationID: prepared.preview.operationID })
  expect(await readFile(join(fixture.workspace, demoMarkerName), "utf8")).toContain(
    `operation_id=${prepared.preview.operationID}`,
  )
  expect(await readDurableOperation(fixture.state.ledgerFilename, prepared.preview.operationID)).toMatchObject({
    state: "succeeded",
    sequence: 8,
  })
})

test("fails without the target effect when the workspace changes after preview", async () => {
  const fixture = await makeFixture("activate-once")
  const control = createAstraControlledWriteControl(fixture.session, fixture.state)
  const prepared = await control.prepare()
  if (prepared.status !== "awaiting_approval") throw new Error(`Preparation blocked: ${prepared.reason}`)
  await writeFile(join(fixture.workspace, "drift.txt"), "changed after preview\n")
  const progress: string[] = []

  const result = await control.decide(prepared.preview.proposalID, "approve", (state) => progress.push(state.status))

  expect(result.status === "failed_without_effect" || result.status === "reconciliation_required").toBeTrue()
  expect(progress).toEqual(["recording_authority"])
  expect(await exists(join(fixture.workspace, demoMarkerName))).toBeFalse()
})

async function makeFixture(mode: "read-only" | "activate-once") {
  const root = await mkdtemp(join(tmpdir(), "astra-write-control-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const stateRoot = join(root, "state")
  await mkdir(workspace)
  await Bun.write(join(workspace, "package.json"), "{}\n")
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error("Test workspace preflight failed")
  return {
    workspace,
    state: {
      ledgerFilename: join(stateRoot, "operations.sqlite"),
      spoolFilename: join(stateRoot, "receipts.sqlite"),
    },
    session: { status: "opened", mode, report } as const,
  }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
