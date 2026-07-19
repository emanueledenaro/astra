import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureGitRepositoryBaseline, inspectGitWorkspace } from "@astra/git"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraGitSessionAuthority } from "../src/git-session-authority"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("advances only to the exact verified repository snapshot", async () => {
  const fixture = await makeFixture()
  const authority = createAstraGitSessionAuthority(fixture.session)

  await git(fixture.workspace, ["add", "tracked.txt"])
  const verified = await captureGitRepositoryBaseline(fixture.workspace)
  if (verified.status !== "complete") throw new Error(JSON.stringify(verified))

  expect(
    await authority.advance(fixture.session.repositoryBaseline.snapshotDigest, verified.snapshot.snapshotDigest),
  ).toBe("advanced")
  expect(authority.current()?.baseline.snapshotDigest).toBe(verified.snapshot.snapshotDigest)
  expect(authority.current()?.inspection.staged.map((entry) => entry.path)).toEqual(["tracked.txt"])
})

test("invalidates authority when the repository no longer matches the verified snapshot", async () => {
  const fixture = await makeFixture()
  const authority = createAstraGitSessionAuthority(fixture.session)
  const verified = await captureGitRepositoryBaseline(fixture.workspace)
  if (verified.status !== "complete") throw new Error(JSON.stringify(verified))

  await writeFile(join(fixture.workspace, "unexpected.txt"), "external change\n")

  expect(
    await authority.advance(fixture.session.repositoryBaseline.snapshotDigest, verified.snapshot.snapshotDigest),
  ).toBe("invalidated")
  expect(authority.current()).toBeNull()
})

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-git-authority-"))
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
    workspace,
    session: {
      status: "opened",
      mode: "activate-once",
      report,
      repositoryBaseline: baseline.snapshot,
      repositoryInspection: inspection,
    } as const,
  }
}

async function git(workspace: string, args: string[]) {
  const process = Bun.spawn(["/usr/bin/git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
  if (exitCode !== 0) throw new Error(`Git failed: ${stderr}`)
}
