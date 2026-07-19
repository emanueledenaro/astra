import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkWorkspaceActivation, revalidateWorkspaceSnapshot, scanWorkspace } from "../src/workspace-preflight"
import { createMaliciousWorkspace, directoryDigest, sentinelNames } from "./support"

const cleanup: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.all(cleanup.map((remove) => remove()))
})

describe("bounded workspace preflight", () => {
  test("opens a malicious workspace without triggering repository effects or network", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        return new Response("unexpected")
      },
    })
    const fixture = await createMaliciousWorkspace(server.port)
    cleanup.push(fixture.cleanup)

    try {
      const before = await directoryDigest(fixture.root)
      const report = await scanWorkspace(fixture.root)
      const after = await directoryDigest(fixture.root)

      expect(report).toMatchObject({
        root: fixture.root,
        completeness: "complete",
        state: "awaiting_decision",
        blockers: [],
      })
      expect(report.identity).not.toBeNull()
      expect(report.securityDigest).toStartWith("sha256:")
      expect(report.surfaces.map((surface) => surface.kind)).toEqual(
        expect.arrayContaining([
          "environment_file",
          "git_metadata",
          "mcp_configuration",
          "opencode_configuration",
          "package_configuration",
          "repository_instructions",
          "symbolic_link",
        ]),
      )
      expect(report.surfaces.find((surface) => surface.kind === "git_metadata")).toEqual({
        kind: "git_metadata",
        path: ".git",
        entryKind: "directory",
      })
      expect(checkWorkspaceActivation(report)).toEqual({
        allowed: false,
        reason: "git_baseline_not_inspected",
      })
      expect(after).toBe(before)
      expect(await sentinelNames(fixture.sentinel)).toEqual([])
      expect(requests).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test("records a .git directory without inspecting repository contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-git-directory-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, ".git", "hooks"), { recursive: true })
    await writeFile(join(root, ".git", "hooks", "post-checkout"), "must not run or be read\n")

    const report = await scanWorkspace(root)

    expect(report.completeness).toBe("complete")
    expect(report.scannedBytes).toBe(0)
    expect(report.surfaces).toContainEqual({ kind: "git_metadata", path: ".git", entryKind: "directory" })
    expect(checkWorkspaceActivation(report)).toEqual({
      allowed: false,
      reason: "git_baseline_not_inspected",
    })
  })

  test("blocks activation when the opened workspace is nested inside a Git repository", async () => {
    const repository = await mkdtemp(join(tmpdir(), "astra-preflight-git-parent-"))
    const root = join(repository, "packages", "nested")
    cleanup.push(() => rm(repository, { recursive: true, force: true }))
    await mkdir(join(repository, ".git"))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "package.json"), "{}\n")

    const report = await scanWorkspace(root)

    expect(report.completeness).toBe("complete")
    expect(report.surfaces).toContainEqual({
      kind: "git_metadata",
      path: "../../.git",
      entryKind: "directory",
    })
    expect(checkWorkspaceActivation(report)).toEqual({
      allowed: false,
      reason: "git_baseline_not_inspected",
    })
  })

  test("blocks activation through an intermediate symlink into a Git repository", async () => {
    const repository = await mkdtemp(join(tmpdir(), "astra-preflight-git-physical-parent-"))
    const aliases = await mkdtemp(join(tmpdir(), "astra-preflight-git-alias-"))
    const physicalParent = join(repository, "packages")
    const root = join(aliases, "linked-packages", "app")
    cleanup.push(() => rm(repository, { recursive: true, force: true }))
    cleanup.push(() => rm(aliases, { recursive: true, force: true }))
    await mkdir(join(repository, ".git"))
    await mkdir(join(physicalParent, "app"), { recursive: true })
    await writeFile(join(physicalParent, "app", "package.json"), "{}\n")
    await symlink(physicalParent, join(aliases, "linked-packages"))

    const report = await scanWorkspace(root)

    expect(report.completeness).toBe("complete")
    expect(report.surfaces).toContainEqual({
      kind: "git_metadata",
      path: "../../.git",
      entryKind: "directory",
    })
    expect(checkWorkspaceActivation(report)).toEqual({
      allowed: false,
      reason: "git_baseline_not_inspected",
    })
  })

  test("fails closed for a case-variant Git metadata entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-git-case-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, ".GiT"))

    const report = await scanWorkspace(root)

    expect(report.completeness).toBe("complete")
    expect(report.surfaces).toContainEqual({ kind: "git_metadata", path: ".GiT", entryKind: "directory" })
    expect(checkWorkspaceActivation(report)).toEqual({
      allowed: false,
      reason: "git_baseline_not_inspected",
    })
  })

  test("digests a bounded regular .git file but does not inspect its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-git-file-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, ".git"), "gitdir: ../external/repository.git\n")

    const report = await scanWorkspace(root)

    expect(report.completeness).toBe("complete")
    expect(report.scannedBytes).toBe(Buffer.byteLength("gitdir: ../external/repository.git\n"))
    expect(report.surfaces).toContainEqual({ kind: "git_metadata", path: ".git", entryKind: "file" })
    await writeFile(join(root, ".git"), "gitdir: ../different/repository.git\n")
    expect(await revalidateWorkspaceSnapshot(report)).toMatchObject({
      matched: false,
      reason: "security_digest_changed",
    })
  })

  test("records a .git symlink as Git metadata without following its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-git-symlink-"))
    const external = await mkdtemp(join(tmpdir(), "astra-preflight-external-git-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    cleanup.push(() => rm(external, { recursive: true, force: true }))
    await writeFile(join(external, "config"), "before\n")
    await symlink(external, join(root, ".git"))

    const first = await scanWorkspace(root)
    await writeFile(join(external, "config"), "after and deliberately different\n")
    const second = await scanWorkspace(root)

    expect(first.surfaces).toContainEqual({ kind: "git_metadata", path: ".git", entryKind: "symlink" })
    expect(first.securityDigest).toBe(second.securityDigest)
    expect(first.scannedBytes).toBe(0)
    expect(checkWorkspaceActivation(first)).toEqual({
      allowed: false,
      reason: "git_baseline_not_inspected",
    })
  })

  test("blocks a symbolic-link workspace root without following it", async () => {
    const target = await mkdtemp(join(tmpdir(), "astra-preflight-target-"))
    const parent = await mkdtemp(join(tmpdir(), "astra-preflight-link-"))
    const link = join(parent, "workspace")
    cleanup.push(() => rm(target, { recursive: true, force: true }))
    cleanup.push(() => rm(parent, { recursive: true, force: true }))
    await symlink(target, link)

    expect(await scanWorkspace(link)).toMatchObject({
      identity: null,
      securityDigest: null,
      completeness: "incomplete",
      state: "preflight_blocked",
      blockers: ["workspace_root_is_link"],
    })
  })

  test("fails closed when the bounded root inventory is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-limit-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await Promise.all(Array.from({ length: 4 }, (_, index) => writeFile(join(root, `file-${index}`), "x")))

    expect(await scanWorkspace(root, { maxEntries: 3 })).toMatchObject({
      completeness: "incomplete",
      state: "preflight_blocked",
      blockers: ["entry_limit_exceeded"],
      scannedEntries: 3,
    })
  })

  test("fails closed on invalid resource limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-invalid-limit-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))

    expect(await scanWorkspace(root, { maxEntries: 0 })).toMatchObject({
      completeness: "incomplete",
      state: "preflight_blocked",
      blockers: ["invalid_limits"],
    })
  })

  test("binds activate-once eligibility to the exact identity and security digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-revalidate-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, "package.json"), "{}\n")
    const report = await scanWorkspace(root)

    expect(await revalidateWorkspaceSnapshot(report)).toMatchObject({ matched: true })
    await writeFile(join(root, "AGENTS.md"), "changed\n")
    expect(await revalidateWorkspaceSnapshot(report)).toMatchObject({
      matched: false,
      reason: "security_digest_changed",
    })
  })

  test("does not let larger static limits override the missing Git baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-git-override-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, ".git"))

    const report = await scanWorkspace(root, {
      maxEntries: 1_024,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxDurationMs: 10_000,
    })

    expect(report.completeness).toBe("complete")
    expect(checkWorkspaceActivation(report)).toEqual({
      allowed: false,
      reason: "git_baseline_not_inspected",
    })
    expect(await revalidateWorkspaceSnapshot(report)).toMatchObject({
      matched: false,
      reason: "git_baseline_not_inspected",
    })
  })

  test("fails closed when a digested file exceeds the byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-preflight-bytes-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, "empty"))
    await writeFile(join(root, "package.json"), "x".repeat(32))

    expect(await scanWorkspace(root, { maxFileBytes: 16 })).toMatchObject({
      completeness: "incomplete",
      state: "preflight_blocked",
      blockers: ["file_byte_limit_exceeded:package.json"],
    })
  })
})
