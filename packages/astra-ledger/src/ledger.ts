import {
  parseOperationEventEnvelope,
  parseOperationID,
  type ActorRef,
  type OperationEventEnvelope,
  type OperationID,
} from "@astra/domain/operation-contract"
import {
  operationStates,
  projectOperationEvent,
  type OperationEvent,
  type OperationState,
} from "@astra/domain/operation"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { digestEvent } from "./digest"
import {
  AdmissionConflictError,
  EventConflictError,
  LedgerCorruptionError,
  LedgerInjectedFault,
  LedgerNotInitializedError,
  LedgerReadLimitError,
  OperationConcurrencyError,
  OperationEventValidationError,
  OperationTransitionError,
  mapStorageError,
  type LedgerFaultPoint,
  type OperationLedgerError,
} from "./error"
import { parseLifecyclePayload, type ParsedLifecyclePayload } from "./event-payload"

const ledgerSchemaVersion = 1
const maximumReadEvents = 256
const maximumIntegrityEvents = 100_000
const maximumIntegrityOperations = 10_000
const emptyDigest = `sha256:${"0".repeat(64)}`

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type Database = Effect.Success<typeof makeDatabase>
type QueryExecutor = Pick<Database, "all" | "run">

export type OperationEventDraft = Readonly<{
  eventID: string
  operationID: OperationID
  name: OperationEvent
  schemaVersion: number
  recordedAt: string
  observedAt: string
  actor: ActorRef
  causationID: string | null
  correlationID: string
  attemptID: string | null
  payload: Readonly<Record<string, unknown>>
  redaction: OperationEventEnvelope["redaction"]
  externalBlobDigest: string | null
}>

export type AppendOperationEvent = Readonly<{
  expectedState: OperationState | null
  expectedSequence: number
  event: OperationEventDraft
}>

export type PersistedOperationEvent = OperationEventEnvelope & Readonly<{ globalCursor: number }>

export type OperationRecord = Readonly<{
  operationID: OperationID
  admissionKey: string
  state: OperationState
  sequence: number
  decisionID: string | null
  lastEventID: string
  lastCursor: number
  lastDigest: string
  updatedAt: string
}>

export type AppendOperationEventResult = Readonly<{
  kind: "appended" | "replayed"
  event: PersistedOperationEvent
  operation: OperationRecord
}>

export type LedgerDurability = Readonly<{
  journalMode: string
  foreignKeys: boolean
  busyTimeoutMilliseconds: number
  synchronous: "OFF" | "NORMAL" | "FULL" | "EXTRA"
}>

export interface OperationLedger {
  initialize(): Effect.Effect<void, OperationLedgerError>
  append(command: AppendOperationEvent): Effect.Effect<AppendOperationEventResult, OperationLedgerError>
  getOperation(operationID: OperationID): Effect.Effect<OperationRecord | null, OperationLedgerError>
  readEvents(
    operationID: OperationID,
    options: Readonly<{ limit: number }>,
  ): Effect.Effect<ReadonlyArray<PersistedOperationEvent>, OperationLedgerError>
  readGlobalCursor(): Effect.Effect<number, OperationLedgerError>
  readDurability(): Effect.Effect<LedgerDurability, OperationLedgerError>
}

type LedgerFault = (point: LedgerFaultPoint) => Effect.Effect<void, LedgerInjectedFault>

export function makeOperationLedger(): Effect.Effect<
  OperationLedger,
  never,
  import("effect/unstable/sql/SqlClient").SqlClient
> {
  return makeOperationLedgerInternal(() => Effect.void)
}

export function makeOperationLedgerInternal(
  injectFault: LedgerFault,
): Effect.Effect<OperationLedger, never, import("effect/unstable/sql/SqlClient").SqlClient> {
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    return {
      initialize: () => initialize(db),
      append: (command) => append(db, command, injectFault),
      getOperation: (operationID) => getOperation(db, operationID),
      readEvents: (operationID, options) => readEvents(db, operationID, options.limit),
      readGlobalCursor: () => readGlobalCursor(db),
      readDurability: () => readDurability(db),
    }
  })
}

