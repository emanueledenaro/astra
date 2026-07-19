import { afterAll, describe, expect, test } from "bun:test"
import { renameSync } from "node:fs"
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { governedWorkspaceSearchTaskID } from "../../astra-domain/src/governed-workspace-search"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import {
  classifyGovernedWorkspaceSearchObservation,
  executeGovernedWorkspaceSearch,
  hostExecutionBoundaryLabel,
  proposeGovernedWorkspaceSearch,
  recoverGovernedWorkspaceSearch,
  type ExecuteGovernedWorkspaceSearchInput,
} from "../src/governed-workspace-search"
import { runWithLedger } from "../src/operation-storage"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("governed workspace fixed-string search", () => {
  test("seals exact grep authority and treats shell metacharacters as literal bytes", async () => {
    const sentinel = join(tmpdir(), `astra-search-shell-${crypto.randomUUID()}`)
    const query = `$(touch ${sentinel}); * ? [x]`
    const input = await searchInput("approved", query, {
      "source.txt": `before ${query} after\n`,
      grep: `#!/bin/sh\ntouch ${sentinel}\n`,
      Makefile: `all:\n\ttouch ${sentinel}\n`,
    })

    const result = await executeGovernedWorkspaceSearch(input)

    expect(input.proposal.preview).toMatchObject({
      taskID: governedWorkspaceSearchTaskID,
      query,
      queryBytes: Buffer.byteLength(query),
      boundary: "host_no_sandbox",
      boundaryLabel: hostExecutionBoundaryLabel,
      executable: { requestedPath: "/usr/bin/grep", canonicalPath: "/usr/bin/grep" },
      workingDirectory: input.report.root,
      environment: [
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TZ", value: "UTC" },
      ],
      limits: { timeoutMs: 5_000, maxStdoutBytes: 65_536, maxStderrBytes: 4_096 },
      network: { mode: "host_unrestricted", warning: "network is not isolated" },
      writes: [],
    })
    expect(input.proposal.preview.argv).toEqual([
      "/usr/bin/grep",
      "-r",
      "-I",
      "-n",
      "-F",
      "--exclude-dir=.git",
      "--exclude-dir=node_modules",
      "--",
      query,
      ".",
    ])
    expect(input.proposal.capability.manifest.process.arguments).toEqual(input.proposal.preview.launcher.argv.slice(1))
    expect(input.proposal.capability.manifest.process.searchArguments).toEqual(input.proposal.preview.argv.slice(1))
    expect(input.proposal.preview.launcher.argv[0]).toBe(input.proposal.preview.launcher.executable.canonicalPath)
    expect(input.proposal.preview.stdin).toMatchObject({ content: "sealed_launcher_input" })
    expect(input.proposal.preview.stdin.bytes).toBeGreaterThan(0)
    expect(input.proposal.preview.argv).not.toContain("-c")
    expect(input.proposal.preview.argv).not.toContain("sh")
    expect(Object.isFrozen(input.proposal.preview)).toBeTrue()
    expect(Object.isFrozen(input.proposal.preview.launcher)).toBeTrue()
    expect(Object.isFrozen(input.proposal.preview.launcher.argv)).toBeTrue()
    expect(Object.isFrozen(input.proposal.preview.argv)).toBeTrue()
    expect(result).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { exitCode: 0, outputLineCount: 1, outcome: "matches" },
    })
    expect(result.output?.stdout).toContain(`./source.txt:1:before ${query} after`)
    expect(await exists(sentinel)).toBeFalse()
  }, 15_000)

  test("records rejection durably and never enters the process boundary", async () => {
    const input = await searchInput("rejected", "needle")
    let entered = 0

    const result = await executeGovernedWorkspaceSearch(input, { onProcessEntered: () => entered++ })

    expect(result).toMatchObject({ state: "denied", status: "denied_without_effect", receiptID: null })
    expect(entered).toBe(0)
    expect(await eventNames(input)).toEqual(["operation.admitted", "policy.ask", "approval.rejected"])
    expect(await exists(input.spoolFilename)).toBeFalse()
  }, 15_000)

  test("observes both matching and no-match grep exits without claiming verification", async () => {
    const matching = await searchInput("approved", "needle", { "a.ts": "needle\nneedle again\n" })
    const matched = await executeGovernedWorkspaceSearch(matching)
    expect(matched).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { exitCode: 0, outputLineCount: 2, outcome: "matches" },
    })
    expect(await receiptPreview(matching)).toBe("COMPLETED — SEARCH OUTPUT OBSERVED — NOT VERIFIED • 2 OUTPUT LINES")

    const missing = await searchInput("approved", "absent literal", { "a.ts": "other\n" })
    const noMatches = await executeGovernedWorkspaceSearch(missing)
    expect(noMatches).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { stdout: "", stderr: "", exitCode: 1, outputLineCount: 0, outcome: "no_matches" },
    })
    expect(await receiptPreview(missing)).toBe("COMPLETED — SEARCH OUTPUT OBSERVED — NOT VERIFIED • 0 OUTPUT LINES")
    expect(JSON.stringify(matched)).not.toContain('"state":"verified"')
    expect(JSON.stringify(noMatches)).not.toContain('"state":"verified"')
  }, 15_000)

  test("reports raw output lines without claiming they equal semantic matches", async () => {
    const input = await searchInput("approved", "needle", { "part1\npart2.txt": "needle\n" })

    expect(await executeGovernedWorkspaceSearch(input)).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { exitCode: 0, outputLineCount: 2, outcome: "matches" },
    })
    expect(await receiptPreview(input)).toBe("COMPLETED — SEARCH OUTPUT OBSERVED — NOT VERIFIED • 2 OUTPUT LINES")
  }, 15_000)

  test("does not follow recursive workspace symlinks", async () => {
    const outside = await temporaryDirectory("astra-governed-search-outside-")
    const secret = `OUTSIDE_SEARCH_SECRET_${crypto.randomUUID()}`
    await writeFile(join(outside, "secret.txt"), `${secret}\n`)
    const input = await searchInput("approved", secret, {}, async (workspace) => {
      await symlink(outside, join(workspace, "escape-directory"))
      await symlink(join(outside, "secret.txt"), join(workspace, "escape-file"))
    })

    expect(await executeGovernedWorkspaceSearch(input)).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: { stdout: "", exitCode: 1, outputLineCount: 0, outcome: "no_matches" },
    })
  }, 15_000)

  test("persists only redacted output facts, never query or matching source text", async () => {
    const secret = `TOP_SECRET_SEARCH_RESULT_${crypto.randomUUID()}`
    const input = await searchInput("approved", secret, { "secret.txt": `${secret}\n` })

    const result = await executeGovernedWorkspaceSearch(input)
    expect(result.output?.stdout).toContain(secret)
    expect(await receiptPreview(input)).toBe("COMPLETED — SEARCH OUTPUT OBSERVED — NOT VERIFIED • 1 OUTPUT LINES")

    for (const filename of [input.ledgerFilename, input.spoolFilename]) {
      expect((await readFile(filename)).includes(Buffer.from(secret))).toBeFalse()
    }
  }, 15_000)

  test("rejects drift before claim and never enters the process boundary", async () => {
    const input = await searchInput("approved", "needle")
    await writeFile(join(input.report.root, "package.json"), '{"changed":true}\n')
    let entered = 0

    expect(executeGovernedWorkspaceSearch(input, { onProcessEntered: () => entered++ })).rejects.toMatchObject({
      code: "invalid_input",
    })
    expect(entered).toBe(0)
    expect(await exists(input.ledgerFilename)).toBeFalse()
  }, 15_000)

  test("rejects a workspace path swap at process entry without searching the replacement inode", async () => {
    const secret = `REPLACEMENT_WORKSPACE_SECRET_${crypto.randomUUID()}`
    const input = await searchInput("approved", secret)
    const replacement = await temporaryDirectory("astra-governed-search-replacement-")
    await writeFile(join(replacement, "secret.txt"), `${secret}\n`)
    const original = `${input.report.root}-original`
    roots.push(original)

    const result = await executeGovernedWorkspaceSearch(input, {
      onProcessEntered: () => {
        renameSync(input.report.root, original)
        renameSync(replacement, input.report.root)
      },
    })

    expect(result).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      output: { outcome: "unknown", outputLineCount: null },
    })
    expect(result.output?.stdout).not.toContain(secret)
  }, 15_000)

  test("rejects authority tampering before admission and process entry", async () => {
    const input = await searchInput("approved", "needle")
    const changed = {
      ...input,
      proposal: {
        ...input.proposal,
        preview: { ...input.proposal.preview, argv: [...input.proposal.preview.argv, "unexpected"] },
      },
    } satisfies ExecuteGovernedWorkspaceSearchInput
    let entered = 0

    expect(executeGovernedWorkspaceSearch(changed, { onProcessEntered: () => entered++ })).rejects.toMatchObject({
      code: "invalid_input",
    })
    expect(entered).toBe(0)
    expect(await exists(input.ledgerFilename)).toBeFalse()
  }, 15_000)

  test("rejects accessor-backed capability data without evaluating it", async () => {
    const input = await searchInput("approved", "needle")
    let reads = 0
    const capability = structuredClone(input.proposal.capability)
    Object.defineProperty(capability, "manifest", {
      enumerable: true,
      get() {
        reads++
        return input.proposal.capability.manifest
      },
    })
    const changed = {
      ...input,
      proposal: {
        ...input.proposal,
        capability,
      },
    }

    expect(executeGovernedWorkspaceSearch(changed)).rejects.toMatchObject({ code: "invalid_input" })
    expect(reads).toBe(0)
    expect(await exists(input.ledgerFilename)).toBeFalse()
  }, 15_000)

  test("rejects nested report, preview, and consent accessors without evaluating them", async () => {
    const reportInput = await searchInput("approved", "needle")
    let reportReads = 0
    const report = structuredClone(reportInput.report)
    Object.defineProperty(report, "identity", {
      enumerable: true,
      get() {
        reportReads++
        return reportInput.report.identity
      },
    })
    expect(executeGovernedWorkspaceSearch({ ...reportInput, report })).rejects.toMatchObject({ code: "invalid_input" })
    expect(reportReads).toBe(0)

    const previewInput = await searchInput("approved", "needle")
    let previewReads = 0
    const proposal = structuredClone(previewInput.proposal)
    Object.defineProperty(proposal.preview.workspace, "device", {
      enumerable: true,
      get() {
        previewReads++
        return previewInput.proposal.preview.workspace.device
      },
    })
    expect(executeGovernedWorkspaceSearch({ ...previewInput, proposal })).rejects.toMatchObject({
      code: "invalid_input",
    })
    expect(previewReads).toBe(0)

    const consentInput = await searchInput("approved", "needle")
    let consentReads = 0
    const consent = structuredClone(consentInput.consent)
    Object.defineProperty(consent, "decidedAt", {
      enumerable: true,
      get() {
        consentReads++
        return consentInput.consent.decidedAt
      },
    })
    expect(executeGovernedWorkspaceSearch({ ...consentInput, consent })).rejects.toMatchObject({
      code: "invalid_input",
    })
    expect(consentReads).toBe(0)
  }, 15_000)

  test("snapshots proposal and durable state paths before asynchronous work", async () => {
    const source = await searchInput("approved", "needle", { "a.ts": "needle\n" })
    const report = structuredClone(source.report)
    const proposalInput = {
      operationID: crypto.randomUUID(),
      request: source.request,
      report,
      policyAskedAt: source.policyAskedAt,
    }
    let rootReads = 0
    const proposed = proposeGovernedWorkspaceSearch(proposalInput)
    Object.defineProperty(report, "root", {
      enumerable: true,
      get() {
        rootReads++
        return source.report.root
      },
    })
    await proposed
    expect(rootReads).toBe(0)

    const input = structuredClone(source)
    const originalLedger = input.ledgerFilename
    const originalSpool = input.spoolFilename
    const changedLedger = join(input.report.root, ".astra-mutated-ledger.sqlite")
    const changedSpool = join(input.report.root, ".astra-mutated-spool.sqlite")
    const execution = executeGovernedWorkspaceSearch(input)
    Reflect.set(input, "ledgerFilename", changedLedger)
    Reflect.set(input, "spoolFilename", changedSpool)

    expect(await execution).toMatchObject({ state: "completed" })
    expect(await exists(changedLedger)).toBeFalse()
    expect(await exists(changedSpool)).toBeFalse()

    Reflect.set(input, "ledgerFilename", originalLedger)
    Reflect.set(input, "spoolFilename", originalSpool)
    const changedRecoveryLedger = join(input.report.root, ".astra-mutated-recovery-ledger.sqlite")
    const changedRecoverySpool = join(input.report.root, ".astra-mutated-recovery-spool.sqlite")
    const recovery = recoverGovernedWorkspaceSearch(input)
    Reflect.set(input, "ledgerFilename", changedRecoveryLedger)
    Reflect.set(input, "spoolFilename", changedRecoverySpool)

    expect(await recovery).toMatchObject({ state: "completed", output: null })
    expect(await exists(changedRecoveryLedger)).toBeFalse()
    expect(await exists(changedRecoverySpool)).toBeFalse()
  }, 15_000)

  test("recovers the exact receipt while unrelated pending receipts remain in a shared spool", async () => {
    const first = await searchInput("approved", "first", { "a.ts": "first\n" })
    await expectFault(
      executeGovernedWorkspaceSearch(first, {
        injectFault: async (point) => {
          if (point === "after_spool_before_ledger") throw new Error("simulated crash")
        },
      }),
    )

    const secondSource = await searchInput("approved", "second", { "b.ts": "second\n" })
    const second = {
      ...secondSource,
      ledgerFilename: first.ledgerFilename,
      spoolFilename: first.spoolFilename,
    }
    expect(await executeGovernedWorkspaceSearch(second)).toMatchObject({ state: "completed" })
    expect(await recoverGovernedWorkspaceSearch(second)).toMatchObject({ state: "completed", output: null })
  }, 15_000)

  test("recovers exact terminal replays without rerunning or retaining source output", async () => {
    const input = await searchInput("approved", "needle", { "a.ts": "needle\n" })
    let entered = 0
    expect(await executeGovernedWorkspaceSearch(input, { onProcessEntered: () => entered++ })).toMatchObject({
      state: "completed",
      output: { outputLineCount: 1 },
    })
    const before = await eventNames(input)

    expect(await recoverGovernedWorkspaceSearch(input)).toMatchObject({ state: "completed", output: null })
    expect(await executeGovernedWorkspaceSearch(input, { onProcessEntered: () => entered++ })).toMatchObject({
      state: "completed",
      output: null,
    })
    expect(entered).toBe(1)
    expect(await eventNames(input)).toEqual(before)
  }, 15_000)

  test("rejects divergent reuse of a durable Operation ID", async () => {
    const input = await searchInput("approved", "first", { "a.ts": "first\nsecond\n" })
    let entered = 0
    expect(await executeGovernedWorkspaceSearch(input, { onProcessEntered: () => entered++ })).toMatchObject({
      state: "completed",
      output: { outputLineCount: 1 },
    })
    const request = {
      taskID: governedWorkspaceSearchTaskID,
      query: "second",
      queryBytes: Buffer.byteLength("second"),
    } as const
    const proposal = await proposeGovernedWorkspaceSearch({
      operationID: input.operationID,
      request,
      report: input.report,
      policyAskedAt: input.policyAskedAt,
    })

    expect(
      executeGovernedWorkspaceSearch({ ...input, request, proposal }, { onProcessEntered: () => entered++ }),
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(entered).toBe(1)
  }, 15_000)

  test("never retries an expired claimed process after a restart", async () => {
    const input = await searchInput("approved", "needle")
    let entered = 0
    await expectFault(
      executeGovernedWorkspaceSearch(input, {
        onProcessEntered: () => entered++,
        injectFault: async (point) => {
          if (point === "after_claim_before_effect") throw new Error("simulated crash")
        },
      }),
    )
    expect(entered).toBe(0)
    expect(recoverGovernedWorkspaceSearch(input, { now: () => Date.now() + 120_000 })).resolves.toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      output: null,
    })
    expect(entered).toBe(0)
  }, 15_000)

  test("ingests a durable spooled receipt after restart without rerunning grep", async () => {
    const input = await searchInput("approved", "needle", { "a.ts": "needle\n" })
    let entered = 0
    await expectFault(
      executeGovernedWorkspaceSearch(input, {
        onProcessEntered: () => entered++,
        injectFault: async (point) => {
          if (point === "after_spool_before_ledger") throw new Error("simulated crash")
        },
      }),
    )
    expect(entered).toBe(1)

    expect(await recoverGovernedWorkspaceSearch(input)).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      output: null,
    })
    expect(entered).toBe(1)
  }, 15_000)

  test("records uncertainty after an observed effect loses its receipt and never retries", async () => {
    const input = await searchInput("approved", "needle", { "a.ts": "needle\n" })
    let entered = 0
    await expectFault(
      executeGovernedWorkspaceSearch(input, {
        onProcessEntered: () => entered++,
        injectFault: async (point) => {
          if (point === "after_effect_before_spool") throw new Error("simulated crash")
        },
      }),
    )
    expect(entered).toBe(1)

    expect(await recoverGovernedWorkspaceSearch(input, { now: () => Date.now() + 120_000 })).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      output: null,
    })
    expect(entered).toBe(1)
  }, 15_000)

  test("marks bounded output overflow and timeout observations unknown", async () => {
    const input = await searchInput("approved", "needle", { "large.txt": "needle\n".repeat(20_000) })

    expect(await executeGovernedWorkspaceSearch(input)).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      output: { outcome: "unknown", outputLineCount: null },
    })
    expect(
      classifyGovernedWorkspaceSearchObservation({
        started: true,
        termination: { kind: "unconfirmed" },
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stopReason: "timeout",
      }),
    ).toBe("effect_unknown")
    expect(
      classifyGovernedWorkspaceSearchObservation({
        started: true,
        termination: { kind: "exited", exitCode: 2 },
        stdout: new Uint8Array(),
        stderr: Buffer.from("redacted error"),
      }),
    ).toBe("effect_unknown")
  }, 15_000)
})

