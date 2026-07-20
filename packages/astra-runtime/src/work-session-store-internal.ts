import { createHash } from "node:crypto"
import { constants, lstatSync, realpathSync } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { dlopen, ptr } from "bun:ffi"
import { Database } from "bun:sqlite"
import {
  createAstraWorkSessionEvent,
  makeAstraWorkSessionEvent,
  parseAstraWorkSessionEvent,
  parseAstraWorkSessionProjection,
  projectAstraWorkSessionEvent,
  type AstraWorkSessionActor,
  type AstraWorkSessionEvent,
  type AstraWorkSessionEventDraft,
  type AstraWorkSessionProjection,
} from "@astra/domain/work-session"
import type { WorkspaceIdentity } from "@astra/domain/workspace-trust"
import { macOSAccountHomeInternal } from "./macos-account-home-internal"

export type CreateWorkSessionInput = Readonly<{
  sessionID: string
  workspaceRoot: string
  workspaceIdentity: WorkspaceIdentity
  objective: string | null
  intent: Readonly<{ summary: string; next: string }>
  observedAt: string
  actor: AstraWorkSessionActor
}>

export type AppendWorkSessionInput = Readonly<{
  sessionID: string
  expectedSequence: number
  observedAt: string
  actor: AstraWorkSessionActor
  draft: AstraWorkSessionEventDraft
}>

export type DeleteWorkSessionInput = Readonly<{
  sessionID: string
  expectedSequence: number
  expectedProjectionDigest: `sha256:${string}`
}>

export type AstraDurableWorkSession = Readonly<{
  projection: AstraWorkSessionProjection
  events: ReadonlyArray<AstraWorkSessionEvent>
}>

export type AstraWorkSessionSummary = Readonly<{
  sessionID: string
  workspaceRoot: string
  phase: AstraWorkSessionProjection["phase"]
  sequence: number
  projectionDigest: `sha256:${string}`
  updatedAt: string
}>

export class WorkSessionStoreError extends Error {
  readonly _tag = "WorkSessionStoreError"

