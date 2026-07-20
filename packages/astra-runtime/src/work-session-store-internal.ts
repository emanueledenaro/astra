import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
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
}>

type SessionRow = Readonly<{
  session_id: string
  current_sequence: number
  last_event_digest: string
  projection_digest: string
  projection_json: string
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

export function workSessionStateRootInternal() {
  return join(macOSAccountHomeInternal(), "Library", "Application Support", "Astra", "Sessions")
}

export function workSessionDatabasePathInternal(stateRoot: string, sessionID: string) {
  return join(stateRoot, sessionDirectoryName(sessionID), "work-session.sqlite")
}

export function createWorkSessionStoreInternal(options: WorkSessionStoreInternalOptions) {
  const stateRoot = requireCanonicalStateRoot(options.stateRoot)
  const expectedUID = options.expectedUID ?? effectiveUID()

  return Object.freeze({
    create: (input: CreateWorkSessionInput) => createSession(stateRoot, expectedUID, options, input),
    append: (input: AppendWorkSessionInput) => appendSession(stateRoot, expectedUID, options, input),
    load: (sessionID: string) => loadSession(stateRoot, expectedUID, sessionID),
    list: () => listSessions(stateRoot, expectedUID),
    export: (sessionID: string) => exportSession(stateRoot, expectedUID, sessionID),
    delete: (input: DeleteWorkSessionInput) => deleteSession(stateRoot, expectedUID, input),
  })
}

async function createSession(
  stateRoot: string,
  expectedUID: number,
  options: WorkSessionStoreInternalOptions,
  input: CreateWorkSessionInput,
): Promise<AstraDurableWorkSession> {
  const event = createAstraWorkSessionEvent(input)
  if (!event.ok) throw new WorkSessionStoreError("invalid_input", "The initial work-session event is invalid")
  const projected = projectAstraWorkSessionEvent(null, event.value)
  if (!projected.ok) throw new WorkSessionStoreError("invalid_input", "The initial work-session projection is invalid")
  await prepareStateRoot(stateRoot, event.value.workspaceRoot, expectedUID)
  const directory = dirname(workSessionDatabasePathInternal(stateRoot, event.value.sessionID))
  const createdDirectory = await createPrivateSessionDirectory(directory, expectedUID)
  const filename = join(directory, "work-session.sqlite")
  let createdFile = false
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
    const database = openDatabase(filename, false)
    try {
      initializeSchema(database)
      transaction(database, () => {
        insertEvent(database, event.value)
        options.afterEventInsert?.()
        insertProjection(database, projected.value)
      })
    } finally {
      database.close()
    }
    await assertSafeSessionState(stateRoot, event.value.workspaceRoot, directory, filename, expectedUID)
    return freezeRecord({ projection: projected.value, events: [event.value] })
  } catch (cause) {
    if (createdFile) await removeNewSessionState(filename, directory, createdDirectory)
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work session could not be created atomically", cause)
  }
}

async function appendSession(
  stateRoot: string,
  expectedUID: number,
  options: WorkSessionStoreInternalOptions,
  input: AppendWorkSessionInput,
): Promise<AstraDurableWorkSession> {
  const parsed = parseAppendInput(input)
  const filename = workSessionDatabasePathInternal(stateRoot, parsed.sessionID)
  const directory = dirname(filename)
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertSafeSessionDirectory(directory, expectedUID)
  await assertSafeDatabaseFamily(filename, expectedUID)
  const database = openDatabase(filename, false)
  try {
    return transaction(database, () => {
      const current = loadDatabase(database)
      assertSessionPathBinding(current, parsed.sessionID, stateRoot, directory)
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
      insertEvent(database, event.value)
      options.afterEventInsert?.()
      updateProjection(database, projected.value, parsed.expectedSequence)
      return freezeRecord({ projection: projected.value, events: [...current.events, event.value] })
    })
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work-session append failed atomically", cause)
  } finally {
    database.close()
  }
}

async function loadSession(stateRoot: string, expectedUID: number, sessionIDInput: string) {
  const sessionID = requireSessionID(sessionIDInput)
  const filename = workSessionDatabasePathInternal(stateRoot, sessionID)
  if (!(await pathExists(stateRoot))) throw new WorkSessionStoreError("not_found", "The work session does not exist")
  await assertExistingStateRoot(stateRoot, expectedUID)
  if (!(await pathExists(filename))) throw new WorkSessionStoreError("not_found", "The work session does not exist")
  const directory = dirname(filename)
  await assertSafeSessionDirectory(directory, expectedUID)
  await assertSafeDatabaseFamily(filename, expectedUID)
  const database = openDatabase(filename, true)
  try {
    const record = loadDatabase(database)
    assertSessionPathBinding(record, sessionID, stateRoot, directory)
    await assertOutsideWorkspace(record.projection.workspaceRoot, stateRoot)
    return record
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "The work-session state is unavailable", cause)
  } finally {
    database.close()
  }
}

