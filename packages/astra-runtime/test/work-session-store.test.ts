import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  createWorkSessionStoreInternal,
  workSessionDatabasePathInternal,
  workSessionStateRootInternal,
  type AppendWorkSessionInput,
  type DeleteWorkSessionInput,
} from "../src/work-session-store-internal"

const roots: Array<string> = []
const actor = { kind: "system", actorID: "astra-parent" } as const
const startedAt = "2026-07-20T12:00:00.000Z"

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable Astra work-session store", () => {
  test("keeps state path and fault seams out of the public package API", async () => {
    const publicAPI = await import("../src/index")
    const publicStore = await import("../src/work-session-store")
    expect("createWorkSessionStoreInternal" in publicAPI).toBe(false)
    expect("workSessionStateRootInternal" in publicAPI).toBe(false)
    expect("workSessionDatabasePathInternal" in publicAPI).toBe(false)
    expect(Object.keys(publicStore).toSorted()).toEqual([
      "WorkSessionStoreError",
      "appendDurableWorkSession",
      "createDurableWorkSession",
      "deleteDurableWorkSession",
      "exportDurableWorkSession",
      "listDurableWorkSessions",
      "loadDurableWorkSession",
    ])
  })

  test("derives the macOS state root from the effective account and ignores HOME", async () => {
    const hostileHome = await temporaryDirectory("astra-session-hostile-home-")
    const cache = await temporaryDirectory("astra-session-transpiler-cache-")
    const helperURL = new URL("../src/work-session-store-internal.ts", import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `const { workSessionStateRootInternal } = await import(${JSON.stringify(helperURL)}); process.stdout.write(workSessionStateRootInternal())`,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, HOME: hostileHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toBe(workSessionStateRootInternal())
    expect(stdout.startsWith(hostileHome)).toBe(false)
    expect(await readdir(hostileHome)).toEqual([])
  })

  test("creates, appends, and exactly reloads a frozen full chain after restart", async () => {
    const fixture = await makeFixture("exact-reload")
    const first = await fixture.store.create(fixture.createInput)
    const analyzing = await fixture.store.append({
      sessionID: fixture.sessionID,
      expectedSequence: 1,
      observedAt: later(1),
      actor,
      draft: { type: "phase.changed", payload: { phase: "analyzing" } },
    })
    const restarted = createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot })
    const loaded = await restarted.load(fixture.sessionID)

    expect(first.projection.sequence).toBe(1)
    expect(analyzing.projection.sequence).toBe(2)
    expect(loaded).toEqual(analyzing)
    expect(loaded.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.projection)).toBe(true)
    expect(Object.isFrozen(loaded.events)).toBe(true)
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    expect(databasePath.startsWith(fixture.workspace)).toBe(false)
    expect((await lstat(databasePath)).mode & 0o077).toBe(0)
  })

  test("rejects stale optimistic writers without a partial event", async () => {
    const fixture = await makeFixture("stale-writer")
    await fixture.store.create(fixture.createInput)
    await fixture.store.append({
      sessionID: fixture.sessionID,
      expectedSequence: 1,
      observedAt: later(1),
      actor,
      draft: { type: "phase.changed", payload: { phase: "analyzing" } },
    })

    await expect(
      fixture.store.append({
        sessionID: fixture.sessionID,
        expectedSequence: 1,
        observedAt: later(2),
        actor,
        draft: { type: "phase.changed", payload: { phase: "blocked" } },
      }),
    ).rejects.toMatchObject({ code: "sequence_conflict" })
    expect((await fixture.store.load(fixture.sessionID)).events).toHaveLength(2)
  })

  test("persists at most one of two concurrent appends at the same sequence", async () => {
    const fixture = await makeFixture("concurrent-writers")
    await fixture.store.create(fixture.createInput)
    const writers = ["analyzing", "blocked"] as const
    const results = await Promise.allSettled(
      writers.map((phase, index) =>
        createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot }).append({
          sessionID: fixture.sessionID,
          expectedSequence: 1,
          observedAt: later(index + 1),
          actor,
          draft: { type: "phase.changed", payload: { phase } },
        }),
      ),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await fixture.store.load(fixture.sessionID)).events).toHaveLength(2)
  })

  test("rolls back event and projection together when the transaction is interrupted", async () => {
    const fixture = await makeFixture("atomic-rollback")
    await fixture.store.create(fixture.createInput)
    const interrupted = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      afterEventInsert: () => {
        throw new Error("injected transaction interruption")
      },
    })

    await expect(
      interrupted.append({
        sessionID: fixture.sessionID,
        expectedSequence: 1,
        observedAt: later(1),
        actor,
        draft: { type: "phase.changed", payload: { phase: "analyzing" } },
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    const loaded = await fixture.store.load(fixture.sessionID)
    expect(loaded.projection.sequence).toBe(1)
    expect(loaded.events).toHaveLength(1)
  })

  test.each([
    ["event row", "update work_session_event set event_json = replace(event_json, 'analyzing', 'blocked') where sequence = 2"],
    ["event hash", `update work_session_event set event_digest = 'sha256:${"f".repeat(64)}' where sequence = 2`],
    ["event sequence", "update work_session_event set sequence = 7 where sequence = 2"],
    ["projection", "update work_session set projection_json = replace(projection_json, 'analyzing', 'blocked')"],
  ] as const)("reports %s corruption as unavailable, never idle", async (_label, mutation) => {
    const fixture = await makeFixture(`tamper-${_label.replace(" ", "-")}`)
    await fixture.store.create(fixture.createInput)
    await fixture.store.append({
      sessionID: fixture.sessionID,
      expectedSequence: 1,
      observedAt: later(1),
      actor,
      draft: { type: "phase.changed", payload: { phase: "analyzing" } },
    })
    const database = new Database(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID))
    database.exec(mutation)
    database.close()

    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "state_unavailable" })
  })

  test("blocks state roots inside the workspace, symlink roots, and foreign ownership without creating state", async () => {
    const inside = await makeFixture("inside-root", { stateInsideWorkspace: true })
    await expect(inside.store.create(inside.createInput)).rejects.toMatchObject({ code: "unsafe_state_path" })
    expect(await exists(inside.stateRoot)).toBe(false)

    const linked = await makeFixture("symlink-root")
    const actual = await temporaryDirectory("astra-session-actual-state-")
    const stateLink = join(await temporaryDirectory("astra-session-state-link-parent-"), "state")
    await symlink(actual, stateLink)
    const linkedStore = createWorkSessionStoreInternal({ stateRoot: stateLink })
    await expect(linkedStore.create(linked.createInput)).rejects.toMatchObject({ code: "unsafe_state_path" })
    expect(await readdir(actual)).toEqual([])

    const foreign = await makeFixture("foreign-owner")
    const uid = (await lstat(foreign.stateRoot)).uid
    const foreignStore = createWorkSessionStoreInternal({ stateRoot: foreign.stateRoot, expectedUID: uid + 1 })
    await expect(foreignStore.create(foreign.createInput)).rejects.toMatchObject({ code: "unsafe_state_path" })
    expect(await readdir(foreign.stateRoot)).toEqual([])
  })

  test.each(["session-directory", "session-directory-child"] as const)(
    "rejects a workspace that is inside the %s before creating SQLite state",
    async (placement) => {
      const stateRoot = await temporaryDirectory(`astra-session-overlap-${placement}-`)
      const sessionID = `session-overlap-${placement}`
      const sessionDirectory = dirname(workSessionDatabasePathInternal(stateRoot, sessionID))
      await mkdir(sessionDirectory, { mode: 0o700 })
      const workspace = placement === "session-directory" ? sessionDirectory : join(sessionDirectory, "workspace")
      if (workspace !== sessionDirectory) await mkdir(workspace, { mode: 0o700 })
      await writeFile(join(workspace, "README.md"), "fixture\n")
      const facts = await lstat(workspace)
      const store = createWorkSessionStoreInternal({ stateRoot })

      await expect(
        store.create({
          sessionID,
          workspaceRoot: await realpath(workspace),
          workspaceIdentity: { device: String(facts.dev), inode: String(facts.ino) },
          objective: "Reject overlapping state",
          intent: { summary: "Validate placement", next: "Create nothing" },
          observedAt: startedAt,
          actor,
        }),
      ).rejects.toMatchObject({ code: "unsafe_state_path" })
      expect(await exists(workSessionDatabasePathInternal(stateRoot, sessionID))).toBe(false)
    },
  )

  test("rejects accessor-backed create, append, and delete inputs without invoking accessors or changing state", async () => {
    const fixture = await makeFixture("accessor-input")
    let getterCalls = 0
    const createInput = Object.defineProperty({ ...fixture.createInput }, "sessionID", {
      enumerable: true,
      get() {
        getterCalls += 1
        return fixture.sessionID
      },
    })
    await expect(fixture.store.create(createInput)).rejects.toMatchObject({ code: "invalid_input" })
    expect(getterCalls).toBe(0)
    expect(await readdir(fixture.stateRoot)).toEqual([])

    const record = await fixture.store.create(fixture.createInput)
    const appendInput = Object.defineProperty(
      {
        sessionID: fixture.sessionID,
        expectedSequence: 1,
        observedAt: later(1),
        actor,
        draft: { type: "phase.changed", payload: { phase: "analyzing" } },
      },
      "draft",
      {
        enumerable: true,
        get() {
          getterCalls += 1
          return { type: "phase.changed", payload: { phase: "analyzing" } }
        },
      },
    )
    await expect(fixture.store.append(appendInput as AppendWorkSessionInput)).rejects.toMatchObject({ code: "invalid_input" })
    expect(getterCalls).toBe(0)
    expect((await fixture.store.load(fixture.sessionID)).projection.sequence).toBe(1)

    const deleteInput = Object.defineProperty(
      { sessionID: fixture.sessionID, expectedSequence: record.projection.sequence },
      "expectedProjectionDigest",
      {
      enumerable: true,
      get() {
        getterCalls += 1
        return record.projection.projectionDigest
      },
      },
    )
    await expect(fixture.store.delete(deleteInput as DeleteWorkSessionInput)).rejects.toMatchObject({ code: "invalid_input" })
    expect(getterCalls).toBe(0)
    expect((await fixture.store.load(fixture.sessionID)).projection.sessionID).toBe(fixture.sessionID)

    const optionAccessor = Object.defineProperty({}, "stateRoot", {
      enumerable: true,
      get() {
        getterCalls += 1
        return fixture.stateRoot
      },
    })
    expect(() => createWorkSessionStoreInternal(optionAccessor as { stateRoot: string })).toThrow()
    expect(getterCalls).toBe(0)
  })

  test("exports canonical projection-only JSON without credential, secret text, or event payload fields", async () => {
    const fixture = await makeFixture("safe-export")
    const record = await fixture.store.create({
      ...fixture.createInput,
      objective: "API_TOKEN=must-not-leave-the-store",
      intent: { summary: "Credential value must-not-leave-the-store", next: "Keep it local" },
    })
    const before = await readdir(join(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID), ".."))
    const exported = await fixture.store.export(fixture.sessionID)
    const parsed = JSON.parse(exported) as {
      schemaVersion: number
      projection: { sessionID: string; projectionDigest: string; objectiveDigest: string }
    }

    expect(exported).toBe(canonicalJson(parsed))
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      projection: { sessionID: fixture.sessionID, projectionDigest: record.projection.projectionDigest },
    })
    expect(parsed.projection.objectiveDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(exported).not.toContain("credential")
    expect(exported).not.toContain("must-not-leave-the-store")
    expect(exported).not.toContain("eventDigest")
    expect(await readdir(join(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID), ".."))).toEqual(before)
  })

  test("explicit deletion removes only the exact bound session and fails closed on aliases", async () => {
    const first = await makeFixture("delete-first")
    const second = await makeFixture("delete-second", { stateRoot: first.stateRoot })
    const firstRecord = await first.store.create(first.createInput)
    await second.store.create(second.createInput)

    await first.store.delete({
      sessionID: first.sessionID,
      expectedSequence: firstRecord.projection.sequence,
      expectedProjectionDigest: firstRecord.projection.projectionDigest,
    })
    await expect(first.store.load(first.sessionID)).rejects.toMatchObject({ code: "not_found" })
    expect((await second.store.load(second.sessionID)).projection.sessionID).toBe(second.sessionID)

    const alias = await makeFixture("delete-alias")
    const aliasRecord = await alias.store.create(alias.createInput)
    const databasePath = workSessionDatabasePathInternal(alias.stateRoot, alias.sessionID)
    const preserved = `${databasePath}.preserved`
    await Bun.write(preserved, await Bun.file(databasePath).arrayBuffer())
    await rm(databasePath)
    await symlink(preserved, databasePath)
    await expect(
      alias.store.delete({
        sessionID: alias.sessionID,
        expectedSequence: aliasRecord.projection.sequence,
        expectedProjectionDigest: aliasRecord.projection.projectionDigest,
      }),
    ).rejects.toMatchObject({ code: "unsafe_state_path" })
    expect(await exists(preserved)).toBe(true)
  })

  test("holds an exclusive CAS through delete and rejects a concurrent newer projection", async () => {
    const fixture = await makeFixture("delete-cas")
    const record = await fixture.store.create(fixture.createInput)
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    let writerRejected = false
    const deleting = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      beforeDeleteUnlink: () => {
        const writer = new Database(databasePath)
        writer.exec("PRAGMA busy_timeout = 0")
        try {
          writer.exec("BEGIN IMMEDIATE")
          writer.query("update work_session set current_sequence = current_sequence + 1 where singleton = 1").run()
          writer.exec("COMMIT")
        } catch {
          writerRejected = true
          try {
            writer.exec("ROLLBACK")
          } catch {
            // The competing transaction never acquired authority.
          }
        } finally {
          writer.close()
        }
      },
    })

    await deleting.delete({
      sessionID: fixture.sessionID,
      expectedSequence: record.projection.sequence,
      expectedProjectionDigest: record.projection.projectionDigest,
    })
    expect(writerRejected).toBe(true)
    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "not_found" })
  })

  test("preserves a newer session when delete carries stale sequence and digest authority", async () => {
    const fixture = await makeFixture("delete-stale")
    const original = await fixture.store.create(fixture.createInput)
    const newer = await fixture.store.append({
      sessionID: fixture.sessionID,
      expectedSequence: original.projection.sequence,
      observedAt: later(1),
      actor,
      draft: { type: "phase.changed", payload: { phase: "analyzing" } },
    })

    await expect(
      fixture.store.delete({
        sessionID: fixture.sessionID,
        expectedSequence: original.projection.sequence,
        expectedProjectionDigest: original.projection.projectionDigest,
      }),
    ).rejects.toMatchObject({ code: "sequence_conflict" })
    expect(await fixture.store.load(fixture.sessionID)).toEqual(newer)
  })

  test("loads projection and events from one read snapshot", async () => {
    const fixture = await makeFixture("load-snapshot")
    const record = await fixture.store.create(fixture.createInput)
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    let writerRejected = false
    let hookCalls = 0
    const observing = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      afterProjectionRead: () => {
        hookCalls += 1
        const writer = new Database(databasePath)
        writer.exec("PRAGMA busy_timeout = 0")
        try {
          writer.exec("BEGIN IMMEDIATE")
          writer.query("update work_session set current_sequence = current_sequence + 1 where singleton = 1").run()
          writer.exec("COMMIT")
        } catch {
          writerRejected = true
          try {
            writer.exec("ROLLBACK")
          } catch {
            // The read snapshot keeps the competing writer out.
          }
        } finally {
          writer.close()
        }
      },
    })

    expect(await observing.load(fixture.sessionID)).toEqual(record)
    expect(hookCalls).toBe(1)
    expect(writerRejected).toBe(true)
  })

  test.each([
    ["user version", "PRAGMA user_version = 2"],
    ["application id", "PRAGMA application_id = 7"],
    ["extra schema object", "create table injected_state(value text) strict"],
    ["unknown column", "alter table work_session add column injected_value text"],
    [
      "extra event row",
      `insert into work_session_event(sequence, event_digest, previous_digest, event_json) values (99, 'sha256:${"9".repeat(64)}', 'sha256:${"8".repeat(64)}', '{}')`,
    ],
  ] as const)("rejects %s schema tampering", async (_label, mutation) => {
    const fixture = await makeFixture(`schema-${_label.replaceAll(" ", "-")}`)
    await fixture.store.create(fixture.createInput)
    const database = new Database(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID))
    database.exec(mutation)
    database.close()

    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "state_unavailable" })
  })

  test("does not delete a replacement SQLite family during failed-create cleanup", async () => {
    const fixture = await makeFixture("cleanup-swap")
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const directory = dirname(databasePath)
    const displaced = `${directory}.displaced`
    const replacement = "replacement-must-survive"
    const swapping = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      afterEventInsert: () => {
        renameSync(directory, displaced)
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(databasePath, replacement, { mode: 0o600 })
        throw new Error("swap after SQLite insert")
      },
    })

    await expect(swapping.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(await readFile(databasePath, "utf8")).toBe(replacement)
    expect(await exists(displaced)).toBe(true)
  })

  test("fails closed when a session directory is replaced before database open", async () => {
    const fixture = await makeFixture("open-swap")
    await fixture.store.create(fixture.createInput)
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const directory = dirname(databasePath)
    const displaced = `${directory}.displaced`
    const replacement = "replacement-open-target"
    let swapped = false
    const opening = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      beforeDatabaseOpen: () => {
        swapped = true
        renameSync(directory, displaced)
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(databasePath, replacement, { mode: 0o600 })
      },
    })

    await expect(opening.load(fixture.sessionID)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(swapped).toBe(true)
    expect(await readFile(databasePath, "utf8")).toBe(replacement)
  })

  test("fails closed and preserves replacement files on a delete path swap", async () => {
    const fixture = await makeFixture("delete-swap")
    const record = await fixture.store.create(fixture.createInput)
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const directory = dirname(databasePath)
    const displaced = `${directory}.displaced`
    const replacement = "replacement-delete-target"
    let swapped = false
    const deleting = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      beforeDeleteUnlink: () => {
        swapped = true
        renameSync(directory, displaced)
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(databasePath, replacement, { mode: 0o600 })
      },
    })

    await expect(
      deleting.delete({
        sessionID: fixture.sessionID,
        expectedSequence: record.projection.sequence,
        expectedProjectionDigest: record.projection.projectionDigest,
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    expect(swapped).toBe(true)
    expect(await readFile(databasePath, "utf8")).toBe(replacement)
  })

  test("reloads ambiguous effects as reconciliation-required and never invokes an effect adapter", async () => {
    const fixture = await makeFixture("ambiguous-effect")
    const store = createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot })
    expect(Object.keys(store).toSorted()).toEqual(["append", "create", "delete", "export", "list", "load"])
    await store.create(fixture.createInput)
    await store.append({
      sessionID: fixture.sessionID,
      expectedSequence: 1,
      observedAt: later(1),
      actor,
      draft: {
        type: "effect.ambiguous",
        payload: {
          operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670431",
          summary: "Operation receipt is ambiguous",
        },
      },
    })

    const loaded = await createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot }).load(fixture.sessionID)
    expect(loaded.projection.phase).toBe("reconciliation-required")
  })

  test("lists valid sessions without creating state and rejects a corrupt member", async () => {
    const emptyRoot = join(await temporaryDirectory("astra-session-empty-parent-"), "missing")
    const empty = createWorkSessionStoreInternal({ stateRoot: emptyRoot })
    expect(await empty.list()).toEqual([])
    expect(await exists(emptyRoot)).toBe(false)

    const fixture = await makeFixture("list-corrupt")
    await fixture.store.create(fixture.createInput)
    expect((await fixture.store.list()).map((record) => record.sessionID)).toEqual([fixture.sessionID])
    await writeFile(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID), "corrupt")
    await expect(fixture.store.list()).rejects.toMatchObject({ code: "state_unavailable" })
  })
})

