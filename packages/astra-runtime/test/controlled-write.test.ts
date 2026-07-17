import { afterAll, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createControlledWritePlan, demoMarkerName } from "../src/controlled-write-plan"
import { prepareControlledWrite, verifyControlledWrite } from "../src/controlled-write"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "astra-controlled-write-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{}\n")
  return root
}

describe("controlled demo write", () => {
  test("creates exactly one new marker and verifies independent readback", async () => {
    const root = await workspace()
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, "operation-positive")
    const prepared = await prepareControlledWrite(plan, report, allowTestEffect)

    expect(prepared.prepared).toBeTrue()
    if (!prepared.prepared) throw new Error(prepared.reason)
    const result = await prepared.execute()
    expect(result).toMatchObject({
      status: "effect_observed",
      receipt: {
        path: join(root, demoMarkerName),
        expectedDigest: plan.contentDigest,
        observedDigest: plan.contentDigest,
        targetIdentityMatched: true,
        workspaceIdentityMatched: true,
      },
    })
    expect(await readFile(join(root, demoMarkerName), "utf8")).toBe(plan.content)
    expect(await prepared.execute()).toEqual({
      status: "failed_without_effect",
      reason: "attempt_already_consumed",
    })
  })

  test("refuses an existing marker without overwriting it", async () => {
    const root = await workspace()
    const marker = join(root, demoMarkerName)
    await writeFile(marker, "user-owned\n")
    const report = await scanWorkspace(root)
    const prepared = await prepareControlledWrite(
      createControlledWritePlan(root, "operation-existing"),
      report,
      allowTestEffect,
    )

    expect(prepared).toEqual({ prepared: false, reason: "target_already_exists" })
    expect(await readFile(marker, "utf8")).toBe("user-owned\n")
  })

  test("does not treat mismatched readback as verified evidence", async () => {
    const root = await workspace()
    const plan = createControlledWritePlan(root, "operation-mismatch")
    await writeFile(join(root, demoMarkerName), "unexpected\n")

    const receipt = await verifyControlledWrite(plan)
    expect(receipt.observedDigest).not.toBe(plan.contentDigest)
    expect(receipt.bytes).not.toBe(Buffer.byteLength(plan.content))
    expect(receipt.workspaceIdentityMatched).toBeTrue()
  })

  test("does not verify a matching replacement or follow a swapped symlink", async () => {
    const root = await workspace()
    const plan = createControlledWritePlan(root, "operation-swap")
    const marker = join(root, demoMarkerName)
    const original = marker + ".original"
    await writeFile(marker, plan.content)
    const originalFacts = await lstat(marker)
    const originalIdentity = { device: String(originalFacts.dev), inode: String(originalFacts.ino) }

    await rename(marker, original)
    await writeFile(marker, plan.content)
    const replacementReceipt = await verifyControlledWrite(plan, marker, undefined, originalIdentity)
    expect(replacementReceipt).toMatchObject({
      observedDigest: null,
      targetIdentityMatched: false,
    })

    await rm(marker)
    await symlink(original, marker)
    const symlinkReceipt = await verifyControlledWrite(plan, marker, undefined, originalIdentity)
    expect(symlinkReceipt).toMatchObject({
      observedDigest: null,
      targetIdentityMatched: false,
    })
  })

  test("blocks the effect when the trusted snapshot changes before dispatch", async () => {
    const root = await workspace()
    const report = await scanWorkspace(root)
    await writeFile(join(root, "AGENTS.md"), "changed after approval preview\n")

    expect(
      await prepareControlledWrite(createControlledWritePlan(root, "operation-stale"), report, allowTestEffect),
    ).toMatchObject({
      prepared: false,
      reason: "security_digest_changed",
    })
  })

  test("blocks the effect when Git metadata exists without an inspected baseline", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const report = await scanWorkspace(root)

    expect(
      await prepareControlledWrite(createControlledWritePlan(root, "operation-git"), report, allowTestEffect),
    ).toEqual({
      prepared: false,
      reason: "git_baseline_not_inspected",
    })
    expect(await lstat(join(root, demoMarkerName)).catch(() => null)).toBeNull()
  })

  test("blocks the effect when Git metadata appears after preparation", async () => {
    const root = await workspace()
    const report = await scanWorkspace(root)
    const prepared = await prepareControlledWrite(
      createControlledWritePlan(root, "operation-late-git"),
      report,
      allowTestEffect,
    )
    expect(prepared.prepared).toBeTrue()
    if (!prepared.prepared) throw new Error(prepared.reason)

    await mkdir(join(root, ".git"))

    expect(await prepared.execute()).toEqual({
      status: "failed_without_effect",
      reason: "git_baseline_not_inspected",
    })
    expect(await lstat(join(root, demoMarkerName)).catch(() => null)).toBeNull()
  })
})

async function allowTestEffect() {
  return { allowed: true as const }
}