async function listSessions(stateRoot: string, expectedUID: number): Promise<ReadonlyArray<AstraWorkSessionSummary>> {
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
    const record = await loadSessionDirectory(stateRoot, join(stateRoot, entry.name), expectedUID)
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

async function loadSessionDirectory(stateRoot: string, directory: string, expectedUID: number) {
  await assertSafeSessionDirectory(directory, expectedUID)
  const filename = join(directory, "work-session.sqlite")
  await assertSafeDatabaseFamily(filename, expectedUID)
  const database = openDatabase(filename, true)
  try {
    const record = loadDatabase(database)
    assertSessionPathBinding(record, record.projection.sessionID, stateRoot, directory)
    await assertOutsideWorkspace(record.projection.workspaceRoot, stateRoot)
    return record
  } catch (cause) {
    if (cause instanceof WorkSessionStoreError) throw cause
    throw new WorkSessionStoreError("state_unavailable", "A listed work session is unavailable", cause)
  } finally {
    database.close()
  }
}

async function exportSession(stateRoot: string, expectedUID: number, sessionID: string) {
  const record = await loadSession(stateRoot, expectedUID, sessionID)
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
    updatedAt: projection.updatedAt,
  }
}

function digestText(input: string) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

async function deleteSession(stateRoot: string, expectedUID: number, input: DeleteWorkSessionInput) {
  const record = exactRecord(input, ["sessionID", "expectedProjectionDigest"])
  const sessionID = record ? requireSessionID(record.sessionID) : null
  const expectedProjectionDigest = record && typeof record.expectedProjectionDigest === "string" && digestPattern.test(record.expectedProjectionDigest)
    ? record.expectedProjectionDigest
    : null
  if (!sessionID || !expectedProjectionDigest) {
    throw new WorkSessionStoreError("invalid_input", "The work-session delete binding is invalid")
  }
  const loaded = await loadSession(stateRoot, expectedUID, sessionID)
  if (loaded.projection.projectionDigest !== expectedProjectionDigest) {
    throw new WorkSessionStoreError("sequence_conflict", "The work-session delete binding is stale")
  }
  const filename = workSessionDatabasePathInternal(stateRoot, sessionID)
  const directory = dirname(filename)
  await assertDeletableSessionDirectory(directory, filename, expectedUID)
  for (const suffix of sqliteSuffixes) {
    const candidate = `${filename}${suffix}`
    if (!(await pathExists(candidate))) continue
    await assertSafeStateFile(candidate, expectedUID)
    await unlink(candidate).catch((cause) => {
      throw new WorkSessionStoreError("state_unavailable", "The bound work-session file could not be deleted", cause)
    })
  }
  await rmdir(directory).catch((cause) => {
    throw new WorkSessionStoreError("state_unavailable", "The bound work-session directory could not be deleted", cause)
  })
}

function loadDatabase(database: Database): AstraDurableWorkSession {
  const row = database
    .query<SessionRow, []>(
      "select session_id, current_sequence, last_event_digest, projection_digest, projection_json from work_session where singleton = 1",
    )
    .get()
  if (!row) throw new WorkSessionStoreError("state_unavailable", "The work-session projection row is missing")
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

function openDatabase(filename: string, readonly: boolean) {
  try {
    const database = new Database(filename, { readonly, create: false, strict: true })
    database.exec("PRAGMA trusted_schema = OFF")
    database.exec("PRAGMA busy_timeout = 5000")
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

async function prepareStateRoot(stateRoot: string, workspaceRoot: string, expectedUID: number) {
  await assertStateRootPlacementBeforeCreate(stateRoot, workspaceRoot, expectedUID)
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertOutsideWorkspace(workspaceRoot, stateRoot)
}

async function assertStateRootPlacementBeforeCreate(stateRoot: string, workspaceRoot: string, expectedUID: number) {
  await assertOutsideWorkspace(workspaceRoot, stateRoot)
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
  directory: string,
  filename: string,
  expectedUID: number,
) {
  await assertExistingStateRoot(stateRoot, expectedUID)
  await assertOutsideWorkspace(workspaceRoot, stateRoot)
  await assertSafeSessionDirectory(directory, expectedUID)
  await assertSafeDatabaseFamily(filename, expectedUID)
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

async function assertOutsideWorkspace(workspaceRoot: string, stateRoot: string) {
  const canonicalWorkspace = await realpath(workspaceRoot).catch((cause) => {
    throw new WorkSessionStoreError("unsafe_state_path", "The workspace root cannot be canonicalized", cause)
  })
  const resolvedState = await resolveUncreatedPath(stateRoot)
  if (isInside(canonicalWorkspace, resolvedState)) {
    throw new WorkSessionStoreError("unsafe_state_path", "The work-session state root resolves inside the workspace")
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

async function removeNewSessionState(filename: string, directory: string, createdDirectory: boolean) {
  for (const suffix of sqliteSuffixes) await unlink(`${filename}${suffix}`).catch(() => undefined)
  if (createdDirectory) await rmdir(directory).catch(() => undefined)
}

function requireCanonicalStateRoot(input: string) {
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
