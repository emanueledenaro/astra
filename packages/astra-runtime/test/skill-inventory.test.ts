import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  defaultSkillInventoryLimits,
  inspectWorkspaceSkills,
  readExactWorkspaceSkill,
} from "../src/skill-inventory"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-skill-inventory-"))
  roots.push(root)
  return root
}

async function skill(root: string, relative: string, name = "safe-skill") {
  const path = join(root, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    [`---`, `name: ${name}`, `description: Explicitly approved test instructions.`, `---`, ``, `# Safe skill`, ``, `Do not execute anything automatically.`, ``].join("\n"),
  )
  return path
}

describe("bounded skill inventory", () => {
  test("reads only workspace-local OpenCode SKILL.md files", async () => {
    const root = await fixture()
    await skill(root, ".opencode/skills/safe-skill/SKILL.md")
    await writeFile(join(root, ".opencode/skills/safe-skill/script.ts"), "throw new Error('must not be loaded')\n")
    await skill(root, ".agents/skills/ignored/SKILL.md", "ignored-agent")
    await skill(root, ".claude/skills/ignored/SKILL.md", "ignored-claude")
    await skill(root, ".opencode/plugins/ignored/SKILL.md", "ignored-plugin")

    const result = await inspectWorkspaceSkills(root)

    expect(result.status).toBe("complete")
    if (result.status !== "complete") return
    expect(result.verification).toBe("not_verified")
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      name: "safe-skill",
      relativePath: ".opencode/skills/safe-skill/SKILL.md",
      description: "Explicitly approved test instructions.",
      descriptionTrust: "untrusted_workspace_metadata",
    })
    expect(JSON.stringify(result)).not.toContain("Do not execute anything automatically")
    expect(JSON.stringify(result)).not.toContain("script.ts")

    const loaded = await readExactWorkspaceSkill(root, result.candidates[0]!)
    expect(loaded).toMatchObject({ trust: "untrusted_instruction_data" })
    expect(loaded?.instructions).toContain("Do not execute anything automatically")
  })

  test("never follows a symlinked skill file or skill root", async () => {
    const root = await fixture()
    const outside = await fixture()
    const target = await skill(outside, "target/SKILL.md", "outside")
    await mkdir(join(root, ".opencode/skills/link"), { recursive: true })
    await symlink(target, join(root, ".opencode/skills/link/SKILL.md"))

    expect(await inspectWorkspaceSkills(root)).toMatchObject({
      status: "blocked",
      reason: "skill_root_symlink",
      verification: "not_verified",
    })

    const rootWithLinkedDirectory = await fixture()
    await mkdir(join(rootWithLinkedDirectory, ".opencode"), { recursive: true })
    await symlink(join(outside, "target"), join(rootWithLinkedDirectory, ".opencode/skills"))
    expect(await inspectWorkspaceSkills(rootWithLinkedDirectory)).toMatchObject({
      status: "blocked",
      reason: "skill_root_symlink",
    })
  })

  test("fails closed on inventory and byte limits", async () => {
    const root = await fixture()
    await skill(root, ".opencode/skill/one/SKILL.md", "one")
    await skill(root, ".opencode/skill/two/SKILL.md", "two")

    expect(await inspectWorkspaceSkills(root, { maxCandidates: 1 })).toMatchObject({
      status: "blocked",
      reason: "candidate_limit_exceeded",
    })
    expect(await inspectWorkspaceSkills(root, { maxFileBytes: 16 })).toMatchObject({
      status: "blocked",
      reason: "file_limit_exceeded",
    })
    expect(await inspectWorkspaceSkills(root, { maxEntries: 1 })).toMatchObject({
      status: "blocked",
      reason: "entry_limit_exceeded",
    })
    expect(await inspectWorkspaceSkills(root, { maxDurationMs: 0 })).toMatchObject({
      status: "blocked",
      reason: "invalid_limits",
    })
  })

  test("rejects drift after inventory without returning stale instructions", async () => {
    const root = await fixture()
    const path = await skill(root, ".opencode/skills/safe-skill/SKILL.md")
    const inventory = await inspectWorkspaceSkills(root)
    if (inventory.status !== "complete") throw new Error(inventory.reason)
    const candidate = inventory.candidates[0]!

    await writeFile(path, `${await Bun.file(path).text()}\nChanged after preview.\n`)

    expect(await readExactWorkspaceSkill(root, candidate, defaultSkillInventoryLimits)).toBeNull()
  })

  test("keeps the inventory module free of process, network, and write imports", async () => {
    const source = await Bun.file(new URL("../src/skill-inventory.ts", import.meta.url)).text()
    expect(source).not.toContain('from "node:child_process"')
    expect(source).not.toContain('from "node:http"')
    expect(source).not.toContain('from "node:https"')
    expect(source).not.toContain("fetch(")
    expect(source).not.toContain("Bun.spawn")
    expect(source).not.toContain("writeFile(")
  })
})