function initialize(db: Database): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    yield* db.run(sql`PRAGMA journal_mode = WAL`)
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* db.run(sql`PRAGMA busy_timeout = 5000`)
    yield* db.run(sql`PRAGMA synchronous = FULL`)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS ledger_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        last_cursor INTEGER NOT NULL CHECK (last_cursor >= 0)
      )
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS operation_event (
        event_id TEXT PRIMARY KEY,
        global_cursor INTEGER NOT NULL UNIQUE CHECK (global_cursor > 0),
        operation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        name TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        attempt_id TEXT,
        payload_json TEXT NOT NULL,
        previous_digest TEXT,
        digest TEXT NOT NULL,
        redaction TEXT NOT NULL CHECK (redaction IN ('public', 'internal', 'sensitive_redacted')),
        external_blob_digest TEXT,
        UNIQUE (operation_id, sequence)
      )
    `)
    yield* db.run(sql`
      CREATE INDEX IF NOT EXISTS operation_event_operation_cursor
      ON operation_event (operation_id, sequence)
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS operation_projection (
        operation_id TEXT PRIMARY KEY,
        admission_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        decision_id TEXT,
        last_event_id TEXT NOT NULL,
        last_cursor INTEGER NOT NULL UNIQUE CHECK (last_cursor > 0),
        last_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (last_event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(
      sql`INSERT OR IGNORE INTO ledger_meta (singleton, schema_version, last_cursor) VALUES (1, ${ledgerSchemaVersion}, 0)`,
    )
    const meta = yield* requireInitialized(db)
    yield* verifyLedgerIntegrity(db, meta)
  }).pipe(Effect.mapError(mapStorageError("Failed to initialize the operation ledger")))
}

function append(
  db: Database,
  command: AppendOperationEvent,
  injectFault: LedgerFault,
): Effect.Effect<AppendOperationEventResult, OperationLedgerError> {
  if (!Number.isSafeInteger(command.expectedSequence) || command.expectedSequence < 0) {
    return Effect.fail(
      new OperationEventValidationError(
        "Expected sequence must be a non-negative safe integer",
        "$.expectedSequence",
        "expected_non_negative_integer",
      ),
    )
  }

  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const meta = yield* requireInitialized(tx)
          yield* verifyLedgerIntegrity(tx, meta)
          const existingRows = yield* tx.all<EventRow>(
            sql`SELECT * FROM operation_event WHERE event_id = ${command.event.eventID} LIMIT 1`,
          )
          if (existingRows[0]) return yield* replayExistingEvent(tx, command, existingRows[0])

          const replay = yield* loadAndVerifyOperation(tx, command.event.operationID, maximumReadEvents)
          const actualState = replay?.operation.state ?? null
          const actualSequence = replay?.operation.sequence ?? 0
          if (actualState !== command.expectedState || actualSequence !== command.expectedSequence) {
            return yield* Effect.fail(
              new OperationConcurrencyError(
                command.expectedState,
                command.expectedSequence,
                actualState,
                actualSequence,
              ),
            )
          }

          const transition = projectOperationEvent(actualState, command.event.name)
          if (!transition.accepted) {
            return yield* Effect.fail(new OperationTransitionError(actualState, command.event.name, transition.code))
          }

          const nextCursor = meta.last_cursor + 1
          const persisted = yield* parseAndDigestEvent(
            command.event,
            actualSequence + 1,
            nextCursor,
            replay?.operation.lastDigest ?? null,
          )
          const lifecycle = yield* parseStoredLifecycle(persisted)
          yield* validateLifecycleLink(replay?.operation ?? null, command.event.name, lifecycle)

          if (lifecycle.admissionKey) {
            const admissionRows = yield* tx.all<{ operation_id: string }>(
              sql`SELECT operation_id FROM operation_projection WHERE admission_key = ${lifecycle.admissionKey} LIMIT 1`,
            )
            if (admissionRows[0] && admissionRows[0].operation_id !== command.event.operationID) {
              return yield* Effect.fail(new AdmissionConflictError(lifecycle.admissionKey))
            }
          }

          yield* insertEvent(tx, persisted)
          yield* injectFault("after_event_insert")
          const operation = yield* projectEvent(tx, replay?.operation ?? null, transition.state, persisted, lifecycle)
          yield* injectFault("after_projection_update")
          yield* tx.run(sql`UPDATE ledger_meta SET last_cursor = ${nextCursor} WHERE singleton = 1`)

          return { kind: "appended" as const, event: persisted, operation }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapStorageError("Failed to append the operation event")))
}

