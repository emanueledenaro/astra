import { afterAll, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureGitRepositoryBaseline } from "@astra/git"
import { parseOperationID, type OperationReceipt } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import { createControlledWritePlan, demoMarkerName } from "../src/controlled-write-plan"
import { proposeControlledWriteCapability } from "../src/controlled-write-capability"
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
const gitTestTimeout = 20_000

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable approved controlled write coordinator", () => {
  test(
    "executes and independently verifies a Git workspace against distinct pre- and post-effect snapshots",
    async () => {
      const input = await gitOperationInput()
      const executed = await executeApprovedControlledWrite(input)

      expect(executed).toMatchObject({ status: "effect_observed", state: "effect_observed" })
      const receipt = await operationReceipt(input)
      expect(receipt?.verificationContext).toMatchObject({
        schemaVersion: 2,
        admittedRepositorySnapshotDigest: input.repositoryBaseline.snapshotDigest,
        activationGuard: "allowed",
      })
      if (
        !receipt ||
        !("schemaVersion" in receipt.verificationContext) ||
        receipt.verificationContext.schemaVersion !== 2
      ) {
        throw new Error("Expected a Git-aware receipt")
      }
      expect(receipt.verificationContext.postEffectRepositorySnapshotDigest).not.toBe(
        receipt.verificationContext.admittedRepositorySnapshotDigest,
      )
      expect(await verifyRecordedControlledWrite(input)).toMatchObject({ status: "verified", state: "succeeded" })
    },
    gitTestTimeout,
  )

  test(
    "rejects a stale Git baseline before durable admission or host effect",
    async () => {
      const input = await gitOperationInput()
      await writeFile(join(input.plan.workspaceRoot, "drift.txt"), "drift before admission\n")

      expect(await executeApprovedControlledWrite(input).catch((cause) => cause)).toMatchObject({
        code: "invalid_input",
        message: "git_baseline_stale",
      })
      expect(await exists(input.ledgerFilename)).toBeFalse()
      expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
    },
    gitTestTimeout,
  )

  test(
    "revalidates the Git baseline again at the immediate effect boundary",
    async () => {
      const input = await gitOperationInput()
      const result = await executeApprovedControlledWrite(input, {
        async beforeEffectBoundary() {
          await writeFile(join(input.plan.workspaceRoot, "drift.txt"), "drift at effect boundary\n")
        },
      })

      expect(result).toMatchObject({ status: "failed_without_effect", state: "failed" })
      expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
    },
    gitTestTimeout,
  )

  test(
    "records unknown verification when a Git workspace changes after the observed receipt",
    async () => {
      const input = await gitOperationInput()
      expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
      await writeFile(join(input.plan.workspaceRoot, "after-receipt.txt"), "later drift\n")

      expect(await verifyRecordedControlledWrite(input)).toMatchObject({
        status: "unknown",
        state: "reconciliation_required",
      })
    },
    gitTestTimeout,
  )

  test(
    "recovers an admitted Git operation after the effect without requiring the pre-effect baseline to remain current",
    async () => {
      const input = await gitOperationInput()
      expect(
        await executeApprovedControlledWrite(input, faultAt("after_spool_before_ledger")).catch((cause) => cause),
      ).toMatchObject({ code: "state_unavailable" })
      const marker = await readFile(join(input.plan.workspaceRoot, demoMarkerName), "utf8")
      expect(await pendingReceiptCount(input.spoolFilename)).toBe(1)

      const recovered = await executeApprovedControlledWrite(input)

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
    },
    gitTestTimeout,
  )

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
    expect((await operationReceipt(input))?.capabilityDigest).toBe(input.capabilityProposal.capability.capabilityDigest)

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

  test("does not load workspace Bun config, preload code, or environment during host execution", async () => {
    const workspace = await temporaryDirectory("astra-coordinator-hostile-bun-")
    const state = await temporaryDirectory("astra-coordinator-hostile-bun-state-")
    const startupCanary = join(state, "workspace-startup-ran.txt")
    await writeFile(join(workspace, "package.json"), "{}\n")
    await writeFile(join(workspace, ".env"), "ASTRA_WORKSPACE_ENV_CANARY=loaded\n")
    await writeFile(
      join(workspace, "hostile-preload.ts"),
      `await Bun.write(${JSON.stringify(startupCanary)}, process.env.ASTRA_WORKSPACE_ENV_CANARY ?? "missing")\n`,
    )
    await writeFile(join(workspace, "bunfig.toml"), 'preload = ["./hostile-preload.ts"]\n')
    const report = await scanWorkspace(workspace)
    const base = Date.now() - 1_000
    const plan = createControlledWritePlan(workspace, crypto.randomUUID(), new Date(base).toISOString())
    const policyAskedAt = new Date(base + 100).toISOString()
    const input = {
      ledgerFilename: join(state, "operations.sqlite"),
      spoolFilename: join(state, "receipts.sqlite"),
      plan,
      report,
      capabilityProposal: await proposeControlledWriteCapability({ plan, report, policyAskedAt }),
      policyAskedAt,
      approvalGrantedAt: new Date(base + 200).toISOString(),
      recordingStartedAt: new Date(base + 300).toISOString(),
    } satisfies ExecuteApprovedControlledWriteInput

    expect(input.capabilityProposal.capability.manifest.process).toMatchObject({
      arguments: ["--no-install", "--no-env-file", "--config=/dev/null", "--eval", input.capabilityProposal.program],
      workingDirectory: "/",
    })
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    expect(await exists(startupCanary)).toBeFalse()
    expect(await readFile(join(workspace, demoMarkerName), "utf8")).toBe(plan.content)
  })

  test("rejects changed capability input before durable admission or workspace effect", async () => {
    const input = await operationInput()
    const changed = {
      ...input,
      capabilityProposal: { ...input.capabilityProposal, stdin: `${input.capabilityProposal.stdin} ` },
    }

    expect(await executeApprovedControlledWrite(changed).catch((cause) => cause)).toMatchObject({
      code: "invalid_input",
    })
    expect(await exists(input.ledgerFilename)).toBeFalse()
    expect(await exists(join(input.plan.workspaceRoot, demoMarkerName))).toBeFalse()
  })

  test("does not replay verified evidence for a caller bound to a different workspace", async () => {
    const input = await operationInput()
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    expect(await verifyRecordedControlledWrite(input)).toMatchObject({ status: "verified", state: "succeeded" })
    const decoy = await temporaryDirectory("astra-coordinator-verified-decoy-")
    await writeFile(join(decoy, "package.json"), "{}\n")
    await writeFile(join(decoy, demoMarkerName), input.plan.content)

    expect(
      verifyRecordedControlledWrite({
        ...input,
        plan: { ...input.plan, workspaceRoot: decoy },
        report: await scanWorkspace(decoy),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" })
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

  test("rejects a decoy workspace with the same operation and content", async () => {
    const input = await operationInput()
    expect(await executeApprovedControlledWrite(input)).toMatchObject({ status: "effect_observed" })
    const decoy = await temporaryDirectory("astra-coordinator-decoy-")
    await writeFile(join(decoy, "package.json"), "{}\n")
    await writeFile(join(decoy, demoMarkerName), input.plan.content)
    const report = await scanWorkspace(decoy)

    expect(
      await verifyRecordedControlledWrite({
        ...input,
        plan: { ...input.plan, workspaceRoot: decoy },
        report,
      }).catch((cause) => cause),
    ).toMatchObject({ _tag: "ControlledWriteVerificationError", code: "invalid_input" })
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
  const policyAskedAt = new Date(base + 100).toISOString()
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    plan,
    report,
    capabilityProposal: await proposeControlledWriteCapability({ plan, report, policyAskedAt }),
    policyAskedAt,
    approvalGrantedAt: new Date(base + 200).toISOString(),
    recordingStartedAt: new Date(base + 300).toISOString(),
  }
}

async function gitOperationInput() {
  const workspace = await temporaryDirectory("astra-coordinator-git-workspace-")
  const state = await temporaryDirectory("astra-coordinator-git-state-")
  await git(workspace, "init", "-q", "--initial-branch=main")
  await writeFile(join(workspace, "package.json"), "{}\n")
  await git(workspace, "add", "package.json")
  await git(workspace, "-c", "user.name=Astra", "-c", "user.email=astra@example.invalid", "commit", "-qm", "initial")
  const report = await scanWorkspace(workspace)
  const captured = await captureGitRepositoryBaseline(workspace)
  if (captured.status !== "complete") throw new Error(`Git baseline blocked: ${captured.reason}`)
  const base = Date.now() - 1_000
  const plan = createControlledWritePlan(workspace, crypto.randomUUID(), new Date(base).toISOString())
  const policyAskedAt = new Date(base + 100).toISOString()
  return {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    plan,
    report,
    repositoryBaseline: captured.snapshot,
    capabilityProposal: await proposeControlledWriteCapability({
      plan,
      report,
      repositoryBaseline: captured.snapshot,
      policyAskedAt,
    }),
    policyAskedAt,
    approvalGrantedAt: new Date(base + 200).toISOString(),
    recordingStartedAt: new Date(base + 300).toISOString(),
  } as const satisfies ExecuteApprovedControlledWriteInput & {
    repositoryBaseline: NonNullable<ExecuteApprovedControlledWriteInput["repositoryBaseline"]>
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

async function operationReceipt(input: ExecuteApprovedControlledWriteInput): Promise<OperationReceipt | null> {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const parsed = parseOperationID(input.plan.operationId)
      if (!parsed.ok) return yield* Effect.die("Invalid test Operation ID")
      const operation = yield* ledger.getOperation(parsed.value)
      if (!operation?.dispatchRequestID) return null
      return (yield* ledger.getDispatchSnapshot(operation.dispatchRequestID))?.receipt ?? null
    }),
  )
}

async function git(root: string, ...arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn(["/Applications/Xcode.app/Contents/Developer/usr/bin/git", "-C", root, ...arguments_], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Git fixture command failed: ${stderr}`)
}

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
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
