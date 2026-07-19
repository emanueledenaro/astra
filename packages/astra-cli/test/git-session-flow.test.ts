import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureGitRepositoryBaseline,
  executeGitCommitLocal,
  inspectGitWorkspace,
  prepareGitCommitLocal,
  verifyGitCommitLocal,
} from "@astra/git"
import {
  executeDurableGitCommit,
  verifyDurableGitCommit,
  type GitCommitAdapter,
} from "@astra/runtime/git-commit-coordinator"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraGitCommitControl, type AstraGitCommitControlDependencies } from "../src/git-commit-control"
import { createAstraGitStageControl } from "../src/git-stage-control"
import { createAstraGitSessionAuthority } from "../src/git-session-authority"
import { createAstraGitUnstageControl } from "../src/git-unstage-control"
import { startAstraTuiControlServer } from "../src/tui-control-server"
import { createAstraGitClientAuthority } from "@opencode-ai/tui/astra/git-client-authority"
import { createAstraGitCommitClient } from "@opencode-ai/tui/astra/git-commit-client"
import { createAstraGitStageClient } from "@opencode-ai/tui/astra/git-stage-client"
import { createAstraGitUnstageClient } from "@opencode-ai/tui/astra/git-unstage-client"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("stages and commits consecutively in one activated session", async () => {
  const fixture = await makeFixture()
  const authority = createAstraGitSessionAuthority(fixture.session)
  const stage = createAstraGitStageControl(fixture.session, fixture.state, undefined, authority)
  const commit = createAstraGitCommitControl(fixture.session, fixture.state, commitDependencies(), authority)
  const unstage = createAstraGitUnstageControl(fixture.session, fixture.state, undefined, authority)
  const sessionID = randomUUID()
  const server = await startAstraTuiControlServer({
    directory: fixture.root,
    workspaceRoot: fixture.workspace,
    sessionID,
    gitStageControl: stage,
    gitCommitControl: commit,
    gitUnstageControl: unstage,
  })
  const clientAuthority = createAstraGitClientAuthority(fixture.session.repositoryBaseline.snapshotDigest)
  const environment = { ASTRA_CONTROL_SOCKET: server.socketPath, ASTRA_CONTROL_TOKEN: server.token }
  const options = { expectedWorkspaceRoot: fixture.workspace, baselineAuthority: clientAuthority }
  const stageClient = createAstraGitStageClient(environment, sessionID, options)
  const commitClient = createAstraGitCommitClient(environment, sessionID, options)
  const unstageClient = createAstraGitUnstageClient(environment, sessionID, options)

  try {
    await stageTracked(stageClient)

    const unstagePreview = await unstageClient.prepare()
    if (unstagePreview.status !== "prepared") throw new Error(unstagePreview.reason)
    expect(await unstageClient.decide(unstagePreview.preview.proposalID, "approve")).toMatchObject({
      status: "verified",
    })
    expect((await git(fixture.workspace, ["diff", "--cached", "--name-only"])).trim()).toBe("")

    await stageTracked(stageClient)

    const commitPreview = await commitClient.prepare("test: consecutive session flow")
    if (commitPreview.status !== "prepared") throw new Error(commitPreview.reason)
    const committed = await commitClient.decide(commitPreview.preview.proposalID, "approve")
    expect(committed).toMatchObject({ status: "verified" })
    if (committed.status !== "verified") throw new Error(JSON.stringify(committed))
    expect(committed.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(clientAuthority.current()).toBe(committed.snapshotDigest)
    expect((await git(fixture.workspace, ["log", "-1", "--format=%s"])).trim()).toBe("test: consecutive session flow")
  } finally {
    stageClient.dispose()
    commitClient.dispose()
    unstageClient.dispose()
    await server.close()
  }
}, 180_000)

async function stageTracked(client: ReturnType<typeof createAstraGitStageClient>) {
  const inventory = await client.inventory()
  if (inventory.status !== "inventory") throw new Error(inventory.reason)
  const tracked = inventory.inventory.candidates.find((candidate) => candidate.path === "tracked.txt")
  if (!tracked) throw new Error("Missing tracked candidate")
  const preview = await client.prepare(inventory.inventory.inventoryID, [tracked.candidateID])
  if (preview.status !== "prepared") throw new Error(preview.reason)
  expect(await client.decide(preview.preview.proposalID, "approve")).toMatchObject({ status: "verified" })
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-git-session-flow-"))
  roots.push(root)
  const workspacePath = join(root, "workspace")
  await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  await writeFile(join(workspace, "tracked.txt"), "initial\n")
  await git(workspace, ["init", "-q"])
  await git(workspace, ["config", "user.email", "astra@example.invalid"])
  await git(workspace, ["config", "user.name", "Astra Test"])
  await git(workspace, ["add", "tracked.txt"])
  await git(workspace, ["commit", "-qm", "initial"])
  await writeFile(join(workspace, "tracked.txt"), "changed\n")

  const report = await scanWorkspace(workspace)
  const baseline = await captureGitRepositoryBaseline(workspace)
  const inspection = await inspectGitWorkspace(workspace)
  if (report.completeness !== "complete" || baseline.status !== "complete" || inspection.status !== "complete") {
    throw new Error("Fixture authority capture failed")
  }
  return {
    root,
    workspace,
    state: {
      ledgerFilename: join(root, "state", "operations.sqlite"),
      spoolFilename: join(root, "state", "receipts.sqlite"),
    },
    session: {
      status: "opened",
      mode: "activate-once",
      report,
      repositoryBaseline: baseline.snapshot,
      repositoryInspection: inspection,
    } as const,
  }
}

function commitDependencies(): AstraGitCommitControlDependencies {
  const environment = {
    ...process.env,
    ASTRA_GIT_AUTHOR_NAME: "Astra Test",
    ASTRA_GIT_AUTHOR_EMAIL: "astra@example.invalid",
  }
  const adapter = {
    execute: (input, claimProposal) => executeGitCommitLocal(input, { claimProposal }),
    verify: verifyGitCommitLocal,
  } satisfies GitCommitAdapter
  return {
    now: Date.now,
    prepare: (workspaceRoot, baseline, message, now) =>
      prepareGitCommitLocal(workspaceRoot, baseline, message, environment, now),
    execute: (input, selectedAdapter) => executeDurableGitCommit(input, { adapter: selectedAdapter }),
    verify: verifyDurableGitCommit,
    adapter,
  }
}

async function git(workspace: string, args: string[]) {
  const process = Bun.spawn(["/usr/bin/git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Git failed: ${stderr}`)
  return stdout
}
