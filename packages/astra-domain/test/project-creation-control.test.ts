import { describe, expect, test } from "bun:test"
import { parseWorkspaceBaseline } from "../src/operation-contract"
import {
  makeProjectCreationWorkspaceBaseline,
  parseProjectCreationDraft,
  projectCreationLimits,
  sealProjectParentAuthority,
  type ProjectCreationDraft,
  type ProjectParentAuthority,
} from "../src/project-creation-control"

const parentPath = "/private/tmp/astra-projects"
const observedAt = "2026-07-20T10:15:30.000Z"

describe("project creation draft", () => {
  test("accepts and freezes one bounded ordered text-file proposal", () => {
    const parsed = parseProjectCreationDraft(validDraft())

    expect(parsed).toEqual({ ok: true, value: validDraft() })
    if (!parsed.ok) throw new Error("Expected a valid draft")
    expect(Object.isFrozen(parsed.value)).toBe(true)
    expect(Object.isFrozen(parsed.value.files)).toBe(true)
    expect(parsed.value.files.every(Object.isFrozen)).toBe(true)
  })

  test("rejects a relative parent", () => {
    expect(parseProjectCreationDraft({ ...validDraft(), parentPath: "projects" })).toEqual({
      ok: false,
      reason: "parent_path_not_absolute",
    })
  })

  test.each([
    ["traversal", "../outside.ts", "file_path_traversal"],
    ["absolute", "/tmp/outside.ts", "file_path_not_relative"],
    ["deep", "one/two/three/four/five/six/seven/eight/nine.ts", "file_path_too_deep"],
  ] as const)("rejects a %s proposed file path", (_label, path, reason) => {
    expect(parseProjectCreationDraft({ ...validDraft(), files: [{ path, content: "safe\n" }] })).toEqual({
      ok: false,
      reason,
    })
  })

  test("rejects duplicate proposed file paths", () => {
    expect(
      parseProjectCreationDraft({
        ...validDraft(),
        files: [
          { path: "src/index.ts", content: "first\n" },
          { path: "src/index.ts", content: "second\n" },
        ],
      }),
    ).toEqual({ ok: false, reason: "duplicate_file_path" })
  })

  test("rejects symlink proposals and control-bearing text", () => {
    expect(
      parseProjectCreationDraft({
        ...validDraft(),
        files: [{ path: "src/link", content: "safe\n", symlink: "../outside" }],
      }),
    ).toEqual({ ok: false, reason: "unsupported_file_field" })
    expect(
      parseProjectCreationDraft({ ...validDraft(), files: [{ path: "src/index.ts", content: "safe\u0000binary" }] }),
    ).toEqual({ ok: false, reason: "file_content_not_text" })
  })

  test.each(["install", "remote", "push"])("rejects the unsupported %s field", (field) => {
    expect(parseProjectCreationDraft({ ...validDraft(), [field]: true })).toEqual({
      ok: false,
      reason: "unsupported_draft_field",
    })
  })

  test("rejects accessor-backed draft and file inputs without invoking accessors", () => {
    let accesses = 0
    const draft = validDraft() as ProjectCreationDraft & { remote?: boolean }
    Object.defineProperty(draft, "objective", {
      enumerable: true,
      get() {
        accesses += 1
        return "must not be read"
      },
    })
    expect(parseProjectCreationDraft(draft)).toEqual({ ok: false, reason: "accessor_not_allowed" })

    const file = { path: "src/index.ts" } as { path: string; content?: string }
    Object.defineProperty(file, "content", {
      enumerable: true,
      get() {
        accesses += 1
        return "must not be read"
      },
    })
    expect(parseProjectCreationDraft({ ...validDraft(), files: [file] })).toEqual({
      ok: false,
      reason: "accessor_not_allowed",
    })
    expect(accesses).toBe(0)
  })

  test("enforces every fixed byte, file-count, and path-depth limit", () => {
    expect(parseProjectCreationDraft({ ...validDraft(), name: "x".repeat(81) })).toEqual({
      ok: false,
      reason: "name_invalid",
    })
    expect(parseProjectCreationDraft({ ...validDraft(), objective: "x".repeat(4_097) })).toEqual({
      ok: false,
      reason: "objective_too_large",
    })
    expect(
      parseProjectCreationDraft({
        ...validDraft(),
        files: Array.from({ length: 33 }, (_, index) => ({ path: `file-${index}`, content: "" })),
      }),
    ).toEqual({ ok: false, reason: "too_many_files" })
    expect(
      parseProjectCreationDraft({
        ...validDraft(),
        files: [{ path: "large.txt", content: "x".repeat(64 * 1_024 + 1) }],
      }),
    ).toEqual({ ok: false, reason: "file_too_large" })
    expect(
      parseProjectCreationDraft({
        ...validDraft(),
        files: Array.from({ length: 5 }, (_, index) => ({
          path: `large-${index}.txt`,
          content: "x".repeat(64 * 1_024),
        })),
      }),
    ).toEqual({ ok: false, reason: "total_files_too_large" })
  })
})

