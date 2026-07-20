import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { constants, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { dlopen, ptr } from "bun:ffi"
import {
  createWorkSessionStoreInternal,
  workSessionDatabasePathInternal,
  workSessionStateRootInternal,
  type AppendWorkSessionInput,
  type DeleteWorkSessionInput,
} from "../src/work-session-store-internal"
import { providerConversationGenesisDigest, type AstraWorkSessionEventDraft } from "@astra/domain/work-session"

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

  test("atomically upgrades v1 to a durable v2 conversation and reloads two turns after restart", async () => {
    const fixture = await makeFixture("provider-conversation-restart")
    const created = await fixture.store.create(fixture.createInput)
    expect(created.projection.schemaVersion).toBe(1)
    expect("conversation" in created.projection).toBe(false)

    const first = await fixture.store.append({
      sessionID: fixture.sessionID,
      expectedSequence: 1,
      observedAt: later(1),
      actor,
      draft: providerTurn("turn-1", providerConversationGenesisDigest, "First question", "First answer"),
    })
    if (first.projection.schemaVersion !== 2) throw new Error("provider turn must upgrade the projection")
    const second = await fixture.store.append({
      sessionID: fixture.sessionID,
      expectedSequence: 2,
      observedAt: later(2),
      actor,
      draft: providerTurn("turn-2", first.projection.conversation.historyDigest, "Second question", "Second answer"),
    })

    const loaded = await createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot }).load(fixture.sessionID)
    expect(loaded).toEqual(second)
    expect(loaded.projection.schemaVersion).toBe(2)
    if (loaded.projection.schemaVersion !== 2) throw new Error("provider conversation must reload as v2")
    expect(loaded.projection.conversation.turns.map((turn) => [turn.userText, turn.assistantText])).toEqual([
      ["First question", "First answer"],
      ["Second question", "Second answer"],
    ])
  })

  test("rolls back a provider turn and keeps v1 when durable append fails", async () => {
    const fixture = await makeFixture("provider-conversation-rollback")
    await fixture.store.create(fixture.createInput)
    const interrupted = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      afterEventInsert: () => {
        throw new Error("injected provider transcript interruption")
      },
    })

    await expect(
      interrupted.append({
        sessionID: fixture.sessionID,
        expectedSequence: 1,
        observedAt: later(1),
        actor,
        draft: providerTurn("turn-1", providerConversationGenesisDigest, "First question", "First answer"),
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    const loaded = await fixture.store.load(fixture.sessionID)
    expect(loaded.projection.schemaVersion).toBe(1)
    expect(loaded.events).toHaveLength(1)
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

  test.each([
    [
      "missing STRICT and singleton CHECK",
      `alter table work_session rename to old_work_session;
       create table work_session (
         singleton integer primary key,
         session_id text not null unique,
         current_sequence integer not null,
         last_event_digest text not null,
         projection_digest text not null,
         projection_json text not null
       );
       insert into work_session select * from old_work_session;
       drop table old_work_session`,
    ],
    [
      "changed UNIQUE target",
      `alter table work_session rename to old_work_session;
       create table work_session (
         singleton integer primary key check (singleton = 1),
         session_id text not null,
         current_sequence integer not null,
         last_event_digest text not null,
         projection_digest text not null unique,
         projection_json text not null
       ) strict;
       insert into work_session select * from old_work_session;
       drop table old_work_session`,
    ],
  ] as const)("rejects canonical schema with %s despite matching names and columns", async (_label, mutation) => {
    const fixture = await makeFixture(`schema-contract-${_label.replaceAll(" ", "-")}`)
    await fixture.store.create(fixture.createInput)
    const database = new Database(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID))
    database.exec(mutation)
    database.close()

    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "state_unavailable" })
  })

  test("never initializes a replacement inserted after exclusive file creation but before pinning", async () => {
    const fixture = await makeFixture("create-wx-swap")
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const displaced = `${databasePath}.created-inode`
    const replacement = "replacement-must-stay-inert"
    let swapped = false
    const creating = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      afterCreateFileBeforePin: () => {
        swapped = true
        renameSync(databasePath, displaced)
        writeFileSync(databasePath, replacement, { mode: 0o600 })
      },
    })

    await expect(creating.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(swapped).toBe(true)
    expect(await readFile(databasePath, "utf8")).toBe(replacement)
    expect((await lstat(displaced)).size).toBe(0)
  })

  test("never initializes a replacement inserted after the final create identity check", async () => {
    const fixture = await makeFixture("create-final-swap")
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const displaced = `${databasePath}.created-inode`
    const replacement = "replacement-after-final-create-check"
    let swapped = false
    const creating = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      afterFinalCreateIdentityCheck: () => {
        swapped = true
        renameSync(databasePath, displaced)
        writeFileSync(databasePath, replacement, { mode: 0o600 })
      },
    })

    await expect(creating.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(swapped).toBe(true)
    expect(await readFile(databasePath, "utf8")).toBe(replacement)
    expect((await lstat(displaced)).size).toBe(0)
    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "not_found" })
  })

  test.each(["session-directory-fsync", "state-root-fsync"] as const)(
    "never reports create success when the %s publication boundary fails",
    async (nativeFailure) => {
      const fixture = await makeFixture(`create-${nativeFailure}`)
      const failing = createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot, nativeFailure })

      await expect(failing.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
      const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
      expect((await lstat(databasePath)).size).toBe(0)
      await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "not_found" })
      expect(await fixture.store.list()).toEqual([])
    },
  )

  test("serializes concurrent interprocess creates across capacity scan and publication", async () => {
    const fixture = await makeFixture("interprocess-create-lock")
    const children = [
      spawnConcurrentCreate(fixture, "interprocess-session-a"),
      spawnConcurrentCreate(fixture, "interprocess-session-b"),
    ]
    const results = await Promise.all(children.map(readConcurrentCreate))

    expect(results.filter((result) => result.status === "created")).toHaveLength(1)
    expect(results.filter((result) => result.status === "failed" && result.code === "state_unavailable")).toHaveLength(1)
    expect(await readdir(fixture.stateRoot)).toHaveLength(1)
  })

  test("retries a contended same-process lock asynchronously without blocking the event loop", async () => {
    const fixture = await makeFixture("same-process-lock-progress")
    let markLocked!: () => void
    let releaseHolder!: () => void
    const locked = new Promise<void>((resolve) => { markLocked = resolve })
    const release = new Promise<void>((resolve) => { releaseHolder = resolve })
    let holderDone = false
    const holderStore = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      physicalEntryLimit: 2,
      afterStateRootLock: async () => {
        markLocked()
        await release
      },
    })
    const holder = holderStore
      .create({ ...fixture.createInput, sessionID: "same-process-holder" })
      .finally(() => { holderDone = true })

    try {
      await locked
      await Bun.sleep(20)
      expect(holderDone).toBe(false)
      let heartbeat = false
      setTimeout(() => { heartbeat = true }, 0)
      const waiter = createWorkSessionStoreInternal({
        stateRoot: fixture.stateRoot,
        physicalEntryLimit: 2,
      }).create({ ...fixture.createInput, sessionID: "same-process-waiter" })
      await Bun.sleep(25)
      expect(heartbeat).toBe(true)
      expect(holderDone).toBe(false)
      releaseHolder()
      await expect(Promise.all([holder, waiter])).resolves.toHaveLength(2)
    } finally {
      releaseHolder()
      await holder.catch(() => undefined)
    }
  })

  test("times out a permanently contended state-root lock without a session claim", async () => {
    const fixture = await makeFixture("state-root-lock-timeout")
    let markLocked!: () => void
    let releaseHolder!: () => void
    const locked = new Promise<void>((resolve) => { markLocked = resolve })
    const release = new Promise<void>((resolve) => { releaseHolder = resolve })
    let holderDone = false
    const holder = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      physicalEntryLimit: 2,
      afterStateRootLock: async () => {
        markLocked()
        await release
      },
    })
      .create({ ...fixture.createInput, sessionID: "timeout-holder" })
      .finally(() => { holderDone = true })

    try {
      await locked
      await Bun.sleep(20)
      expect(holderDone).toBe(false)
      const waiterID = "timeout-waiter"
      const waiter = createWorkSessionStoreInternal({
        stateRoot: fixture.stateRoot,
        physicalEntryLimit: 2,
        stateRootLockTimeoutMs: 25,
        stateRootLockRetryDelayMs: 5,
      })
      await expect(waiter.create({ ...fixture.createInput, sessionID: waiterID })).rejects.toMatchObject({
        code: "state_unavailable",
      })
      expect(await exists(workSessionDatabasePathInternal(fixture.stateRoot, waiterID))).toBe(false)
    } finally {
      releaseHolder()
      await holder
    }
  })

  test("never acquires a retry after validation crosses the lock deadline", async () => {
    const fixture = await makeFixture("state-root-lock-late-retry")
    let markLocked!: () => void
    let releaseHolder!: () => void
    const locked = new Promise<void>((resolve) => { markLocked = resolve })
    const release = new Promise<void>((resolve) => { releaseHolder = resolve })
    const holder = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      physicalEntryLimit: 2,
      afterStateRootLock: async () => {
        markLocked()
        await release
      },
    }).create({ ...fixture.createInput, sessionID: "late-retry-holder" })
    let validationDelayed = false

    try {
      await locked
      const waiterID = "late-retry-waiter"
      const waiter = createWorkSessionStoreInternal({
        stateRoot: fixture.stateRoot,
        physicalEntryLimit: 2,
        stateRootLockTimeoutMs: 20,
        stateRootLockRetryDelayMs: 1,
        beforeStateRootLockRetryValidation: async () => {
          validationDelayed = true
          releaseHolder()
          await holder
          await Bun.sleep(30)
        },
      })

      await expect(waiter.create({ ...fixture.createInput, sessionID: waiterID })).rejects.toMatchObject({
        code: "state_unavailable",
      })
      expect(validationDelayed).toBe(true)
      expect(await exists(workSessionDatabasePathInternal(fixture.stateRoot, waiterID))).toBe(false)
    } finally {
      releaseHolder()
      await holder
    }
  })

  test("fails closed without a session claim when the pinned state-root lock cannot be acquired", async () => {
    const fixture = await makeFixture("state-root-lock-failure")
    const before = await readdir(fixture.stateRoot)
    const failing = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      nativeFailure: "state-root-lock",
    })

    await expect(failing.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(await readdir(fixture.stateRoot)).toEqual(before)
    expect(await exists(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID))).toBe(false)
  })

  test("never reports first-start success when a newly created state component parent cannot sync", async () => {
    const parent = await temporaryDirectory("astra-session-first-start-parent-")
    const stateRoot = join(parent, "Astra", "Sessions")
    const fixture = await makeFixture("first-start-parent-fsync", { stateRoot })
    const failing = createWorkSessionStoreInternal({
      stateRoot,
      nativeFailure: "state-root-parent-fsync",
    })

    await expect(failing.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(await exists(workSessionDatabasePathInternal(stateRoot, fixture.sessionID))).toBe(false)
    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "not_found" })
  })

  test("does not require parent publication sync when the state root already exists", async () => {
    const fixture = await makeFixture("existing-root-parent-sync")
    const store = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      nativeFailure: "state-root-parent-fsync",
    })

    const created = await store.create(fixture.createInput)
    expect(await store.load(fixture.sessionID)).toEqual(created)
  })

  test("creates first-start components only below the pinned parent after a same-UID path replacement", async () => {
    const parent = await temporaryDirectory("astra-session-parent-replacement-")
    const stateRoot = join(parent, "Astra", "Sessions")
    const displaced = join(parent, "Astra.displaced")
    const replacement = join(parent, "Astra")
    const fixture = await makeFixture("first-start-parent-replacement", { stateRoot })
    let replaced = false
    const store = createWorkSessionStoreInternal({
      stateRoot,
      afterStateRootParentPin: (parentPath, component) => {
        if (component !== "Sessions") return
        replaced = true
        renameSync(parentPath, displaced)
        mkdirSync(parentPath, { mode: 0o700 })
      },
    })

    await expect(store.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(replaced).toBe(true)
    expect(await exists(join(replacement, "Sessions"))).toBe(false)
    expect(await exists(join(displaced, "Sessions"))).toBe(true)
    expect(await exists(workSessionDatabasePathInternal(stateRoot, fixture.sessionID))).toBe(false)
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

  test("a replacement after the final delete identity check is never unlinked", async () => {
    const fixture = await makeFixture("delete-final-swap")
    const record = await fixture.store.create(fixture.createInput)
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const directory = dirname(databasePath)
    const displaced = `${directory}.displaced`
    const replacement = "replacement-after-final-check"
    let swapped = false
    const deleting = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      beforeDeleteTombstoneWrite: () => {
        swapped = true
        renameSync(directory, displaced)
        mkdirSync(directory, { mode: 0o700 })
        writeFileSync(databasePath, replacement, { mode: 0o600 })
      },
    })

    await deleting.delete({
      sessionID: fixture.sessionID,
      expectedSequence: record.projection.sequence,
      expectedProjectionDigest: record.projection.projectionDigest,
    })
    expect(swapped).toBe(true)
    expect(await readFile(databasePath, "utf8")).toBe(replacement)
    expect((await lstat(join(displaced, "work-session.sqlite"))).size).toBe(0)
    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "not_found" })
  })

  test("scrubs every pinned SQLite family inode before exposing a delete tombstone", async () => {
    const fixture = await makeFixture("delete-privacy")
    const secret = "ASTRA_DELETE_CANARY_must_not_remain"
    const record = await fixture.store.create({ ...fixture.createInput, objective: secret })
    const databasePath = workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID)
    const deleting = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      beforeDeleteUnlink: () => {
        for (const suffix of ["-journal", "-shm", "-wal"] as const) {
          writeFileSync(`${databasePath}${suffix}`, `${secret}:${suffix}`, { mode: 0o600 })
        }
      },
    })

    await deleting.delete({
      sessionID: fixture.sessionID,
      expectedSequence: record.projection.sequence,
      expectedProjectionDigest: record.projection.projectionDigest,
    })

    for (const name of await readdir(dirname(databasePath))) {
      const bytes = await readFile(join(dirname(databasePath), name))
      expect(bytes.byteLength, name).toBe(0)
      expect(bytes.toString("utf8"), name).not.toContain(secret)
    }
    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "not_found" })
    expect(await fixture.store.list()).toEqual([])
  })

  test.each(["scrub", "tombstone", "tombstone-fsync"] as const)(
    "never reports delete success when the %s boundary fails",
    async (nativeFailure) => {
      const fixture = await makeFixture(`delete-failure-${nativeFailure}`)
      const record = await fixture.store.create(fixture.createInput)
      const failing = createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot, nativeFailure })

      await expect(
        failing.delete({
          sessionID: fixture.sessionID,
          expectedSequence: record.projection.sequence,
          expectedProjectionDigest: record.projection.projectionDigest,
        }),
      ).rejects.toMatchObject({ code: "state_unavailable" })
      if (nativeFailure === "scrub") {
        expect(await fixture.store.load(fixture.sessionID)).toEqual(record)
      } else {
        await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "state_unavailable" })
      }
    },
  )

  test("closes the current SQLite-family descriptor when validation fails before registration", async () => {
    const fixture = await makeFixture("family-fd-balance")
    const record = await fixture.store.create(fixture.createInput)
    const descriptorEvents: Array<Readonly<{ state: "opened" | "closed"; suffix: string; fd: number }>> = []
    const failing = createWorkSessionStoreInternal({
      stateRoot: fixture.stateRoot,
      nativeFailure: "database-family-stat",
      observeDatabaseFamilyFD: (event) => descriptorEvents.push(event),
    })

    await expect(
      failing.delete({
        sessionID: fixture.sessionID,
        expectedSequence: record.projection.sequence,
        expectedProjectionDigest: record.projection.projectionDigest,
      }),
    ).rejects.toMatchObject({ code: "state_unavailable" })
    expect(descriptorEvents.map(({ state, suffix }) => ({ state, suffix }))).toEqual([
      { state: "opened", suffix: "" },
      { state: "closed", suffix: "" },
    ])
    expect(await fixture.store.load(fixture.sessionID)).toEqual(record)
  })

  test.each([
    ["status", (record: Record<string, unknown>) => ({ ...record, status: "future" })],
    ["session ID", (record: Record<string, unknown>) => ({ ...record, sessionID: "../invalid" })],
    ["digest", (record: Record<string, unknown>) => ({ ...record, projectionDigest: "not-a-digest" })],
    ["sequence", (record: Record<string, unknown>) => ({ ...record, sequence: 0 })],
    [
      "status union",
      (record: Record<string, unknown>) => ({ ...record, status: "create-failed", sequence: 1 }),
    ],
  ] as const)("treats a corrupt tombstone %s as unavailable for load, list, and delete", async (_label, corrupt) => {
    const fixture = await makeFixture(`corrupt-tombstone-${_label.replace(" ", "-")}`)
    const record = await fixture.store.create(fixture.createInput)
    const deleteInput = {
      sessionID: fixture.sessionID,
      expectedSequence: record.projection.sequence,
      expectedProjectionDigest: record.projection.projectionDigest,
    } as const
    await fixture.store.delete(deleteInput)
    await overwriteRawTombstone(fixture.stateRoot, fixture.sessionID, corrupt({
      schemaVersion: 1,
      sessionID: fixture.sessionID,
      status: "deleted",
      sequence: record.projection.sequence,
      projectionDigest: record.projection.projectionDigest,
    }))

    await expect(fixture.store.load(fixture.sessionID)).rejects.toMatchObject({ code: "state_unavailable" })
    await expect(fixture.store.list()).rejects.toMatchObject({ code: "state_unavailable" })
    await expect(fixture.store.delete(deleteInput)).rejects.toMatchObject({ code: "state_unavailable" })
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

  test("counts only live sessions while strictly validating more than 256 tombstoned entries", async () => {
    const fixture = await makeFixture("list-tombstone-capacity")
    await fixture.store.create(fixture.createInput)
    await seedRawTombstonedDirectories(
      fixture.stateRoot,
      Array.from({ length: 257 }, (_, index) => `tombstoned-${index.toString().padStart(3, "0")}`),
    )

    expect((await fixture.store.list()).map((entry) => entry.sessionID)).toEqual([fixture.sessionID])
  })

  test("refuses create before effects when the bounded physical inventory is full", async () => {
    const fixture = await makeFixture("physical-capacity")
    const sessionIDs = ["physical-capacity-0", "physical-capacity-1", "physical-capacity-2"]
    await seedRawTombstonedDirectories(fixture.stateRoot, sessionIDs)
    const before = await readdir(fixture.stateRoot)
    const bounded = createWorkSessionStoreInternal({ stateRoot: fixture.stateRoot, physicalEntryLimit: 3 })

    await expect(bounded.create(fixture.createInput)).rejects.toMatchObject({ code: "state_unavailable" })
    expect(await readdir(fixture.stateRoot)).toEqual(before)
    expect(await exists(workSessionDatabasePathInternal(fixture.stateRoot, fixture.sessionID))).toBe(false)
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

function providerTurn(
  turnID: string,
  priorHistoryDigest: `sha256:${string}`,
  userText: string,
  assistantText: string,
): Extract<AstraWorkSessionEventDraft, { type: "provider.turn-recorded" }> {
  return {
    type: "provider.turn-recorded",
    payload: {
      priorHistoryDigest,
      turn: {
        turnID,
        operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670431",
        receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670432",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
        adapterDigest: `sha256:${"1".repeat(64)}`,
        credentialProfile: "anthropic-api-key",
        accountFingerprint: `sha256:${"2".repeat(64)}`,
        destination: { method: "POST", origin: "https://api.anthropic.com", path: "/v1/messages" },
        contextDigest: `sha256:${"3".repeat(64)}`,
        requestBodyDigest: `sha256:${"4".repeat(64)}`,
        requestBytes: Buffer.byteLength(userText),
        workspaceBaselineDigest: `sha256:${"5".repeat(64)}`,
        gitBaselineDigest: `sha256:${"6".repeat(64)}`,
        userText,
        assistantText,
        assistantTextDigest: `sha256:${Bun.CryptoHasher.hash("sha256", assistantText, "hex")}`,
        assistantTextBytes: Buffer.byteLength(assistantText),
        finishReason: "stop",
        assurance: "observed_not_verified",
      },
    },
  }
}

async function exists(path: string) {
  return lstat(path).then(() => true, () => false)
}

async function seedRawTombstonedDirectories(stateRoot: string, sessionIDs: ReadonlyArray<string>) {
  await Promise.all(
    sessionIDs.map((sessionID) => mkdir(dirname(workSessionDatabasePathInternal(stateRoot, sessionID)), { mode: 0o700 })),
  )
  const library = openXattrLibrary()
  const handle = await open(stateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const sessionID of sessionIDs) {
      writeRawTombstone(handle.fd, library, sessionID, {
        schemaVersion: 1,
        sessionID,
        status: "deleted",
        sequence: 1,
        projectionDigest: `sha256:${"a".repeat(64)}`,
      })
    }
    await handle.sync()
  } finally {
    await handle.close()
    library.close()
  }
}

async function overwriteRawTombstone(stateRoot: string, sessionID: string, tombstone: unknown) {
  const library = openXattrLibrary()
  const handle = await open(stateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    writeRawTombstone(handle.fd, library, sessionID, tombstone)
    await handle.sync()
  } finally {
    await handle.close()
    library.close()
  }
}

function writeRawTombstone(
  rootFD: number,
  library: ReturnType<typeof openXattrLibrary>,
  sessionID: string,
  tombstone: unknown,
) {
  const directoryName = basename(dirname(workSessionDatabasePathInternal("/state", sessionID)))
  const name = Buffer.from(`com.astra.work-session.tombstone.${directoryName}\0`)
  const value = Buffer.from(canonicalJson(tombstone))
  if (library.symbols.fsetxattr(rootFD, ptr(name), ptr(value), value.length, 0, 0) !== 0) {
    throw new Error(`could not seed tombstone for ${sessionID}`)
  }
}

function openXattrLibrary() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    fsetxattr: { args: ["i32", "ptr", "ptr", "usize", "u32", "i32"], returns: "i32" },
  })
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

function spawnConcurrentCreate(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  sessionID: string,
) {
  const helperURL = new URL("../src/work-session-store-internal.ts", import.meta.url).href
  const input = { ...fixture.createInput, sessionID }
  const source = `
    const { createWorkSessionStoreInternal } = await import(${JSON.stringify(helperURL)});
    const store = createWorkSessionStoreInternal({
      stateRoot: ${JSON.stringify(fixture.stateRoot)},
      physicalEntryLimit: 1,
      afterStateRootLock: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150),
    });
    try {
      await store.create(${JSON.stringify(input)});
      process.stdout.write(JSON.stringify({ status: "created" }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: "failed", code: error?.code ?? "unknown" }));
    }
  `
  return Bun.spawn([process.execPath, "--eval", source], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function readConcurrentCreate(child: ReturnType<typeof spawnConcurrentCreate>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  return JSON.parse(stdout) as Readonly<{ status: "created" | "failed"; code?: string }>
}
