import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { scanWorkspace } from "../../astra-runtime/src/workspace-preflight"
import { createAstraSkillActivationClient } from "../../tui/src/astra/skill-activation-client"
import { createAstraSkillActivationControl } from "../src/skill-activation-control"
import { startAstraTuiControlServer } from "../src/tui-control-server"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("runs explicit inventory, zero-effect rejection, and one-shot private activation through the real socket", async () => {
  const workspace = await temporary("astra-skill-smoke-workspace-")
  const state = await temporary("astra-skill-smoke-state-")
  const privateRuntime = await mkdtemp("/tmp/as-sk-")
  roots.push(privateRuntime)
  await chmod(privateRuntime, 0o700)
  const skillPath = join(workspace, ".opencode/skills/safe-skill/SKILL.md")
  await mkdir(dirname(skillPath), { recursive: true })
  await writeFile(
    skillPath,
    [
      "---",
      "name: safe-skill",
      "description: Workspace supplied test skill.",
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
  const sessionID = crypto.randomUUID()
  const session = { status: "opened", mode: "activate-once", report } as const
  const skillControl = createAstraSkillActivationControl(
    session,
    { sessionID },
    {
      ledgerFilename: join(state, "operations.sqlite"),
      spoolFilename: join(state, "receipts.sqlite"),
      privateRuntimeDirectory: privateRuntime,
    },
  )
  let activeSkillControl = skillControl
  let server = await startAstraTuiControlServer({
    directory: privateRuntime,
    workspaceRoot: workspace,
    sessionID,
    skillActivationControl: skillControl,
  })
  let client = createAstraSkillActivationClient(
    { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
    sessionID,
  )
  const before = await workspaceTree(workspace)

  try {
    expect(await readdir(state)).toEqual([])
    expect(await readdir(privateRuntime)).toEqual(["control.sock"])

    const firstInventory = await client.inventory()
    if (firstInventory.status !== "complete" || !firstInventory.candidates[0]) {
      throw new Error("The explicit skill inventory failed")
    }
    expect(firstInventory.candidates[0]).toMatchObject({
      relativePath: ".opencode/skills/safe-skill/SKILL.md",
      metadataTrust: "UNTRUSTED WORKSPACE METADATA",
    })
    const rejectedProposal = await client.prepare(
      firstInventory.inventoryID,
      firstInventory.candidates[0].candidateID,
    )
    if (rejectedProposal.status !== "prepared") throw new Error(rejectedProposal.reason)
    const rejected = await client.decide(rejectedProposal.preview.proposalID, "reject")
    expect(rejected).toMatchObject({ status: "denied_without_effect", verification: "not_verified" })
    expect(await workspaceTree(workspace)).toEqual(before)
    expect(await readdir(privateRuntime)).toEqual(["control.sock"])
    expect(await skillControl.takePromptBundle()).toBeNull()

    client.dispose()
    await server.close()
    const approvalSessionID = crypto.randomUUID()
    activeSkillControl = createAstraSkillActivationControl(
      session,
      { sessionID: approvalSessionID },
      {
        ledgerFilename: join(state, "operations.sqlite"),
        spoolFilename: join(state, "receipts.sqlite"),
        privateRuntimeDirectory: privateRuntime,
      },
    )
    server = await startAstraTuiControlServer({
      directory: privateRuntime,
      workspaceRoot: workspace,
      sessionID: approvalSessionID,
      skillActivationControl: activeSkillControl,
    })
    client = createAstraSkillActivationClient(
      { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token },
      approvalSessionID,
    )

    const secondInventory = await client.inventory()
    if (secondInventory.status !== "complete" || !secondInventory.candidates[0]) {
      throw new Error("The second explicit skill inventory failed")
    }
    const approvedProposal = await client.prepare(
      secondInventory.inventoryID,
      secondInventory.candidates[0].candidateID,
    )
    if (approvedProposal.status !== "prepared") throw new Error(approvedProposal.reason)
    const phases: string[] = []
    const approved = await client.decide(approvedProposal.preview.proposalID, "approve", {
      onProgress(progress) {
        phases.push(progress.status)
      },
    })
    expect(approved).toMatchObject({ status: "completed_observed_not_verified", verification: "not_verified" })
    expect(phases).toEqual(["recording_authority", "submitting_approval", "effect_observed_not_verified"])
    expect(JSON.stringify(approved)).not.toContain("bundlePath")
    expect(JSON.stringify(approved)).not.toContain("Never run commands")
    expect(await workspaceTree(workspace)).toEqual(before)

    const bundle = await activeSkillControl.takePromptBundle()
    expect(bundle).toMatchObject({
      operationID: approvedProposal.preview.operationID,
      assurance: "observed_not_verified",
      skill: { name: "safe-skill", trust: "untrusted_instruction_data", resourceDiscovery: "none" },
    })
    expect(bundle?.skill.instructions).toContain("Never run commands automatically")
    expect(await activeSkillControl.takePromptBundle()).toBeNull()
    expect(await readdir(privateRuntime)).toEqual(["control.sock"])
  } finally {
    client.dispose()
    await server.close()
  }
})

async function temporary(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function workspaceTree(root: string) {
  return (await readdir(root, { recursive: true })).toSorted()
}
