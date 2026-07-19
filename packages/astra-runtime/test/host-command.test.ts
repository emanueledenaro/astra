import { afterAll, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import {
  classifyHostCommandObservation,
  executeHostCommand,
  hostExecutionBoundaryLabel,
  proposeHostCommand,
  recoverHostCommand,
  type ExecuteHostCommandInput,
} from "../src/host-command"
import { runWithLedger, runWithReceiptSpool } from "../src/operation-storage"
import { scanWorkspace } from "../src/workspace-preflight"
import { deterministicUUID, digest } from "../src/controlled-write-authority"
import { parseDispatchRequestID, parseOperationReceipt, parseReceiptID } from "@astra/domain/operation-contract"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("governed host command", () => {
  test("builds an exact direct-exec preview with an explicit host boundary", async () => {
    const input = await commandInput("approved")
    const preview = input.proposal.preview

    expect(preview).toMatchObject({
      command: "pwd",
      script: null,
      scriptBytes: 0,
      boundary: "host_no_sandbox",
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      argv: [preview.executable.canonicalPath],
      workingDirectory: "/",
      environment: [
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TZ", value: "UTC" },
      ],
      stdin: { bytes: 0 },
      limits: { timeoutMs: 3_000, maxStdoutBytes: 4_096, maxStderrBytes: 4_096 },
      workspace: { canonicalPath: input.report.root, access: "identity_guard" },
      network: { mode: "host_unrestricted", warning: "network is not isolated" },
      filesystem: { mode: "bounded_read_only", warning: "workspace reads only" },
      writes: [],
      verification: "not_verified",
    })
    expect(preview.executable.requestedPath).toBe("/bin/pwd")
    expect(preview.argv).toHaveLength(1)
    expect(preview.argv).not.toContain("-c")
    expect(preview.argv).not.toContain("eval")
    expect(Object.isFrozen(preview)).toBeTrue()
    expect(Object.isFrozen(preview.argv)).toBeTrue()
    expect(Object.isFrozen(preview.environment)).toBeTrue()
    expect(Object.isFrozen(preview.environment[0])).toBeTrue()
    expect(Object.isFrozen(preview.limits)).toBeTrue()
    expect(() => Reflect.apply(Array.prototype.push, preview.argv, ["/usr/bin/printf"])).toThrow(TypeError)
  })

  test("records explicit rejection and never reaches the process seam", async () => {
    const input = await commandInput("rejected")
    const result = await executeHostCommand(input)

    expect(result).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
      receiptID: null,
      boundaryLabel: hostExecutionBoundaryLabel,
    })
    expect(await eventNames(input)).toEqual(["operation.admitted", "policy.ask", "approval.rejected"])
    expect(await exists(input.spoolFilename)).toBeFalse()
  })

  test("rejects preview or capability mismatch before admission and without a process", async () => {
    const input = await commandInput("approved")
    const changed = {
      ...input,
      proposal: {
        ...input.proposal,
        preview: { ...input.proposal.preview, argv: [...input.proposal.preview.argv, "unexpected"] },
      },
    } satisfies ExecuteHostCommandInput
    expect(executeHostCommand(changed)).rejects.toMatchObject({ code: "invalid_input" })
    expect(await exists(input.ledgerFilename)).toBeFalse()
  })

  test("claims before one process call and records COMPLETED as observed, never verified", async () => {
    const input = await commandInput("approved")
    const result = await executeHostCommand(input)
    expect(result).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      boundaryLabel: hostExecutionBoundaryLabel,
      output: { stdout: "/\n", stderr: "", exitCode: 0 },
    })
    expect(await receiptPreview(input)).toStartWith("COMPLETED — OUTPUT OBSERVED — NOT VERIFIED")
    expect(JSON.stringify(result)).not.toContain("VERIFIED")
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.completed",
    ])

    expect(await executeHostCommand(input)).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: null,
    })
  })

  test("executes the real allowlisted pwd process without a shell", async () => {
    const input = await commandInput("approved")
    const result = await executeHostCommand(input)

    expect(result).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { stdout: "/\n", stderr: "", exitCode: 0 },
    })
  })

  test("runs one exact shell script with an unrestricted host warning and never claims verification", async () => {
    const input = await commandInput("approved", "printf 'shell-ready\\n'")
    const preview = input.proposal.preview

    expect(preview).toMatchObject({
      command: "shell",
      script: "printf 'shell-ready\\n'",
      scriptBytes: 22,
      boundaryLabel: hostExecutionBoundaryLabel,
      executable: { requestedPath: "/bin/zsh" },
      argv: [preview.executable.canonicalPath, "-f", "-c", "printf 'shell-ready\\n'"],
      workingDirectory: input.report.root,
      workspace: { access: "host_unrestricted" },
      filesystem: { mode: "host_unrestricted", warning: "host filesystem is not isolated" },
      network: { mode: "host_unrestricted", warning: "network is not isolated" },
      writes: ["command-defined host filesystem effects"],
      verification: "not_verified",
    })
    const result = await executeHostCommand(input)
    expect(result).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { stdout: "shell-ready\n", stderr: "", exitCode: 0 },
    })
    expect(JSON.stringify(result)).not.toContain("VERIFIED")
  })

  test("rejects an invalid shell script before inspecting or dispatching a process", async () => {
    const workspace = await temporaryDirectory("astra-host-command-workspace-")
    const report = await scanWorkspace(workspace)
    const input = {
      operationID: crypto.randomUUID(),
      request: { command: "shell", script: "printf ok", scriptBytes: 999 },
      report,
      policyAskedAt: new Date().toISOString(),
    } as const

    expect(proposeHostCommand(input)).rejects.toThrow("The shell script request is invalid")
    const deceptiveScript = "printf safe\u202Etxt"
    expect(
      proposeHostCommand({
        ...input,
        operationID: crypto.randomUUID(),
        request: { command: "shell", script: deceptiveScript, scriptBytes: Buffer.byteLength(deceptiveScript) },
      }),
    ).rejects.toThrow("The shell script request is invalid")
  })

  test("classifies any observed nonzero process exit as effect unknown", () => {
    expect(
      classifyHostCommandObservation({
        started: true,
        termination: { kind: "exited", exitCode: 2 },
        stdout: new Uint8Array(),
        stderr: Buffer.from("failed\n"),
      }),
    ).toBe("effect_unknown")
  })

  test("exact retries recover the terminal claim without adding events", async () => {
    const input = await commandInput("approved")
    expect(await executeHostCommand(input)).toMatchObject({ state: "completed" })
    const before = await eventNames(input)

    expect(await recoverHostCommand(input)).toMatchObject({ state: "completed", output: null })
    expect(await executeHostCommand(input)).toMatchObject({ state: "completed", output: null })
    expect(await eventNames(input)).toEqual(before)
  })

  test("completes a crashed pending outbox exactly once on re-run instead of wedging", async () => {
    const input = await commandInput("approved")
    expect(
      executeHostCommand(input, {
        injectFault: async (point) => {
          if (point === "after_batch_before_claim") throw new Error("injected crash between batch and claim")
        },
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
    ])

    const result = await executeHostCommand(input)
    expect(result).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { stdout: "/\n", stderr: "", exitCode: 0 },
    })
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.completed",
    ])
  })

  test("converts an effect that stalled past its claim lease into durable uncertainty before spooling", async () => {
    const input = await commandInput("approved")
    let clockNow = Date.parse(input.recordingStartedAt) + 100
    const result = await executeHostCommand(input, {
      now: () => clockNow,
      injectFault: async (point) => {
        if (point === "after_claim_before_effect") clockNow += 120_000
      },
    })
    expect(result).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      receiptID: null,
    })
    expect(await exists(input.spoolFilename)).toBeFalse()
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])

    const replayed = await executeHostCommand(input)
    expect(replayed).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(JSON.stringify(replayed)).not.toContain("completed")
  })

  test("recovers past a poisoned spool by retiring the stale receipt against durable uncertainty", async () => {
    const input = await commandInput("approved")
    expect(
      executeHostCommand(input, {
        injectFault: async (point) => {
          if (point === "after_claim_before_effect") throw new Error("injected crash between claim and effect")
        },
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })

    const dispatchRequestID = requireDispatchRequestID(deterministicUUID(input.operationID, "dispatch:1"))
    const claim = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return (yield* ledger.getDispatchSnapshot(dispatchRequestID))?.claim ?? null
      }),
    )
    expect(claim).not.toBeNull()
    const staleReceipt = requireStaleReceipt({
      receiptID: deterministicUUID(input.operationID, "receipt:1"),
      operationID: input.operationID,
      attemptID: deterministicUUID(input.operationID, "attempt:1"),
      dispatchRequestID,
      executorClaimID: deterministicUUID(input.operationID, "claim:1"),
      capabilityGrantID: deterministicUUID(input.operationID, "capability:1"),
      capabilityDigest: input.proposal.capability.capabilityDigest,
      fencingToken: claim!.fencingToken,
      adapter: {
        identity: "astra-executor:allowlisted-host-command",
        version: "1",
        digest: digest("astra-runtime:host-command:direct-host-process:v1"),
      },
      effectClass: "host_command",
      resources: input.proposal.preview.resources,
      startedAt: claim!.acceptedAt,
      endedAt: new Date(Date.parse(claim!.claimExpiresAt) + 7_200_000).toISOString(),
      observation: { kind: "effect_unknown", observationDigest: digest("stalled beyond claim lease") },
      verificationContext: {
        admittedBaselineDigest: digest("legacy admitted baseline"),
        postEffectWorkspaceDigest: null,
        workspaceIdentity: input.report.identity!,
        targetIdentity: null,
        preflightLimits: input.report.limits,
        activationGuard: "allowed",
      },
      output: { digest: digest("stalled beyond claim lease"), bytes: 0, preview: "EFFECT UNKNOWN: stalled" },
    })
    await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(staleReceipt)
      }),
    )

    const later = Date.parse(claim!.claimExpiresAt) + 10_800_000
    const recovered = await recoverHostCommand(input, { now: () => later })
    expect(recovered).toMatchObject({ state: "reconciliation_required", status: "effect_unknown", receiptID: null })
    expect(await eventNames(input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])

    const entry = await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        return yield* spool.get(requireReceiptID(staleReceipt.receiptID))
      }),
    )
    expect(entry?.acknowledgement).toMatchObject({
      ledgerEventID: deterministicUUID(input.operationID, "event:uncertainty"),
    })
    const pendingAfter = await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        return yield* spool.listPending({ limit: 2 })
      }),
    )
    expect(pendingAfter).toHaveLength(0)

    expect(await recoverHostCommand(input, { now: () => later })).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
    })
  })
})

