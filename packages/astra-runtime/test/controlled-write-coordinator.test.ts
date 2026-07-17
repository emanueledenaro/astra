import { afterAll, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import { createControlledWritePlan, demoMarkerName } from "../src/controlled-write-plan"
import {
  executeApprovedControlledWrite,
  recoverApprovedControlledWrite,
  type ControlledWriteFaultPoint,
  type ExecuteApprovedControlledWriteInput,
} from "../src/controlled-write-coordinator"
import { verifyRecordedControlledWrite } from "../src/controlled-write-verifier"
import { runWithLedger, runWithReceiptSpool } from "../src/operation-storage"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable approved controlled write coordinator", () => {
  test("keeps observation separate from independent durable verification", async () => {
    const input = await operationInput()
    const executed = await executeApprovedControlledWrite(input)

    expect(executed).toMatchObject({ status: "effect_observed", state: "effect_observed", sequence: 6 })
    expect(await readFile(join(input.plan.workspaceRoot, demoMarkerName), "utf8")).toBe(input.plan.content)
    expect(await eventNames(input.ledgerFilename, input.plan.operationId)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.observed",
    ])
    expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)

    const verified = await verifyRecordedControlledWrite(input)
    expect(verified).toMatchObject({ status: "verified", state: "succeeded", sequence: 8 })
    expect(verified.evidence.criteria).toMatchObject([{ criterionID: "marker_exact_bytes", result: "passed" }])
    expect(String(verified.evidence.criteria[0]?.observationDigest)).toBe(input.plan.contentDigest)
    expect(await eventNames(input.ledgerFilename, input.plan.operationId)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.observed",
      "verification.started",
      "verification.passed",
    ])
    expect(await verifyRecordedControlledWrite(input)).toEqual(verified)
  })

  for (const point of ["after_claim_before_effect", "after_effect_before_spool"] as const) {
    test(`records ${point} as uncertainty and never reruns the effect`, async () => {
      const input = await operationInput()
      const failure = executeApprovedControlledWrite(input, faultAt(point)).catch((cause) => cause)
      expect(await failure).toMatchObject({ code: "state_unavailable" })
      const markerBeforeRecovery = await exists(join(input.plan.workspaceRoot, demoMarkerName))

      expect(await recoverApprovedControlledWrite(input).catch((cause) => cause)).toMatchObject({
        code: "operation_in_progress",
      })
      const recovered = await recoverApprovedControlledWrite(input, { now: () => Date.now() + 61_000 })
      expect(recovered).toMatchObject({
        status: "reconciliation_required",
        state: "reconciliation_required",
        sequence: 6,
        receiptID: null,
      })
      expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBe(markerBeforeRecovery)
      expect(await eventNames(input.ledgerFilename, input.plan.operationId)).toEqual([
        "operation.admitted",
        "policy.ask",
        "approval.granted",
        "dispatch.requested",
        "executor.accepted",
        "effect.unknown",
      ])
      expect(await recoverApprovedControlledWrite(input, { now: () => Date.now() + 61_000 })).toEqual(recovered)
      expect(verifyRecordedControlledWrite(input)).rejects.toMatchObject({ code: "receipt_unavailable" })
    })
  }

  test("keeps an exact retry in progress until the durable claim expires without rerunning the effect", async () => {
    const input = await operationInput()
    expect(
      await executeApprovedControlledWrite(input, faultAt("after_claim_before_effect")).catch((cause) => cause),
    ).toMatchObject({ code: "state_unavailable" })
    expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()

    expect(await executeApprovedControlledWrite(input).catch((cause) => cause)).toMatchObject({
      code: "operation_in_progress",
    })
    const recovered = await recoverApprovedControlledWrite(input, { now: () => Date.now() + 61_000 })
    expect(recovered).toMatchObject({
      status: "reconciliation_required",
      state: "reconciliation_required",
      receiptID: null,
    })
    expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
    expect(await eventNames(input.ledgerFilename, input.plan.operationId)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])
  })

  for (const point of ["after_spool_before_ledger", "after_ledger_before_ack"] as const) {
    test(`recovers ${point} by transferring the receipt without rerunning the effect`, async () => {
      const input = await operationInput()
      expect(await executeApprovedControlledWrite(input, faultAt(point)).catch((cause) => cause)).toMatchObject({
        code: "state_unavailable",
      })
      const marker = await readFile(join(input.plan.workspaceRoot, demoMarkerName), "utf8")
      expect(await pendingReceiptCount(input.spoolFilename)).toBe(1)

      const recovered = await recoverApprovedControlledWrite(input)
      expect(recovered).toMatchObject({ status: "effect_observed", state: "effect_observed", sequence: 6 })
      expect(await readFile(join(input.plan.workspaceRoot, demoMarkerName), "utf8")).toBe(marker)
      expect(await pendingReceiptCount(input.spoolFilename)).toBe(0)
      expect(await eventNames(input.ledgerFilename, input.plan.operationId)).toEqual([
        "operation.admitted",
        "policy.ask",
        "approval.granted",
        "dispatch.requested",
        "executor.accepted",
        "effect.observed",
      ])
      expect(await verifyRecordedControlledWrite(input)).toMatchObject({ status: "verified", state: "succeeded" })
    })
  }

  test("rejects overlapping state files before creating workspace or durable effects", async () => {
    const input = await operationInput()
    const shared = input.ledgerFilename
    const rejection = executeApprovedControlledWrite({ ...input, spoolFilename: shared }).catch((cause) => cause)

    expect(await rejection).toMatchObject({ code: "state_unavailable" })
    expect(await exists(shared)).toBeFalse()
    expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
  })

  test("records unknown verification when the target changes after the receipt", async () => {
    const input = await operationInput()
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    await writeFile(join(input.plan.workspaceRoot, demoMarkerName), "tampered after receipt\n")

    const verified = await verifyRecordedControlledWrite(input)
    expect(verified).toMatchObject({ status: "unknown", state: "reconciliation_required", sequence: 8 })
    expect(verified.evidence.criteria).toMatchObject([{ criterionID: "marker_exact_bytes", result: "unknown" }])
    expect(await eventNames(input.ledgerFilename, input.plan.operationId)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.observed",
      "verification.started",
      "verification.unknown",
    ])
  })

  test("records unknown verification when Git metadata appears after execution", async () => {
    const input = await operationInput()
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    await mkdir(join(input.plan.workspaceRoot, ".git"))

    const verified = await verifyRecordedControlledWrite(input)
    expect(verified).toMatchObject({ status: "unknown", state: "reconciliation_required", sequence: 8 })
    expect(verified.evidence.criteria).toMatchObject([{ criterionID: "marker_exact_bytes", result: "unknown" }])
  })

  test("records unknown verification when the target inode is replaced with identical bytes", async () => {
    const input = await operationInput()
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    const marker = join(input.plan.workspaceRoot, demoMarkerName)
    const content = await readFile(marker)
    await rm(marker)
    await writeFile(marker, content)

    const verified = await verifyRecordedControlledWrite(input)
    expect(verified).toMatchObject({ status: "unknown", state: "reconciliation_required", sequence: 8 })
  })

  test("records unknown verification for a decoy workspace with the same operation and content", async () => {
    const input = await operationInput()
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    const decoy = await temporaryDirectory("astra-coordinator-decoy-")
    await writeFile(join(decoy, "package.json"), "{}\n")
    await writeFile(join(decoy, demoMarkerName), input.plan.content)
    const report = await scanWorkspace(decoy)

    const verified = await verifyRecordedControlledWrite({
      ...input,
      plan: { ...input.plan, workspaceRoot: decoy },
      report,
    })
    expect(verified).toMatchObject({ status: "unknown", state: "reconciliation_required", sequence: 8 })
  })

  test("does not start the host effect without a safe remaining claim lease", async () => {
    const input = await operationInput()
    let now = Date.now()
    const result = await executeApprovedControlledWrite(input, {
      now: () => now,
      async beforeEffectBoundary() {
        now += 61_000
      },
    })

    expect(result).toMatchObject({ status: "reconciliation_required", state: "reconciliation_required" })
    expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
  })

  test("allows one concurrent execution without forcing the active claim into reconciliation", async () => {
    const input = await operationInput()
    let release: (() => void) | undefined
    let claimed: (() => void) | undefined
    const claimReached = new Promise<void>((resolve) => (claimed = resolve))
    const continueFirst = new Promise<void>((resolve) => (release = resolve))
    const first = executeApprovedControlledWrite(input, {
      async beforeEffectBoundary() {
        claimed?.()
        await continueFirst
      },
    })
    await claimReached

    const second = await executeApprovedControlledWrite(input).catch((cause) => cause)
    expect(second).toMatchObject({ code: "operation_in_progress" })
    release?.()
    expect(await first).toMatchObject({ status: "effect_observed" })
    expect(await readFile(join(input.plan.workspaceRoot, demoMarkerName), "utf8")).toBe(input.plan.content)
    expect(await eventNames(input.ledgerFilename, input.plan.operationId)).not.toContain("effect.unknown")
  })

  test("rejects a ledger base that overlaps the receipt spool SQLite sidecar family", async () => {
    const input = await operationInput()
    const rejection = executeApprovedControlledWrite({
      ...input,
      spoolFilename: `${input.ledgerFilename}-wal`,
    }).catch((cause) => cause)

    expect(await rejection).toMatchObject({ code: "state_unavailable" })
    expect(await exists(input.ledgerFilename)).toBeFalse()
    expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
  })
})