  constructor(
    readonly code:
      | "invalid_input"
      | "not_found"
      | "already_exists"
      | "sequence_conflict"
      | "unsafe_state_path"
      | "state_unavailable",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

type WorkSessionStoreInternalOptions = Readonly<{
  stateRoot: string
  expectedUID?: number
  afterEventInsert?: () => void
  afterProjectionRead?: () => void
  beforeDatabaseOpen?: () => void
  beforeDeleteUnlink?: () => void
}>

type RequiredWorkSessionStoreInternalOptions = Readonly<{
  stateRoot: string
  expectedUID: number
  afterEventInsert?: () => void
  afterProjectionRead?: () => void
  beforeDatabaseOpen?: () => void
  beforeDeleteUnlink?: () => void
}>

type SessionRow = Readonly<{
  singleton: number
  session_id: string
  current_sequence: number
  last_event_digest: string
  projection_digest: string
  projection_json: string
}>

type PathIdentity = Readonly<{ device: string; inode: string }>

type PinnedSessionPath = Readonly<{
  stateRoot: string
  directory: string
  filename: string
  rootHandle: Awaited<ReturnType<typeof open>>
  directoryFD: number
  databaseFD: number
  directoryIdentity: PathIdentity
  databaseIdentity: PathIdentity
  library: ReturnType<typeof openSessionLibrary>
}>

type EventRow = Readonly<{
  sequence: number
  event_digest: string
  previous_digest: string
  event_json: string
}>

const maximumSessions = 256
const digestPattern = /^sha256:[0-9a-f]{64}$/u
const sessionDirectoryPattern = /^[0-9a-f]{64}$/u
const sqliteSuffixes = ["", "-journal", "-shm", "-wal"] as const
const workSessionApplicationID = 0x41535452
const workSessionSchemaVersion = 1
const removeDirectory = 0x80

export function workSessionStateRootInternal() {
  return join(macOSAccountHomeInternal(), "Library", "Application Support", "Astra", "Sessions")
}

export function workSessionDatabasePathInternal(stateRoot: string, sessionID: string) {
  return join(stateRoot, sessionDirectoryName(sessionID), "work-session.sqlite")
}

export function createWorkSessionStoreInternal(options: WorkSessionStoreInternalOptions) {
  const parsed = parseInternalOptions(options)
  const stateRoot = parsed.stateRoot
  const expectedUID = parsed.expectedUID

  return Object.freeze({
    create: (input: CreateWorkSessionInput) => createSession(stateRoot, expectedUID, parsed, input),
    append: (input: AppendWorkSessionInput) => appendSession(stateRoot, expectedUID, parsed, input),
    load: (sessionID: string) => loadSession(stateRoot, expectedUID, parsed, sessionID),
    list: () => listSessions(stateRoot, expectedUID, parsed),
    export: (sessionID: string) => exportSession(stateRoot, expectedUID, parsed, sessionID),
    delete: (input: DeleteWorkSessionInput) => deleteSession(stateRoot, expectedUID, parsed, input),
  })
}

async function createSession(
  stateRoot: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
  input: CreateWorkSessionInput,
): Promise<AstraDurableWorkSession> {
  const event = createAstraWorkSessionEvent(input)
  if (!event.ok) throw new WorkSessionStoreError("invalid_input", "The initial work-session event is invalid")
  const projected = projectAstraWorkSessionEvent(null, event.value)
  if (!projected.ok) throw new WorkSessionStoreError("invalid_input", "The initial work-session projection is invalid")
  const directory = dirname(workSessionDatabasePathInternal(stateRoot, event.value.sessionID))
  const filename = join(directory, "work-session.sqlite")
  await prepareStateRoot(
    stateRoot,
    directory,
    filename,
    event.value.workspaceRoot,
    event.value.workspaceIdentity,
    expectedUID,
  )
  const createdDirectory = await createPrivateSessionDirectory(directory, expectedUID)
  let createdFile = false
  let binding: PinnedSessionPath | null = null
  try {
    const handle = await open(filename, "wx", 0o600).catch((cause) => {
      if (isNodeError(cause, "EEXIST")) {
        throw new WorkSessionStoreError("already_exists", "The work session already exists", cause)
      }
      throw cause
    })
    createdFile = true
    await handle.close()
    await assertSafeDatabaseFamily(filename, expectedUID)
    binding = await pinSessionPath(stateRoot, directory, filename, expectedUID)
    options.beforeDatabaseOpen?.()
    await assertPinnedSessionPath(binding, expectedUID)
    const database = openDatabase(filename, false)
    try {
      await assertPinnedSessionPath(binding, expectedUID)
      initializeSchema(database)
      transaction(database, () => {
        insertEvent(database, event.value)
        options.afterEventInsert?.()
        insertProjection(database, projected.value)
      })
    } finally {
      database.close()
    }
    await assertPinnedSessionPath(binding, expectedUID)
    await assertSafeSessionState(
      stateRoot,
      event.value.workspaceRoot,
      event.value.workspaceIdentity,
      directory,
      filename,
      expectedUID,
    )
    return freezeRecord({ projection: projected.value, events: [event.value] })
  } catch (cause) {
    if (createdFile && binding) await removeNewSessionState(binding, createdDirectory, expectedUID)
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work session could not be created atomically", cause)
  } finally {
    if (binding) closePinnedSessionPath(binding)
  }
}

async function appendSession(
  stateRoot: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
  input: AppendWorkSessionInput,
): Promise<AstraDurableWorkSession> {
  const parsed = parseAppendInput(input)
  const filename = workSessionDatabasePathInternal(stateRoot, parsed.sessionID)
  const directory = dirname(filename)
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertSafeSessionDirectory(directory, expectedUID)
  await assertSafeDatabaseFamily(filename, expectedUID)
  const binding = await pinSessionPath(stateRoot, directory, filename, expectedUID)
  let database: Database | null = null
  try {
    options.beforeDatabaseOpen?.()
    await assertPinnedSessionPath(binding, expectedUID)
    const openedDatabase = openDatabase(filename, false)
    database = openedDatabase
    await assertPinnedSessionPath(binding, expectedUID)
    const result = transaction(openedDatabase, () => {
      const current = loadDatabase(openedDatabase)
      assertSessionPathBinding(current, parsed.sessionID, stateRoot, directory)
      assertNoWorkspaceStateOverlapExisting(
        current.projection.workspaceRoot,
        current.projection.workspaceIdentity,
        stateRoot,
        directory,
        filename,
      )
      if (current.projection.sequence !== parsed.expectedSequence) {
        throw new WorkSessionStoreError("sequence_conflict", "The expected work-session sequence is stale")
      }
      const event = makeAstraWorkSessionEvent(current.projection, {
        observedAt: parsed.observedAt,
        actor: parsed.actor,
        draft: parsed.draft,
      })
      if (!event.ok) throw new WorkSessionStoreError("invalid_input", `The work-session event was rejected: ${event.code}`)
      const projected = projectAstraWorkSessionEvent(current.projection, event.value)
      if (!projected.ok) {
        throw new WorkSessionStoreError("invalid_input", `The work-session projection was rejected: ${projected.code}`)
      }
      insertEvent(openedDatabase, event.value)
      options.afterEventInsert?.()
      updateProjection(openedDatabase, projected.value, parsed.expectedSequence)
      return freezeRecord({ projection: projected.value, events: [...current.events, event.value] })
    })
    await assertPinnedSessionPath(binding, expectedUID)
    return result
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work-session append failed atomically", cause)
  } finally {
    database?.close()
    closePinnedSessionPath(binding)
  }
}

async function loadSession(
  stateRoot: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
  sessionIDInput: string,
) {
  const sessionID = requireSessionID(sessionIDInput)
  const filename = workSessionDatabasePathInternal(stateRoot, sessionID)
  if (!(await pathExists(stateRoot))) throw new WorkSessionStoreError("not_found", "The work session does not exist")
  await assertExistingStateRoot(stateRoot, expectedUID)
  if (!(await pathExists(filename))) throw new WorkSessionStoreError("not_found", "The work session does not exist")
  const directory = dirname(filename)
  await assertSafeSessionDirectory(directory, expectedUID)
  await assertSafeDatabaseFamily(filename, expectedUID)
  const binding = await pinSessionPath(stateRoot, directory, filename, expectedUID)
  let database: Database | null = null
  try {
    options.beforeDatabaseOpen?.()
    await assertPinnedSessionPath(binding, expectedUID)
    const openedDatabase = openDatabase(filename, true)
    database = openedDatabase
    await assertPinnedSessionPath(binding, expectedUID)
    const record = readTransaction(openedDatabase, () => loadDatabase(openedDatabase, options.afterProjectionRead))
    assertSessionPathBinding(record, sessionID, stateRoot, directory)
    await assertNoWorkspaceStateOverlap(
      record.projection.workspaceRoot,
      record.projection.workspaceIdentity,
      stateRoot,
      directory,
      filename,
    )
    await assertPinnedSessionPath(binding, expectedUID)
    return record
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work-session state is unavailable", cause)
  } finally {
    database?.close()
    closePinnedSessionPath(binding)
  }
}

async function listSessions(
  stateRoot: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
): Promise<ReadonlyArray<AstraWorkSessionSummary>> {
  if (!(await pathExists(stateRoot))) return Object.freeze([])
  await assertExistingStateRoot(stateRoot, expectedUID)
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch((cause) => {
    throw new WorkSessionStoreError("state_unavailable", "The work-session state root cannot be listed", cause)
  })
  if (entries.length > maximumSessions) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session state root exceeds its bounded inventory")
  }
  const summaries: Array<AstraWorkSessionSummary> = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !sessionDirectoryPattern.test(entry.name)) {
      throw new WorkSessionStoreError("unsafe_state_path", "The work-session state root contains an unsafe entry")
    }
    const record = await loadSessionDirectory(stateRoot, join(stateRoot, entry.name), expectedUID, options)
    summaries.push({
      sessionID: record.projection.sessionID,
      workspaceRoot: record.projection.workspaceRoot,
      phase: record.projection.phase,
      sequence: record.projection.sequence,
      projectionDigest: record.projection.projectionDigest,
      updatedAt: record.projection.updatedAt,
    })
  }
  return deepFreeze(summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
}

