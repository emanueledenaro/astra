import { afterAll, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeProjectCreationPreview,
  projectCreationLimits,
  sealProjectParentAuthority,
  type ProjectCreationDraft,
} from "@astra/domain/project-creation-control"
import { executeProjectScaffold } from "../src/project-scaffold"
import { executeProjectScaffoldInternal } from "../src/project-scaffold-internal"

const cleanup: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.all(cleanup.map((remove) => remove()))
})

describe("dedicated project scaffold adapter", () => {
  test("does not touch the parent when durable authority is unavailable", async () => {
    const fixture = await makeFixture("astra-scaffold-reject-")
    const before = await readdir(fixture.parent)

    const result = await executeProjectScaffold(fixture.input, async () => "unavailable")

    expect(result.status).toBe("failed_without_effect")
    expect(await readdir(fixture.parent)).toEqual(before)
  })

  test("creates exact non-executable text files only after accepting the durable claim", async () => {
    const fixture = await makeFixture("astra-scaffold-success-")
    let claimedBeforeEffect = false

    const result = await executeProjectScaffold(fixture.input, async (claim) => {
      expect(claim).toEqual({
        proposalDigest: fixture.input.preview.proposalDigest,
        authorityDigest: fixture.input.authority.observationDigest,
        targetPath: fixture.input.authority.targetPath,
      })
      claimedBeforeEffect = (await readdir(fixture.parent)).length === 0
      return "claimed"
    })

    expect(claimedBeforeEffect).toBe(true)
    expect(result.status).toBe("effect_observed")
    expect(await readFile(join(fixture.target, "README.md"), "utf8")).toBe("# Alpha\n")
    expect(await readFile(join(fixture.target, "src/index.ts"), "utf8")).toBe("export {}\n")
    expect((await lstat(join(fixture.target, "README.md"))).mode & 0o111).toBe(0)
    expect((await readdir(fixture.parent)).filter((name) => name.startsWith(".astra-scaffold-"))).toEqual([])
  })

  test("preserves a target that appears immediately before exclusive publication", async () => {
    const fixture = await makeFixture("astra-scaffold-race-")
    const result = await executeProjectScaffoldInternal(fixture.input, async () => "claimed", {
      beforePublish: async () => {
        await mkdir(fixture.target)
        await writeFile(join(fixture.target, "owner.txt"), "preserve\n")
      },
    })

    expect(result.status).toBe("failed_without_effect")
    expect(await readFile(join(fixture.target, "owner.txt"), "utf8")).toBe("preserve\n")
    expect((await readdir(fixture.parent)).filter((name) => name.startsWith(".astra-scaffold-"))).toEqual([])
  })

  test("reports uncertainty when private staging cleanup cannot be proved", async () => {
    const fixture = await makeFixture("astra-scaffold-cleanup-unknown-")
    const result = await executeProjectScaffoldInternal(fixture.input, async () => "claimed", {
      beforePublish: async () => {
        await mkdir(fixture.target)
      },
      cleanupStaging: async () => {
        throw new Error("simulated cleanup failure")
      },
    })

    expect(result.status).toBe("effect_unknown")
    expect((await readdir(fixture.parent)).some((name) => name.startsWith(".astra-scaffold-"))).toBe(true)
  })

  test("rejects changed file content before accepting durable authority", async () => {
    const fixture = await makeFixture("astra-scaffold-changed-")
    let enteredClaim = false

    await expect(
      executeProjectScaffold(
        {
          ...fixture.input,
          draft: {
            ...fixture.input.draft,
            files: fixture.input.draft.files.map((file, index) =>
              index === 0 ? { ...file, content: "changed\n" } : file,
            ),
          },
        },
        async () => {
          enteredClaim = true
          return "claimed"
        },
      ),
    ).rejects.toThrow("does not match")
    expect(enteredClaim).toBe(false)
    expect(await readdir(fixture.parent)).toEqual([])
  })
})

async function makeFixture(prefix: string) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(() => rm(parent, { recursive: true, force: true }))
  const facts = await lstat(parent)
  const draft: ProjectCreationDraft = {
    name: "alpha",
    parentPath: parent,
    objective: "Create a bounded TypeScript project.",
    stack: "typescript",
    files: [
      { path: "README.md", content: "# Alpha\n" },
      { path: "src/index.ts", content: "export {}\n" },
    ],
    initializeGit: false,
  }
  const authority = sealProjectParentAuthority({
    schemaVersion: 1,
    parentPath: parent,
    parentIdentity: { device: String(facts.dev), inode: String(facts.ino) },
    targetPath: join(parent, draft.name),
    targetName: draft.name,
    targetState: "absent",
    observedAt: "2026-07-20T10:15:30.000Z",
    limits: projectCreationLimits,
  })
  if (!authority.ok) throw new Error(authority.reason)
  const preview = makeProjectCreationPreview(
    authority.value,
    draft,
    "2026-07-20T10:16:00.000Z",
    "0123456789abcdef0123456789abcdef",
    "2026-07-20T10:21:00.000Z",
  )
  return {
    parent,
    target: join(parent, draft.name),
    input: { authority: authority.value, draft, preview },
  }
}
