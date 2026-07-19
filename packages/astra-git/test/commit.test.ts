import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitCommitDecision } from "@astra/domain/git-commit-mutation"
import { computeGitCommitInventoryDigest, computeGitCommitProposalDigest } from "@astra/domain/git-commit-mutation"
import { captureGitRepositoryBaseline } from "../src/baseline"
import {
  executeGitCommitLocal,
  prepareGitCommitLocal,
  verifyGitCommitLocal,
  type GitCommitFaultPoint,
} from "../src/commit"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("governed local Git commit adapter", () => {
  test("prepares deterministic tree and commit OIDs without writing", async () => {
    const fixture = await repository()
    const before = await repositoryWriteDigest(fixture.root)
    const prepared = await prepare(fixture.root, "feat: exact tree\n\nMultiline body.")
    expect(prepared.status).toBe("ready")
    if (prepared.status !== "ready") return
    expect(await repositoryWriteDigest(fixture.root)).toBe(before)
    expect(prepared.preview.treeOID).toBe((await git(fixture.root, ["write-tree"])).trim())
    expect(prepared.preview.message).toBe("feat: exact tree\n\nMultiline body.")
    expect(prepared.preview.verification).toBe("not_verified")
    expect(prepared.preview.hooks).toBe("disabled")
    expect(prepared.preview.network).toBe("not_requested_host_unrestricted")
    expect(prepared.preview.helper).toEqual(prepared.inventory.helper)
    expect(prepared.preview.helper.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  test("rejects with zero claim, process, scratch or repository effect", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    const before = await repositoryWriteDigest(fixture.root)
    let claims = 0
    let processes = 0
    const result = await executeGitCommitLocal(operationInput(prepared, "rejected"), {
      claimProposal: async () => {
        claims += 1
        return claimAuthority(prepared)
      },
      runGit: async () => {
        processes += 1
        throw new Error("rejected operation invoked Git")
      },
    })
    expect(result).toEqual({ status: "denied_without_effect", verification: "not_verified" })
    expect({ claims, processes }).toEqual({ claims: 0, processes: 0 })
    expect(await repositoryWriteDigest(fixture.root)).toBe(before)
  })

  test("rejects recomputed authority when parent object bytes do not match their approved OID", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    const original = prepared.inventory.treeObjects[0]!
    const changedBytes = Buffer.from(original.contentBase64, "base64")
    changedBytes[changedBytes.length - 1] = (changedBytes[changedBytes.length - 1] ?? 0) ^ 1
    const changed = {
      ...original,
      contentBase64: changedBytes.toString("base64"),
      contentDigest: digest(changedBytes),
    }
    const { inventoryDigest: _, ...inventoryAuthority } = prepared.inventory
    const tamperedInventoryAuthority = {
      ...inventoryAuthority,
      treeObjects: [changed, ...prepared.inventory.treeObjects.slice(1)],
    }
    const inventory = {
      ...tamperedInventoryAuthority,
      inventoryDigest: computeGitCommitInventoryDigest(tamperedInventoryAuthority),
    }
    const { proposalDigest: __, ...previewAuthority } = prepared.preview
    const tamperedPreviewAuthority = {
      ...previewAuthority,
      inventoryDigest: inventory.inventoryDigest,
      treeObjects: inventory.treeObjects.map(({ oid, byteLength, contentDigest }) => ({
        oid,
        byteLength,
        contentDigest,
      })),
    }
    const preview = {
      ...tamperedPreviewAuthority,
      proposalDigest: computeGitCommitProposalDigest(tamperedPreviewAuthority),
    }
    let claims = 0
    expect(
      await executeGitCommitLocal(
        {
          preview,
          inventory,
          expectedBaseline: prepared.baseline,
          decision: {
            schemaVersion: 1,
            operation: "git_commit_local",
            proposalDigest: preview.proposalDigest,
            nonce: preview.nonce,
            decision: "approved",
            decidedAt: new Date(Date.parse(preview.createdAt) + 1_000).toISOString(),
          },
        },
        {
          claimProposal: async () => {
            claims += 1
            return claimAuthority(prepared)
          },
        },
      ),
    ).toMatchObject({ status: "blocked_without_effect", reason: "invalid_input" })
    expect(claims).toBe(0)
  })

  test("never deletes a pre-existing scratch collision", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    await mkdir(prepared.preview.runtimeScratch, { mode: 0o700 })
    const sentinel = join(prepared.preview.runtimeScratch, "owner-data")
    await writeFile(sentinel, "must survive")
    const result = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      claimProposal: async () => claimAuthority(prepared),
    })
    expect(result).toMatchObject({ status: "blocked_without_effect", reason: "runtime_scratch_unavailable" })
    expect(await readFile(sentinel, "utf8")).toBe("must survive")
    await rm(prepared.preview.runtimeScratch, { recursive: true, force: true })
  })

  test("rejects a replaced approved native helper without spawning it or changing the repository", async () => {
    const fixture = await repository()
    const defaultPrepared = await ready(fixture.root)
    const helperRoot = await realpath(await mkdtemp(join(tmpdir(), "astra-git-helper-test-")))
    roots.push(helperRoot)
    const trusted = join(helperRoot, "astra-git-commit")
    await copyFile(defaultPrepared.preview.helper.canonicalPath, trusted)
    await chmod(trusted, 0o500)
    const baseline = await captureGitRepositoryBaseline(fixture.root)
    if (baseline.status !== "complete") throw new Error(`Helper baseline failed: ${baseline.reason}`)
    const prepared = await prepareGitCommitLocal(
      fixture.root,
      baseline.snapshot,
      "feat: helper identity",
      { ASTRA_GIT_AUTHOR_NAME: "Astra User", ASTRA_GIT_AUTHOR_EMAIL: "astra@example.test" },
      Date.now() - 2_000,
      { nativeHelperPath: trusted },
    )
    if (prepared.status !== "ready") throw new Error(`Helper preparation failed: ${prepared.reason}`)
    const marker = join(helperRoot, "replaced-helper-invoked")
    await chmod(trusted, 0o700)
    await writeFile(trusted, `#!/bin/sh\nprintf invoked > '${marker}'\n`)
    await chmod(trusted, 0o500)
    const result = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      claimProposal: async () => claimAuthority(prepared),
    })
    expect(result).toMatchObject({
      status: "blocked_without_effect",
      verification: "not_verified",
      reason: "native_helper_unavailable",
    })
    expect(Bun.file(marker).size).toBe(0)
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(prepared.preview.expectedOldOID)
  })

  test("claims first, installs exact objects, updates the ref with CAS and verifies byte-exact", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root, "feat: governed commit\n\nExact bytes.")
    const indexBefore = digest(await readFile(join(fixture.root, ".git", "index")))
    const worktreeBefore = await readFile(join(fixture.root, "tracked.txt"), "utf8")
    let claims = 0
    const executed = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      claimProposal: async () => {
        claims += 1
        return claimAuthority(prepared)
      },
    })
    expect(claims).toBe(1)
    if (executed.status !== "effect_observed") throw new Error(`Positive execution failed: ${JSON.stringify(executed)}`)
    expect(executed.status).toBe("effect_observed")
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(prepared.preview.commitOID)
    expect(digest(await readFile(join(fixture.root, ".git", "index")))).toBe(indexBefore)
    expect(await readFile(join(fixture.root, "tracked.txt"), "utf8")).toBe(worktreeBefore)
    if (executed.status !== "effect_observed") return
    const verified = await verifyGitCommitLocal({
      preview: prepared.preview,
      inventory: prepared.inventory,
      expectedBaseline: prepared.baseline,
      observation: executed.observation,
    })
    expect(verified).toMatchObject({
      status: "verified",
      verification: "independent_commit_bytes_and_repository_state",
      snapshotDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
  })

  test("handles an unchanged subtree whose tree object already exists in the repository", async () => {
    const fixture = await repository(false)
    await mkdir(join(fixture.root, "dir"))
    await writeFile(join(fixture.root, "dir", "stable.txt"), "stable\n")
    await writeFile(join(fixture.root, "top.txt"), "before\n")
    await git(fixture.root, ["add", "dir/stable.txt", "top.txt"])
    await git(fixture.root, ["commit", "-q", "-m", "nested baseline"], { identity: true })
    await writeFile(join(fixture.root, "top.txt"), "after\n")
    await git(fixture.root, ["add", "top.txt"])
    const prepared = await ready(fixture.root)
    expect(prepared.inventory.treeObjects.length).toBeGreaterThan(1)
    expect(
      await executeGitCommitLocal(operationInput(prepared, "approved"), {
        claimProposal: async () => claimAuthority(prepared),
      }),
    ).toMatchObject({ status: "effect_observed", verification: "not_verified" })
  })

  test("fails closed when an existing approved tree object is corrupt", async () => {
    const fixture = await repository(false)
    await mkdir(join(fixture.root, "dir"))
    await writeFile(join(fixture.root, "dir", "stable.txt"), "stable\n")
    await writeFile(join(fixture.root, "top.txt"), "before\n")
    await git(fixture.root, ["add", "dir/stable.txt", "top.txt"])
    await git(fixture.root, ["commit", "-q", "-m", "nested baseline"], { identity: true })
    await writeFile(join(fixture.root, "top.txt"), "after\n")
    await git(fixture.root, ["add", "top.txt"])
    const prepared = await ready(fixture.root)
    const existingTree = (await git(fixture.root, ["rev-parse", "HEAD:dir"])).trim()
    const existingTreePath = join(fixture.root, ".git", "objects", existingTree.slice(0, 2), existingTree.slice(2))
    await chmod(existingTreePath, 0o600)
    await writeFile(existingTreePath, "corrupt")
    expect(
      await executeGitCommitLocal(operationInput(prepared, "approved"), {
        claimProposal: async () => claimAuthority(prepared),
      }),
    ).toMatchObject({
      status: "blocked_without_effect",
      verification: "not_verified",
      reason: "native_helper_unavailable",
    })
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(prepared.preview.expectedOldOID)
  })

  test("never invokes hooks, editor, signer, credential helper or global config", async () => {
    const fixture = await repository()
    const markers = ["reference-transaction", "commit-msg", "post-commit", "editor", "signer", "credential", "config"]
    for (const hook of markers.slice(0, 3)) {
      await hostile(join(fixture.root, ".git", "hooks", hook), join(fixture.root, `${hook}.invoked`))
    }
    for (const helper of markers.slice(3)) {
      await hostile(join(fixture.root, helper), join(fixture.root, `${helper}.invoked`))
    }
    const global = join(fixture.root, "hostile-global")
    await writeFile(
      global,
      `[core]\n  hooksPath = ${fixture.root}\n[commit]\n  gpgSign = true\n[credential]\n  helper = ${join(fixture.root, "credential")}\n`,
    )
    const baseline = await captureGitRepositoryBaseline(fixture.root)
    if (baseline.status !== "complete") throw new Error(`Hostile baseline failed: ${baseline.reason}`)
    const preparedResult = await prepareGitCommitLocal(
      fixture.root,
      baseline.snapshot,
      "feat: governed commit",
      {
        ASTRA_GIT_AUTHOR_NAME: "Astra User",
        ASTRA_GIT_AUTHOR_EMAIL: "astra@example.test",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: join(fixture.root, "config"),
      },
      Date.now() - 2_000,
    )
    if (preparedResult.status !== "ready") throw new Error(`Hostile preparation failed: ${preparedResult.reason}`)
    const prepared = preparedResult
    const executed = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      environment: {
        GIT_CONFIG_GLOBAL: global,
        GIT_EDITOR: join(fixture.root, "editor"),
        GIT_ASKPASS: join(fixture.root, "credential"),
      },
      claimProposal: async () => claimAuthority(prepared),
    })
    if (executed.status !== "effect_observed") throw new Error(`Hostile execution failed: ${JSON.stringify(executed)}`)
    expect(executed.status).toBe("effect_observed")
    for (const marker of markers) expect(Bun.file(join(fixture.root, `${marker}.invoked`)).size).toBe(0)
  })

  test("a ref race after object installation requires reconciliation and is never retried", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    let updates = 0
    const result = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      claimProposal: async () => claimAuthority(prepared),
      injectFault: async (point: GitCommitFaultPoint) => {
        if (point !== "after_objects_installed_before_ref_cas") return
        updates += 1
        const currentTree = (await git(fixture.root, ["rev-parse", "HEAD^{tree}"])).trim()
        const concurrent = (
          await git(fixture.root, ["commit-tree", currentTree, "-p", prepared.preview.expectedOldOID], {
            input: "concurrent\n",
            identity: true,
          })
        ).trim()
        await git(fixture.root, ["update-ref", prepared.preview.ref, concurrent, prepared.preview.expectedOldOID])
      },
    })
    expect(updates).toBe(1)
    expect(result).toMatchObject({ status: "reconciliation_required", verification: "not_verified" })
    const current = (await git(fixture.root, ["rev-parse", "HEAD"])).trim()
    expect(current).not.toBe(prepared.preview.expectedOldOID)
    expect(current).not.toBe(prepared.preview.commitOID)
  })

  test("blocks index drift after durable claim without updating the ref", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    await writeFile(join(fixture.root, "tracked.txt"), "drifted after preview\n")
    await git(fixture.root, ["add", "tracked.txt"])
    let claims = 0
    const result = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      claimProposal: async () => {
        claims += 1
        return claimAuthority(prepared)
      },
    })
    expect(claims).toBe(1)
    expect(result).toMatchObject({ status: "blocked_without_effect", reason: "baseline_stale" })
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(prepared.preview.expectedOldOID)
  })

  test("never updates the ref after the durable effect lease expires", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    let now = Date.now()
    const result = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      now: () => now,
      claimProposal: async () => ({
        status: "claimed",
        effectExpiresAt: new Date(now + 20_000).toISOString(),
      }),
      injectFault: async (point) => {
        if (point === "after_objects_installed_before_ref_cas") now += 6_000
      },
    })
    expect(result).toMatchObject({
      status: "reconciliation_required",
      verification: "not_verified",
      reason: "authority_expired_after_effect",
    })
    expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(prepared.preview.expectedOldOID)
  })

  for (const point of [
    "after_claim_before_revalidation",
    "after_quarantine_before_object_install",
    "after_objects_installed_before_ref_cas",
    "after_ref_cas_before_observation",
  ] as const) {
    test(`${point} reports uncertainty and never false success`, async () => {
      const fixture = await repository()
      const prepared = await ready(fixture.root)
      const result = await executeGitCommitLocal(operationInput(prepared, "approved"), {
        claimProposal: async () => claimAuthority(prepared),
        injectFault: async (current) => {
          if (current === point) throw new Error(`fault at ${point}`)
        },
      })
      expect(result).toMatchObject({ status: "reconciliation_required", verification: "not_verified" })
      if (point !== "after_ref_cas_before_observation") {
        expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(prepared.preview.expectedOldOID)
      }
    })
  }

  test("does not verify when another ref changes between independent observations", async () => {
    const fixture = await repository()
    const prepared = await ready(fixture.root)
    const executed = await executeGitCommitLocal(operationInput(prepared, "approved"), {
      claimProposal: async () => claimAuthority(prepared),
    })
    expect(executed.status).toBe("effect_observed")
    if (executed.status !== "effect_observed") return
    expect(
      await verifyGitCommitLocal(
        {
          preview: prepared.preview,
          inventory: prepared.inventory,
          expectedBaseline: prepared.baseline,
          observation: executed.observation,
        },
        {
          captureBaseline: async (root) => {
            const captured = await captureGitRepositoryBaseline(root)
            await git(root, ["update-ref", "refs/heads/concurrent", prepared.preview.expectedOldOID])
            return captured
          },
        },
      ),
    ).toMatchObject({ status: "stale", verification: "not_verified", reason: "post_state_changed" })
  })

  test("blocks detached, unborn, empty staged state, conflicts, submodules, split index and locks", async () => {
    const missingIdentity = await repository()
    const missingIdentityBaseline = await captureGitRepositoryBaseline(missingIdentity.root)
    if (missingIdentityBaseline.status !== "complete") throw new Error("Identity fixture baseline failed")
    expect(
      await prepareGitCommitLocal(missingIdentity.root, missingIdentityBaseline.snapshot, "feat: missing identity", {}),
    ).toMatchObject({ status: "blocked", reason: "identity_required" })

    const detached = await repository()
    await git(detached.root, ["checkout", "--detach", "-q"])
    expect((await prepare(detached.root)).status).toBe("blocked")

    const unborn = await emptyRepository()
    expect((await prepareWithFreshBaseline(unborn)).status).toBe("blocked")

    const empty = await repository(false)
    expect(await prepare(empty.root)).toMatchObject({ status: "blocked", reason: "nothing_staged" })

    const conflict = await repository()
    await createConflict(conflict.root)
    expect(await prepare(conflict.root)).toMatchObject({ status: "blocked", reason: "conflicts_present" })

    const submodule = await repository()
    await git(submodule.root, ["update-index", "--add", "--cacheinfo", "160000", submodule.initialOID, "module"])
    expect((await prepare(submodule.root)).status).toBe("blocked")

    const split = await repository()
    await git(split.root, ["update-index", "--split-index"])
    expect((await prepare(split.root)).status).toBe("blocked")

    const locked = await repository()
    await writeFile(join(locked.root, ".git", "index.lock"), "held")
    expect(await prepare(locked.root)).toMatchObject({ status: "blocked", reason: "index_lock_present" })
  }, 60_000)

  test("blocks a packed branch ref before any object computation", async () => {
    const packed = await repository()
    await git(packed.root, ["pack-refs", "--all", "--prune"])
    expect(await prepare(packed.root)).toMatchObject({ status: "blocked", reason: "packed_ref_unsupported" })

    const packedWithLoose = await repository()
    await git(packedWithLoose.root, ["pack-refs", "--all"])
    await writeFile(join(packedWithLoose.root, ".git", "refs", "heads", "main"), `${packedWithLoose.initialOID}\n`)
    expect(await prepare(packedWithLoose.root)).toMatchObject({
      status: "blocked",
      reason: "packed_ref_unsupported",
    })
  })
})

