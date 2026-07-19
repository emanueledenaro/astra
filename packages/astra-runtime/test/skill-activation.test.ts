import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import {
  cleanupSkillActivationBundle,
  decideSkillActivation,
  prepareSkillActivation,
  recoverSkillActivation,
  type DecideSkillActivationInput,
  type PrepareSkillActivationInput,
} from "../src/skill-activation"
import { inspectWorkspaceSkills } from "../src/skill-inventory"
import { runWithLedger } from "../src/operation-storage"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("governed workspace skill activation", () => {
  test("rejects read-only activation before creating durable state", async () => {
    const fixture = await activationFixture("read-only")

    expect(prepareSkillActivation(fixture.prepare)).rejects.toMatchObject({ code: "invalid_input" })
    expect(await exists(fixture.prepare.ledgerFilename)).toBeFalse()
    expect(await exists(fixture.prepare.spoolFilename)).toBeFalse()
    expect(await readdir(fixture.runtime)).toEqual([])
  })

  test("persists rejection without creating or exposing a private skill bundle", async () => {
    const fixture = await activationFixture("activate-once")
    const proposal = await prepareSkillActivation(fixture.prepare)
    const result = await decideSkillActivation({
      ...fixture.prepare,
      proposal,
      consent: { decision: "rejected", decidedAt: fixture.decidedAt },
      privateRuntimeDirectory: fixture.runtime,
    })

    expect(result).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
      receiptID: null,
      bundlePath: null,
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    })
    expect(await readdir(fixture.runtime)).toEqual([])
    expect(await eventNames(fixture.prepare)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.rejected",
    ])
  })

  test("creates one private session bundle after exact consent and reports observed, not verified", async () => {
    const fixture = await activationFixture("activate-once")
    const before = await workspaceSnapshot(fixture.workspace)
    const proposal = await prepareSkillActivation(fixture.prepare)
    const input: DecideSkillActivationInput = {
      ...fixture.prepare,
      proposal,
      consent: { decision: "approved", decidedAt: fixture.decidedAt },
      privateRuntimeDirectory: fixture.runtime,
    }

    const result = await decideSkillActivation(input)
    expect(result).toMatchObject({
      state: "completed",
      status: "completed_observed_not_verified",
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    })
    expect(result.bundlePath).not.toBeNull()
    const bundle = JSON.parse(await readFile(result.bundlePath!, "utf8"))
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      sessionID: fixture.prepare.plan.sessionID,
      skill: {
        name: "safe-skill",
        trust: "untrusted_instruction_data",
        resourceDiscovery: "none",
      },
      assurance: "observed_not_verified",
    })
    expect(bundle.skill.instructions).toContain("Never run commands automatically")
    expect(await receiptPreview(fixture.prepare)).toBe("COMPLETED — SKILL CONTENT OBSERVED — NOT VERIFIED")
    expect(await workspaceSnapshot(fixture.workspace)).toEqual(before)
    expect(await eventNames(fixture.prepare)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.completed",
    ])

    const replay = await decideSkillActivation(input)
    expect(replay).toEqual(result)
    expect(await readdir(fixture.runtime)).toHaveLength(1)
    expect(
      await cleanupSkillActivationBundle({
        workspaceRoot: fixture.workspace,
        privateRuntimeDirectory: fixture.runtime,
        sessionID: fixture.prepare.plan.sessionID,
        capabilityGrantID: proposal.capability.manifest.grant.capabilityGrantID,
      }),
    ).toBeTrue()
    expect(await readdir(fixture.runtime)).toEqual([])
  })

  test("records no effect when the selected instructions drift after preview", async () => {
    const fixture = await activationFixture("activate-once")
    const proposal = await prepareSkillActivation(fixture.prepare)
    await writeFile(fixture.skillPath, `${await readFile(fixture.skillPath, "utf8")}\nChanged after preview.\n`)

    const result = await decideSkillActivation({
      ...fixture.prepare,
      proposal,
      consent: { decision: "approved", decidedAt: fixture.decidedAt },
      privateRuntimeDirectory: fixture.runtime,
    })

    expect(result).toMatchObject({ state: "failed", status: "failed_without_effect", bundlePath: null })
    expect(await readdir(fixture.runtime)).toEqual([])
    expect(await receiptPreview(fixture.prepare)).toBe("NO EFFECT — skill_identity_changed")
  })

  test("records no effect when the workspace preflight baseline drifts after preview", async () => {
    const fixture = await activationFixture("activate-once")
    const proposal = await prepareSkillActivation(fixture.prepare)
    await writeFile(join(fixture.workspace, "package.json"), "{}\n")

    const result = await decideSkillActivation({
      ...fixture.prepare,
      proposal,
      consent: { decision: "approved", decidedAt: fixture.decidedAt },
      privateRuntimeDirectory: fixture.runtime,
    })

    expect(result).toMatchObject({ state: "failed", status: "failed_without_effect", bundlePath: null })
    expect(await readdir(fixture.runtime)).toEqual([])
    expect(await receiptPreview(fixture.prepare)).toBe("NO EFFECT — workspace_baseline_changed")
  })

  test("recovers a crash after bundle creation as durable uncertainty without reactivating it", async () => {
    const fixture = await activationFixture("activate-once")
    const proposal = await prepareSkillActivation(fixture.prepare)
    const input: DecideSkillActivationInput = {
      ...fixture.prepare,
      proposal,
      consent: { decision: "approved", decidedAt: fixture.decidedAt },
      privateRuntimeDirectory: fixture.runtime,
    }
    let faults = 0
    expect(
      decideSkillActivation(input, {
        now: () => fixture.executionAt,
        async injectFault(point) {
          if (point !== "after_effect_before_spool") return
          faults += 1
          throw new Error("simulated crash after effect")
        },
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    expect(faults).toBe(1)
    expect(await readdir(fixture.runtime)).toHaveLength(1)

    const recovered = await recoverSkillActivation(
      {
        ...fixture.prepare,
        proposal,
        privateRuntimeDirectory: fixture.runtime,
      },
      { now: () => fixture.executionAt + 61_000 },
    )
    expect(recovered).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      receiptID: null,
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
    })
    expect(recovered.bundlePath).not.toBeNull()
    expect(await readdir(fixture.runtime)).toHaveLength(1)
    expect(await eventNames(fixture.prepare)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])
  })

  for (const faultPoint of ["after_spool_before_ledger", "after_ledger_before_ack"] as const) {
    test(`recovers ${faultPoint} by transferring the exact receipt without a second activation`, async () => {
      const fixture = await activationFixture("activate-once")
      const proposal = await prepareSkillActivation(fixture.prepare)
      const input: DecideSkillActivationInput = {
        ...fixture.prepare,
        proposal,
        consent: { decision: "approved", decidedAt: fixture.decidedAt },
        privateRuntimeDirectory: fixture.runtime,
      }
      expect(
        decideSkillActivation(input, {
          now: () => fixture.executionAt,
          async injectFault(point) {
            if (point === faultPoint) throw new Error(`simulated crash at ${faultPoint}`)
          },
        }),
      ).rejects.toMatchObject({ code: "state_unavailable" })
      expect(await readdir(fixture.runtime)).toHaveLength(1)

      const recovered = await recoverSkillActivation(
        {
          ...fixture.prepare,
          proposal,
          privateRuntimeDirectory: fixture.runtime,
        },
        { now: () => fixture.executionAt + 1_000 },
      )
      expect(recovered).toMatchObject({
        state: "completed",
        status: "completed_observed_not_verified",
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      })
      expect(await readdir(fixture.runtime)).toHaveLength(1)
      expect((await eventNames(fixture.prepare)).filter((name) => name === "effect.completed")).toHaveLength(1)
    })
  }
})