async function makeFixture(
  label: string,
  options: Readonly<{ stateInsideWorkspace?: boolean; stateRoot?: string }> = {},
) {
  const workspace = await temporaryDirectory(`astra-session-workspace-${label}-`)
  await writeFile(join(workspace, "README.md"), "fixture\n")
  const facts = await lstat(workspace)
  const stateRoot = options.stateRoot ?? (options.stateInsideWorkspace ? join(workspace, ".astra-state") : await temporaryDirectory(`astra-session-state-${label}-`))
  if (options.stateInsideWorkspace) await rm(stateRoot, { recursive: true, force: true })
  const sessionID = `session-${label}`
  return {
    workspace,
    stateRoot,
    sessionID,
    store: createWorkSessionStoreInternal({ stateRoot }),
    createInput: {
      sessionID,
      workspaceRoot: await realpath(workspace),
      workspaceIdentity: { device: String(facts.dev), inode: String(facts.ino) },
      objective: "Deliver observable work",
      intent: { summary: "Inspect the task", next: "Create a bounded plan" },
      observedAt: startedAt,
      actor,
    },
  }
}

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  await chmod(root, 0o700)
  return root
}

function later(offset: number) {
  return new Date(Date.parse(startedAt) + offset * 1_000).toISOString()
}

async function exists(path: string) {
  return lstat(path).then(() => true, () => false)
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean" || typeof input === "number") {
    return JSON.stringify(input)
  }
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  return `{${Object.entries(input as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`
}