async function repository(withStage = true) {
  const root = await emptyRepository()
  await writeFile(join(root, "tracked.txt"), "initial\n")
  await git(root, ["add", "tracked.txt"])
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", "initial"])
  const initialOID = (await git(root, ["rev-parse", "HEAD"])).trim()
  if (withStage) {
    await writeFile(join(root, "tracked.txt"), "staged\n")
    await git(root, ["add", "tracked.txt"])
  }
  return { root, initialOID }
}

async function emptyRepository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "astra-git-commit-test-")))
  roots.push(root)
  await git(root, ["init", "-q", "-b", "main"])
  return root
}

async function prepare(root: string, message = "feat: governed commit") {
  const baseline = await captureGitRepositoryBaseline(root)
  if (baseline.status !== "complete") return { status: "blocked" as const, reason: baseline.reason }
  return prepareGitCommitLocal(
    root,
    baseline.snapshot,
    message,
    { ASTRA_GIT_AUTHOR_NAME: "Astra User", ASTRA_GIT_AUTHOR_EMAIL: "astra@example.test" },
    Date.now() - 2_000,
  )
}

async function prepareWithFreshBaseline(root: string) {
  const baseline = await captureGitRepositoryBaseline(root)
  if (baseline.status !== "complete") return { status: "blocked" as const, reason: baseline.reason }
  return prepareGitCommitLocal(
    root,
    baseline.snapshot,
    "feat: governed commit",
    { ASTRA_GIT_AUTHOR_NAME: "Astra User", ASTRA_GIT_AUTHOR_EMAIL: "astra@example.test" },
    Date.now() - 2_000,
  )
}

