import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureGitRepositoryBaseline,
  defaultGitRepositoryBaselineLimits,
  revalidateGitRepositoryBaseline,
} from "../src"
import { captureGitRepositoryBaselineWithHooks } from "../src/baseline"

const roots: Array<string> = []
const realGit = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("bounded Git repository baseline", () => {
  test("uses explicit defaults large enough for Astra without silently relaxing them", () => {
    expect(defaultGitRepositoryBaselineLimits).toMatchObject({
      maxEntries: 25_000,
      maxBoundaryDurationMs: 15_000,
      maxContentEntries: 25_000,
      maxFileBytes: 32 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      maxDurationMs: 60_000,
    })
  })

  test("captures deterministically and leaves Git plus worktree bytes unchanged", async () => {
    const root = await repository()
    await writeFile(join(root, "untracked.txt"), "untracked\n")
    const before = await directoryDigest(root)

    const first = await captureGitRepositoryBaseline(root)
    const second = await captureGitRepositoryBaseline(root)

    expect(first.status).toBe("complete")
    expect(second).toEqual(first)
    if (first.status !== "complete") throw new Error(first.reason)
    expect(first.snapshot).toMatchObject({
      schemaVersion: 1,
      mode: "bounded_read_only",
      durability: "ephemeral",
      verification: "not_verified",
      head: { kind: "symbolic", symbolicRef: "refs/heads/main" },
      worktree: { ignored: "excluded", trackedPaths: 1, untrackedPaths: 1 },
      observer: { adapter: "astra.git-baseline.v1" },
    })
    expect(first.snapshot.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.keys(first.snapshot)).not.toContain("entries")
    expect(Object.keys(first.snapshot.refs).sort()).toEqual(["count", "digest"])
    expect(Object.keys(first.snapshot.index).sort()).toEqual(["digest", "entryCount", "metadataDigest"])
    expect(JSON.stringify(first.snapshot)).not.toContain("tracked.txt")
    expect(JSON.stringify(first.snapshot)).not.toContain("untracked.txt")
    expect(await directoryDigest(root)).toBe(before)
  })

  test("detects same-size tracked and untracked byte drift", async () => {
    const root = await repository()
    await writeFile(join(root, "untracked.txt"), "AAAA")
    const first = await complete(root)
    const trackedTimes = await stat(join(root, "tracked.txt"))
    const untrackedTimes = await stat(join(root, "untracked.txt"))

    await writeFile(join(root, "tracked.txt"), "changed\n")
    await writeFile(join(root, "untracked.txt"), "BBBB")
    await utimes(join(root, "tracked.txt"), trackedTimes.atime, trackedTimes.mtime)
    await utimes(join(root, "untracked.txt"), untrackedTimes.atime, untrackedTimes.mtime)
    const result = await revalidateGitRepositoryBaseline(root, first)

    expect(result).toMatchObject({
      status: "stale",
      expectedSnapshotDigest: first.snapshotDigest,
    })
  })

  test("binds symlink targets, executable bits, and deleted tracked paths", async () => {
    const symlinkRoot = await repository()
    await writeFile(join(symlinkRoot, "target-a"), "a")
    await writeFile(join(symlinkRoot, "target-b"), "b")
    await symlink("target-a", join(symlinkRoot, "link"))
    await git(symlinkRoot, "add", "link")
    const symlinkBaseline = await complete(symlinkRoot)
    await rm(join(symlinkRoot, "link"))
    await symlink("target-b", join(symlinkRoot, "link"))
    expect(await revalidateGitRepositoryBaseline(symlinkRoot, symlinkBaseline)).toMatchObject({ status: "stale" })

    const executableRoot = await repository()
    const executableBaseline = await complete(executableRoot)
    await chmod(join(executableRoot, "tracked.txt"), 0o755)
    expect(await revalidateGitRepositoryBaseline(executableRoot, executableBaseline)).toMatchObject({
      status: "stale",
    })

    const deletedRoot = await repository()
    await rm(join(deletedRoot, "tracked.txt"))
    const deletedBaseline = await complete(deletedRoot)
    await writeFile(join(deletedRoot, "tracked.txt"), "initial\n")
    expect(await revalidateGitRepositoryBaseline(deletedRoot, deletedBaseline)).toMatchObject({ status: "stale" })
  }, 30_000)

  test("binds executable bits for inert Git hook metadata", async () => {
    const root = await repository()
    const hook = join(root, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nexit 0\n")
    await chmod(hook, 0o644)
    const baseline = await complete(root)

    await chmod(hook, 0o755)

    expect(await revalidateGitRepositoryBaseline(root, baseline)).toMatchObject({ status: "stale" })
  })

  test("captures a full conflicted index and blocks unsupported split-index extensions", async () => {
    const conflictRoot = await conflictedRepository()
    const conflict = await captureGitRepositoryBaseline(conflictRoot)
    expect(conflict.status).toBe("complete")
    if (conflict.status !== "complete") throw new Error(conflict.reason)
    expect(conflict.snapshot.index.entryCount).toBe(3)

    const splitRoot = await repository()
    await git(splitRoot, "update-index", "--split-index")
    expect(await captureGitRepositoryBaseline(splitRoot)).toMatchObject({
      status: "blocked",
      reason: "git_index_extension_unsupported",
    })
  })

  test("fails closed on content limits and mutation between observations", async () => {
    const limited = await repository()
    expect(await captureGitRepositoryBaseline(limited, { maxFileBytes: 1 })).toMatchObject({
      status: "blocked",
      reason: "content_file_limit_exceeded",
    })
    expect(await captureGitRepositoryBaseline(limited, { maxContentEntries: 1 })).toMatchObject({
      status: "blocked",
      reason: "content_entry_limit_exceeded",
    })

    const mutating = await repository()
    const result = await captureGitRepositoryBaselineWithHooks(
      mutating,
      {},
      {
        async afterFirstContentObservation() {
          await writeFile(join(mutating, "tracked.txt"), "changed\n")
        },
      },
    )
    expect(result).toMatchObject({ status: "blocked", reason: "observation_changed" })

    const timed = await repository()
    const timedResult = await captureGitRepositoryBaselineWithHooks(
      timed,
      { maxDurationMs: 2_000 },
      {
        async afterFirstContentObservation() {
          await Bun.sleep(2_100)
        },
      },
    )
    expect(timedResult.status).toBe("blocked")
    if (timedResult.status !== "blocked") throw new Error("The deadline was not enforced")
    expect(["boundary_time_limit_exceeded", "content_time_limit_exceeded"]).toContain(timedResult.reason)
  })

  test("enforces traversal and file-read deadlines inside metadata capture", async () => {
    const traversed = await repository()
    const traversalResult = await captureGitRepositoryBaselineWithHooks(
      traversed,
      { maxBoundaryEntries: 128 },
      {
        async afterInitialBoundary() {
          await Promise.all(
            Array.from({ length: 200 }, (_, index) =>
              writeFile(join(traversed, ".git", "hooks", `astra-${index.toString().padStart(3, "0")}`), ""),
            ),
          )
        },
      },
    )
    expect(traversalResult).toMatchObject({ status: "blocked", reason: "boundary_entry_limit_exceeded" })

    const timed = await repository()
    let delayed = false
    const timedResult = await captureGitRepositoryBaselineWithHooks(
      timed,
      { maxDurationMs: 1_000 },
      {
        async beforeFileReadChunk() {
          if (delayed) return
          delayed = true
          await Bun.sleep(1_100)
        },
      },
    )
    expect(timedResult).toMatchObject({ status: "blocked", reason: "content_time_limit_exceeded" })
  })

  test("blocks intermediate symlinks instead of following a tracked path outside the root", async () => {
    const root = await repository()
    await mkdir(join(root, "directory"))
    await writeFile(join(root, "directory", "file.txt"), "inside\n")
    await git(root, "add", "directory/file.txt")
    await git(root, "commit", "-qm", "nested")
    const outside = await temporaryDirectory("astra-git-outside-")
    await writeFile(join(outside, "file.txt"), "outside\n")
    await rm(join(root, "directory"), { recursive: true })
    await symlink(outside, join(root, "directory"))

    expect(await captureGitRepositoryBaseline(root)).toMatchObject({
      status: "blocked",
      reason: "content_intermediate_symlink",
    })
  })

  test("binds repository config and returns current, stale, or blocked on revalidation", async () => {
    const root = await repository()
    const baseline = await complete(root)

    expect(await revalidateGitRepositoryBaseline(root, baseline)).toEqual({
      status: "current",
      expectedSnapshotDigest: baseline.snapshotDigest,
      currentSnapshotDigest: baseline.snapshotDigest,
    })

    const callerOwned = { ...baseline, limits: { ...baseline.limits }, worktree: { ...baseline.worktree } }
    const stableDigest = callerOwned.snapshotDigest
    const pending = revalidateGitRepositoryBaseline(root, callerOwned)
    callerOwned.snapshotDigest = `sha256:${"f".repeat(64)}`
    callerOwned.limits.maxDurationMs = 1
    callerOwned.worktree.totalBytes += 1
    expect(await pending).toEqual({
      status: "current",
      expectedSnapshotDigest: stableDigest,
      currentSnapshotDigest: stableDigest,
    })

    const refRoot = await repository()
    const refBaseline = await complete(refRoot)
    await git(refRoot, "branch", "new-reference")
    expect(await revalidateGitRepositoryBaseline(refRoot, refBaseline)).toMatchObject({ status: "stale" })

    await writeFile(
      join(root, ".git", "config"),
      (await readFile(join(root, ".git", "config"), "utf8")) + "\n[gc]\n\tauto = 0\n",
    )
    expect(await revalidateGitRepositoryBaseline(root, baseline)).toMatchObject({ status: "stale" })

    const blockedRoot = await repository()
    const blockedBaseline = await complete(blockedRoot)
    await rm(join(blockedRoot, ".git"), { recursive: true })
    expect(await revalidateGitRepositoryBaseline(blockedRoot, blockedBaseline)).toMatchObject({
      status: "blocked",
      expectedSnapshotDigest: blockedBaseline.snapshotDigest,
      reason: "git_metadata_missing",
    })
  }, 30_000)

  test("rejects a structurally valid baseline whose authority fields do not match its digest", async () => {
    const root = await repository()
    const baseline = await complete(root)
    const forged = {
      ...baseline,
      worktree: { ...baseline.worktree, digest: `sha256:${"f".repeat(64)}` as const },
    } satisfies GitRepositoryBaselineSnapshot

    expect(await revalidateGitRepositoryBaseline(root, forged)).toEqual({
      status: "blocked",
      expectedSnapshotDigest: baseline.snapshotDigest,
      reason: "invalid_snapshot",
    })
  })

  test("rejects external Git include ambiguity and explicitly excludes ignored content", async () => {
    const included = await repository()
    await writeFile(
      join(included, ".git", "config"),
      (await readFile(join(included, ".git", "config"), "utf8")) + "\n[include]\n\tpath = /tmp/hostile\n",
    )
    expect(await captureGitRepositoryBaseline(included)).toMatchObject({
      status: "blocked",
      reason: "git_config_include_unsupported",
    })

    const malformed = await repository()
    await writeFile(
      join(malformed, ".git", "config"),
      (await readFile(join(malformed, ".git", "config"), "utf8")) + "\n[include]\n\tpath = /tmp/hostile\n[invalid\n",
    )
    expect(await captureGitRepositoryBaseline(malformed)).toMatchObject({
      status: "blocked",
      reason: "git_config_include_unsupported",
    })

    const worktreeConfig = await repository()
    await writeFile(
      join(worktreeConfig, ".git", "config"),
      (await readFile(join(worktreeConfig, ".git", "config"), "utf8")) + "\n[extensions]\n\tworktreeConfig = true\n",
    )
    await writeFile(join(worktreeConfig, ".git", "config.worktree"), "[include]\n\tpath = /tmp/hostile\n")
    expect(await captureGitRepositoryBaseline(worktreeConfig)).toMatchObject({
      status: "blocked",
      reason: "git_config_include_unsupported",
    })

    const raced = await repository()
    const outside = await temporaryDirectory("astra-git-outside-config-")
    const outsideConfig = join(outside, "included-config")
    await writeFile(outsideConfig, "[status]\n\tshowUntrackedFiles = no\n")
    let swapped = false
    const racedResult = await captureGitRepositoryBaselineWithHooks(
      raced,
      {},
      {
        async afterConfigPreflight() {
          if (swapped) return
          swapped = true
          await writeFile(
            join(raced, ".git", "config"),
            (await readFile(join(raced, ".git", "config"), "utf8")) + `\n[include]\n\tpath = ${outsideConfig}\n`,
          )
        },
      },
    )
    expect(racedResult.status).toBe("blocked")
    if (racedResult.status !== "blocked") throw new Error("The config swap was not blocked")
    expect(["git_process_failed", "sandbox_profile_rejected"]).toContain(racedResult.reason)

    const ignored = await repository()
    await writeFile(join(ignored, ".gitignore"), "ignored.txt\n")
    await git(ignored, "add", ".gitignore")
    await writeFile(join(ignored, "ignored.txt"), "one")
    const ignoredBaseline = await complete(ignored)
    await writeFile(join(ignored, "ignored.txt"), "two")
    expect(await revalidateGitRepositoryBaseline(ignored, ignoredBaseline)).toMatchObject({ status: "current" })
  })
})

async function complete(root: string) {
  const result = await captureGitRepositoryBaseline(root)
  if (result.status !== "complete") throw new Error(`${result.reason}: ${root}`)
  return result.snapshot
}

async function repository() {
  const root = await temporaryDirectory("astra-git-baseline-")
  await git(root, "init", "-q", "--initial-branch=main")
  await writeFile(join(root, "tracked.txt"), "initial\n")
  await git(root, "add", "tracked.txt")
  await git(root, "-c", "user.name=Astra", "-c", "user.email=astra@example.invalid", "commit", "-qm", "initial")
  return root
}

async function conflictedRepository() {
  const root = await repository()
  await git(root, "checkout", "-qb", "other")
  await writeFile(join(root, "tracked.txt"), "other\n")
  await git(root, "commit", "-qam", "other")
  await git(root, "checkout", "-q", "main")
  await writeFile(join(root, "tracked.txt"), "main\n")
  await git(root, "commit", "-qam", "main")
  await gitAllowFailure(root, "merge", "other")
  return root
}

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

async function git(root: string, ...arguments_: ReadonlyArray<string>) {
  const result = await gitProcess(root, arguments_)
  if (result.exitCode !== 0) throw new Error(`Git fixture command failed: ${result.stderr}`)
  return result.stdout
}

async function gitAllowFailure(root: string, ...arguments_: ReadonlyArray<string>) {
  return gitProcess(root, arguments_)
}

async function gitProcess(root: string, arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn([realGit, "-C", root, ...arguments_], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function directoryDigest(root: string) {
  const hash = createHash("sha256")
  await appendDirectory(hash, root, "")
  return hash.digest("hex")
}

async function appendDirectory(hash: ReturnType<typeof createHash>, root: string, relative: string) {
  const entries = await readdir(join(root, relative))
  entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  for (const name of entries) {
    const childRelative = join(relative, name)
    const path = join(root, childRelative)
    const facts = await lstat(path)
    hash.update(`${childRelative}\0${facts.mode}\0${facts.size}\0${facts.mtimeMs}\0`)
    if (facts.isSymbolicLink()) {
      hash.update(`link\0${await readlink(path)}\0`)
      continue
    }
    if (facts.isDirectory()) {
      await appendDirectory(hash, root, childRelative)
      continue
    }
    if (facts.isFile()) hash.update(await readFile(path))
  }
}
