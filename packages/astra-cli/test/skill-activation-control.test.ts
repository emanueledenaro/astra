import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scanWorkspace } from "../../astra-runtime/src/workspace-preflight"
import { revalidateWorkspacePreflight } from "../../astra-runtime/src/workspace-preflight"
import { inspectWorkspaceSkills } from "../../astra-runtime/src/skill-inventory"
import {
  cleanupSkillActivationBundle,
  decideSkillActivation,
  prepareSkillActivation,
} from "../../astra-runtime/src/skill-activation"
import { revalidateGitRepositoryBaseline } from "@astra/git"
import {
  createAstraSkillActivationControl,
  type AstraSkillActivationControlDependencies,
} from "../src/skill-activation-control"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Astra skill activation parent control", () => {
  test("does nothing on construction and blocks read-only before inventory", async () => {
    const fixture = await makeFixture("read-only")
    const before = await tree(fixture.workspace)
    const result = await fixture.control.inventory(crypto.randomUUID())

    expect(result).toMatchObject({ status: "blocked", reason: "read_only" })
    expect(await tree(fixture.workspace)).toEqual(before)
    expect(await readdir(fixture.state)).toEqual([])
    expect(await readdir(fixture.runtime)).toEqual([])
  })

  test("inventories only after an explicit request and exposes untrusted metadata", async () => {
    const fixture = await makeFixture("activate-once")
    const result = await fixture.control.inventory(crypto.randomUUID())

    expect(result.status).toBe("complete")
    if (result.status !== "complete") return
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      name: "safe-skill",
      relativePath: ".opencode/skills/safe-skill/SKILL.md",
      metadataTrust: "UNTRUSTED WORKSPACE METADATA",
      provenance: "workspace_opencode",
    })
    expect(result.verification).toBe("not_verified")
    expect(await readdir(fixture.state)).toEqual([])
    expect(await readdir(fixture.runtime)).toEqual([])
  })

  test("records rejection and never creates or returns a prompt bundle", async () => {
    const fixture = await makeFixture("activate-once")
    const prepared = await prepareOne(fixture)
    const result = await fixture.control.decide(
      crypto.randomUUID(),
      prepared.preview.proposalID,
      "reject",
    )

    expect(result).toMatchObject({
      status: "denied_without_effect",
      receiptID: null,
      verification: "not_verified",
    })
    expect(await fixture.control.takePromptBundle()).toBeNull()
    expect(await readdir(fixture.runtime)).toEqual([])
    expect(await fixture.control.inventory(crypto.randomUUID())).toMatchObject({
      status: "blocked",
      reason: "activation_already_decided",
    })
  })

  test("activates one exact skill after consent and hands it only to the local trusted consumer", async () => {
    const fixture = await makeFixture("activate-once")
    const prepared = await prepareOne(fixture)
    expect(prepared.preview).toMatchObject({
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      verification: "not_verified",
      skill: {
        provenance: "workspace_opencode",
        trust: "UNTRUSTED INSTRUCTION DATA",
      },
      effects: { workspaceWrite: "none", process: "none", network: "none", plugins: "none", mcp: "none", tools: "none" },
    })

    const progress: string[] = []
    const result = await fixture.control.decide(
      crypto.randomUUID(),
      prepared.preview.proposalID,
      "approve",
      (event) => progress.push(event.status),
    )
    expect(result).toMatchObject({
      status: "completed_observed_not_verified",
      verification: "not_verified",
    })
    expect(progress).toEqual([
      "recording_authority",
      "submitting_approval",
      "effect_observed_not_verified",
    ])

    const bundle = await fixture.control.takePromptBundle()
    expect(bundle).toMatchObject({
      operationID: prepared.preview.operationID,
      assurance: "observed_not_verified",
      source: { provenance: "workspace_opencode", relativePath: ".opencode/skills/safe-skill/SKILL.md" },
      skill: {
        name: "safe-skill",
        trust: "untrusted_instruction_data",
        resourceDiscovery: "none",
      },
    })
    expect(bundle?.skill.instructions).toContain("Never run commands automatically")
    expect(await fixture.control.takePromptBundle()).toBeNull()
    expect(await readdir(fixture.runtime)).toEqual([])

    const replay = await fixture.control.decide(crypto.randomUUID(), prepared.preview.proposalID, "approve")
    expect(replay).toMatchObject({ status: "blocked", reason: "proposal_consumed" })
  })

  test("fails closed when the selected skill drifts after preview", async () => {
    const fixture = await makeFixture("activate-once")
    const prepared = await prepareOne(fixture)
    await writeFile(fixture.skillPath, `${await readFile(fixture.skillPath, "utf8")}\nChanged after preview.\n`)

    const result = await fixture.control.decide(crypto.randomUUID(), prepared.preview.proposalID, "approve")
    expect(result).toMatchObject({ status: "failed_without_effect", verification: "not_verified" })
    expect(await fixture.control.takePromptBundle()).toBeNull()
    expect(await readdir(fixture.runtime)).toEqual([])
  })

  test("rejects a proposal whose preview does not exactly match the selected capability", async () => {
    const dependencies = realDependencies({
      async prepare(input) {
        const proposal = await prepareSkillActivation(input)
        return {
          ...proposal,
          preview: {
            ...proposal.preview,
            skill: { ...proposal.preview.skill, fileBytes: proposal.preview.skill.fileBytes + 1 },
          },
        }
      },
    })
    const fixture = await makeFixture("activate-once", dependencies)
    const inventory = await fixture.control.inventory(crypto.randomUUID())
    if (inventory.status !== "complete" || !inventory.candidates[0]) throw new Error("Missing inventory")
    const result = await fixture.control.prepare(
      crypto.randomUUID(),
      inventory.inventoryID,
      inventory.candidates[0].candidateID,
    )
    expect(result).toMatchObject({ status: "blocked", reason: "proposal_binding_mismatch" })
    expect(await readdir(fixture.runtime)).toEqual([])
  })

  test("allows a trusted bundle take to retry after transient cleanup failure", async () => {
    let cleanups = 0
    const dependencies = realDependencies({
      async cleanup(input) {
        cleanups++
        if (cleanups === 1) return false
        return cleanupSkillActivationBundle(input)
      },
    })
    const fixture = await makeFixture("activate-once", dependencies)
    const prepared = await prepareOne(fixture)
    expect(await fixture.control.decide(crypto.randomUUID(), prepared.preview.proposalID, "approve")).toMatchObject({
      status: "completed_observed_not_verified",
    })

    expect(await fixture.control.takePromptBundle()).toBeNull()
    expect(await fixture.control.takePromptBundle()).toMatchObject({
      operationID: prepared.preview.operationID,
      assurance: "observed_not_verified",
    })
    expect(cleanups).toBe(2)
    expect(await readdir(fixture.runtime)).toEqual([])
  })
})