async function ready(root: string, message = "feat: governed commit") {
  const result = await prepare(root, message)
  if (result.status !== "ready") throw new Error(`Preparation blocked: ${result.reason}`)
  return result
}

function operationInput(prepared: Awaited<ReturnType<typeof ready>>, decision: "approved" | "rejected") {
  return {
    preview: prepared.preview,
    inventory: prepared.inventory,
    expectedBaseline: prepared.baseline,
    decision: {
      schemaVersion: 1,
      operation: "git_commit_local",
      proposalDigest: prepared.preview.proposalDigest,
      nonce: prepared.preview.nonce,
      decision,
      decidedAt: new Date(Date.parse(prepared.preview.createdAt) + 1_000).toISOString(),
    } satisfies GitCommitDecision,
  }
}

function claimAuthority(prepared: Awaited<ReturnType<typeof ready>>) {
  return { status: "claimed", effectExpiresAt: prepared.preview.expiresAt } as const
}

async function repositoryWriteDigest(root: string) {
  const files = ["HEAD", "index", "packed-refs"]
  const refs = await readdir(join(root, ".git", "refs", "heads")).catch(() => [])
  const objects = await objectPaths(join(root, ".git", "objects"))
  const values = await Promise.all(
    [...files, ...refs.map((name) => `refs/heads/${name}`), ...objects.map((name) => `objects/${name}`)].map(
      async (name) => `${name}:${digest(await readFile(join(root, ".git", name)).catch(() => Buffer.alloc(0)))}`,
    ),
  )
  return digest(Buffer.from(values.sort().join("\n")))
}

