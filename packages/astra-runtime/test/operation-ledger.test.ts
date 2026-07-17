import { afterAll, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createControlledWritePlan, demoMarkerName } from "../src/controlled-write-plan"
import {
  DeniedOperationRecordingError,
  readDurableOperation,
  recordDeniedControlledWrite,
} from "../src/operation-ledger"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []
const operationID = "0196e4cb-5d80-7b1d-8fb2-263b81670431"
const createdAt = "2026-07-17T10:00:00.000Z"
const observation = {
  policyAskedAt: "2026-07-17T10:01:00.000Z",
  approvalRejectedAt: "2026-07-17T10:03:00.000Z",
  recordingStartedAt: "2026-07-17T10:03:01.000Z",
} as const

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable denied controlled write", () => {
  test("persists, reopens, and idempotently replays a denial without touching the workspace", async () => {
    const root = await workspace()
    const filename = join(await temporaryDirectory("astra-runtime-state-"), "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)

    const first = await recordDeniedControlledWrite({ filename, plan, report, ...observation })
    expect(first).toMatchObject({ operationID, state: "denied", sequence: 3, lastCursor: 3 })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()

    const database = new Database(filename, { readonly: true })
    const timestamps = database.query("select recorded_at, observed_at from operation_event order by sequence").all()
    database.close()
    expect(timestamps).toEqual([
      { recorded_at: observation.recordingStartedAt, observed_at: createdAt },
      { recorded_at: observation.recordingStartedAt, observed_at: observation.policyAskedAt },
      { recorded_at: observation.recordingStartedAt, observed_at: observation.approvalRejectedAt },
    ])

    const filesBeforeRead = await readdir(join(filename, ".."))
    expect(await readDurableOperation(filename, operationID)).toEqual(first)
    expect(await readdir(join(filename, ".."))).toEqual(filesBeforeRead)
    expect(await recordDeniedControlledWrite({ filename, plan, report, ...observation })).toEqual(first)
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("fails closed instead of inventing a non-Git baseline", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const filename = join(await temporaryDirectory("astra-runtime-state-"), "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)

    const rejection = recordDeniedControlledWrite({ filename, plan, report, ...observation }).catch((error) => error)
    expect(await rejection).toBeInstanceOf(DeniedOperationRecordingError)
    expect(await exists(filename)).toBeFalse()
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("rejects a ledger parent symlink that resolves inside the workspace", async () => {
    const root = await workspace()
    const state = await temporaryDirectory("astra-runtime-state-")
    const linkedParent = join(state, "linked-state")
    await symlink(root, linkedParent)
    const filename = join(linkedParent, "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)

    const rejection = recordDeniedControlledWrite({ filename, plan, report, ...observation }).catch((error) => error)
    expect(await rejection).toMatchObject({ code: "ledger_inside_workspace" })
    expect(await exists(join(root, "operations.sqlite"))).toBeFalse()
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("does not initialize or add sidecars while reading a truncated ledger", async () => {
    const state = await temporaryDirectory("astra-runtime-state-")
    const filename = join(state, "operations.sqlite")
    await writeFile(filename, "")

    const rejection = readDurableOperation(filename, operationID).catch((error) => error)
    expect(await rejection).toBeInstanceOf(DeniedOperationRecordingError)
    expect(await readFile(filename)).toEqual(Buffer.alloc(0))
    expect(await readdir(state)).toEqual(["operations.sqlite"])
  })
})

async function workspace() {
  const root = await temporaryDirectory("astra-runtime-ledger-")
  await writeFile(join(root, "package.json"), "{}\n")
  return root
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
