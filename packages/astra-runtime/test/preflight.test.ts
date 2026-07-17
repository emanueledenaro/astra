import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { revalidateWorkspaceSnapshot, scanWorkspace } from "../src/workspace-preflight"
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
      expect(after).toBe(before)
      expect(await sentinelNames(fixture.sentinel)).toEqual([])
      expect(requests).toBe(0)
    } finally {
      await server.stop(true)
    }
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