async function searchInput(
  decision: "approved" | "rejected",
  query: string,
  files: Readonly<Record<string, string>> = {},
  setup?: (workspace: string) => Promise<void>,
): Promise<ExecuteGovernedWorkspaceSearchInput> {
  const workspace = await temporaryDirectory("astra-governed-search-workspace-")
  const state = await temporaryDirectory("astra-governed-search-state-")
  await writeFile(join(workspace, "package.json"), "{}\n")
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(workspace, name), content)))
  await setup?.(workspace)
  const report = await scanWorkspace(workspace)
  const base = Date.now() - 1_000
  const policyAskedAt = new Date(base).toISOString()
  const operationID = crypto.randomUUID()
  const request = { taskID: governedWorkspaceSearchTaskID, query, queryBytes: Buffer.byteLength(query) } as const
  const proposalInput = { operationID, request, report, policyAskedAt }
  return {
    ...proposalInput,
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    proposal: await proposeGovernedWorkspaceSearch(proposalInput),
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

async function eventNames(input: ExecuteGovernedWorkspaceSearchInput) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return (yield* ledger.readEvents(requireOperationID(input.operationID), { limit: 16 })).map((event) => event.name)
    }),
  )
}

async function receiptPreview(input: ExecuteGovernedWorkspaceSearchInput) {
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

async function expectFault(input: Promise<unknown>) {
  const result = await input.then(
    () => ({ kind: "resolved" as const }),
    (cause: unknown) => ({ kind: "rejected" as const, cause }),
  )
  expect(result.kind).toBe("rejected")
  if (result.kind === "resolved") return
  expect(result.cause).toMatchObject({ code: "state_unavailable" })
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