async function loadSessionDirectory(
  stateRoot: string,
  directory: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
) {
  await assertSafeSessionDirectory(directory, expectedUID)
  const filename = join(directory, "work-session.sqlite")
  await assertSafeDatabaseFamily(filename, expectedUID)
  const binding = await pinSessionPath(stateRoot, directory, filename, expectedUID)
  let database: Database | null = null
  try {
    options.beforeDatabaseOpen?.()
    await assertPinnedSessionPath(binding, expectedUID)
    const openedDatabase = openDatabase(filename, true)
    database = openedDatabase
    await assertPinnedSessionPath(binding, expectedUID)
    const record = readTransaction(openedDatabase, () => loadDatabase(openedDatabase, options.afterProjectionRead))
    assertSessionPathBinding(record, record.projection.sessionID, stateRoot, directory)
    await assertNoWorkspaceStateOverlap(
      record.projection.workspaceRoot,
      record.projection.workspaceIdentity,
      stateRoot,
      directory,
      filename,
    )
    await assertPinnedSessionPath(binding, expectedUID)
    return record
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "A listed work session is unavailable", cause)
  } finally {
    database?.close()
    closePinnedSessionPath(binding)
  }
}

async function exportSession(
  stateRoot: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
  sessionID: string,
) {
  const record = await loadSession(stateRoot, expectedUID, options, sessionID)
  return canonicalJson({ schemaVersion: 1, projection: secretFreeProjection(record.projection) })
}

function secretFreeProjection(projection: AstraWorkSessionProjection) {
  return {
    schemaVersion: 1,
    sessionID: projection.sessionID,
    workspaceRoot: projection.workspaceRoot,
    workspaceIdentity: projection.workspaceIdentity,
    sequence: projection.sequence,
    lastEventDigest: projection.lastEventDigest,
    projectionDigest: projection.projectionDigest,
    phase: projection.phase,
    objectiveDigest: projection.objective === null ? null : digestText(projection.objective),
    intentDigest: digestText(canonicalJson(projection.intent)),
    agents: projection.agents.map((agent) => ({
      agentID: agent.agentID,
      parentAgentID: agent.parentAgentID,
      state: agent.state,
      effectAuthority: "none" as const,
    })),
    decisions: projection.decisions.map((decision) => ({
      decisionID: decision.decisionID,
      kind: decision.kind,
      state: decision.state,
      resourcesDigest: digestText(canonicalJson(decision.resources)),
      boundaryDigest: digestText(decision.boundary),
    })),
    evidence: projection.evidence.map((evidence) => ({
      evidenceID: evidence.evidenceID,
      kind: evidence.kind,
      valueDigest: digestText(evidence.value),
    })),
    candidatePatchID: projection.candidatePatchID,
    reconciliationPending: projection.reconciliationPending,
    updatedAt: projection.updatedAt,
  }
}

function digestText(input: string) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

async function deleteSession(
  stateRoot: string,
  expectedUID: number,
  options: RequiredWorkSessionStoreInternalOptions,
  input: DeleteWorkSessionInput,
) {
  const record = exactRecord(input, ["sessionID", "expectedSequence", "expectedProjectionDigest"])
  const sessionID = record ? requireSessionID(record.sessionID) : null
  const expectedSequence = record && Number.isSafeInteger(record.expectedSequence) && (record.expectedSequence as number) >= 1
    ? (record.expectedSequence as number)
    : null
  const expectedProjectionDigest = record && typeof record.expectedProjectionDigest === "string" && digestPattern.test(record.expectedProjectionDigest)
    ? record.expectedProjectionDigest
    : null
  if (!sessionID || expectedSequence === null || !expectedProjectionDigest) {
    throw new WorkSessionStoreError("invalid_input", "The work-session delete binding is invalid")
  }
  const filename = workSessionDatabasePathInternal(stateRoot, sessionID)
  const directory = dirname(filename)
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertDeletableSessionDirectory(directory, filename, expectedUID)
  const binding = await pinSessionPath(stateRoot, directory, filename, expectedUID)
  let database: Database | null = null
  let deletionStarted = false
  let deletionFailure: unknown = null
  try {
    options.beforeDatabaseOpen?.()
    await assertPinnedSessionPath(binding, expectedUID)
    database = openDatabase(filename, false)
    database.exec("PRAGMA locking_mode = EXCLUSIVE")
    database.exec("BEGIN EXCLUSIVE")
    const loaded = loadDatabase(database)
    assertSessionPathBinding(loaded, sessionID, stateRoot, directory)
    assertNoWorkspaceStateOverlapExisting(
      loaded.projection.workspaceRoot,
      loaded.projection.workspaceIdentity,
      stateRoot,
      directory,
      filename,
    )
    if (
      loaded.projection.sequence !== expectedSequence ||
      loaded.projection.projectionDigest !== expectedProjectionDigest
    ) {
      throw new WorkSessionStoreError("sequence_conflict", "The work-session delete binding is stale")
    }
    options.beforeDeleteUnlink?.()
    await assertPinnedSessionPath(binding, expectedUID)
    await assertDeletableSessionDirectory(directory, filename, expectedUID)
    await assertPinnedSessionPath(binding, expectedUID)
    deletionStarted = true
    await unlinkPinnedDatabaseFamily(binding, expectedUID)
  } catch (cause) {
    if (!deletionStarted) {
      try {
        database?.exec("ROLLBACK")
      } catch {
        // The connection may not have acquired the exclusive transaction.
      }
    }
    deletionFailure = cause instanceof WorkSessionStoreError
      ? cause
      : new WorkSessionStoreError("state_unavailable", "The bound work-session state could not be deleted", cause)
  } finally {
    database?.close()
  }
  if (deletionFailure) {
    closePinnedSessionPath(binding)
    throw deletionFailure
  }
  try {
    await removePinnedSessionDirectory(binding)
  } catch (cause) {
    throw new WorkSessionStoreError("state_unavailable", "The bound work-session directory could not be deleted", cause)
  } finally {
    closePinnedSessionPath(binding)
  }
}