async function objectPaths(root: string, prefix = ""): Promise<Array<string>> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = join(prefix, entry.name)
      return entry.isDirectory() ? objectPaths(join(root, entry.name), relative) : [relative]
    }),
  )
  return nested.flat()
}

async function hostile(path: string, marker: string) {
  await writeFile(path, `#!/bin/sh\nprintf invoked > '${marker}'\nexit 99\n`)
  await chmod(path, 0o755)
}

async function createConflict(root: string) {
  await git(root, ["checkout", "-q", "-b", "other"])
  await writeFile(join(root, "tracked.txt"), "other\n")
  await git(root, ["commit", "-q", "-am", "other", "--no-gpg-sign"], { identity: true })
  await git(root, ["checkout", "-q", "main"])
  await writeFile(join(root, "tracked.txt"), "main\n")
  await git(root, ["commit", "-q", "-am", "main", "--no-gpg-sign"], { identity: true })
  await git(root, ["merge", "other"], { allowFailure: true, identity: true })
}

async function git(
  root: string,
  arguments_: ReadonlyArray<string>,
  options: Readonly<{ input?: string; allowFailure?: boolean; identity?: boolean }> = {},
) {
  const child = Bun.spawn(["/usr/bin/git", ...arguments_], {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: join(root, "empty-home"),
      GIT_CONFIG_NOSYSTEM: "1",
      ...(options.identity
        ? {
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.test",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.test",
          }
        : {}),
    },
    stdin: options.input ? new Blob([options.input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0 && !options.allowFailure) throw new Error(`git ${arguments_.join(" ")} failed: ${stderr}`)
  return stdout
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