function replayExistingEvent(
  tx: QueryExecutor,
  command: AppendOperationEvent,
  row: EventRow,
): Effect.Effect<AppendOperationEventResult, OperationLedgerError> {
  return Effect.gen(function* () {
    const replay = yield* loadAndVerifyOperation(tx, requireStoredOperationID(row.operation_id), maximumReadEvents)
    if (!replay) return yield* Effect.fail(new LedgerCorruptionError(`Event ${row.event_id} has no projection`))
    const existing = replay.events.find((event) => event.eventID === row.event_id)
    if (!existing) return yield* Effect.fail(new LedgerCorruptionError(`Event ${row.event_id} was not replayed`))
    if (command.event.operationID !== existing.operationID) {
      return yield* Effect.fail(new EventConflictError(command.event.eventID))
    }
    const candidate = yield* parseAndDigestEvent(
      command.event,
      existing.sequence,
      existing.globalCursor,
      existing.previousDigest,
    )
    if (candidate.digest !== existing.digest) {
      return yield* Effect.fail(new EventConflictError(command.event.eventID))
    }
    return { kind: "replayed", event: existing, operation: replay.operation }
  })
}

function getOperation(
  db: Database,
  operationID: OperationID,
): Effect.Effect<OperationRecord | null, OperationLedgerError> {
  return Effect.gen(function* () {
    yield* requireInitialized(db)
    return (yield* loadAndVerifyOperation(db, operationID, maximumReadEvents))?.operation ?? null
  }).pipe(Effect.mapError(mapStorageError("Failed to read the operation")))
}

function readEvents(
  db: Database,
  operationID: OperationID,
  limit: number,
): Effect.Effect<ReadonlyArray<PersistedOperationEvent>, OperationLedgerError> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumReadEvents) {
    return Effect.fail(new LedgerReadLimitError(limit))
  }
  return Effect.gen(function* () {
    yield* requireInitialized(db)
    return (yield* loadAndVerifyOperation(db, operationID, limit))?.events ?? []
  }).pipe(Effect.mapError(mapStorageError("Failed to read operation events")))
}

function readGlobalCursor(db: Database): Effect.Effect<number, OperationLedgerError> {
  return requireInitialized(db).pipe(
    Effect.map((meta) => meta.last_cursor),
    Effect.mapError(mapStorageError("Failed to read the global ledger cursor")),
  )
}