describe("project-parent authority ledger envelope", () => {
  test("seals one frozen absent-child authority and projects the existing parent identity", () => {
    const authority = validAuthority()
    const baseline = makeProjectCreationWorkspaceBaseline(authority, validDraft())

    expect(authority).toMatchObject({
      schemaVersion: 1,
      parentPath,
      parentIdentity: { device: "42", inode: "9001" },
      targetPath: `${parentPath}/alpha`,
      targetName: "alpha",
      targetState: "absent",
      observedAt,
      limits: projectCreationLimits,
    })
    expect(authority.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.parentIdentity)).toBe(true)
    expect(Object.isFrozen(authority.limits)).toBe(true)

    expect(baseline).toMatchObject({
      kind: "workspace",
      locationID: `project-parent-authority:${parentPath}`,
      workspaceIdentity: authority.parentIdentity,
      repository: { kind: "non_git" },
    })
    expect(parseWorkspaceBaseline(baseline).ok).toBe(true)
    expect(JSON.stringify(baseline)).not.toContain("targetIdentity")
    expect(JSON.stringify(baseline)).not.toContain("childIdentity")
  })

  test("binds every draft and authority field into every ledger digest", () => {
    const authority = validAuthority()
    const draft = validDraft()
    const original = makeProjectCreationWorkspaceBaseline(authority, draft)
    const originalDigests = baselineDigests(original)
    const draftChanges: ReadonlyArray<ProjectCreationDraft> = [
      { ...draft, objective: "A changed objective" },
      { ...draft, stack: "javascript" },
      { ...draft, files: [{ path: "src/main.ts", content: "export {}\n" }] },
      { ...draft, files: [...draft.files].reverse() },
      { ...draft, initializeGit: false },
    ]
    const authorityChanges: ReadonlyArray<ProjectParentAuthority> = [
      validAuthority({ observedAt: "2026-07-20T10:15:31.000Z" }),
      validAuthority({ parentIdentity: { device: "42", inode: "9002" } }),
    ]

    for (const changedDraft of draftChanges) {
      expect(
        allDigestsChanged(
          originalDigests,
          baselineDigests(makeProjectCreationWorkspaceBaseline(authority, changedDraft)),
        ),
      ).toBe(true)
    }
    for (const changedAuthority of authorityChanges) {
      expect(
        allDigestsChanged(
          originalDigests,
          baselineDigests(makeProjectCreationWorkspaceBaseline(changedAuthority, draft)),
        ),
      ).toBe(true)
    }
  })

  test("rejects accessor-backed authority input without invoking it", () => {
    const authority = { ...validAuthority() }
    let accesses = 0
    Object.defineProperty(authority, "parentPath", {
      enumerable: true,
      get() {
        accesses += 1
        return parentPath
      },
    })

    expect(() => makeProjectCreationWorkspaceBaseline(authority, validDraft())).toThrow("accessor_not_allowed")
    expect(accesses).toBe(0)
  })
})

function validDraft(): ProjectCreationDraft {
  return {
    name: "alpha",
    parentPath,
    objective: "Create a small local TypeScript project.",
    stack: "typescript",
    files: [
      { path: "README.md", content: "# Alpha\n" },
      { path: "src/index.ts", content: "export {}\n" },
    ],
    initializeGit: true,
  }
}

function validAuthority(
  changes: Partial<Pick<ProjectParentAuthority, "observedAt" | "parentIdentity">> = {},
): ProjectParentAuthority {
  const sealed = sealProjectParentAuthority({
    schemaVersion: 1,
    parentPath,
    parentIdentity: changes.parentIdentity ?? { device: "42", inode: "9001" },
    targetPath: `${parentPath}/alpha`,
    targetName: "alpha",
    targetState: "absent",
    observedAt: changes.observedAt ?? observedAt,
    limits: projectCreationLimits,
  })
  if (!sealed.ok) throw new Error(`Expected a valid authority: ${sealed.reason}`)
  return sealed.value
}

function baselineDigests(baseline: ReturnType<typeof makeProjectCreationWorkspaceBaseline>) {
  return {
    trustDigest: baseline.trustDigest,
    markerDigest: baseline.repository.kind === "non_git" ? baseline.repository.markerDigest : null,
    policyDigest: baseline.policyDigest,
    adapterDigest: baseline.adapterDigest,
  }
}

function allDigestsChanged(
  original: ReturnType<typeof baselineDigests>,
  changed: ReturnType<typeof baselineDigests>,
) {
  return Object.keys(original).every((key) => {
    const digestKey = key as keyof typeof original
    return changed[digestKey] !== original[digestKey]
  })
}