async function activationFixture(workspaceMode: "read-only" | "activate-once") {
  const workspace = await temporaryDirectory("astra-skill-workspace-")
  const state = await temporaryDirectory("astra-skill-state-")
  const runtime = await temporaryDirectory("astra-skill-private-")
  const skillPath = join(workspace, ".opencode/skills/safe-skill/SKILL.md")
  await mkdir(dirname(skillPath), { recursive: true })
  await writeFile(
    skillPath,
    [
      "---",
      "name: safe-skill",
      "description: Explicitly approved test instructions.",
      "---",
      "",
      "# Safe skill",
      "",
      "Never run commands automatically.",
      "",
    ].join("\n"),
  )
  const [report, inventory] = await Promise.all([scanWorkspace(workspace), inspectWorkspaceSkills(workspace)])
  if (report.completeness !== "complete") throw new Error(report.blockers.join(", "))
  if (inventory.status !== "complete") throw new Error(inventory.reason)
  const candidate = inventory.candidates[0]
  if (!candidate) throw new Error("Missing skill candidate")
  const base = Date.now() - 1_000
  const prepare: PrepareSkillActivationInput = {
    plan: {
      operationID: crypto.randomUUID(),
      sessionID: crypto.randomUUID(),
      workspaceMode,
      candidate,
      limits: inventory.limits,
      createdAt: new Date(base).toISOString(),
    },
    report,
    policyAskedAt: new Date(base + 100).toISOString(),
    recordingStartedAt: new Date(base + 200).toISOString(),
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
  }
  return {
    workspace,
    runtime,
    skillPath,
    prepare,
    decidedAt: new Date(base + 300).toISOString(),
    executionAt: base + 400,
  }
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function eventNames(input: PrepareSkillActivationInput) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return (yield* ledger.readEvents(requireOperationID(input.plan.operationID), { limit: 16 })).map(
        (event) => event.name,
      )
    }),
  )
}

async function receiptPreview(input: PrepareSkillActivationInput) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const candidates = yield* ledger.listRecoveryCandidates({ limit: 16 })
      return candidates.find((candidate) => candidate.request.operationID === requireOperationID(input.plan.operationID))
        ?.receipt?.output.preview
    }),
  )
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new Error("Invalid test Operation ID")
  return parsed.value
}

async function workspaceSnapshot(root: string) {
  const paths = (await readdir(root, { recursive: true })).toSorted()
  const skill = await readFile(join(root, ".opencode/skills/safe-skill/SKILL.md"), "utf8")
  return { paths, skill }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