function readDurability(db: Database): Effect.Effect<LedgerDurability, OperationLedgerError> {
  return Effect.gen(function* () {
    yield* requireInitialized(db)
    const journal = yield* db.all<{ journal_mode: string }>(sql`PRAGMA journal_mode`)
    const foreignKeys = yield* db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
    const busyTimeout = yield* db.all<{ timeout: number }>(sql`PRAGMA busy_timeout`)
    const synchronous = yield* db.all<{ synchronous: number }>(sql`PRAGMA synchronous`)
    const synchronousNames = ["OFF", "NORMAL", "FULL", "EXTRA"] as const
    const synchronousName = synchronousNames[synchronous[0]?.synchronous ?? -1]
    if (!journal[0] || !foreignKeys[0] || !busyTimeout[0] || !synchronousName) {
      return yield* Effect.fail(new LedgerCorruptionError("SQLite durability pragmas returned invalid values"))
    }
    return {
      journalMode: journal[0].journal_mode.toLowerCase(),
      foreignKeys: foreignKeys[0].foreign_keys === 1,
      busyTimeoutMilliseconds: busyTimeout[0].timeout,
      synchronous: synchronousName,
    }
  }).pipe(Effect.mapError(mapStorageError("Failed to read ledger durability")))
}

function requireInitialized(db: QueryExecutor): Effect.Effect<MetaRow, OperationLedgerError> {
  return Effect.gen(function* () {
    const rows = yield* db.all<MetaRow>(
      sql`SELECT schema_version, last_cursor FROM ledger_meta WHERE singleton = 1 LIMIT 1`,
    )
    if (!rows[0]) return yield* Effect.fail(new LedgerNotInitializedError())
    if (rows[0].schema_version !== ledgerSchemaVersion || !Number.isSafeInteger(rows[0].last_cursor)) {
      return yield* Effect.fail(new LedgerCorruptionError("Ledger metadata has an unknown or malformed schema"))
    }
    const cursorRows = yield* db.all<{ last_cursor: number }>(
      sql`SELECT COALESCE(MAX(global_cursor), 0) AS last_cursor FROM operation_event`,
    )
    if (!cursorRows[0] || cursorRows[0].last_cursor !== rows[0].last_cursor) {
      return yield* Effect.fail(new LedgerCorruptionError("Global cursor metadata does not match the event ledger"))
    }
    return rows[0]
  }).pipe(Effect.mapError(mapStorageError("Failed to read ledger metadata")))
}

function verifyLedgerIntegrity(db: QueryExecutor, meta: MetaRow): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    if (meta.last_cursor > maximumIntegrityEvents) {
      return yield* Effect.fail(new LedgerCorruptionError("Ledger exceeds the bounded integrity scan capacity"))
    }
    const cursors = yield* db.all<{ global_cursor: number }>(sql`
      SELECT global_cursor FROM operation_event
      ORDER BY global_cursor ASC
      LIMIT ${maximumIntegrityEvents + 1}
    `)
    if (cursors.length !== meta.last_cursor) {
      return yield* Effect.fail(new LedgerCorruptionError("Global cursor sequence is incomplete"))
    }
    for (const [index, row] of cursors.entries()) {
      if (row.global_cursor !== index + 1) {
        return yield* Effect.fail(new LedgerCorruptionError("Global cursor sequence is not contiguous"))
      }
    }

    const eventOperations = yield* db.all<{ operation_id: string }>(sql`
      SELECT DISTINCT operation_id FROM operation_event
      ORDER BY operation_id ASC
      LIMIT ${maximumIntegrityOperations + 1}
    `)
    const projectedOperations = yield* db.all<{ operation_id: string }>(sql`
      SELECT operation_id FROM operation_projection
      ORDER BY operation_id ASC
      LIMIT ${maximumIntegrityOperations + 1}
    `)
    if (
      eventOperations.length > maximumIntegrityOperations ||
      eventOperations.length !== projectedOperations.length ||
      eventOperations.some((row, index) => row.operation_id !== projectedOperations[index]?.operation_id)
    ) {
      return yield* Effect.fail(new LedgerCorruptionError("Event aggregates and projections do not match"))
    }
    for (const row of eventOperations) {
      yield* loadAndVerifyOperation(db, requireStoredOperationID(row.operation_id), maximumReadEvents)
    }
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to verify ledger integrity")))
}

