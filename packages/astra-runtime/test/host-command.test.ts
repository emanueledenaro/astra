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
import { runWithLedger } from "../src/operation-storage"
import { scanWorkspace } from "../src/workspace-preflight"

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
      writes: [],
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
})

async function commandInput(decision: "approved" | "rejected"): Promise<ExecuteHostCommandInput> {
  const workspace = await temporaryDirectory("astra-host-command-workspace-")
  const state = await temporaryDirectory("astra-host-command-state-")
  await writeFile(join(workspace, "package.json"), "{}\n")
  const report = await scanWorkspace(workspace)
  const base = Date.now() - 1_000
  const policyAskedAt = new Date(base).toISOString()
  const operationID = crypto.randomUUID()
  const proposalInput = { operationID, report, policyAskedAt }
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

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
