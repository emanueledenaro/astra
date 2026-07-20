import { afterAll, describe, expect, test } from "bun:test"
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeProjectCreationPreview,
  type ProjectCreationDecision,
  type ProjectCreationDraft,
} from "@astra/domain/project-creation-control"
import { captureProjectParentAuthority } from "../src/project-parent-authority"
import {
  executeDurableProjectScaffold,
  recoverDurableProjectScaffold,
  verifyDurableProjectScaffold,
  type DurableProjectScaffoldInput,
} from "../src/project-creation-coordinator"
import {
  createProjectScaffoldCoordinatorInternal,
  type ProjectScaffoldCoordinatorInternalOptions,
} from "../src/project-creation-coordinator-internal"
import { makeProjectScaffoldOperationFacts } from "../src/project-creation-operation-facts"
import { verifyProjectScaffoldTreeInternal } from "../src/project-creation-verifier-internal"

const cleanup: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.all(cleanup.map((remove) => remove()))
})

describe("durable project scaffold coordination", () => {
  test("keeps state paths, clocks, fault injection, and observers outside the public package API", async () => {
    const publicAPI = await import("../src/index")

    expect(executeDurableProjectScaffold.length).toBe(1)
    expect(recoverDurableProjectScaffold.length).toBe(1)
    expect(verifyDurableProjectScaffold.length).toBe(1)
    expect("createProjectScaffoldCoordinatorInternal" in publicAPI).toBe(false)
    expect("projectScaffoldFaultPoints" in publicAPI).toBe(false)
  })

  test("keeps rejection pure: no target, staging, ledger, spool, or host adapter", async () => {
    const fixture = await makeFixture("astra-project-reject-", "rejected")
    let hostEntries = 0

    const result = await fixture.coordinator({
      onHostAdapterEntered: () => {
        hostEntries += 1
      },
    }).execute(fixture.input)

    expect(result.status).toBe("denied_without_effect")
    expect(hostEntries).toBe(0)
    expect(await exists(fixture.target)).toBe(false)
    expect(await exists(fixture.ledger)).toBe(false)
    expect(await exists(fixture.spool)).toBe(false)
    expect(await readdir(fixture.parent)).toEqual([])
  })

  test("blocks a symlink state root before creating operation state or entering the adapter", async () => {
    const fixture = await makeFixture("astra-project-state-root-link-")
    const container = await realpath(await mkdtemp(join(tmpdir(), "astra-project-state-root-container-")))
    const stateLink = join(container, "state")
    cleanup.push(() => rm(container, { recursive: true, force: true }))
    await symlink(fixture.state, stateLink)
    let hostEntries = 0
    const coordinator = createProjectScaffoldCoordinatorInternal({
      stateRoot: stateLink,
      now: fixture.now,
      onHostAdapterEntered: () => {
        hostEntries += 1
      },
    })

    await expect(coordinator.execute(fixture.input)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(hostEntries).toBe(0)
    expect(await exists(fixture.target)).toBe(false)
    expect(await readdir(fixture.state)).toEqual([])
  })

  test("blocks a replaced parent before durable admission or adapter entry", async () => {
    const fixture = await makeFixture("astra-project-stale-parent-")
    const original = `${fixture.parent}-original`
    cleanup.push(() => rm(original, { recursive: true, force: true }))
    await rename(fixture.parent, original)
    await mkdir(fixture.parent)
    let hostEntries = 0

    await expect(
      fixture.coordinator({
        onHostAdapterEntered: () => {
          hostEntries += 1
        },
      }).execute(fixture.input),
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(hostEntries).toBe(0)
    expect(await exists(fixture.ledger)).toBe(false)
    expect(await exists(fixture.spool)).toBe(false)
    expect(await readdir(fixture.parent)).toEqual([])
  })

  test("preserves a target that appears after preview and creates no durable state", async () => {
    const fixture = await makeFixture("astra-project-existing-target-")
    await writeFile(fixture.target, "preserve\n")

    await expect(fixture.coordinator().execute(fixture.input)).rejects.toMatchObject({
      code: "invalid_input",
    })
    expect(await readFile(fixture.target, "utf8")).toBe("preserve\n")
    expect(await exists(fixture.ledger)).toBe(false)
    expect(await exists(fixture.spool)).toBe(false)
  })

  test.each(["draft", "preview-capability", "authority"] as const)(
    "rejects a changed %s binding before admission",
    async (kind) => {
      const fixture = await makeFixture(`astra-project-changed-${kind}-`)
      const changed =
        kind === "draft"
          ? {
              ...fixture.input,
              draft: {
                ...fixture.input.draft,
                files: fixture.input.draft.files.map((file, index) =>
                  index === 0 ? { ...file, content: "changed\n" } : file,
                ),
              },
            }
          : kind === "preview-capability"
            ? {
                ...fixture.input,
                preview: { ...fixture.input.preview, proposalDigest: `sha256:${"0".repeat(64)}` },
                decision: { ...fixture.input.decision, proposalDigest: `sha256:${"0".repeat(64)}` },
              }
            : {
                ...fixture.input,
                authority: { ...fixture.input.authority, observationDigest: `sha256:${"0".repeat(64)}` },
              }
      let hostEntries = 0

      await expect(
        fixture.coordinator({
          onHostAdapterEntered: () => {
            hostEntries += 1
          },
        }).execute(changed as DurableProjectScaffoldInput),
      ).rejects.toMatchObject({ code: "invalid_input" })
      expect(hostEntries).toBe(0)
      expect(await exists(fixture.ledger)).toBe(false)
      expect(await exists(fixture.spool)).toBe(false)
      expect(await readdir(fixture.parent)).toEqual([])
    },
  )

  test("records observation first and only independent exact-tree proof succeeds", async () => {
    const fixture = await makeFixture("astra-project-success-")
    const coordinator = fixture.coordinator()
    const observed = await coordinator.execute(fixture.input)

    expect(observed.status).toBe("effect_observed")
    expect(observed.state).toBe("effect_observed")
    expect(await readFile(join(fixture.target, "README.md"), "utf8")).toBe("# Alpha\n")

    const verified = await coordinator.verify(fixture.input)
    expect(verified.status).toBe("verified")
    expect(verified.state).toBe("succeeded")
    expect(verified.evidence?.criteria).toEqual([
      expect.objectContaining({ criterionID: "exact_project_tree", result: "passed" }),
    ])
  })

  test("receipt-spool recovery never invokes the scaffold adapter twice", async () => {
    const fixture = await makeFixture("astra-project-spool-recovery-")
    let entries = 0

    await expect(
      fixture.coordinator({
        onHostAdapterEntered: () => {
          entries += 1
        },
        injectFault: async (point) => {
          if (point === "after_spool_before_ledger") throw new Error("simulated spool handoff interruption")
        },
      }).execute(fixture.input),
    ).rejects.toMatchObject({ code: "state_unavailable" })

    const recovered = await fixture.coordinator({
      onHostAdapterEntered: () => {
        entries += 1
      },
    }).execute(fixture.input)
    expect(recovered.status).toBe("effect_observed")
    expect(entries).toBe(1)
    expect(await readFile(join(fixture.target, "README.md"), "utf8")).toBe("# Alpha\n")
  })

  test("missing post-effect receipt becomes reconciliation required after the claim expires", async () => {
    const fixture = await makeFixture("astra-project-uncertain-")
    let now = fixture.now()

    await expect(
      fixture.coordinator({
        injectFault: async (point) => {
          if (point === "after_adapter_before_spool") throw new Error("simulated receipt loss")
        },
        now: () => now,
      }).execute(fixture.input),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    now += 61_000

    const recovered = await fixture.coordinator({ now: () => now }).recover(fixture.input)
    expect(recovered.status).toBe("reconciliation_required")
    expect(recovered.state).toBe("reconciliation_required")
    expect(await readFile(join(fixture.target, "README.md"), "utf8")).toBe("# Alpha\n")
  })

  test("extra final entries cannot verify", async () => {
    const fixture = await makeFixture("astra-project-extra-entry-")
    const coordinator = fixture.coordinator()
    await coordinator.execute(fixture.input)
    await writeFile(join(fixture.target, "extra.txt"), "extra\n")

    const verified = await coordinator.verify(fixture.input)
    expect(verified.status).not.toBe("verified")
    expect(verified.state).not.toBe("succeeded")
  })

  test.each([
    ["missing", async (target: string) => rm(join(target, "README.md"))],
    ["changed", async (target: string) => writeFile(join(target, "README.md"), "changed\n")],
    [
      "symlink",
      async (target: string) => {
        await rm(join(target, "README.md"))
        await symlink("src/index.ts", join(target, "README.md"))
      },
    ],
    [
      "non-regular",
      async (target: string) => {
        await rm(join(target, "README.md"))
        await mkdir(join(target, "README.md"))
      },
    ],
    ["executable", async (target: string) => chmod(join(target, "README.md"), 0o700)],
  ] as const)("does not verify a %s final entry", async (label, mutate) => {
    const fixture = await makeFixture(`astra-project-${label}-`)
    const coordinator = fixture.coordinator()
    await coordinator.execute(fixture.input)
    await mutate(fixture.target)

    const verified = await coordinator.verify(fixture.input)
    expect(verified.status).not.toBe("verified")
    expect(verified.state).not.toBe("succeeded")
  })

  test("two concurrent calls enter the host adapter at most once", async () => {
    const fixture = await makeFixture("astra-project-concurrent-")
    let entries = 0
    const coordinator = fixture.coordinator({
      onHostAdapterEntered: () => {
        entries += 1
      },
    })
    const results = await Promise.allSettled([
      coordinator.execute(fixture.input),
      coordinator.execute(fixture.input),
    ])

    expect(results.some((result) => result.status === "fulfilled" && result.value.status === "effect_observed")).toBe(true)
    expect(entries).toBe(1)
    expect(await readFile(join(fixture.target, "README.md"), "utf8")).toBe("# Alpha\n")
    expect((await readdir(fixture.parent)).filter((name) => name.startsWith(".astra-scaffold-"))).toEqual([])
  })

  test("writes hostile project configuration as inert text without running repository hooks", async () => {
    const fixture = await makeFixture("astra-project-inert-config-")
    const marker = join(fixture.parent, "hook-ran")
    const draft = {
      ...fixture.input.draft,
      files: [
        ...fixture.input.draft.files,
        { path: ".env", content: "ASTRA_MUST_NOT_LOAD=1\n" },
        {
          path: "package.json",
          content: JSON.stringify({ scripts: { postinstall: `touch ${marker}` } }),
        },
        { path: "opencode.json", content: JSON.stringify({ plugin: ["malicious-local-plugin"] }) },
      ],
    }
    const preview = makeProjectCreationPreview(
      fixture.input.authority,
      draft,
      fixture.input.preview.createdAt,
      fixture.input.preview.nonce,
      fixture.input.preview.expiresAt,
    )
    const input = {
      ...fixture.input,
      draft,
      preview,
      decision: { ...fixture.input.decision, proposalDigest: preview.proposalDigest },
    }

    const result = await fixture.coordinator().execute(input)
    expect(result.status).toBe("effect_observed")
    expect(await exists(marker)).toBe(false)
    expect(await readFile(join(fixture.target, ".env"), "utf8")).toBe("ASTRA_MUST_NOT_LOAD=1\n")
    expect(await readFile(join(fixture.target, "opencode.json"), "utf8")).toContain("malicious-local-plugin")
  })

  test("never follows a nested directory replaced by a symlink during verification", async () => {
    const fixture = await makeFixture("astra-project-verifier-race-")
    await fixture.coordinator().execute(fixture.input)
    const target = await lstat(fixture.target)
    const outside = await realpath(await mkdtemp(join(tmpdir(), "astra-project-verifier-outside-")))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, "index.ts"), "outside secret\n")
    let replaced = false

    const verification = await verifyProjectScaffoldTreeInternal(
      fixture.input.authority,
      fixture.input.preview,
      { device: String(target.dev), inode: String(target.ino) },
      {
        beforeOpenEntry: async (relativePath) => {
          if (relativePath !== "src" || replaced) return
          replaced = true
          await rename(join(fixture.target, "src"), join(fixture.target, "src-original"))
          await symlink(outside, join(fixture.target, "src"))
        },
      },
    )

    expect(replaced).toBe(true)
    expect(verification.status).toBe("unknown")
    expect(verification.status).not.toBe("verified")
    expect(await readFile(join(outside, "index.ts"), "utf8")).toBe("outside secret\n")
  })

  test("does not verify a target name replaced during the second descriptor read", async () => {
    const fixture = await makeFixture("astra-project-verifier-target-name-race-")
    await fixture.coordinator().execute(fixture.input)
    const target = await lstat(fixture.target)
    const approvedTarget = `${fixture.target}-approved`
    cleanup.push(() => rm(approvedTarget, { recursive: true, force: true }))
    let visits = 0

    const verification = await verifyProjectScaffoldTreeInternal(
      fixture.input.authority,
      fixture.input.preview,
      { device: String(target.dev), inode: String(target.ino) },
      {
        beforeOpenEntry: async (relativePath) => {
          if (relativePath !== "src/index.ts") return
          visits += 1
          if (visits !== 2) return
          await rename(fixture.target, approvedTarget)
          await mkdir(fixture.target)
        },
      },
    )

    expect(visits).toBe(2)
    expect(verification.status).toBe("unknown")
  })

  test("opens the target only beneath the pinned parent descriptor", async () => {
    const fixture = await makeFixture("astra-project-verifier-parent-race-")
    await fixture.coordinator().execute(fixture.input)
    const target = await lstat(fixture.target)
    const approvedParent = `${fixture.parent}-approved`
    const outside = await realpath(await mkdtemp(join(tmpdir(), "astra-project-verifier-parent-outside-")))
    cleanup.push(() => rm(approvedParent, { recursive: true, force: true }))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, "secret.txt"), "outside secret\n")
    let replaced = false

    const verification = await verifyProjectScaffoldTreeInternal(
      fixture.input.authority,
      fixture.input.preview,
      { device: String(target.dev), inode: String(target.ino) },
      {
        afterParentOpen: async () => {
          if (replaced) return
          replaced = true
          await rename(fixture.parent, approvedParent)
          await mkdir(fixture.parent)
          await symlink(outside, fixture.target)
        },
      },
    )

    expect(replaced).toBe(true)
    expect(verification.status).toBe("unknown")
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside secret\n")
  })

  test("stops native enumeration before opening entries beyond the verification budget", async () => {
    const fixture = await makeFixture("astra-project-verifier-budget-")
    await fixture.coordinator().execute(fixture.input)
    const target = await lstat(fixture.target)
    await Promise.all(
      Array.from({ length: 258 }, (_, index) => writeFile(join(fixture.target, `extra-${index}.txt`), "extra\n")),
    )
    let openedEntries = 0

    const verification = await verifyProjectScaffoldTreeInternal(
      fixture.input.authority,
      fixture.input.preview,
      { device: String(target.dev), inode: String(target.ino) },
      {
        beforeOpenEntry: async () => {
          openedEntries += 1
        },
      },
    )

    expect(verification.status).toBe("unknown")
    expect(verification.reason).toContain("entry limit")
    expect(openedEntries).toBe(0)
  })
})