function loadAndVerifyOperation(
  db: QueryExecutor,
  operationID: OperationID,
  limit: number,
): Effect.Effect<ReplayResult | null, OperationLedgerError> {
  return Effect.gen(function* () {
    const projectionRows = yield* db.all<ProjectionRow>(
      sql`SELECT * FROM operation_projection WHERE operation_id = ${operationID} LIMIT 1`,
    )
    const rows = yield* db.all<EventRow>(
      sql`SELECT * FROM operation_event WHERE operation_id = ${operationID} ORDER BY sequence ASC LIMIT ${limit + 1}`,
    )
    if (rows.length > limit) return yield* Effect.fail(new LedgerReadLimitError(limit))
    if (!projectionRows[0] && rows.length === 0) return null
    if (!projectionRows[0] || rows.length === 0) {
      return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} has incomplete durable state`))
    }

    const events: Array<PersistedOperationEvent> = []
    let state: OperationState | null = null
    let previousDigest: string | null = null
    let previousCursor = 0
    let admission: string | null = null
    let decision: string | null = null
    for (const [index, row] of rows.entries()) {
      const event = yield* decodeEventRow(row)
      const lifecycle = yield* parseStoredLifecycle(event)
      if (
        event.sequence !== index + 1 ||
        event.previousDigest !== previousDigest ||
        event.globalCursor <= previousCursor
      ) {
        return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} has a broken event chain`))
      }
      const transition = projectOperationEvent(state, event.name)
      if (!transition.accepted) {
        return yield* Effect.fail(
          new LedgerCorruptionError(`Operation ${operationID} contains an illegal ${event.name} transition`),
        )
      }
      if (event.name === "operation.admitted") admission = lifecycle.admissionKey
      if (event.name === "policy.ask") decision = lifecycle.decisionID
      if (event.name === "approval.rejected" && lifecycle.decisionID !== decision) {
        return yield* Effect.fail(
          new LedgerCorruptionError(`Operation ${operationID} rejection targets another decision`),
        )
      }
      state = transition.state
      previousDigest = event.digest
      previousCursor = event.globalCursor
      events.push(event)
    }

    const last = events.at(-1)
    if (!last || !state || !admission) {
      return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} cannot be projected`))
    }
    const operation: OperationRecord = {
      operationID,
      admissionKey: admission,
      state,
      sequence: last.sequence,
      decisionID: decision,
      lastEventID: last.eventID,
      lastCursor: last.globalCursor,
      lastDigest: last.digest,
      updatedAt: last.recordedAt,
    }
    if (!projectionMatches(projectionRows[0], operation)) {
      return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} projection does not match replay`))
    }
    return { operation, events }
  }).pipe(Effect.mapError(mapStorageError("Failed to replay operation events")))
}

function parseAndDigestEvent(
  draft: OperationEventDraft,
  sequence: number,
  globalCursor: number,
  previousDigest: string | null,
): Effect.Effect<PersistedOperationEvent, OperationEventValidationError> {
  return Effect.try({
    try: () => {
      if (draft.schemaVersion !== ledgerSchemaVersion) {
        throw new OperationEventValidationError(
          `Unsupported operation event schema ${draft.schemaVersion}`,
          "$.schemaVersion",
          "unknown_schema_version",
        )
      }
      const firstPass = requireEnvelope({ ...draft, sequence, previousDigest, digest: emptyDigest })
      const lifecycle = parseLifecyclePayload(firstPass.name, firstPass.payload)
      const normalized = requireEnvelope({ ...firstPass, payload: lifecycle.payload })
      const { digest: _, ...withoutDigest } = normalized
      const digest = digestEvent({ globalCursor, ...withoutDigest })
      return { ...requireEnvelope({ ...normalized, digest }), globalCursor }
    },
    catch: (cause) =>
      cause instanceof OperationEventValidationError
        ? cause
        : new OperationEventValidationError("Malformed operation event", "$", "invalid_event"),
  })
}