function loadDatabase(database: Database, afterProjectionRead?: () => void): AstraDurableWorkSession {
  validateDatabaseContract(database)
  const rows = database
    .query<SessionRow, []>(
      "select singleton, session_id, current_sequence, last_event_digest, projection_digest, projection_json from work_session order by singleton",
    )
    .all()
  if (rows.length !== 1 || rows[0]?.singleton !== 1) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session projection row contract is invalid")
  }
  const row = rows[0]
  afterProjectionRead?.()
  const eventRows = database
    .query<EventRow, []>(
      "select sequence, event_digest, previous_digest, event_json from work_session_event order by sequence",
    )
    .all()
  if (eventRows.length === 0 || eventRows.length > 10_000) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session event chain is empty or over limit")
  }
  const events: Array<AstraWorkSessionEvent> = []
  let projection: AstraWorkSessionProjection | null = null
  for (const [index, eventRow] of eventRows.entries()) {
    const parsedJson = parseStoredJson(eventRow.event_json)
    const event = parseAstraWorkSessionEvent(parsedJson)
    if (
      !event.ok ||
      event.value.sequence !== index + 1 ||
      eventRow.sequence !== event.value.sequence ||
      eventRow.event_digest !== event.value.eventDigest ||
      eventRow.previous_digest !== event.value.previousDigest
    ) {
      throw new WorkSessionStoreError("state_unavailable", "The work-session event chain is corrupt")
    }
    const next = projectAstraWorkSessionEvent(projection, event.value)
    if (!next.ok) throw new WorkSessionStoreError("state_unavailable", "The work-session event chain cannot be projected")
    projection = next.value
    events.push(event.value)
  }
  if (!projection) throw new WorkSessionStoreError("state_unavailable", "The work-session projection is unavailable")
  const persistedProjection = parseAstraWorkSessionProjection(parseStoredJson(row.projection_json))
  if (
    !persistedProjection.ok ||
    row.session_id !== projection.sessionID ||
    row.current_sequence !== projection.sequence ||
    row.last_event_digest !== projection.lastEventDigest ||
    row.projection_digest !== projection.projectionDigest ||
    canonicalJson(persistedProjection.value) !== canonicalJson(projection)
  ) {
    throw new WorkSessionStoreError("state_unavailable", "The persisted work-session projection does not match replay")
  }
  return freezeRecord({ projection, events })
}

function initializeSchema(database: Database) {
  database.exec("PRAGMA trusted_schema = OFF")
  database.exec("PRAGMA journal_mode = DELETE")
  database.exec("PRAGMA synchronous = FULL")
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA busy_timeout = 5000")
  database.exec(`PRAGMA application_id = ${workSessionApplicationID}`)
  database.exec(`PRAGMA user_version = ${workSessionSchemaVersion}`)
  database.exec(`
    create table work_session (
      singleton integer primary key check (singleton = 1),
      session_id text not null unique,
      current_sequence integer not null,
      last_event_digest text not null,
      projection_digest text not null,
      projection_json text not null
    ) strict;
    create table work_session_event (
      sequence integer primary key,
      event_digest text not null unique,
      previous_digest text not null,
      event_json text not null
    ) strict;
  `)
  validateDatabaseContract(database)
}

function validateDatabaseContract(database: Database) {
  const applicationID = database.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id
  const userVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
  const journalMode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode
  const trustedSchema = database.query<{ trusted_schema: number }, []>("PRAGMA trusted_schema").get()?.trusted_schema
  const foreignKeys = database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys
  const quickCheck = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check
  if (
    applicationID !== workSessionApplicationID ||
    userVersion !== workSessionSchemaVersion ||
    journalMode !== "delete" ||
    trustedSchema !== 0 ||
    foreignKeys !== 1 ||
    quickCheck !== "ok"
  ) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session SQLite pragma contract is invalid")
  }

  const schemaObjects = database
    .query<{ type: string; name: string; tbl_name: string }, []>(
      "select type, name, tbl_name from sqlite_schema where name not like 'sqlite_%' order by type, name",
    )
    .all()
  if (
    canonicalJson(schemaObjects) !==
    canonicalJson([
      { type: "table", name: "work_session", tbl_name: "work_session" },
      { type: "table", name: "work_session_event", tbl_name: "work_session_event" },
    ])
  ) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session SQLite schema contains unexpected objects")
  }

  assertExactTableColumns(database, "work_session", [
    ["singleton", "INTEGER", 0, 1],
    ["session_id", "TEXT", 1, 0],
    ["current_sequence", "INTEGER", 1, 0],
    ["last_event_digest", "TEXT", 1, 0],
    ["projection_digest", "TEXT", 1, 0],
    ["projection_json", "TEXT", 1, 0],
  ])
  assertExactTableColumns(database, "work_session_event", [
    ["sequence", "INTEGER", 0, 1],
    ["event_digest", "TEXT", 1, 0],
    ["previous_digest", "TEXT", 1, 0],
    ["event_json", "TEXT", 1, 0],
  ])
  assertExactIndexes(database, "work_session", ["sqlite_autoindex_work_session_1"])
  assertExactIndexes(database, "work_session_event", ["sqlite_autoindex_work_session_event_1"])
}

function assertExactTableColumns(
  database: Database,
  table: string,
  expected: ReadonlyArray<readonly [string, string, number, number]>,
) {
  const columns = database
    .query<{ name: string; type: string; notnull: number; pk: number }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => [column.name, column.type, column.notnull, column.pk])
  if (canonicalJson(columns) !== canonicalJson(expected)) {
    throw new WorkSessionStoreError("state_unavailable", `The ${table} column contract is invalid`)
  }
}

function assertExactIndexes(database: Database, table: string, expectedNames: ReadonlyArray<string>) {
  const indexes = database
    .query<{ name: string }, []>(`PRAGMA index_list(${table})`)
    .all()
    .map((index) => index.name)
    .toSorted()
  if (canonicalJson(indexes) !== canonicalJson([...expectedNames].toSorted())) {
    throw new WorkSessionStoreError("state_unavailable", `The ${table} index contract is invalid`)
  }
}