async function makeFixture(prefix: string, decision: ProjectCreationDecision["decision"] = "approved") {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const state = await realpath(await mkdtemp(join(tmpdir(), `${prefix}state-`)))
  cleanup.push(() => rm(parent, { recursive: true, force: true }))
  cleanup.push(() => rm(state, { recursive: true, force: true }))
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
  const captured = await captureProjectParentAuthority(parent, draft.name, "2026-07-20T10:15:30.000Z")
  if (captured.status !== "complete") throw new Error(captured.reason)
  const preview = makeProjectCreationPreview(
    captured.authority,
    draft,
    "2026-07-20T10:16:00.000Z",
    "0123456789abcdef0123456789abcdef",
    "2026-07-20T10:21:00.000Z",
  )
  const input: DurableProjectScaffoldInput = {
    authority: captured.authority,
    draft,
    preview,
    decision: {
      proposalDigest: preview.proposalDigest,
      nonce: preview.nonce,
      decision,
      decidedAt: "2026-07-20T10:17:00.000Z",
    },
    recordingStartedAt: "2026-07-20T10:17:30.000Z",
  }
  const operationID = makeProjectScaffoldOperationFacts(input).operationID
  const operationStateDirectory = join(state, operationID)
  const now = () => Date.parse("2026-07-20T10:18:00.000Z")
  return {
    parent,
    state,
    target: join(parent, draft.name),
    ledger: join(operationStateDirectory, "operations.sqlite"),
    spool: join(operationStateDirectory, "receipts.sqlite"),
    input,
    now,
    coordinator: (options: Omit<ProjectScaffoldCoordinatorInternalOptions, "stateRoot"> = {}) =>
      createProjectScaffoldCoordinatorInternal({ stateRoot: state, now, ...options }),
  }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

if (false) {
  const input = {} as DurableProjectScaffoldInput
  // @ts-expect-error Public scaffold inputs cannot select ledger or spool paths.
  void ({ ...input, ledgerFilename: "/tmp/operations.sqlite" } satisfies DurableProjectScaffoldInput)
  // @ts-expect-error The public coordinator cannot accept a clock, observer, or fault-injection argument.
  void executeDurableProjectScaffold(input, { now: () => 0 })
}