function decodeEventRow(row: EventRow): Effect.Effect<PersistedOperationEvent, LedgerCorruptionError> {
  return Effect.try({
    try: () => {
      if (row.schema_version !== ledgerSchemaVersion) throw new Error("unknown_schema_version")
      const event = requireEnvelope({
        eventID: row.event_id,
        operationID: row.operation_id,
        sequence: row.sequence,
        name: row.name,
        schemaVersion: row.schema_version,
        recordedAt: row.recorded_at,
        observedAt: row.observed_at,
        actor: JSON.parse(row.actor_json),
        causationID: row.causation_id,
        correlationID: row.correlation_id,
        attemptID: row.attempt_id,
        payload: JSON.parse(row.payload_json),
        previousDigest: row.previous_digest,
        digest: row.digest,
        redaction: row.redaction,
        externalBlobDigest: row.external_blob_digest,
      })
      parseLifecyclePayload(event.name, event.payload)
      const { digest: _, ...withoutDigest } = event
      const expectedDigest = digestEvent({ globalCursor: row.global_cursor, ...withoutDigest })
      if (event.digest !== expectedDigest) throw new Error("event_digest_mismatch")
      return { ...event, globalCursor: row.global_cursor }
    },
    catch: (cause) => new LedgerCorruptionError(`Stored event ${row.event_id} is malformed or corrupted`, cause),
  })
}

function requireEnvelope(input: unknown): OperationEventEnvelope {
  const result = parseOperationEventEnvelope(input)
  if (result.ok) return result.value
  throw new OperationEventValidationError(
    `Invalid operation event at ${result.issue.path}`,
    result.issue.path,
    result.issue.reason,
  )
}

function parseStoredLifecycle(
  event: PersistedOperationEvent,
): Effect.Effect<ParsedLifecyclePayload, OperationEventValidationError> {
  return Effect.try({
    try: () => parseLifecyclePayload(event.name, event.payload),
    catch: (cause) =>
      cause instanceof OperationEventValidationError
        ? cause
        : new OperationEventValidationError("Malformed lifecycle payload", "$.payload", "invalid_payload"),
  })
}

function validateLifecycleLink(
  operation: OperationRecord | null,
  name: OperationEvent,
  lifecycle: ParsedLifecyclePayload,
): Effect.Effect<void, OperationEventValidationError> {
  if (name !== "approval.rejected" || lifecycle.decisionID === operation?.decisionID) return Effect.void
  return Effect.fail(
    new OperationEventValidationError(
      "Approval rejection must target the active policy decision",
      "$.payload.decisionID",
      "decision_mismatch",
    ),
  )
}

function insertEvent(db: QueryExecutor, event: PersistedOperationEvent) {
  return db.run(sql`
    INSERT INTO operation_event (
      event_id, global_cursor, operation_id, sequence, name, schema_version,
      recorded_at, observed_at, actor_json, causation_id, correlation_id,
      attempt_id, payload_json, previous_digest, digest, redaction, external_blob_digest
    ) VALUES (
      ${event.eventID}, ${event.globalCursor}, ${event.operationID}, ${event.sequence}, ${event.name},
      ${event.schemaVersion}, ${event.recordedAt}, ${event.observedAt}, ${JSON.stringify(event.actor)},
      ${event.causationID}, ${event.correlationID}, ${event.attemptID}, ${JSON.stringify(event.payload)},
      ${event.previousDigest}, ${event.digest}, ${event.redaction}, ${event.externalBlobDigest}
    )
  `)
}