function insertEvent(database: Database, event: AstraWorkSessionEvent) {
  database
    .query("insert into work_session_event (sequence, event_digest, previous_digest, event_json) values (?, ?, ?, ?)")
    .run(event.sequence, event.eventDigest, event.previousDigest, canonicalJson(event))
}

function insertProjection(database: Database, projection: AstraWorkSessionProjection) {
  database
    .query(
      "insert into work_session (singleton, session_id, current_sequence, last_event_digest, projection_digest, projection_json) values (1, ?, ?, ?, ?, ?)",
    )
    .run(
      projection.sessionID,
      projection.sequence,
      projection.lastEventDigest,
      projection.projectionDigest,
      canonicalJson(projection),
    )
}

function updateProjection(database: Database, projection: AstraWorkSessionProjection, expectedSequence: number) {
  const result = database
    .query(
      "update work_session set current_sequence = ?, last_event_digest = ?, projection_digest = ?, projection_json = ? where singleton = 1 and current_sequence = ?",
    )
    .run(
      projection.sequence,
      projection.lastEventDigest,
      projection.projectionDigest,
      canonicalJson(projection),
      expectedSequence,
    )
  if (result.changes !== 1) throw new WorkSessionStoreError("sequence_conflict", "The work-session writer lost authority")
}

function transaction<Value>(database: Database, use: () => Value): Value {
  database.exec("BEGIN IMMEDIATE")
  try {
    const value = use()
    database.exec("COMMIT")
    return value
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

function readTransaction<Value>(database: Database, use: () => Value): Value {
  database.exec("BEGIN")
  try {
    const value = use()
    database.exec("COMMIT")
    return value
  } catch (cause) {
    database.exec("ROLLBACK")
    throw cause
  }
}

function openDatabase(filename: string, readonly: boolean) {
  try {
    const database = new Database(filename, { readonly, create: false, strict: true })
    database.exec("PRAGMA trusted_schema = OFF")
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec("PRAGMA foreign_keys = ON")
    if (!readonly) {
      database.exec("PRAGMA foreign_keys = ON")
      database.exec("PRAGMA synchronous = FULL")
    }
    return database
  } catch (cause) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session database cannot be opened", cause)
  }
}

function parseAppendInput(input: AppendWorkSessionInput) {
  const record = exactRecord(input, ["sessionID", "expectedSequence", "observedAt", "actor", "draft"])
  if (!record || !Number.isSafeInteger(record.expectedSequence) || (record.expectedSequence as number) < 1) {
    throw new WorkSessionStoreError("invalid_input", "The work-session append binding is invalid")
  }
  return {
    sessionID: requireSessionID(record.sessionID),
    expectedSequence: record.expectedSequence as number,
    observedAt: record.observedAt as string,
    actor: record.actor as AstraWorkSessionActor,
    draft: record.draft as AstraWorkSessionEventDraft,
  }
}

function assertSessionPathBinding(
  record: AstraDurableWorkSession,
  sessionID: string,
  stateRoot: string,
  directory: string,
) {
  if (
    record.projection.sessionID !== sessionID ||
    directory !== dirname(workSessionDatabasePathInternal(stateRoot, record.projection.sessionID))
  ) {
    throw new WorkSessionStoreError("state_unavailable", "The work-session path is not bound to its session identity")
  }
}

async function prepareStateRoot(
  stateRoot: string,
  directory: string,
  filename: string,
  workspaceRoot: string,
  workspaceIdentity: WorkspaceIdentity,
  expectedUID: number,
) {
  await assertStateRootPlacementBeforeCreate(
    stateRoot,
    directory,
    filename,
    workspaceRoot,
    workspaceIdentity,
    expectedUID,
  )
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertNoWorkspaceStateOverlap(workspaceRoot, workspaceIdentity, stateRoot, directory, filename)
}

async function assertStateRootPlacementBeforeCreate(
  stateRoot: string,
  directory: string,
  filename: string,
  workspaceRoot: string,
  workspaceIdentity: WorkspaceIdentity,
  expectedUID: number,
) {
  await assertNoWorkspaceStateOverlap(workspaceRoot, workspaceIdentity, stateRoot, directory, filename)
  let existing = stateRoot
  const missing: Array<string> = []
  while (true) {
    const facts = await optionalLstat(existing)
    if (facts) {
      const canonical = await realpath(existing).catch(() => null)
      if (!facts.isDirectory() || facts.isSymbolicLink() || facts.uid !== expectedUID || canonical !== existing) {
        throw new WorkSessionStoreError("unsafe_state_path", "The nearest session-state ancestor is unsafe")
      }
      if (resolve(existing, ...missing) !== stateRoot) {
        throw new WorkSessionStoreError("unsafe_state_path", "The session-state path crosses an alias")
      }
      return
    }
    const parent = dirname(existing)
    if (parent === existing) throw new WorkSessionStoreError("unsafe_state_path", "No safe state ancestor exists")
    missing.unshift(basename(existing))
    existing = parent
  }
}

async function assertExistingStateRoot(stateRoot: string, expectedUID: number) {
  await assertPrivateDirectory(stateRoot, expectedUID, "state root")
}

async function createPrivateSessionDirectory(directory: string, expectedUID: number) {
  let created = false
  await mkdir(directory, { mode: 0o700 }).then(
    () => {
      created = true
    },
    (cause) => {
      if (!isNodeError(cause, "EEXIST")) throw cause
    },
  )
  await assertSafeSessionDirectory(directory, expectedUID)
  return created
}

async function assertSafeSessionState(
  stateRoot: string,
  workspaceRoot: string,
  workspaceIdentity: WorkspaceIdentity,
  directory: string,
  filename: string,
  expectedUID: number,
) {
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertSafeSessionDirectory(directory, expectedUID)
  await assertSafeDatabaseFamily(filename, expectedUID)
  await assertNoWorkspaceStateOverlap(
    workspaceRoot,
    workspaceIdentity,
    stateRoot,
    directory,
    filename,
  )
}

async function assertSafeSessionDirectory(directory: string, expectedUID: number) {
  await assertPrivateDirectory(directory, expectedUID, "session directory")
  if (!sessionDirectoryPattern.test(basename(directory))) {
    throw new WorkSessionStoreError("unsafe_state_path", "The session directory name is not canonical")
  }
}

async function assertPrivateDirectory(path: string, expectedUID: number, label: string) {
  const facts = await optionalLstat(path)
  const canonical = facts ? await realpath(path).catch(() => null) : null
  if (
    !facts ||
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    facts.uid !== expectedUID ||
    (facts.mode & 0o077) !== 0 ||
    canonical !== path
  ) {
    throw new WorkSessionStoreError("unsafe_state_path", `The ${label} is not canonical, private, and account-owned`)
  }
}

async function assertSafeDatabaseFamily(filename: string, expectedUID: number) {
  for (const suffix of sqliteSuffixes) {
    const candidate = `${filename}${suffix}`
    if (!(await pathExists(candidate))) {
      if (suffix === "") throw new WorkSessionStoreError("not_found", "The work-session database does not exist")
      continue
    }
    await assertSafeStateFile(candidate, expectedUID)
  }
}

async function assertSafeStateFile(path: string, expectedUID: number) {
  const facts = await optionalLstat(path)
  const canonical = facts ? await realpath(path).catch(() => null) : null
  if (
    !facts ||
    !facts.isFile() ||
    facts.isSymbolicLink() ||
    facts.nlink !== 1 ||
    facts.uid !== expectedUID ||
    (facts.mode & 0o077) !== 0 ||
    canonical !== path
  ) {
    throw new WorkSessionStoreError("unsafe_state_path", "A work-session SQLite file has an unsafe identity")
  }
}

async function assertDeletableSessionDirectory(directory: string, filename: string, expectedUID: number) {
  await assertSafeSessionDirectory(directory, expectedUID)
  const allowed = new Set(sqliteSuffixes.map((suffix) => basename(`${filename}${suffix}`)))
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => !allowed.has(entry.name))) {
    throw new WorkSessionStoreError("unsafe_state_path", "The session directory contains unbound state")
  }
  await assertSafeDatabaseFamily(filename, expectedUID)
}

