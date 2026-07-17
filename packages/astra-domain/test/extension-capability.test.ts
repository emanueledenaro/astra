import { describe, expect, test } from "bun:test"
import {
  computeSkillActivationCapabilityDigest,
  isWorkspaceOpenCodeSkillPath,
  parseSkillActivationCapability,
  type SkillActivationCapabilityManifest,
} from "../src/extension-capability"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseOperationID,
} from "../src/operation-contract"

const digest = (value: string) => {
  const parsed = parseContentDigest(`sha256:${value.repeat(64).slice(0, 64)}`)
  if (!parsed.ok) throw new Error("Invalid test digest")
  return parsed.value
}

function manifest(): SkillActivationCapabilityManifest {
  return {
    schemaVersion: 1,
    kind: "skill_instruction_activation",
    grant: {
      capabilityGrantID: capabilityGrantID("00000000-0000-8000-8000-000000000002"),
      operationID: operationID("00000000-0000-8000-8000-000000000001"),
      attemptID: attemptID("00000000-0000-8000-8000-000000000003"),
      baselineDigest: digest("a"),
      expiresAt: "2026-07-17T15:05:00.000Z",
    },
    session: {
      sessionID: "00000000-0000-4000-8000-000000000004",
      lifetime: "astra_session",
    },
    workspace: {
      canonicalPath: "/Users/example/project",
      device: "1",
      inode: "2",
      securityDigest: digest("b"),
    },
    skill: {
      source: "workspace_opencode",
      name: "safe-skill",
      relativePath: ".opencode/skills/safe-skill/SKILL.md",
      fileIdentity: { device: "1", inode: "3" },
      fileDigest: digest("c"),
      fileBytes: 512,
      instructionsDigest: digest("d"),
      instructionsBytes: 256,
      descriptionDigest: digest("e"),
    },
    exposure: {
      systemPrompt: "fixed_safe_description",
      toolResult: "approved_content_only",
      resourceDiscovery: "none",
      trust: "untrusted_instruction_data",
    },
    authority: {
      workspaceRead: ".opencode/skills/safe-skill/SKILL.md",
      workspaceWrite: "none",
      runtimeWrite: "private_session_skill_bundle",
      process: "none",
      shell: "none",
      network: "none",
      plugins: "none",
      mcp: "none",
    },
    limits: {
      maxCandidates: 32,
      maxEntries: 256,
      maxFileBytes: 65_536,
      maxTotalBytes: 262_144,
      maxDurationMs: 1_000,
    },
  }
}

describe("skill activation capability", () => {
  test("strictly parses and freezes a session-only data capability", () => {
    const input = manifest()
    const parsed = parseSkillActivationCapability({
      manifest: input,
      capabilityDigest: computeSkillActivationCapabilityDigest(input),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.manifest.authority).toEqual({
      workspaceRead: ".opencode/skills/safe-skill/SKILL.md",
      workspaceWrite: "none",
      runtimeWrite: "private_session_skill_bundle",
      process: "none",
      shell: "none",
      network: "none",
      plugins: "none",
      mcp: "none",
    })
    expect(parsed.value.manifest.exposure.trust).toBe("untrusted_instruction_data")
    expect(Object.isFrozen(parsed.value.manifest.skill.fileIdentity)).toBe(true)
    expect(Object.isFrozen(parsed.value.manifest)).toBe(true)
  })

  test("rejects authority expansion, extra fields, and stale digests", () => {
    const original = manifest()
    const capabilityDigest = computeSkillActivationCapabilityDigest(original)
    const expanded = structuredClone(original)
    ;(expanded.authority as { network: string }).network = "host_unrestricted"
    expect(parseSkillActivationCapability({ manifest: expanded, capabilityDigest })).toEqual({
      ok: false,
      reason: "invalid_capability",
    })

    const extra = { ...original, unexpected: true }
    expect(
      parseSkillActivationCapability({ manifest: extra, capabilityDigest: computeSkillActivationCapabilityDigest(original) }),
    ).toEqual({ ok: false, reason: "invalid_capability" })

    const changed = structuredClone(original)
    ;(changed.skill as { fileBytes: number }).fileBytes += 1
    expect(parseSkillActivationCapability({ manifest: changed, capabilityDigest })).toEqual({
      ok: false,
      reason: "invalid_capability",
    })
  })

  test("accepts only workspace-local OpenCode SKILL.md paths", () => {
    expect(isWorkspaceOpenCodeSkillPath(".opencode/skill/one/SKILL.md")).toBe(true)
    expect(isWorkspaceOpenCodeSkillPath(".opencode/skills/group/one/SKILL.md")).toBe(true)
    for (const path of [
      ".agents/skills/one/SKILL.md",
      ".claude/skills/one/SKILL.md",
      ".opencode/skills/../secret/SKILL.md",
      ".opencode/skills/one/script.ts",
      "/tmp/SKILL.md",
      ".opencode\\skills\\one\\SKILL.md",
    ]) {
      expect(isWorkspaceOpenCodeSkillPath(path)).toBe(false)
    }
  })

  test("rejects accessor-backed capability data without invoking it", () => {
    let reads = 0
    const hostile = Object.defineProperty({}, "manifest", {
      enumerable: true,
      get() {
        reads += 1
        return manifest()
      },
    })
    Object.defineProperty(hostile, "capabilityDigest", {
      enumerable: true,
      value: digest,
    })

    expect(parseSkillActivationCapability(hostile)).toEqual({ ok: false, reason: "invalid_capability" })
    expect(reads).toBe(0)
  })
})

function operationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new Error("Invalid test Operation ID")
  return parsed.value
}

function attemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new Error("Invalid test attempt ID")
  return parsed.value
}

function capabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new Error("Invalid test capability grant ID")
  return parsed.value
}