async function prepareOne(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  const inventory = await fixture.control.inventory(crypto.randomUUID())
  if (inventory.status !== "complete" || !inventory.candidates[0]) throw new Error("Missing skill inventory")
  const prepared = await fixture.control.prepare(
    crypto.randomUUID(),
    inventory.inventoryID,
    inventory.candidates[0].candidateID,
  )
  if (prepared.status !== "prepared") throw new Error(prepared.reason)
  return prepared
}

async function makeFixture(
  mode: "read-only" | "activate-once",
  dependencies?: AstraSkillActivationControlDependencies,
) {
  const workspace = await temporary("astra-skill-control-workspace-")
  const state = await temporary("astra-skill-control-state-")
  const runtime = await temporary("astra-skill-control-private-")
  await chmod(runtime, 0o700)
  const skillPath = join(workspace, ".opencode/skills/safe-skill/SKILL.md")
  await mkdir(dirname(skillPath), { recursive: true })
  await writeFile(
    skillPath,
    [
      "---",
      "name: safe-skill",
      "description: Workspace supplied description.",
      "---",
      "",
      "# Safe skill",
      "",
      "Never run commands automatically.",
      "",
    ].join("\n"),
  )
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(", "))
  const control = createAstraSkillActivationControl(
    { status: "opened", mode, report },
    { sessionID: crypto.randomUUID() },
    {
      ledgerFilename: join(state, "operations.sqlite"),
      spoolFilename: join(state, "receipts.sqlite"),
      privateRuntimeDirectory: runtime,
    },
    dependencies,
  )
  return { workspace, state, runtime, skillPath, control }
}

function realDependencies(
  overrides: Partial<AstraSkillActivationControlDependencies> = {},
): AstraSkillActivationControlDependencies {
  return {
    now: Date.now,
    inspect: inspectWorkspaceSkills,
    revalidateWorkspace: revalidateWorkspacePreflight,
    revalidateGit: revalidateGitRepositoryBaseline,
    prepare: prepareSkillActivation,
    decide: decideSkillActivation,
    cleanup: cleanupSkillActivationBundle,
    ...overrides,
  }
}

async function temporary(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

async function tree(root: string) {
  return (await readdir(root, { recursive: true })).toSorted()
}