function projectEvent(
  db: QueryExecutor,
  current: OperationRecord | null,
  state: OperationState,
  event: PersistedOperationEvent,
  lifecycle: ParsedLifecyclePayload,
): Effect.Effect<OperationRecord, OperationLedgerError> {
  return Effect.gen(function* () {
    const admission = lifecycle.admissionKey ?? current?.admissionKey
    if (!admission)
      return yield* Effect.fail(new LedgerCorruptionError("Admission event did not provide an admission key"))
    const decisionID = event.name === "policy.ask" ? lifecycle.decisionID : (current?.decisionID ?? null)
    if (!current) {
      yield* db.run(sql`
        INSERT INTO operation_projection (
          operation_id, admission_key, state, sequence, decision_id,
          last_event_id, last_cursor, last_digest, updated_at
        ) VALUES (
          ${event.operationID}, ${admission}, ${state}, ${event.sequence}, ${decisionID},
          ${event.eventID}, ${event.globalCursor}, ${event.digest}, ${event.recordedAt}
        )
      `)
    } else {
      yield* db.run(sql`
        UPDATE operation_projection SET
          state = ${state}, sequence = ${event.sequence}, decision_id = ${decisionID},
          last_event_id = ${event.eventID}, last_cursor = ${event.globalCursor},
          last_digest = ${event.digest}, updated_at = ${event.recordedAt}
        WHERE operation_id = ${event.operationID}
          AND state = ${current.state}
          AND sequence = ${current.sequence}
      `)
    }

    const projected = yield* db.all<ProjectionRow>(
      sql`SELECT * FROM operation_projection WHERE operation_id = ${event.operationID} LIMIT 1`,
    )
    if (!projected[0] || projected[0].sequence !== event.sequence || projected[0].state !== state) {
      return yield* Effect.fail(
        new OperationConcurrencyError(
          current?.state ?? null,
          current?.sequence ?? 0,
          current?.state ?? null,
          current?.sequence ?? 0,
        ),
      )
    }
    return projectionRowToRecord(projected[0])
  }).pipe(Effect.mapError(mapStorageError("Failed to project the operation event")))
}

function projectionMatches(row: ProjectionRow, operation: OperationRecord) {
  return (
    row.operation_id === operation.operationID &&
    row.admission_key === operation.admissionKey &&
    row.state === operation.state &&
    row.sequence === operation.sequence &&
    row.decision_id === operation.decisionID &&
    row.last_event_id === operation.lastEventID &&
    row.last_cursor === operation.lastCursor &&
    row.last_digest === operation.lastDigest &&
    row.updated_at === operation.updatedAt
  )
}

function projectionRowToRecord(row: ProjectionRow): OperationRecord {
  if (!isOperationState(row.state)) {
    throw new LedgerCorruptionError(`Projection contains unknown operation state ${row.state}`)
  }
  return {
    operationID: requireStoredOperationID(row.operation_id),
    admissionKey: row.admission_key,
    state: row.state,
    sequence: row.sequence,
    decisionID: row.decision_id,
    lastEventID: row.last_event_id,
    lastCursor: row.last_cursor,
    lastDigest: row.last_digest,
    updatedAt: row.updated_at,
  }
}

function requireStoredOperationID(value: string): OperationID {
  const result = parseOperationID(value)
  if (result.ok) return result.value
  throw new LedgerCorruptionError(`Stored operation ID ${value} is malformed`)
}

function isOperationState(value: string): value is OperationState {
  return operationStates.some((state) => state === value)
}

type ReplayResult = Readonly<{
  operation: OperationRecord
  events: ReadonlyArray<PersistedOperationEvent>
}>

type MetaRow = Readonly<{
  schema_version: number
  last_cursor: number
}>

type ProjectionRow = Readonly<{
  operation_id: string
  admission_key: string
  state: string
  sequence: number
  decision_id: string | null
  last_event_id: string
  last_cursor: number
  last_digest: string
  updated_at: string
}>

type EventRow = Readonly<{
  event_id: string
  global_cursor: number
  operation_id: string
  sequence: number
  name: string
  schema_version: number
  recorded_at: string
  observed_at: string
  actor_json: string
  causation_id: string | null
  correlation_id: string
  attempt_id: string | null
  payload_json: string
  previous_digest: string | null
  digest: string
  redaction: string
  external_blob_digest: string | null
}>