async function assertNoWorkspaceStateOverlap(
  workspaceRoot: string,
  workspaceIdentity: WorkspaceIdentity,
  stateRoot: string,
  directory: string,
  filename: string,
) {
  const canonicalWorkspace = await realpath(workspaceRoot).catch((cause) => {
    throw new WorkSessionStoreError("unsafe_state_path", "The workspace root cannot be canonicalized", cause)
  })
  const workspaceFacts = await lstat(canonicalWorkspace).catch((cause) => {
    throw new WorkSessionStoreError("unsafe_state_path", "The workspace identity cannot be read", cause)
  })
  if (
    canonicalWorkspace !== workspaceRoot ||
    !workspaceFacts.isDirectory() ||
    workspaceFacts.isSymbolicLink() ||
    String(workspaceFacts.dev) !== workspaceIdentity.device ||
    String(workspaceFacts.ino) !== workspaceIdentity.inode
  ) {
    throw new WorkSessionStoreError("unsafe_state_path", "The workspace root is not bound to its canonical identity")
  }
  for (const statePath of [stateRoot, directory, filename]) {
    const resolvedState = await resolveUncreatedPath(statePath)
    if (isInside(canonicalWorkspace, resolvedState) || isInside(resolvedState, canonicalWorkspace)) {
      throw new WorkSessionStoreError("unsafe_state_path", "The workspace and work-session state paths overlap")
    }
  }
}

function assertNoWorkspaceStateOverlapExisting(
  workspaceRoot: string,
  workspaceIdentity: WorkspaceIdentity,
  stateRoot: string,
  directory: string,
  filename: string,
) {
  try {
    const canonicalWorkspace = realpathSync(workspaceRoot)
    const workspaceFacts = lstatSync(canonicalWorkspace)
    if (
      canonicalWorkspace !== workspaceRoot ||
      !workspaceFacts.isDirectory() ||
      workspaceFacts.isSymbolicLink() ||
      String(workspaceFacts.dev) !== workspaceIdentity.device ||
      String(workspaceFacts.ino) !== workspaceIdentity.inode
    ) {
      throw new WorkSessionStoreError("unsafe_state_path", "The workspace root changed canonical identity")
    }
    for (const statePath of [stateRoot, directory, filename]) {
      const canonicalState = realpathSync(statePath)
      if (isInside(canonicalWorkspace, canonicalState) || isInside(canonicalState, canonicalWorkspace)) {
        throw new WorkSessionStoreError("unsafe_state_path", "The workspace and work-session state paths overlap")
      }
    }
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("unsafe_state_path", "The workspace/state identity could not be revalidated", cause)
  }
}

async function resolveUncreatedPath(input: string) {
  let current = input
  const missing: Array<string> = []
  while (true) {
    const canonical = await realpath(current).catch((cause) => {
      if (isNodeError(cause, "ENOENT")) return null
      throw new WorkSessionStoreError("unsafe_state_path", "The state path cannot be canonicalized", cause)
    })
    if (canonical) return resolve(canonical, ...missing)
    const parent = dirname(current)
    if (parent === current) throw new WorkSessionStoreError("unsafe_state_path", "No canonical state ancestor exists")
    missing.unshift(basename(current))
    current = parent
  }
}

function parseInternalOptions(input: WorkSessionStoreInternalOptions): RequiredWorkSessionStoreInternalOptions {
  const record = exactOptionalRecord(input, [
    "stateRoot",
    "expectedUID",
    "afterEventInsert",
    "afterProjectionRead",
    "beforeDatabaseOpen",
    "beforeDeleteUnlink",
  ])
  if (!record) throw new WorkSessionStoreError("invalid_input", "The internal work-session options are invalid")
  const expectedUID = Object.hasOwn(record, "expectedUID") ? record.expectedUID : effectiveUID()
  if (!Number.isSafeInteger(expectedUID) || (expectedUID as number) < 0) {
    throw new WorkSessionStoreError("invalid_input", "The expected work-session account identity is invalid")
  }
  for (const key of ["afterEventInsert", "afterProjectionRead", "beforeDatabaseOpen", "beforeDeleteUnlink"] as const) {
    if (Object.hasOwn(record, key) && typeof record[key] !== "function") {
      throw new WorkSessionStoreError("invalid_input", "An internal work-session test seam is invalid")
    }
  }
  return Object.freeze({
    stateRoot: requireCanonicalStateRoot(record.stateRoot),
    expectedUID: expectedUID as number,
    ...(typeof record.afterEventInsert === "function" ? { afterEventInsert: record.afterEventInsert as () => void } : {}),
    ...(typeof record.afterProjectionRead === "function"
      ? { afterProjectionRead: record.afterProjectionRead as () => void }
      : {}),
    ...(typeof record.beforeDatabaseOpen === "function"
      ? { beforeDatabaseOpen: record.beforeDatabaseOpen as () => void }
      : {}),
    ...(typeof record.beforeDeleteUnlink === "function"
      ? { beforeDeleteUnlink: record.beforeDeleteUnlink as () => void }
      : {}),
  })
}

