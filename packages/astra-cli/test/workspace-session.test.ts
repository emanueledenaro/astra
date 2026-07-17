import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { captureGitRepositoryBaseline, inspectGitWorkspace, revalidateGitRepositoryBaseline } from "@astra/git"
import { openAstraWorkspaceSession } from "../src/workspace-session"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("opens a non-Git workspace read-only without workspace effects", async () => {
  const root = await workspace()
  const before = await readdir(root)
  const views: string[] = []

  const result = await openAstraWorkspaceSession(root, {
    ...unusedGitDependencies(),
    async present(view) {
      views.push(view.state)
      return "read-only"
    },
  })

  expect(result).toMatchObject({ status: "opened", mode: "read-only", report: { root } })
  expect(views).toEqual(["awaiting-decision"])
  expect(await readdir(root)).toEqual(before)
})

test("uses the canonical workspace path when only an intermediate path component is a symlink", async () => {
  const physical = await workspace()
  const aliases = await realpath(await mkdtemp(join(tmpdir(), "astra-product-alias-")))
  roots.push(aliases)
  await symlink(dirname(physical), join(aliases, "linked-parent"))
  const aliased = join(aliases, "linked-parent", basename(physical))

  const result = await openAstraWorkspaceSession(aliased, {
    ...unusedGitDependencies(),
    async present(view) {
      expect(view.workspace).toBe(physical)
      return "read-only"
    },
  })

  expect(result).toMatchObject({ status: "opened", report: { root: physical } })
})

test("opens a non-Git workspace with one-process activation and no demo write", async () => {
  const root = await workspace()
  const before = await readdir(root)

  const result = await openAstraWorkspaceSession(root, {
    ...unusedGitDependencies(),
    async present(view) {
      expect(view.activationAllowed).toBeTrue()
      return "activate-once"
    },
  })

  expect(result).toMatchObject({ status: "opened", mode: "activate-once" })
  expect(await readdir(root)).toEqual(before)
})

test("shows stale state and does not open when static facts change after the decision screen", async () => {
  const root = await workspace()
  const states: string[] = []
  let calls = 0

  const result = await openAstraWorkspaceSession(root, {
    ...unusedGitDependencies(),
    async present(view) {
      states.push(view.state)
      calls += 1
      if (calls === 1) {
        await writeFile(join(root, "AGENTS.md"), "changed after preview\n")
        return "read-only"
      }
      return "exit"
    },
  })

  expect(result.status).toBe("exited")
  expect(states).toEqual(["awaiting-decision", "stale"])
})

test("binds displayed Git inspection to the baseline activated by the next decision", async () => {
  const root = await gitWorkspace()
  const decisions = ["inspect-git", "activate-once"] as const
  const views: Array<{ git: string; activationAllowed: boolean }> = []
  const progress: Array<{ state: string; git: string }> = []

  const result = await openAstraWorkspaceSession(root, {
    inspectGitWorkspace,
    captureGitRepositoryBaseline,
    revalidateGitRepositoryBaseline,
    async withProgress(view, operation) {
      progress.push({ state: view.state, git: view.git })
      return operation()
    },
    async present(view) {
      views.push({ git: view.git, activationAllowed: view.activationAllowed })
      return decisions[views.length - 1] ?? "exit"
    },
  })

  expect(result).toMatchObject({
    status: "opened",
    mode: "activate-once",
    repositoryBaseline: { snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
  })
  expect(views).toEqual([
    { git: "not-inspected", activationAllowed: false },
    { git: "current", activationAllowed: true },
  ])
  expect(progress).toEqual([
    { state: "working", git: "inspecting" },
    { state: "working", git: "inspecting" },
  ])
}, 20_000)

test("refuses activation when Git changes after the displayed inspection", async () => {
  const root = await gitWorkspace()
  const states: Array<{ state: string; git: string }> = []
  let calls = 0

  const result = await openAstraWorkspaceSession(root, {
    inspectGitWorkspace,
    captureGitRepositoryBaseline,
    revalidateGitRepositoryBaseline,
    async present(view) {
      states.push({ state: view.state, git: view.git })
      calls += 1
      if (calls === 1) return "inspect-git"
      if (calls === 2) {
        await writeFile(join(root, "drift.txt"), "changed after inspection\n")
        return "activate-once"
      }
      return "exit"
    },
  })

  expect(result.status).toBe("exited")
  expect(states).toEqual([
    { state: "awaiting-decision", git: "not-inspected" },
    { state: "awaiting-decision", git: "current" },
    { state: "stale", git: "stale" },
  ])
}, 20_000)

test("reports a blocked Git revalidation without claiming that the repository changed", async () => {
  const root = await gitWorkspace()
  const views: Array<{ state: string; git: string; detail?: string }> = []
  const decisions = ["inspect-git", "activate-once", "exit"] as const
  let revalidations = 0

  const result = await openAstraWorkspaceSession(root, {
    inspectGitWorkspace,
    captureGitRepositoryBaseline,
    async revalidateGitRepositoryBaseline(workspaceRoot, snapshot) {
      revalidations += 1
      if (revalidations === 1) return revalidateGitRepositoryBaseline(workspaceRoot, snapshot)
      return {
        status: "blocked",
        expectedSnapshotDigest: snapshot.snapshotDigest,
        reason: "boundary_time_limit_exceeded",
      }
    },
    async present(view) {
      views.push({ state: view.state, git: view.git, ...(view.detail ? { detail: view.detail } : {}) })
      return decisions[views.length - 1] ?? "exit"
    },
  })

  expect(result.status).toBe("exited")
  expect(views.at(-1)).toEqual({
    state: "blocked",
    git: "blocked",
    detail: "Git revalidation was blocked: boundary time limit exceeded.",
  })
}, 20_000)

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "astra-product-workspace-")))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{}\n")
  return root
}

async function gitWorkspace() {
  const root = await workspace()
  await git(root, "init", "-q", "--initial-branch=main")
  await git(root, "add", "package.json")
  await git(root, "-c", "user.name=Astra", "-c", "user.email=astra@example.invalid", "commit", "-qm", "initial")
  return root
}

function unusedGitDependencies() {
  return {
    async inspectGitWorkspace() {
      throw new Error("Git inspection must not run")
    },
    async captureGitRepositoryBaseline() {
      throw new Error("Git capture must not run")
    },
    async revalidateGitRepositoryBaseline() {
      throw new Error("Git revalidation must not run")
    },
  }
}

async function git(root: string, ...arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn(["/usr/bin/git", "-C", root, ...arguments_], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Git fixture failed: ${stderr}`)
}