async function commandInput(decision: "approved" | "rejected", script?: string): Promise<ExecuteHostCommandInput> {
  const workspace = await temporaryDirectory("astra-host-command-workspace-")
  const state = await temporaryDirectory("astra-host-command-state-")
  await writeFile(join(workspace, "package.json"), "{}\n")
  const report = await scanWorkspace(workspace)
  const base = Date.now() - 1_000
  const policyAskedAt = new Date(base).toISOString()
  const operationID = crypto.randomUUID()
  const request = script
    ? ({ command: "shell", script, scriptBytes: Buffer.byteLength(script) } as const)
    : ({ command: "pwd" } as const)
  const proposalInput = { operationID, request, report, policyAskedAt }
  return {
    ...proposalInput,
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    proposal: await proposeHostCommand(proposalInput),
    consent:
      decision === "approved"
        ? { decision, decidedAt: new Date(base + 100).toISOString() }
        : { decision, decidedAt: new Date(base + 100).toISOString(), reason: "user_rejected" },
    recordingStartedAt: new Date(base + 200).toISOString(),
  }
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function eventNames(input: ExecuteHostCommandInput) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return (yield* ledger.readEvents(requireOperationID(input.operationID), { limit: 16 })).map((event) => event.name)
    }),
  )
}

async function receiptPreview(input: ExecuteHostCommandInput) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const candidates = yield* ledger.listRecoveryCandidates({ limit: 16 })
      return candidates.find((candidate) => candidate.request.operationID === requireOperationID(input.operationID))
        ?.receipt?.output.preview
    }),
  )
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new Error("Invalid test Operation ID")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new Error("Invalid test dispatch request ID")
  return parsed.value
}

function requireStaleReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new Error(`Invalid test receipt at ${parsed.issue.path}`)
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input, "$.receiptID")
  if (!parsed.ok) throw new Error("Invalid test receipt ID")
  return parsed.value
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
