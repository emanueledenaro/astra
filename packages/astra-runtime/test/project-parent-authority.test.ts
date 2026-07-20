import { afterAll, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureProjectParentAuthority,
  revalidateProjectParentAuthority,
} from "../src/project-parent-authority"
import {
  captureProjectParentAuthorityInternal,
  revalidateProjectParentAuthorityInternal,
} from "../src/project-parent-authority-internal"

const cleanup: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.all(cleanup.map((remove) => remove()))
})

describe("project-parent authority capture", () => {
  test("keeps filesystem callbacks outside the public API", () => {
    expect(captureProjectParentAuthority.length).toBe(2)
    expect(revalidateProjectParentAuthority.length).toBe(1)
  })

  test("captures a canonical existing parent and absent direct child without effects", async () => {
    const parent = await temporaryDirectory("astra-project-parent-")
    const before = await lstatNames(parent)
    const result = await captureProjectParentAuthority(parent, "alpha", "2026-07-20T10:15:30.000Z")

    expect(result).toMatchObject({
      status: "complete",
      authority: {
        schemaVersion: 1,
        parentPath: parent,
        targetPath: join(parent, "alpha"),
        targetName: "alpha",
        targetState: "absent",
        observedAt: "2026-07-20T10:15:30.000Z",
      },
    })
    expect(await lstatNames(parent)).toEqual(before)
    if (result.status !== "complete") throw new Error("Expected complete capture")
    expect(await revalidateProjectParentAuthority(result.authority)).toEqual({
      status: "current",
      authority: result.authority,
    })
  })

  test("blocks relative and symlink parent paths", async () => {
    expect(await captureProjectParentAuthority("relative", "alpha")).toEqual({
      status: "blocked",
      reason: "parent_path_not_absolute",
    })

    const target = await temporaryDirectory("astra-project-parent-target-")
    const container = await temporaryDirectory("astra-project-parent-link-")
    const link = join(container, "projects")
    await symlink(target, link)
    expect(await captureProjectParentAuthority(link, "alpha")).toEqual({
      status: "blocked",
      reason: "parent_is_symlink",
    })
  })

  test("blocks an existing child target without changing it", async () => {
    const parent = await temporaryDirectory("astra-project-existing-target-")
    const target = join(parent, "alpha")
    await writeFile(target, "preserve me\n")

    expect(await captureProjectParentAuthority(parent, "alpha")).toEqual({
      status: "blocked",
      reason: "target_already_exists",
    })
    expect(await Bun.file(target).text()).toBe("preserve me\n")
  })

  test("blocks a replacement parent during revalidation", async () => {
    const parent = await temporaryDirectory("astra-project-replaced-parent-")
    const result = await captureProjectParentAuthority(parent, "alpha")
    if (result.status !== "complete") throw new Error("Expected complete capture")
    const original = `${parent}-original`
    cleanup.push(() => rm(original, { recursive: true, force: true }))
    await rename(parent, original)
    await mkdir(parent)

    expect(await revalidateProjectParentAuthority(result.authority)).toEqual({
      status: "blocked",
      reason: "parent_identity_changed",
    })
  })

  test("blocks capture when the parent is replaced after the final target observation", async () => {
    const parent = await temporaryDirectory("astra-project-final-capture-race-")
    const replacement = replacementAfterFinalTargetObservation(parent, "alpha")

    expect(
      await captureProjectParentAuthorityInternal(
        parent,
        "alpha",
        "2026-07-20T10:15:30.000Z",
        replacement.filesystem,
      ),
    ).toEqual({
      status: "blocked",
      reason: "parent_identity_changed",
    })
    expect(replacement.targetObservations()).toBe(2)
  })

  test("blocks when the absent target appears after capture", async () => {
    const parent = await temporaryDirectory("astra-project-stale-target-")
    const result = await captureProjectParentAuthority(parent, "alpha")
    if (result.status !== "complete") throw new Error("Expected complete capture")
    await mkdir(join(parent, "alpha"))

    expect(await revalidateProjectParentAuthority(result.authority)).toEqual({
      status: "blocked",
      reason: "target_appeared",
    })
  })

  test("blocks revalidation when the parent is replaced after the final target observation", async () => {
    const parent = await temporaryDirectory("astra-project-final-revalidation-race-")
    const result = await captureProjectParentAuthority(parent, "alpha")
    if (result.status !== "complete") throw new Error("Expected complete capture")
    const replacement = replacementAfterFinalTargetObservation(parent, "alpha")

    expect(await revalidateProjectParentAuthorityInternal(result.authority, replacement.filesystem)).toEqual({
      status: "blocked",
      reason: "parent_identity_changed",
    })
    expect(replacement.targetObservations()).toBe(2)
  })

  test("blocks a mismatched target path without touching either target", async () => {
    const parent = await temporaryDirectory("astra-project-mismatched-target-")
    const result = await captureProjectParentAuthority(parent, "alpha")
    if (result.status !== "complete") throw new Error("Expected complete capture")
    const mismatched = { ...result.authority, targetPath: join(parent, "beta") }

    expect(await revalidateProjectParentAuthority(mismatched)).toEqual({
      status: "blocked",
      reason: "target_mismatch",
    })
    expect(await lstatNames(parent)).toEqual([])
  })
})

async function temporaryDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return realpath(path)
}

async function lstatNames(path: string) {
  const names: Array<string> = []
  for await (const entry of new Bun.Glob("*").scan({ cwd: path, dot: true, onlyFiles: false })) names.push(entry)
  return names.sort()
}

function replacementAfterFinalTargetObservation(parent: string, targetName: string) {
  const original = `${parent}-approved`
  cleanup.push(() => rm(original, { recursive: true, force: true }))
  let observations = 0
  return {
    filesystem: {
      lstat: async (path: string) => {
        try {
          return await lstat(path)
        } catch (cause) {
          if (path === join(parent, targetName) && errorCode(cause) === "ENOENT") {
            observations += 1
            if (observations === 2) {
              await rename(parent, original)
              await mkdir(parent)
            }
          }
          throw cause
        }
      },
      realpath,
    },
    targetObservations: () => observations,
  }
}

function errorCode(input: unknown) {
  if (typeof input !== "object" || input === null) return null
  const descriptor = Object.getOwnPropertyDescriptor(input, "code")
  return descriptor && "value" in descriptor ? descriptor.value : null
}

if (false) {
  const inaccessibleFilesystem = { lstat, realpath }
  // @ts-expect-error The public capture API never accepts filesystem callbacks.
  void captureProjectParentAuthority("/private/tmp", "alpha", "2026-07-20T10:15:30.000Z", inaccessibleFilesystem)
  // @ts-expect-error The public revalidation API never accepts filesystem callbacks.
  void revalidateProjectParentAuthority(null, inaccessibleFilesystem)
}