async function pinSessionPath(
  stateRoot: string,
  directory: string,
  filename: string,
  expectedUID: number,
): Promise<PinnedSessionPath> {
  const library = openSessionLibrary()
  const rootHandle = await open(
    stateRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch((cause) => {
    throw new WorkSessionStoreError("state_unavailable", "The work-session state root could not be pinned", cause)
  })
  let directoryFD = -1
  let databaseFD = -1
  try {
    await assertHandleMatchesPath(rootHandle, stateRoot, expectedUID, true)
    directoryFD = library.symbols.openat(
      rootHandle.fd,
      cString(basename(directory)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
    )
    if (directoryFD < 0) throw new WorkSessionStoreError("state_unavailable", "The session directory could not be pinned")
    const directoryFacts = await Bun.file(directoryFD).stat()
    assertSafePinnedFacts(directoryFacts, expectedUID, true)
    databaseFD = library.symbols.openat(
      directoryFD,
      cString(basename(filename)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    )
    if (databaseFD < 0) throw new WorkSessionStoreError("state_unavailable", "The session database could not be pinned")
    const databaseFacts = await Bun.file(databaseFD).stat()
    assertSafePinnedFacts(databaseFacts, expectedUID, false)
    const binding = {
      stateRoot,
      directory,
      filename,
      rootHandle,
      directoryFD,
      databaseFD,
      directoryIdentity: identityOf(directoryFacts),
      databaseIdentity: identityOf(databaseFacts),
      library,
    } as const
    await assertPinnedSessionPath(binding, expectedUID)
    return binding
  } catch (cause) {
    if (databaseFD >= 0) library.symbols.close(databaseFD)
    if (directoryFD >= 0) library.symbols.close(directoryFD)
    await rootHandle.close().catch(() => undefined)
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work-session state could not be pinned", cause)
  }
}

async function assertPinnedSessionPath(binding: PinnedSessionPath, expectedUID: number) {
  await assertHandleMatchesPath(binding.rootHandle, binding.stateRoot, expectedUID, true)
  const reboundDirectoryFD = binding.library.symbols.openat(
    binding.rootHandle.fd,
    cString(basename(binding.directory)),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0,
  )
  if (reboundDirectoryFD < 0) {
    throw new WorkSessionStoreError("state_unavailable", "The pinned session directory is no longer bound")
  }
  try {
    const [pinnedDirectory, reboundDirectory, pathDirectory] = await Promise.all([
      Bun.file(binding.directoryFD).stat(),
      Bun.file(reboundDirectoryFD).stat(),
      lstat(binding.directory),
    ])
    if (
      !sameIdentity(pinnedDirectory, reboundDirectory) ||
      !sameIdentity(pinnedDirectory, pathDirectory) ||
      !sameIdentityValue(binding.directoryIdentity, pinnedDirectory)
    ) {
      throw new WorkSessionStoreError("state_unavailable", "The session directory identity changed")
    }
    assertSafePinnedFacts(reboundDirectory, expectedUID, true)
    const reboundDatabaseFD = binding.library.symbols.openat(
      reboundDirectoryFD,
      cString(basename(binding.filename)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    )
    if (reboundDatabaseFD < 0) {
      throw new WorkSessionStoreError("state_unavailable", "The pinned session database is no longer bound")
    }
    try {
      const [pinnedDatabase, reboundDatabase, pathDatabase] = await Promise.all([
        Bun.file(binding.databaseFD).stat(),
        Bun.file(reboundDatabaseFD).stat(),
        lstat(binding.filename),
      ])
      if (
        !sameIdentity(pinnedDatabase, reboundDatabase) ||
        !sameIdentity(pinnedDatabase, pathDatabase) ||
        !sameIdentityValue(binding.databaseIdentity, pinnedDatabase)
      ) {
        throw new WorkSessionStoreError("state_unavailable", "The session database identity changed")
      }
      assertSafePinnedFacts(reboundDatabase, expectedUID, false)
    } finally {
      binding.library.symbols.close(reboundDatabaseFD)
    }
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The pinned work-session path is unavailable", cause)
  } finally {
    binding.library.symbols.close(reboundDirectoryFD)
  }
}

async function assertHandleMatchesPath(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  expectedUID: number,
  directory: boolean,
) {
  const [pinned, current] = await Promise.all([handle.stat(), lstat(path)])
  if (!sameIdentity(pinned, current)) {
    throw new WorkSessionStoreError("state_unavailable", "A pinned work-session ancestor changed identity")
  }
  assertSafePinnedFacts(pinned, expectedUID, directory)
}

function assertSafePinnedFacts(
  facts: Readonly<{
    dev: number | bigint
    ino: number | bigint
    uid: number
    mode: number
    nlink: number
    isDirectory(): boolean
    isFile(): boolean
  }>,
  expectedUID: number,
  directory: boolean,
) {
  if (
    (directory ? !facts.isDirectory() : !facts.isFile()) ||
    facts.uid !== expectedUID ||
    (facts.mode & 0o077) !== 0 ||
    (!directory && facts.nlink !== 1)
  ) {
    throw new WorkSessionStoreError("unsafe_state_path", "A pinned work-session path is unsafe")
  }
}

async function removeNewSessionState(
  binding: PinnedSessionPath,
  createdDirectory: boolean,
  expectedUID: number,
) {
  try {
    await assertPinnedSessionPath(binding, expectedUID)
    await unlinkPinnedDatabaseFamily(binding, expectedUID)
    if (createdDirectory) await removePinnedSessionDirectory(binding)
    return true
  } catch {
    return false
  }
}

async function unlinkPinnedDatabaseFamily(binding: PinnedSessionPath, expectedUID: number) {
  for (const suffix of ["-journal", "-shm", "-wal", ""] as const) {
    const name = `${basename(binding.filename)}${suffix}`
    const descriptor = binding.library.symbols.openat(
      binding.directoryFD,
      cString(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    )
    if (descriptor < 0) {
      if (suffix === "") throw new WorkSessionStoreError("state_unavailable", "The pinned database disappeared")
      continue
    }
    try {
      const facts = await Bun.file(descriptor).stat()
      assertSafePinnedFacts(facts, expectedUID, false)
      if (suffix === "" && !sameIdentityValue(binding.databaseIdentity, facts)) {
        throw new WorkSessionStoreError("state_unavailable", "The pinned database identity changed before deletion")
      }
      const finalDescriptor = binding.library.symbols.openat(
        binding.directoryFD,
        cString(name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0,
      )
      if (finalDescriptor < 0) throw new WorkSessionStoreError("state_unavailable", "A database file changed before deletion")
      try {
        const finalFacts = await Bun.file(finalDescriptor).stat()
        if (!sameIdentity(facts, finalFacts)) {
          throw new WorkSessionStoreError("state_unavailable", "A database file was replaced before deletion")
        }
      } finally {
        binding.library.symbols.close(finalDescriptor)
      }
      if (binding.library.symbols.unlinkat(binding.directoryFD, cString(name), 0) !== 0) {
        throw new WorkSessionStoreError("state_unavailable", "A pinned database file could not be deleted")
      }
    } finally {
      binding.library.symbols.close(descriptor)
    }
  }
}

async function removePinnedSessionDirectory(binding: PinnedSessionPath) {
  const reboundFD = binding.library.symbols.openat(
    binding.rootHandle.fd,
    cString(basename(binding.directory)),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0,
  )
  if (reboundFD < 0) throw new WorkSessionStoreError("state_unavailable", "The session directory disappeared")
  try {
    const facts = await Bun.file(reboundFD).stat()
    if (!sameIdentityValue(binding.directoryIdentity, facts)) {
      throw new WorkSessionStoreError("state_unavailable", "The session directory was replaced before deletion")
    }
  } finally {
    binding.library.symbols.close(reboundFD)
  }
  if (binding.library.symbols.unlinkat(binding.rootHandle.fd, cString(basename(binding.directory)), removeDirectory) !== 0) {
    throw new WorkSessionStoreError("state_unavailable", "The pinned session directory could not be deleted")
  }
}

function closePinnedSessionPath(binding: PinnedSessionPath) {
  binding.library.symbols.close(binding.databaseFD)
  binding.library.symbols.close(binding.directoryFD)
  void binding.rootHandle.close().catch(() => undefined)
}

function identityOf(facts: Readonly<{ dev: number | bigint; ino: number | bigint }>): PathIdentity {
  return { device: String(facts.dev), inode: String(facts.ino) }
}

function sameIdentity(
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>,
) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function sameIdentityValue(identity: PathIdentity, facts: Readonly<{ dev: number | bigint; ino: number | bigint }>) {
  return identity.device === String(facts.dev) && identity.inode === String(facts.ino)
}

function openSessionLibrary() {
  if (process.platform !== "darwin") {
    throw new WorkSessionStoreError("state_unavailable", "Descriptor-relative session state requires macOS")
  }
  return dlopen("/usr/lib/libSystem.B.dylib", {
    close: { args: ["i32"], returns: "i32" },
    openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
  })
}

function cString(input: string) {
  return ptr(Buffer.from(`${input}\0`))
}

function requireCanonicalStateRoot(input: unknown) {
  if (typeof input !== "string" || !isAbsolute(input) || resolve(input) !== input || /\p{C}/u.test(input)) {
    throw new WorkSessionStoreError("unsafe_state_path", "The work-session state root is not canonical")
  }
  return input
}

function requireSessionID(input: unknown) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    input !== input.trim() ||
    /\p{C}/u.test(input) ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._:@/-]*$/u.test(input)
  ) {
    throw new WorkSessionStoreError("invalid_input", "The work-session ID is invalid")
  }
  return input
}

function sessionDirectoryName(sessionID: string) {
  return createHash("sha256").update(`astra.work-session.path.v1\0${requireSessionID(sessionID)}`).digest("hex")
}

function exactRecord(input: unknown, fields: ReadonlyArray<string>) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const allowed = new Set(fields)
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    record[key] = descriptor.value
  }
  if (fields.some((field) => !Object.hasOwn(record, field))) return null
  return record
}

function exactOptionalRecord(input: unknown, fields: ReadonlyArray<string>) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const allowed = new Set(fields)
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    record[key] = descriptor.value
  }
  return Object.hasOwn(record, "stateRoot") ? record : null
}

function parseStoredJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch (cause) {
    throw new WorkSessionStoreError("state_unavailable", "Stored work-session JSON is invalid", cause)
  }
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input)
  if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  if (typeof input !== "object") throw new TypeError("Work-session persistence requires canonical JSON")
  return `{${Object.entries(input)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`
}

function freezeRecord(input: AstraDurableWorkSession): AstraDurableWorkSession {
  return deepFreeze({ projection: input.projection, events: [...input.events] })
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function isInside(root: string, candidatePath: string) {
  const candidate = relative(resolve(root), resolve(candidatePath))
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return null
    throw new WorkSessionStoreError("unsafe_state_path", "A work-session state path is unreadable", cause)
  }
}

async function pathExists(path: string) {
  return optionalLstat(path).then((facts) => facts !== null)
}

function effectiveUID() {
  if (typeof process.geteuid !== "function") {
    throw new WorkSessionStoreError("unsafe_state_path", "The effective account identity is unavailable")
  }
  return process.geteuid()
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}
