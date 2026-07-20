import { describe, expect, test } from "bun:test"
import { parseWorkspaceBaseline } from "../src/operation-contract"
import {
  makeProjectCreationPreview,
  makeProjectCreationWorkspaceBaseline,
  parseProjectCreationDecision,
  parseProjectCreationDraft,
  parseProjectCreationPreview,
  projectCreationBoundaryLabel,
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

  test.each(["line\nbreak.ts", "carriage\rreturn.ts", "tab\tname.ts", "c1\u0085name.ts"])(
    "rejects control-bearing file path %j while preserving controls in content",
    (path) => {
      expect(parseProjectCreationDraft({ ...validDraft(), files: [{ path, content: "line\n\tcontent\r\n" }] })).toEqual({
        ok: false,
        reason: "file_path_invalid",
      })
    },
  )

  test.each(["alpha\nbeta", "alpha\rbeta", "alpha\tbeta", "alpha\u0085beta"])(
    "rejects control-bearing target name %j",
    (name) => {
      expect(parseProjectCreationDraft({ ...validDraft(), name })).toEqual({ ok: false, reason: "name_invalid" })
    },
  )

  test("rejects a control-bearing parent path", () => {
    expect(parseProjectCreationDraft({ ...validDraft(), parentPath: "/private/tmp/projects\nother" })).toEqual({
      ok: false,
      reason: "parent_path_not_canonical",
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
      workspaceIdentity: authority.parentIdentity,
      repository: { kind: "non_git" },
    })
    expect(baseline.locationID).toMatch(/^project-parent-authority:[0-9a-f]{64}$/)
    expect(parseWorkspaceBaseline(baseline).ok).toBe(true)
    expect(JSON.stringify(baseline)).not.toContain("targetIdentity")
    expect(JSON.stringify(baseline)).not.toContain("childIdentity")
  })

  test("projects long space-bearing canonical parents through a fixed-size parser-safe location ID", () => {
    const longParentPath = `/private/tmp/${Array.from({ length: 70 }, (_, index) => `long segment ${index}`).join("/")}`
    const draft = { ...validDraft(), parentPath: longParentPath }
    const authority = validAuthority({
      parentPath: longParentPath,
      targetPath: `${longParentPath}/alpha`,
    })
    const baseline = makeProjectCreationWorkspaceBaseline(authority, draft)

    expect(baseline.locationID).toMatch(/^project-parent-authority:[0-9a-f]{64}$/)
    expect(baseline.locationID.length).toBeLessThanOrEqual(1_024)
    expect(baseline.locationID.trim()).toBe(baseline.locationID)
    expect(parseWorkspaceBaseline(baseline).ok).toBe(true)
  })

  test("binds every draft and authority field into every ledger digest", () => {
    const authority = validAuthority()
    const draft = validDraft()
    const original = makeProjectCreationWorkspaceBaseline(authority, draft)
    const originalDigests = baselineDigests(original)
    const changes: ReadonlyArray<Readonly<{ draft: ProjectCreationDraft; authority: ProjectParentAuthority }>> = [
      { draft: { ...draft, objective: "A changed objective" }, authority },
      { draft: { ...draft, stack: "javascript" }, authority },
      {
        draft: {
          ...draft,
          files: draft.files.map((file, index) => (index === 0 ? { ...file, path: "GUIDE.md" } : file)),
        },
        authority,
      },
      {
        draft: {
          ...draft,
          files: draft.files.map((file, index) => (index === 0 ? { ...file, content: "# Changed Alpha\n" } : file)),
        },
        authority,
      },
      { draft: { ...draft, files: [...draft.files].reverse() }, authority },
      { draft: { ...draft, initializeGit: false }, authority },
      {
        draft: { ...draft, name: "beta" },
        authority: validAuthority({ targetName: "beta", targetPath: `${parentPath}/beta` }),
      },
      {
        draft: { ...draft, parentPath: "/private/tmp/astra moved projects" },
        authority: validAuthority({
          parentPath: "/private/tmp/astra moved projects",
          targetPath: "/private/tmp/astra moved projects/alpha",
        }),
      },
      {
        draft: { ...draft, name: "gamma" },
        authority: validAuthority({ targetName: "gamma", targetPath: `${parentPath}/gamma` }),
      },
      { draft, authority: validAuthority({ parentIdentity: { device: "43", inode: "9001" } }) },
      { draft, authority: validAuthority({ parentIdentity: { device: "42", inode: "9002" } }) },
      { draft, authority: validAuthority({ observedAt: "2026-07-20T10:15:31.000Z" }) },
    ]

    for (const change of changes) {
      expect(
        allDigestsChanged(
          originalDigests,
          baselineDigests(makeProjectCreationWorkspaceBaseline(change.authority, change.draft)),
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

describe("project scaffold consent contract", () => {
  test("binds the exact bounded scaffold and host boundary into a frozen preview", () => {
    const preview = makeProjectCreationPreview(
      validAuthority(),
      validDraft(),
      "2026-07-20T10:16:00.000Z",
      "0123456789abcdef0123456789abcdef",
      "2026-07-20T10:21:00.000Z",
    )

    expect(preview).toMatchObject({
      schemaVersion: 1,
      boundary: projectCreationBoundaryLabel,
      parentPath,
      parentIdentity: { device: "42", inode: "9001" },
      targetPath: `${parentPath}/alpha`,
      targetName: "alpha",
      authorityDigest: validAuthority().observationDigest,
      stack: "typescript",
      initializeGitRequested: true,
      totalBytes: 18,
    })
    expect(preview.files.map((file) => ({ path: file.path, bytes: file.bytes }))).toEqual([
      { path: "README.md", bytes: 8 },
      { path: "src/index.ts", bytes: 10 },
    ])
    expect(preview.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.contentDigest))).toBe(true)
    expect(preview.objectiveDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(preview.proposalDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(parseProjectCreationPreview(preview)).toEqual({ ok: true, value: preview })
    expect(Object.isFrozen(preview)).toBe(true)
    expect(Object.isFrozen(preview.files)).toBe(true)
    expect(preview.files.every(Object.isFrozen)).toBe(true)
  })

  test("rejects a changed preview and changes consent when any draft resource changes", () => {
    const original = makeProjectCreationPreview(
      validAuthority(),
      validDraft(),
      "2026-07-20T10:16:00.000Z",
      "0123456789abcdef0123456789abcdef",
      "2026-07-20T10:21:00.000Z",
    )
    expect(parseProjectCreationPreview({ ...original, targetPath: `${parentPath}/other` })).toEqual({
      ok: false,
      reason: "preview_binding_mismatch",
    })
    expect(parseProjectCreationPreview({ ...original, totalBytes: original.totalBytes + 1 })).toEqual({
      ok: false,
      reason: "preview_binding_mismatch",
    })

    const changed = makeProjectCreationPreview(
      validAuthority(),
      {
        ...validDraft(),
        files: [
          { path: "README.md", content: "# Changed\n" },
          { path: "src/index.ts", content: "export {}\n" },
        ],
      },
      original.createdAt,
      original.nonce,
      original.expiresAt,
    )
    expect(changed.proposalDigest).not.toBe(original.proposalDigest)
    expect(changed.files[0]?.contentDigest).not.toBe(original.files[0]?.contentDigest)
  })

  test("accepts only an exact explicit approval or rejection bound to the preview", () => {
    const preview = makeProjectCreationPreview(
      validAuthority(),
      validDraft(),
      "2026-07-20T10:16:00.000Z",
      "0123456789abcdef0123456789abcdef",
      "2026-07-20T10:21:00.000Z",
    )
    const approved = {
      proposalDigest: preview.proposalDigest,
      nonce: preview.nonce,
      decision: "approved",
      decidedAt: "2026-07-20T10:17:00.000Z",
    } as const

    expect(parseProjectCreationDecision(approved)).toEqual({ ok: true, value: approved })
    expect(parseProjectCreationDecision({ ...approved, decision: "automatic" })).toEqual({
      ok: false,
      reason: "decision_invalid",
    })
    expect(parseProjectCreationDecision({ ...approved, proposalDigest: `sha256:${"0".repeat(64)}` })).toEqual({
      ok: true,
      value: { ...approved, proposalDigest: `sha256:${"0".repeat(64)}` },
    })
    expect(parseProjectCreationDecision({ ...approved, remote: true })).toEqual({
      ok: false,
      reason: "unsupported_decision_field",
    })
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
  changes: Partial<
    Pick<ProjectParentAuthority, "observedAt" | "parentIdentity" | "parentPath" | "targetName" | "targetPath">
  > = {},
): ProjectParentAuthority {
  const authorityParentPath = changes.parentPath ?? parentPath
  const targetName = changes.targetName ?? "alpha"
  const sealed = sealProjectParentAuthority({
    schemaVersion: 1,
    parentPath: authorityParentPath,
    parentIdentity: changes.parentIdentity ?? { device: "42", inode: "9001" },
    targetPath: changes.targetPath ?? `${authorityParentPath}/${targetName}`,
    targetName,
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