async function operationInput(): Promise<ExecuteApprovedControlledWriteInput> {
  const workspace = await temporaryDirectory("astra-coordinator-workspace-")
  const state = await temporaryDirectory("astra-coordinator-state-")
  await writeFile(join(workspace, "package.json"), "{}\n")
  const report = await scanWorkspace(workspace)
  const base = Date.now() - 1_000
  const plan = createControlledWritePlan(workspace, crypto.randomUUID(), new Date(base).toISOString())
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    plan,
    report,
    policyAskedAt: new Date(base + 100).toISOString(),
    approvalGrantedAt: new Date(base + 200).toISOString(),
    recordingStartedAt: new Date(base + 300).toISOString(),
  }
}

function faultAt(expected: ControlledWriteFaultPoint) {
  return {
    async injectFault(point: ControlledWriteFaultPoint) {
      if (point === expected) throw new Error(`Injected coordinator fault at ${point}`)
    },
  }
}

async function eventNames(filename: string, operationID: string) {
  return runWithLedger(filename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const parsed = parseOperationID(operationID)
      if (!parsed.ok) return yield* Effect.die("Invalid test Operation ID")
      return (yield* ledger.readEvents(parsed.value, { limit: 32 })).map((event) => event.name)
    }),
  )
}

async function pendingReceiptCount(filename: string) {
  return runWithReceiptSpool(filename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return (yield* spool.listPending({ limit: 10 })).length
    }),
  )
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
