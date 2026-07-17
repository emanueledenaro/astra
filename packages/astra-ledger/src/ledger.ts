import {
  parseAttemptID,
  parseContentDigest,
  parseDispatchRequest,
  parseDispatchRequestID,
  parseExecutorClaim,
  parseOperationEventEnvelope,
  parseOperationID,
  parseOperationReceipt,
  type ActorRef,
  type AttemptID,
  type DispatchRequest,
  type DispatchRequestID,
  type ExecutorClaim,
  type ExecutorClaimID,
  type OperationEventEnvelope,
  type OperationID,
  type OperationAuthority,
  type OperationReceipt,
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
  CapabilityConflictError,
  DispatchClaimError,
  EventConflictError,
  LedgerCorruptionError,
  LedgerInjectedFault,
  LedgerNotInitializedError,
  LedgerReadLimitError,
  OperationConcurrencyError,
  OperationEventValidationError,
  OperationTransitionError,
  ReceiptConflictError,
  ReceiptIngestionError,
  mapStorageError,
  type LedgerFaultPoint,
  type OperationLedgerError,
} from "./error"
import { parseLifecyclePayload, type ParsedLifecyclePayload } from "./event-payload"

const eventSchemaVersion = 1
const storageSchemaVersion = 4
const maximumReadEvents = 256
const maximumIntegrityEvents = 100_000
const maximumIntegrityOperations = 10_000
const maximumBatchEvents = 32
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
  baselineTrustDigest: string
  baselineAdapterDigest: string
  attemptID: AttemptID | null
  capabilityGrantID: string | null
  authorityExpiresAt: string | null
  dispatchRequestID: DispatchRequestID | null
  dispatchExecutor: string | null
  dispatchAdapterDigest: string | null
  lastEventID: string
  lastCursor: number
  lastDigest: string
  updatedAt: string
}>

export type ClaimDispatchCommand = Readonly<{
  dispatchRequestID: DispatchRequestID
  operationID: OperationID
  attemptID: AttemptID
  executor: string
  executorClaimID: ExecutorClaimID
  claimExpiresAt: string
  event: Omit<
    OperationEventDraft,
    "operationID" | "name" | "attemptID" | "payload" | "recordedAt" | "observedAt" | "causationID"
  >
}>

export type ClaimDispatchResult = Readonly<{
  kind: "claimed" | "replayed"
  claim: ExecutorClaim
  event: PersistedOperationEvent
  operation: OperationRecord
}>

export type IngestReceiptCommand = Readonly<{
  receipt: OperationReceipt
  event: Pick<OperationEventDraft, "eventID" | "schemaVersion" | "correlationID" | "redaction" | "externalBlobDigest">
}>

export type IngestReceiptResult = Readonly<{
  kind: "ingested" | "replayed"
  receipt: OperationReceipt
  receiptDigest: string
  event: PersistedOperationEvent
  operation: OperationRecord
}>

export type DispatchSnapshot = Readonly<{
  request: DispatchRequest
  claim: ExecutorClaim | null
  receipt: OperationReceipt | null
  createdCursor: number
  acceptedCursor: number | null
  receiptCursor: number | null
  recoveryStatus: "pending_outbox" | "claimed_no_receipt" | "receipt_ingested"
}>

export type RecoveryCandidate = DispatchSnapshot

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
  appendBatch(
    commands: ReadonlyArray<AppendOperationEvent>,
  ): Effect.Effect<ReadonlyArray<AppendOperationEventResult>, OperationLedgerError>
  claimDispatch(command: ClaimDispatchCommand): Effect.Effect<ClaimDispatchResult, OperationLedgerError>
  ingestReceipt(command: IngestReceiptCommand): Effect.Effect<IngestReceiptResult, OperationLedgerError>
  getDispatchSnapshot(
    dispatchRequestID: DispatchRequestID,
  ): Effect.Effect<DispatchSnapshot | null, OperationLedgerError>
  listRecoveryCandidates(
    options: Readonly<{ limit: number }>,
  ): Effect.Effect<ReadonlyArray<RecoveryCandidate>, OperationLedgerError>
  getOperation(operationID: OperationID): Effect.Effect<OperationRecord | null, OperationLedgerError>
  readEvents(
    operationID: OperationID,
    options: Readonly<{ limit: number }>,
  ): Effect.Effect<ReadonlyArray<PersistedOperationEvent>, OperationLedgerError>
  readGlobalCursor(): Effect.Effect<number, OperationLedgerError>
  readDurability(): Effect.Effect<LedgerDurability, OperationLedgerError>
}

type LedgerFault = (point: LedgerFaultPoint) => Effect.Effect<void, LedgerInjectedFault>
export type LedgerClock = () => string

export function makeOperationLedger(): Effect.Effect<
  OperationLedger,
  never,
  import("effect/unstable/sql/SqlClient").SqlClient
> {
  return makeOperationLedgerInternal(
    () => Effect.void,
    () => new Date().toISOString(),
  )
}

export function makeOperationLedgerInternal(
  injectFault: LedgerFault,
  clock: LedgerClock = () => new Date().toISOString(),
): Effect.Effect<OperationLedger, never, import("effect/unstable/sql/SqlClient").SqlClient> {
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    return {
      initialize: () => initialize(db),
      append: (command) => append(db, command, injectFault, clock),
      appendBatch: (commands) => appendBatch(db, commands, injectFault, clock),
      claimDispatch: (command) => claimDispatch(db, command, injectFault, clock),
      ingestReceipt: (command) => ingestReceipt(db, command, injectFault, clock),
      getDispatchSnapshot: (dispatchRequestID) => getDispatchSnapshot(db, dispatchRequestID),
      listRecoveryCandidates: (options) => listRecoveryCandidates(db, options.limit),
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
        baseline_trust_digest TEXT,
        baseline_adapter_digest TEXT,
        attempt_id TEXT,
        capability_grant_id TEXT,
        authority_expires_at TEXT,
        dispatch_request_id TEXT,
        dispatch_executor TEXT,
        dispatch_adapter_digest TEXT,
        last_event_id TEXT NOT NULL,
        last_cursor INTEGER NOT NULL UNIQUE CHECK (last_cursor > 0),
        last_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (last_event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(sql`INSERT OR IGNORE INTO ledger_meta (singleton, schema_version, last_cursor) VALUES (1, 1, 0)`)
    yield* db.transaction((tx) => migrateStorage(tx), { behavior: "immediate" })
    const meta = yield* requireInitialized(db)
    yield* verifyLedgerIntegrity(db, meta)
  }).pipe(Effect.mapError(mapStorageError("Failed to initialize the operation ledger")))
}

function migrateStorage(db: QueryExecutor): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const rows = yield* db.all<{ schema_version: number }>(
      sql`SELECT schema_version FROM ledger_meta WHERE singleton = 1 LIMIT 1`,
    )
    if (!rows[0]) return yield* Effect.fail(new LedgerNotInitializedError())
    if (![1, 2, 3, storageSchemaVersion].includes(rows[0].schema_version)) {
      return yield* Effect.fail(new LedgerCorruptionError("Ledger metadata has an unknown storage schema"))
    }

    yield* ensureColumn(db, "ledger_meta", "last_fencing_token", "INTEGER NOT NULL DEFAULT 0")
    yield* ensureColumn(db, "operation_projection", "attempt_id", "TEXT")
    yield* ensureColumn(db, "operation_projection", "baseline_trust_digest", "TEXT")
    yield* ensureColumn(db, "operation_projection", "baseline_adapter_digest", "TEXT")
    yield* ensureColumn(db, "operation_projection", "capability_grant_id", "TEXT")
    yield* ensureColumn(db, "operation_projection", "authority_expires_at", "TEXT")
    yield* ensureColumn(db, "operation_projection", "dispatch_request_id", "TEXT")
    yield* ensureColumn(db, "operation_projection", "dispatch_executor", "TEXT")
    yield* ensureColumn(db, "operation_projection", "dispatch_adapter_digest", "TEXT")
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS dispatch_outbox (
        dispatch_request_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        executor TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        created_event_id TEXT NOT NULL UNIQUE,
        created_cursor INTEGER NOT NULL UNIQUE CHECK (created_cursor > 0),
        FOREIGN KEY (created_event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(sql`
      CREATE INDEX IF NOT EXISTS dispatch_outbox_recovery
      ON dispatch_outbox (created_cursor, dispatch_request_id)
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS executor_claim (
        executor_claim_id TEXT PRIMARY KEY,
        dispatch_request_id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        executor TEXT NOT NULL,
        fencing_token INTEGER NOT NULL UNIQUE CHECK (fencing_token > 0),
        claim_json TEXT NOT NULL,
        claim_digest TEXT NOT NULL,
        accepted_event_id TEXT NOT NULL UNIQUE,
        accepted_cursor INTEGER NOT NULL UNIQUE CHECK (accepted_cursor > 0),
        FOREIGN KEY (dispatch_request_id) REFERENCES dispatch_outbox(dispatch_request_id),
        FOREIGN KEY (accepted_event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(sql`
      CREATE INDEX IF NOT EXISTS executor_claim_recovery
      ON executor_claim (accepted_cursor, executor_claim_id)
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS capability_reservation (
        capability_grant_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL UNIQUE,
        baseline_digest TEXT NOT NULL,
        reserved_event_id TEXT NOT NULL UNIQUE,
        reserved_cursor INTEGER NOT NULL UNIQUE CHECK (reserved_cursor > 0),
        FOREIGN KEY (reserved_event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS capability_consumption (
        capability_grant_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL UNIQUE,
        dispatch_request_id TEXT NOT NULL UNIQUE,
        consumed_event_id TEXT NOT NULL UNIQUE,
        consumed_cursor INTEGER NOT NULL UNIQUE CHECK (consumed_cursor > 0),
        FOREIGN KEY (capability_grant_id) REFERENCES capability_reservation(capability_grant_id),
        FOREIGN KEY (dispatch_request_id) REFERENCES dispatch_outbox(dispatch_request_id),
        FOREIGN KEY (consumed_event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS operation_receipt (
        receipt_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL UNIQUE,
        dispatch_request_id TEXT NOT NULL UNIQUE,
        executor_claim_id TEXT NOT NULL UNIQUE,
        capability_grant_id TEXT NOT NULL UNIQUE,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        receipt_json TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        outcome_event_name TEXT NOT NULL CHECK (
          outcome_event_name IN ('effect.observed', 'execution.failed_without_effect', 'effect.unknown')
        ),
        event_id TEXT NOT NULL UNIQUE,
        event_cursor INTEGER NOT NULL UNIQUE CHECK (event_cursor > 0),
        FOREIGN KEY (dispatch_request_id) REFERENCES dispatch_outbox(dispatch_request_id),
        FOREIGN KEY (executor_claim_id) REFERENCES executor_claim(executor_claim_id),
        FOREIGN KEY (capability_grant_id) REFERENCES capability_consumption(capability_grant_id),
        FOREIGN KEY (event_id) REFERENCES operation_event(event_id)
      )
    `)
    yield* db.run(sql`
      UPDATE operation_projection SET
        baseline_trust_digest = COALESCE(baseline_trust_digest, (
          SELECT json_extract(payload_json, '$.baseline.trustDigest') FROM operation_event
          WHERE operation_event.operation_id = operation_projection.operation_id
            AND name = 'operation.admitted' LIMIT 1
        )),
        baseline_adapter_digest = COALESCE(baseline_adapter_digest, (
          SELECT json_extract(payload_json, '$.baseline.adapterDigest') FROM operation_event
          WHERE operation_event.operation_id = operation_projection.operation_id
            AND name = 'operation.admitted' LIMIT 1
        ))
    `)
    if (rows[0].schema_version !== storageSchemaVersion) {
      yield* db.run(sql`UPDATE ledger_meta SET schema_version = ${storageSchemaVersion} WHERE singleton = 1`)
    }
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to migrate operation ledger storage")))
}

function ensureColumn(db: QueryExecutor, table: string, column: string, declaration: string) {
  return Effect.gen(function* () {
    const columns = yield* db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))
    if (columns.some((candidate) => candidate.name === column)) return
    yield* db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`))
  })
}

function append(
  db: Database,
  command: AppendOperationEvent,
  injectFault: LedgerFault,
  clock: LedgerClock,
): Effect.Effect<AppendOperationEventResult, OperationLedgerError> {
  const validation = validateAppendCommand(command, "$")
  if (validation) return Effect.fail(validation)
  if (command.event.name === "executor.accepted") {
    return Effect.fail(new DispatchClaimError("unbound", "specialized_claim_required"))
  }
  if (isReceiptEvent(command.event.name)) {
    return Effect.fail(new ReceiptIngestionError("unbound", "specialized_ingestion_required"))
  }

  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const meta = yield* requireInitialized(tx)
          yield* verifyLedgerIntegrity(tx, meta)
          return yield* appendWithinTransaction(tx, command, injectFault, requireTrustedNow(clock))
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapStorageError("Failed to append the operation event")))
}

function appendBatch(
  db: Database,
  commands: ReadonlyArray<AppendOperationEvent>,
  injectFault: LedgerFault,
  clock: LedgerClock,
): Effect.Effect<ReadonlyArray<AppendOperationEventResult>, OperationLedgerError> {
  if (commands.length < 1 || commands.length > maximumBatchEvents) {
    return Effect.fail(
      new OperationEventValidationError(
        `Operation event batches must contain 1 to ${maximumBatchEvents} events`,
        "$.commands",
        "invalid_batch_size",
      ),
    )
  }
  for (const [index, command] of commands.entries()) {
    const validation = validateAppendCommand(command, `$.commands[${index}]`)
    if (validation) return Effect.fail(validation)
    if (command.event.name === "executor.accepted") {
      return Effect.fail(new DispatchClaimError("unbound", "specialized_claim_required"))
    }
    if (isReceiptEvent(command.event.name)) {
      return Effect.fail(new ReceiptIngestionError("unbound", "specialized_ingestion_required"))
    }
  }

  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const meta = yield* requireInitialized(tx)
          yield* verifyLedgerIntegrity(tx, meta)
          const trustedNow = requireTrustedNow(clock)
          const results: Array<AppendOperationEventResult> = []
          for (const command of commands) {
            results.push(yield* appendWithinTransaction(tx, command, injectFault, trustedNow))
          }
          return results
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapStorageError("Failed to append the operation event batch")))
}

function appendWithinTransaction(
  tx: QueryExecutor,
  command: AppendOperationEvent,
  injectFault: LedgerFault,
  trustedNow: string,
) {
  return Effect.gen(function* () {
    const meta = yield* requireInitialized(tx)
    const existingRows = yield* tx.all<EventRow>(
      sql`SELECT * FROM operation_event WHERE event_id = ${command.event.eventID} LIMIT 1`,
    )
    if (existingRows[0]) return yield* replayExistingEvent(tx, command, existingRows[0])

    const replay = yield* loadAndVerifyOperation(tx, command.event.operationID, maximumReadEvents)
    const actualState = replay?.operation.state ?? null
    const actualSequence = replay?.operation.sequence ?? 0
    if (actualState !== command.expectedState || actualSequence !== command.expectedSequence) {
      return yield* Effect.fail(
        new OperationConcurrencyError(command.expectedState, command.expectedSequence, actualState, actualSequence),
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
    yield* validateTrustedLifecycle(replay?.operation ?? null, persisted, lifecycle, trustedNow)

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
    if (lifecycle.authority) yield* insertCapabilityReservation(tx, lifecycle.authority, persisted)
    if (lifecycle.dispatchRequest) {
      yield* injectFault("after_dispatch_event_insert")
      yield* insertDispatchOutbox(tx, lifecycle.dispatchRequest, persisted)
      yield* validateCapabilityReservation(tx, lifecycle.dispatchRequest)
      yield* injectFault("after_outbox_insert")
    }
    if (lifecycle.executorClaim) {
      yield* injectFault("after_claim_event_insert")
      yield* insertExecutorClaim(tx, lifecycle.executorClaim, persisted)
      yield* injectFault("after_claim_insert")
    }
    const operation = yield* projectEvent(tx, replay?.operation ?? null, transition.state, persisted, lifecycle)
    yield* injectFault("after_projection_update")
    yield* tx.run(sql`UPDATE ledger_meta SET last_cursor = ${nextCursor} WHERE singleton = 1`)
    return { kind: "appended" as const, event: persisted, operation }
  })
}

function validateAppendCommand(command: AppendOperationEvent, path: string) {
  if (Number.isSafeInteger(command.expectedSequence) && command.expectedSequence >= 0) return null
  return new OperationEventValidationError(
    "Expected sequence must be a non-negative safe integer",
    `${path}.expectedSequence`,
    "expected_non_negative_integer",
  )
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

function claimDispatch(
  db: Database,
  command: ClaimDispatchCommand,
  injectFault: LedgerFault,
  clock: LedgerClock,
): Effect.Effect<ClaimDispatchResult, OperationLedgerError> {
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const meta = yield* requireInitialized(tx)
          yield* verifyLedgerIntegrity(tx, meta)
          const trustedNow = requireTrustedNow(clock)
          const outboxRows = yield* readDispatchRows(tx, command.dispatchRequestID)
          if (!outboxRows[0]) {
            return yield* Effect.fail(new DispatchClaimError(command.dispatchRequestID, "not_found"))
          }
          const snapshot = yield* decodeDispatchSnapshot(outboxRows[0])
          const candidate = yield* requireClaimCandidate(
            command,
            snapshot.claim?.fencingToken ?? meta.last_fencing_token + 1,
            snapshot.claim?.acceptedAt ?? trustedNow,
          )

          if (snapshot.claim) return yield* replayDispatchClaim(tx, command, candidate, snapshot)
          if (
            snapshot.request.operationID !== command.operationID ||
            snapshot.request.attemptID !== command.attemptID ||
            snapshot.request.executor !== command.executor
          ) {
            return yield* Effect.fail(new DispatchClaimError(command.dispatchRequestID, "request_mismatch"))
          }
          yield* validateCapabilityReservation(tx, snapshot.request)
          if (
            Date.parse(trustedNow) >= Date.parse(snapshot.request.authorizationExpiresAt) ||
            Date.parse(trustedNow) < Date.parse(snapshot.request.requestedAt) ||
            Date.parse(candidate.claimExpiresAt) > Date.parse(snapshot.request.authorizationExpiresAt)
          ) {
            return yield* Effect.fail(new DispatchClaimError(command.dispatchRequestID, "authorization_expired"))
          }

          const operation = yield* loadAndVerifyOperation(tx, command.operationID, maximumReadEvents)
          if (
            !operation ||
            operation.operation.state !== "dispatch_pending" ||
            operation.operation.dispatchRequestID !== command.dispatchRequestID ||
            operation.operation.attemptID !== command.attemptID
          ) {
            return yield* Effect.fail(new DispatchClaimError(command.dispatchRequestID, "request_mismatch"))
          }

          const result = yield* appendWithinTransaction(
            tx,
            {
              expectedState: "dispatch_pending",
              expectedSequence: operation.operation.sequence,
              event: {
                ...command.event,
                recordedAt: trustedNow,
                observedAt: trustedNow,
                causationID: outboxRows[0].created_event_id,
                operationID: command.operationID,
                name: "executor.accepted",
                attemptID: command.attemptID,
                payload: candidate,
              },
            },
            injectFault,
            trustedNow,
          )
          yield* insertCapabilityConsumption(tx, snapshot.request, result.event)
          yield* injectFault("after_capability_consumption")
          yield* tx.run(
            sql`UPDATE ledger_meta SET last_fencing_token = ${candidate.fencingToken} WHERE singleton = 1 AND last_fencing_token = ${meta.last_fencing_token}`,
          )
          const updated = yield* requireInitialized(tx)
          if (updated.last_fencing_token !== candidate.fencingToken) {
            return yield* Effect.fail(new DispatchClaimError(command.dispatchRequestID, "already_claimed"))
          }
          return { kind: "claimed" as const, claim: candidate, event: result.event, operation: result.operation }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapStorageError("Failed to claim the pending dispatch")))
}

function requireClaimCandidate(
  command: ClaimDispatchCommand,
  fencingToken: number,
  trustedNow: string,
): Effect.Effect<ExecutorClaim, OperationEventValidationError> {
  const result = parseExecutorClaim({
    executorClaimID: command.executorClaimID,
    dispatchRequestID: command.dispatchRequestID,
    operationID: command.operationID,
    attemptID: command.attemptID,
    executor: command.executor,
    fencingToken,
    acceptedAt: trustedNow,
    claimExpiresAt: command.claimExpiresAt,
  })
  if (result.ok) return Effect.succeed(result.value)
  return Effect.fail(
    new OperationEventValidationError(
      `Invalid executor claim at ${result.issue.path}`,
      result.issue.path,
      result.issue.reason,
    ),
  )
}

function replayDispatchClaim(
  tx: QueryExecutor,
  command: ClaimDispatchCommand,
  candidate: ExecutorClaim,
  snapshot: DispatchSnapshot,
): Effect.Effect<ClaimDispatchResult, OperationLedgerError> {
  return Effect.gen(function* () {
    if (!snapshot.claim || digestEvent({ ...snapshot.claim }) !== digestEvent({ ...candidate })) {
      return yield* Effect.fail(new DispatchClaimError(command.dispatchRequestID, "already_claimed"))
    }
    const claimRows = yield* tx.all<ClaimRow>(
      sql`SELECT * FROM executor_claim WHERE dispatch_request_id = ${command.dispatchRequestID} LIMIT 1`,
    )
    if (!claimRows[0]) return yield* Effect.fail(new LedgerCorruptionError("Claim snapshot has no durable claim row"))
    const eventRows = yield* tx.all<EventRow>(
      sql`SELECT * FROM operation_event WHERE event_id = ${claimRows[0].accepted_event_id} LIMIT 1`,
    )
    if (!eventRows[0]) return yield* Effect.fail(new LedgerCorruptionError("Claim has no executor acceptance event"))
    const replay = yield* replayExistingEvent(
      tx,
      {
        expectedState: "dispatch_pending",
        expectedSequence: eventRows[0].sequence - 1,
        event: {
          ...command.event,
          recordedAt: eventRows[0].recorded_at,
          observedAt: eventRows[0].observed_at,
          causationID: eventRows[0].causation_id,
          operationID: command.operationID,
          name: "executor.accepted",
          attemptID: command.attemptID,
          payload: candidate,
        },
      },
      eventRows[0],
    )
    return { kind: "replayed" as const, claim: candidate, event: replay.event, operation: replay.operation }
  }).pipe(Effect.mapError(mapStorageError("Failed to replay the executor claim")))
}

function ingestReceipt(
  db: Database,
  command: IngestReceiptCommand,
  injectFault: LedgerFault,
  clock: LedgerClock,
): Effect.Effect<IngestReceiptResult, OperationLedgerError> {
  const parsed = parseOperationReceipt(command.receipt)
  if (!parsed.ok) {
    return Effect.fail(
      new OperationEventValidationError(
        `Invalid operation receipt at ${parsed.issue.path}`,
        parsed.issue.path,
        parsed.issue.reason,
      ),
    )
  }
  const receipt = parsed.value
  const receiptDigest = digestEvent({ ...receipt })
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const meta = yield* requireInitialized(tx)
          yield* verifyLedgerIntegrity(tx, meta)
          const existingRows = yield* readReceiptConflictRows(tx, receipt)
          if (existingRows[0]) {
            return yield* replayIngestedReceipt(tx, command, receipt, receiptDigest, existingRows[0])
          }

          const dispatchRows = yield* readDispatchRows(tx, receipt.dispatchRequestID)
          if (!dispatchRows[0]) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "dispatch_not_found"))
          }
          const snapshot = yield* decodeDispatchSnapshot(dispatchRows[0])
          if (!snapshot.claim) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "claim_not_accepted"))
          }
          const trustedNow = requireTrustedNow(clock)
          if (!receiptMatchesDispatch(receipt, snapshot)) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "binding_mismatch"))
          }
          if (
            Date.parse(receipt.startedAt) < Date.parse(snapshot.claim.acceptedAt) ||
            Date.parse(receipt.endedAt) > Date.parse(snapshot.claim.claimExpiresAt) ||
            Date.parse(receipt.endedAt) > Date.parse(trustedNow)
          ) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "stale_claim"))
          }
          const consumption = yield* tx.all<CapabilityConsumptionRow>(sql`
            SELECT * FROM capability_consumption
            WHERE capability_grant_id = ${receipt.capabilityGrantID}
              AND operation_id = ${receipt.operationID}
              AND attempt_id = ${receipt.attemptID}
              AND dispatch_request_id = ${receipt.dispatchRequestID}
            LIMIT 1
          `)
          if (!consumption[0]) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "binding_mismatch"))
          }
          const replay = yield* loadAndVerifyOperation(tx, receipt.operationID, maximumReadEvents)
          if (
            !replay ||
            replay.operation.state !== "dispatched" ||
            replay.operation.attemptID !== receipt.attemptID ||
            replay.operation.dispatchRequestID !== receipt.dispatchRequestID
          ) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "claim_not_accepted"))
          }
          const admission = yield* parseStoredLifecycle(replay.events[0])
          if (
            receipt.effectClass !== admission.effectClass ||
            digestEvent({ resources: receipt.resources }) !== digestEvent({ resources: admission.resources })
          ) {
            return yield* Effect.fail(new ReceiptIngestionError(receipt.receiptID, "binding_mismatch"))
          }
          const eventName = receiptEventName(receipt)
          const result = yield* appendWithinTransaction(
            tx,
            {
              expectedState: "dispatched",
              expectedSequence: replay.operation.sequence,
              event: {
                ...command.event,
                operationID: receipt.operationID,
                name: eventName,
                recordedAt: trustedNow,
                observedAt: trustedNow,
                actor: {
                  kind: "system",
                  subject: snapshot.request.executor,
                  componentDigest: snapshot.request.adapterDigest,
                },
                causationID: dispatchRows[0].accepted_event_id,
                attemptID: receipt.attemptID,
                payload: receipt,
              },
            },
            injectFault,
            trustedNow,
          )
          yield* injectFault("after_receipt_event_insert")
          yield* insertOperationReceipt(tx, receipt, receiptDigest, eventName, result.event)
          yield* injectFault("after_receipt_insert")
          return {
            kind: "ingested" as const,
            receipt,
            receiptDigest,
            event: result.event,
            operation: result.operation,
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapStorageError("Failed to ingest the executor receipt")))
}

function replayIngestedReceipt(
  tx: QueryExecutor,
  command: IngestReceiptCommand,
  receipt: OperationReceipt,
  receiptDigest: string,
  row: ReceiptRow,
): Effect.Effect<IngestReceiptResult, OperationLedgerError> {
  return Effect.gen(function* () {
    const stored = yield* decodeOperationReceiptJson(row.receipt_json, row.receipt_id)
    if (
      row.receipt_id !== receipt.receiptID ||
      row.receipt_digest !== receiptDigest ||
      digestEvent({ ...stored }) !== receiptDigest ||
      row.event_id !== command.event.eventID
    ) {
      return yield* Effect.fail(new ReceiptConflictError(receipt.receiptID))
    }
    const eventRows = yield* tx.all<EventRow>(sql`
      SELECT * FROM operation_event WHERE event_id = ${row.event_id} LIMIT 1
    `)
    if (!eventRows[0]) return yield* Effect.fail(new LedgerCorruptionError("Receipt has no lifecycle event"))
    const event = yield* decodeEventRow(eventRows[0])
    if (
      event.schemaVersion !== command.event.schemaVersion ||
      event.correlationID !== command.event.correlationID ||
      event.redaction !== command.event.redaction ||
      event.externalBlobDigest !== command.event.externalBlobDigest
    ) {
      return yield* Effect.fail(new ReceiptConflictError(receipt.receiptID))
    }
    const operation = yield* loadAndVerifyOperation(tx, receipt.operationID, maximumReadEvents)
    if (!operation) return yield* Effect.fail(new LedgerCorruptionError("Receipt has no operation projection"))
    return { kind: "replayed" as const, receipt: stored, receiptDigest, event, operation: operation.operation }
  }).pipe(Effect.mapError(mapStorageError("Failed to replay the ingested receipt")))
}

function receiptMatchesDispatch(receipt: OperationReceipt, snapshot: DispatchSnapshot) {
  return (
    snapshot.claim !== null &&
    receipt.operationID === snapshot.request.operationID &&
    receipt.attemptID === snapshot.request.attemptID &&
    receipt.dispatchRequestID === snapshot.request.dispatchRequestID &&
    receipt.executorClaimID === snapshot.claim.executorClaimID &&
    receipt.capabilityGrantID === snapshot.request.capabilityGrantID &&
    receipt.fencingToken === snapshot.claim.fencingToken &&
    receipt.adapter.identity === snapshot.request.executor &&
    receipt.adapter.digest === snapshot.request.adapterDigest
  )
}

function receiptEventName(receipt: OperationReceipt): OperationEvent {
  if (receipt.observation.kind === "effect_observed") return "effect.observed"
  if (receipt.observation.kind === "no_effect_proved") return "execution.failed_without_effect"
  return "effect.unknown"
}

function isReceiptEvent(name: OperationEvent) {
  return name === "effect.observed" || name === "execution.failed_without_effect" || name === "effect.unknown"
}

function getDispatchSnapshot(
  db: Database,
  dispatchRequestID: DispatchRequestID,
): Effect.Effect<DispatchSnapshot | null, OperationLedgerError> {
  return Effect.gen(function* () {
    const parsedID = parseDispatchRequestID(dispatchRequestID)
    if (!parsedID.ok) {
      return yield* Effect.fail(
        new OperationEventValidationError("Invalid dispatch request ID", parsedID.issue.path, parsedID.issue.reason),
      )
    }
    const meta = yield* requireInitialized(db)
    yield* verifyLedgerIntegrity(db, meta)
    const rows = yield* readDispatchRows(db, parsedID.value)
    return rows[0] ? yield* decodeDispatchSnapshot(rows[0]) : null
  }).pipe(Effect.mapError(mapStorageError("Failed to read the dispatch snapshot")))
}

function listRecoveryCandidates(
  db: Database,
  limit: number,
): Effect.Effect<ReadonlyArray<RecoveryCandidate>, OperationLedgerError> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumReadEvents) {
    return Effect.fail(new LedgerReadLimitError(limit))
  }
  return Effect.gen(function* () {
    const meta = yield* requireInitialized(db)
    yield* verifyLedgerIntegrity(db, meta)
    const rows = yield* db.all<DispatchJoinRow>(sql`
      SELECT
        dispatch_outbox.*,
        executor_claim.executor_claim_id,
        executor_claim.fencing_token,
        executor_claim.claim_json,
        executor_claim.claim_digest,
        executor_claim.accepted_event_id,
        executor_claim.accepted_cursor,
        operation_receipt.receipt_id,
        operation_receipt.receipt_json,
        operation_receipt.receipt_digest,
        operation_receipt.event_cursor AS receipt_cursor
      FROM dispatch_outbox
      LEFT JOIN executor_claim USING (dispatch_request_id)
      LEFT JOIN operation_receipt USING (dispatch_request_id)
      ORDER BY dispatch_outbox.created_cursor ASC
      LIMIT ${limit}
    `)
    const snapshots: Array<RecoveryCandidate> = []
    for (const row of rows) snapshots.push(yield* decodeDispatchSnapshot(row))
    return snapshots
  }).pipe(Effect.mapError(mapStorageError("Failed to list dispatch recovery candidates")))
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
      sql`SELECT schema_version, last_cursor, last_fencing_token FROM ledger_meta WHERE singleton = 1 LIMIT 1`,
    )
    if (!rows[0]) return yield* Effect.fail(new LedgerNotInitializedError())
    if (
      rows[0].schema_version !== storageSchemaVersion ||
      !Number.isSafeInteger(rows[0].last_cursor) ||
      !Number.isSafeInteger(rows[0].last_fencing_token) ||
      rows[0].last_fencing_token < 0
    ) {
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
    yield* verifyDispatchIntegrity(db, meta)
    yield* verifyCapabilityIntegrity(db)
    yield* verifyReceiptIntegrity(db)
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to verify ledger integrity")))
}

function verifyCapabilityIntegrity(db: QueryExecutor): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const reservations = yield* db.all<CapabilityReservationRow>(sql`
      SELECT * FROM capability_reservation ORDER BY reserved_cursor ASC LIMIT ${maximumIntegrityEvents + 1}
    `)
    const consumptions = yield* db.all<CapabilityConsumptionRow>(sql`
      SELECT * FROM capability_consumption ORDER BY consumed_cursor ASC LIMIT ${maximumIntegrityEvents + 1}
    `)
    const approvalEvents = yield* db.all<EventRow>(sql`
      SELECT * FROM operation_event WHERE name = 'approval.granted'
      ORDER BY global_cursor ASC LIMIT ${maximumIntegrityEvents + 1}
    `)
    const acceptedEvents = yield* db.all<EventRow>(sql`
      SELECT * FROM operation_event WHERE name = 'executor.accepted'
      ORDER BY global_cursor ASC LIMIT ${maximumIntegrityEvents + 1}
    `)
    if (reservations.length !== approvalEvents.length || consumptions.length !== acceptedEvents.length) {
      return yield* Effect.fail(new LedgerCorruptionError("Capability events and durable ownership diverge"))
    }
    for (const [index, row] of reservations.entries()) {
      const eventRow = approvalEvents[index]
      if (!eventRow || eventRow.event_id !== row.reserved_event_id || eventRow.global_cursor !== row.reserved_cursor) {
        return yield* Effect.fail(new LedgerCorruptionError("Capability reservation does not match approval"))
      }
      const lifecycle = yield* parseStoredLifecycle(yield* decodeEventRow(eventRow))
      if (
        !lifecycle.authority ||
        lifecycle.authority.capabilityGrantID !== row.capability_grant_id ||
        lifecycle.authority.attemptID !== row.attempt_id ||
        lifecycle.authority.baselineDigest !== row.baseline_digest ||
        eventRow.operation_id !== row.operation_id
      ) {
        return yield* Effect.fail(new LedgerCorruptionError("Capability reservation facts are inconsistent"))
      }
    }
    for (const [index, row] of consumptions.entries()) {
      const eventRow = acceptedEvents[index]
      if (!eventRow || eventRow.event_id !== row.consumed_event_id || eventRow.global_cursor !== row.consumed_cursor) {
        return yield* Effect.fail(new LedgerCorruptionError("Capability consumption does not match acceptance"))
      }
      const lifecycle = yield* parseStoredLifecycle(yield* decodeEventRow(eventRow))
      const outbox = yield* db.all<OutboxRow>(sql`
        SELECT * FROM dispatch_outbox WHERE dispatch_request_id = ${row.dispatch_request_id} LIMIT 1
      `)
      const request = outbox[0]
        ? yield* decodeDispatchRequestJson(outbox[0].request_json, outbox[0].dispatch_request_id)
        : null
      if (
        !lifecycle.executorClaim ||
        !request ||
        request.capabilityGrantID !== row.capability_grant_id ||
        lifecycle.executorClaim.attemptID !== row.attempt_id ||
        lifecycle.executorClaim.dispatchRequestID !== row.dispatch_request_id ||
        eventRow.operation_id !== row.operation_id
      ) {
        return yield* Effect.fail(new LedgerCorruptionError("Capability consumption facts are inconsistent"))
      }
    }
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to verify capability integrity")))
}

function verifyDispatchIntegrity(db: QueryExecutor, meta: MetaRow): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const rows = yield* db.all<DispatchJoinRow>(sql`
      SELECT
        dispatch_outbox.*,
        executor_claim.executor_claim_id,
        executor_claim.fencing_token,
        executor_claim.claim_json,
        executor_claim.claim_digest,
        executor_claim.accepted_event_id,
        executor_claim.accepted_cursor,
        operation_receipt.receipt_id,
        operation_receipt.receipt_json,
        operation_receipt.receipt_digest,
        operation_receipt.event_cursor AS receipt_cursor
      FROM dispatch_outbox
      LEFT JOIN executor_claim USING (dispatch_request_id)
      LEFT JOIN operation_receipt USING (dispatch_request_id)
      ORDER BY dispatch_outbox.created_cursor ASC
      LIMIT ${maximumIntegrityEvents + 1}
    `)
    const dispatchEvents = yield* db.all<{ event_id: string; global_cursor: number; payload_json: string }>(sql`
      SELECT event_id, global_cursor, payload_json FROM operation_event
      WHERE name = 'dispatch.requested'
      ORDER BY global_cursor ASC
      LIMIT ${maximumIntegrityEvents + 1}
    `)
    const claimEvents = yield* db.all<{ event_id: string; global_cursor: number; payload_json: string }>(sql`
      SELECT event_id, global_cursor, payload_json FROM operation_event
      WHERE name = 'executor.accepted'
      ORDER BY global_cursor ASC
      LIMIT ${maximumIntegrityEvents + 1}
    `)
    const claimed = rows.filter((row) => row.executor_claim_id !== null)
    if (
      rows.length > maximumIntegrityEvents ||
      rows.length !== dispatchEvents.length ||
      claimed.length !== claimEvents.length ||
      claimed.length !== meta.last_fencing_token
    ) {
      return yield* Effect.fail(
        new LedgerCorruptionError("Dispatch events, outbox, claims, and fencing metadata diverge"),
      )
    }

    for (const [index, row] of rows.entries()) {
      const snapshot = yield* decodeDispatchSnapshot(row)
      const dispatchEvent = dispatchEvents[index]
      if (
        !dispatchEvent ||
        dispatchEvent.event_id !== row.created_event_id ||
        dispatchEvent.global_cursor !== row.created_cursor ||
        digestEvent({ ...snapshot.request }) !== row.request_digest
      ) {
        return yield* Effect.fail(new LedgerCorruptionError("A dispatch outbox row does not match its event"))
      }
      const eventRequest = yield* decodeDispatchRequestJson(dispatchEvent.payload_json, dispatchEvent.event_id)
      if (digestEvent({ ...eventRequest }) !== row.request_digest) {
        return yield* Effect.fail(new LedgerCorruptionError("A dispatch event does not match its immutable outbox"))
      }
      const projectionRows = yield* db.all<ProjectionRow>(
        sql`SELECT * FROM operation_projection WHERE operation_id = ${snapshot.request.operationID} LIMIT 1`,
      )
      if (
        !projectionRows[0] ||
        projectionRows[0].dispatch_request_id !== row.dispatch_request_id ||
        projectionRows[0].state !== dispatchSnapshotState(snapshot)
      ) {
        return yield* Effect.fail(new LedgerCorruptionError("A dispatch snapshot does not match its operation"))
      }
    }

    const orderedTokens = claimed.map((row) => row.fencing_token).sort((left, right) => (left ?? 0) - (right ?? 0))
    if (orderedTokens.some((token, index) => token !== index + 1)) {
      return yield* Effect.fail(new LedgerCorruptionError("Executor fencing tokens are not contiguous"))
    }
    const eventsByID = new Map(claimEvents.map((event) => [event.event_id, event]))
    for (const row of claimed) {
      const claimEvent = row.accepted_event_id ? eventsByID.get(row.accepted_event_id) : undefined
      if (
        !claimEvent ||
        claimEvent.event_id !== row.accepted_event_id ||
        claimEvent.global_cursor !== row.accepted_cursor ||
        !row.claim_json ||
        !row.claim_digest
      ) {
        return yield* Effect.fail(new LedgerCorruptionError("An executor claim does not match its acceptance event"))
      }
      const claim = yield* decodeExecutorClaimJson(claimEvent.payload_json, claimEvent.event_id)
      if (digestEvent({ ...claim }) !== row.claim_digest) {
        return yield* Effect.fail(new LedgerCorruptionError("An executor acceptance event does not match its claim"))
      }
    }
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to verify dispatch integrity")))
}

function dispatchSnapshotState(snapshot: DispatchSnapshot): OperationState {
  if (!snapshot.claim) return "dispatch_pending"
  if (!snapshot.receipt) return "dispatched"
  if (snapshot.receipt.observation.kind === "effect_observed") return "effect_observed"
  if (snapshot.receipt.observation.kind === "no_effect_proved") return "failed"
  return "reconciliation_required"
}

function verifyReceiptIntegrity(db: QueryExecutor): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const receipts = yield* db.all<ReceiptRow>(sql`
      SELECT * FROM operation_receipt ORDER BY event_cursor ASC LIMIT ${maximumIntegrityEvents + 1}
    `)
    const events = yield* db.all<EventRow>(sql`
      SELECT * FROM operation_event
      WHERE name IN ('effect.observed', 'execution.failed_without_effect', 'effect.unknown')
      ORDER BY global_cursor ASC LIMIT ${maximumIntegrityEvents + 1}
    `)
    if (receipts.length > maximumIntegrityEvents || receipts.length !== events.length) {
      return yield* Effect.fail(new LedgerCorruptionError("Receipt events and immutable receipts diverge"))
    }
    for (const [index, row] of receipts.entries()) {
      const eventRow = events[index]
      const receipt = yield* decodeOperationReceiptJson(row.receipt_json, row.receipt_id)
      if (
        !eventRow ||
        row.receipt_id !== receipt.receiptID ||
        row.operation_id !== receipt.operationID ||
        row.attempt_id !== receipt.attemptID ||
        row.dispatch_request_id !== receipt.dispatchRequestID ||
        row.executor_claim_id !== receipt.executorClaimID ||
        row.capability_grant_id !== receipt.capabilityGrantID ||
        row.fencing_token !== receipt.fencingToken ||
        row.receipt_digest !== digestEvent({ ...receipt }) ||
        row.outcome_event_name !== receiptEventName(receipt) ||
        row.event_id !== eventRow.event_id ||
        row.event_cursor !== eventRow.global_cursor
      ) {
        return yield* Effect.fail(new LedgerCorruptionError("An immutable receipt does not match its event"))
      }
      const lifecycle = yield* parseStoredLifecycle(yield* decodeEventRow(eventRow))
      if (!lifecycle.receipt || digestEvent({ ...lifecycle.receipt }) !== row.receipt_digest) {
        return yield* Effect.fail(new LedgerCorruptionError("A receipt event does not match its immutable receipt"))
      }
    }
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to verify operation receipt integrity")))
}

function decodeDispatchRequestJson(
  value: string,
  context: string,
): Effect.Effect<DispatchRequest, LedgerCorruptionError> {
  return Effect.try({
    try: () => {
      const result = parseDispatchRequest(JSON.parse(value))
      if (!result.ok) throw new Error(result.issue.reason)
      return result.value
    },
    catch: (cause) => new LedgerCorruptionError(`Dispatch request ${context} is malformed`, cause),
  })
}

function decodeExecutorClaimJson(value: string, context: string): Effect.Effect<ExecutorClaim, LedgerCorruptionError> {
  return Effect.try({
    try: () => {
      const result = parseExecutorClaim(JSON.parse(value))
      if (!result.ok) throw new Error(result.issue.reason)
      return result.value
    },
    catch: (cause) => new LedgerCorruptionError(`Executor claim ${context} is malformed`, cause),
  })
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
    let baselineTrustDigest: string | null = null
    let baselineAdapterDigest: string | null = null
    let attemptID: AttemptID | null = null
    let capabilityGrantID: string | null = null
    let authorityExpiresAt: string | null = null
    let dispatchRequestID: DispatchRequestID | null = null
    let dispatchExecutor: string | null = null
    let dispatchAdapterDigest: string | null = null
    let dispatchRequestedAt: string | null = null
    let executorClaimID: ExecutorClaimID | null = null
    let fencingToken: number | null = null
    let executorAcceptedAt: string | null = null
    let effectClass: string | null = null
    let resources: ReadonlyArray<string> | null = null
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
      if (event.name === "operation.admitted") {
        admission = lifecycle.admissionKey
        baselineTrustDigest = lifecycle.baselineTrustDigest
        baselineAdapterDigest = lifecycle.baselineAdapterDigest
        effectClass = lifecycle.effectClass
        resources = lifecycle.resources
      }
      if (event.name === "policy.ask") decision = lifecycle.decisionID
      if (
        (event.name === "approval.rejected" || event.name === "approval.granted") &&
        lifecycle.decisionID !== decision
      ) {
        return yield* Effect.fail(
          new LedgerCorruptionError(`Operation ${operationID} approval targets another decision`),
        )
      }
      if (lifecycle.authority) {
        if (lifecycle.authority.baselineDigest !== baselineTrustDigest) {
          return yield* Effect.fail(
            new LedgerCorruptionError(`Operation ${operationID} authority baseline is inconsistent`),
          )
        }
        attemptID = lifecycle.authority.attemptID
        capabilityGrantID = lifecycle.authority.capabilityGrantID
        authorityExpiresAt = lifecycle.authority.expiresAt
        if (event.attemptID !== attemptID || event.causationID !== events.at(-1)?.eventID) {
          return yield* Effect.fail(
            new LedgerCorruptionError(`Operation ${operationID} approval envelope is inconsistent`),
          )
        }
      }
      if (lifecycle.dispatchRequest) {
        if (
          lifecycle.dispatchRequest.operationID !== operationID ||
          lifecycle.dispatchRequest.attemptID !== attemptID ||
          lifecycle.dispatchRequest.capabilityGrantID !== capabilityGrantID ||
          lifecycle.dispatchRequest.baselineDigest !== baselineTrustDigest ||
          lifecycle.dispatchRequest.adapterDigest !== baselineAdapterDigest ||
          lifecycle.dispatchRequest.authorizationExpiresAt !== authorityExpiresAt
        ) {
          return yield* Effect.fail(
            new LedgerCorruptionError(`Operation ${operationID} dispatch authority is inconsistent`),
          )
        }
        dispatchRequestID = lifecycle.dispatchRequest.dispatchRequestID
        dispatchExecutor = lifecycle.dispatchRequest.executor
        dispatchAdapterDigest = lifecycle.dispatchRequest.adapterDigest
        dispatchRequestedAt = lifecycle.dispatchRequest.requestedAt
        if (
          event.attemptID !== attemptID ||
          event.observedAt !== dispatchRequestedAt ||
          event.causationID !== events.at(-1)?.eventID
        ) {
          return yield* Effect.fail(
            new LedgerCorruptionError(`Operation ${operationID} dispatch envelope is inconsistent`),
          )
        }
      }
      if (
        lifecycle.executorClaim &&
        (lifecycle.executorClaim.operationID !== operationID ||
          lifecycle.executorClaim.attemptID !== attemptID ||
          lifecycle.executorClaim.dispatchRequestID !== dispatchRequestID)
      ) {
        return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} executor claim is inconsistent`))
      }
      if (
        lifecycle.executorClaim &&
        (event.attemptID !== attemptID ||
          event.observedAt !== lifecycle.executorClaim.acceptedAt ||
          event.recordedAt !== lifecycle.executorClaim.acceptedAt ||
          event.causationID !== events.at(-1)?.eventID ||
          event.actor.kind !== "system" ||
          event.actor.subject !== dispatchExecutor ||
          event.actor.componentDigest !== dispatchAdapterDigest ||
          Date.parse(lifecycle.executorClaim.acceptedAt) < Date.parse(dispatchRequestedAt ?? ""))
      ) {
        return yield* Effect.fail(
          new LedgerCorruptionError(`Operation ${operationID} executor envelope is inconsistent`),
        )
      }
      if (lifecycle.executorClaim) {
        executorClaimID = lifecycle.executorClaim.executorClaimID
        fencingToken = lifecycle.executorClaim.fencingToken
        executorAcceptedAt = lifecycle.executorClaim.acceptedAt
      }
      if (
        lifecycle.receipt &&
        (lifecycle.receipt.operationID !== operationID ||
          lifecycle.receipt.attemptID !== attemptID ||
          lifecycle.receipt.dispatchRequestID !== dispatchRequestID ||
          lifecycle.receipt.executorClaimID !== executorClaimID ||
          lifecycle.receipt.capabilityGrantID !== capabilityGrantID ||
          lifecycle.receipt.fencingToken !== fencingToken ||
          lifecycle.receipt.adapter.identity !== dispatchExecutor ||
          lifecycle.receipt.adapter.digest !== dispatchAdapterDigest ||
          lifecycle.receipt.effectClass !== effectClass ||
          digestEvent({ resources: lifecycle.receipt.resources }) !== digestEvent({ resources }))
      ) {
        return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} receipt binding is inconsistent`))
      }
      if (
        lifecycle.receipt &&
        (event.attemptID !== attemptID ||
          event.observedAt !== event.recordedAt ||
          event.causationID !== events.at(-1)?.eventID ||
          event.actor.kind !== "system" ||
          event.actor.subject !== dispatchExecutor ||
          event.actor.componentDigest !== dispatchAdapterDigest ||
          Date.parse(lifecycle.receipt.startedAt) < Date.parse(executorAcceptedAt ?? "") ||
          Date.parse(lifecycle.receipt.endedAt) > Date.parse(event.observedAt))
      ) {
        return yield* Effect.fail(
          new LedgerCorruptionError(`Operation ${operationID} receipt envelope is inconsistent`),
        )
      }
      state = transition.state
      previousDigest = event.digest
      previousCursor = event.globalCursor
      events.push(event)
    }

    const last = events.at(-1)
    if (!last || !state || !admission || !baselineTrustDigest || !baselineAdapterDigest) {
      return yield* Effect.fail(new LedgerCorruptionError(`Operation ${operationID} cannot be projected`))
    }
    const operation: OperationRecord = {
      operationID,
      admissionKey: admission,
      state,
      sequence: last.sequence,
      decisionID: decision,
      baselineTrustDigest,
      baselineAdapterDigest,
      attemptID,
      capabilityGrantID,
      authorityExpiresAt,
      dispatchRequestID,
      dispatchExecutor,
      dispatchAdapterDigest,
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
      if (draft.schemaVersion !== eventSchemaVersion) {
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
      if (row.schema_version !== eventSchemaVersion) throw new Error("unknown_schema_version")
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
  if ((name === "approval.rejected" || name === "approval.granted") && lifecycle.decisionID !== operation?.decisionID) {
    return Effect.fail(
      new OperationEventValidationError(
        "Approval must target the active policy decision",
        "$.payload.decisionID",
        "decision_mismatch",
      ),
    )
  }
  if (
    lifecycle.dispatchRequest &&
    (lifecycle.dispatchRequest.operationID !== operation?.operationID ||
      lifecycle.dispatchRequest.attemptID !== operation.attemptID ||
      lifecycle.dispatchRequest.capabilityGrantID !== operation.capabilityGrantID ||
      lifecycle.dispatchRequest.baselineDigest !== operation.baselineTrustDigest ||
      lifecycle.dispatchRequest.adapterDigest !== operation.baselineAdapterDigest ||
      lifecycle.dispatchRequest.authorizationExpiresAt !== operation.authorityExpiresAt)
  ) {
    return Effect.fail(
      new OperationEventValidationError(
        "Dispatch request must use the active operation authority",
        "$.payload",
        "authority_mismatch",
      ),
    )
  }
  if (lifecycle.authority && lifecycle.authority.baselineDigest !== operation?.baselineTrustDigest) {
    return Effect.fail(
      new OperationEventValidationError(
        "Approval authority must bind the admitted trust baseline",
        "$.payload.baselineDigest",
        "baseline_mismatch",
      ),
    )
  }
  if (
    lifecycle.executorClaim &&
    (lifecycle.executorClaim.operationID !== operation?.operationID ||
      lifecycle.executorClaim.attemptID !== operation.attemptID ||
      lifecycle.executorClaim.dispatchRequestID !== operation.dispatchRequestID)
  ) {
    return Effect.fail(
      new OperationEventValidationError(
        "Executor claim must consume the active dispatch request",
        "$.payload",
        "dispatch_mismatch",
      ),
    )
  }
  if (
    lifecycle.receipt &&
    (lifecycle.receipt.operationID !== operation?.operationID ||
      lifecycle.receipt.attemptID !== operation.attemptID ||
      lifecycle.receipt.dispatchRequestID !== operation.dispatchRequestID ||
      lifecycle.receipt.capabilityGrantID !== operation.capabilityGrantID ||
      lifecycle.receipt.adapter.identity !== operation.dispatchExecutor ||
      lifecycle.receipt.adapter.digest !== operation.dispatchAdapterDigest)
  ) {
    return Effect.fail(
      new OperationEventValidationError(
        "Receipt must bind the active dispatch, capability, and adapter",
        "$.payload",
        "receipt_binding_mismatch",
      ),
    )
  }
  return Effect.void
}

function validateTrustedLifecycle(
  operation: OperationRecord | null,
  event: PersistedOperationEvent,
  lifecycle: ParsedLifecyclePayload,
  trustedNow: string,
): Effect.Effect<void, OperationEventValidationError> {
  if (Date.parse(event.observedAt) > Date.parse(event.recordedAt)) {
    return invalidLifecycle("An event cannot be recorded before it was observed", "$.recordedAt", "timestamp_mismatch")
  }
  if (Date.parse(event.recordedAt) > Date.parse(trustedNow)) {
    return invalidLifecycle("An event cannot be recorded in the future", "$.recordedAt", "future_recording")
  }
  if (lifecycle.authority) {
    if (Date.parse(event.observedAt) > Date.parse(trustedNow)) {
      return invalidLifecycle("Approval observation cannot be in the future", "$.observedAt", "future_observation")
    }
    if (Date.parse(lifecycle.authority.expiresAt) <= Date.parse(trustedNow)) {
      return invalidLifecycle("Approval authority is already expired", "$.payload.expiresAt", "authority_expired")
    }
    if (event.attemptID !== lifecycle.authority.attemptID) {
      return invalidLifecycle("Approval event must bind its attempt", "$.attemptID", "attempt_mismatch")
    }
    if (event.causationID !== operation?.lastEventID) {
      return invalidLifecycle(
        "Approval must be caused by the active policy decision",
        "$.causationID",
        "causation_mismatch",
      )
    }
  }
  if (lifecycle.dispatchRequest) {
    if (Date.parse(operation?.authorityExpiresAt ?? "") <= Date.parse(trustedNow)) {
      return invalidLifecycle("Dispatch authority is expired", "$.payload.authorizationExpiresAt", "authority_expired")
    }
    if (Date.parse(lifecycle.dispatchRequest.requestedAt) > Date.parse(trustedNow)) {
      return invalidLifecycle("Dispatch request cannot be future-dated", "$.payload.requestedAt", "future_request")
    }
    if (event.attemptID !== lifecycle.dispatchRequest.attemptID) {
      return invalidLifecycle("Dispatch event must bind its attempt", "$.attemptID", "attempt_mismatch")
    }
    if (event.observedAt !== lifecycle.dispatchRequest.requestedAt) {
      return invalidLifecycle("Dispatch event must bind request time", "$.observedAt", "timestamp_mismatch")
    }
    if (event.causationID !== operation?.lastEventID) {
      return invalidLifecycle("Dispatch must be caused by its approval", "$.causationID", "causation_mismatch")
    }
  }
  if (lifecycle.executorClaim) {
    if (event.attemptID !== lifecycle.executorClaim.attemptID) {
      return invalidLifecycle("Executor acceptance must bind its attempt", "$.attemptID", "attempt_mismatch")
    }
    if (
      event.observedAt !== lifecycle.executorClaim.acceptedAt ||
      event.recordedAt !== lifecycle.executorClaim.acceptedAt
    ) {
      return invalidLifecycle("Executor acceptance time must be ledger generated", "$.observedAt", "timestamp_mismatch")
    }
    if (event.causationID !== operation?.lastEventID) {
      return invalidLifecycle(
        "Executor acceptance must be caused by its dispatch",
        "$.causationID",
        "causation_mismatch",
      )
    }
    if (
      event.actor.kind !== "system" ||
      event.actor.subject !== operation?.dispatchExecutor ||
      event.actor.componentDigest !== operation.dispatchAdapterDigest
    ) {
      return invalidLifecycle("Executor actor does not match the authorized adapter", "$.actor", "executor_mismatch")
    }
  }
  if (lifecycle.receipt) {
    if (event.attemptID !== lifecycle.receipt.attemptID) {
      return invalidLifecycle("Receipt event must bind its attempt", "$.attemptID", "attempt_mismatch")
    }
    if (event.observedAt !== event.recordedAt || Date.parse(lifecycle.receipt.endedAt) > Date.parse(event.observedAt)) {
      return invalidLifecycle("Receipt time must be ledger observed", "$.observedAt", "timestamp_mismatch")
    }
    if (event.causationID !== operation?.lastEventID) {
      return invalidLifecycle("Receipt must be caused by executor acceptance", "$.causationID", "causation_mismatch")
    }
    if (
      event.actor.kind !== "system" ||
      event.actor.subject !== operation?.dispatchExecutor ||
      event.actor.componentDigest !== operation.dispatchAdapterDigest
    ) {
      return invalidLifecycle("Receipt actor does not match the authorized adapter", "$.actor", "executor_mismatch")
    }
  }
  return Effect.void
}

function invalidLifecycle(message: string, path: string, reason: string) {
  return Effect.fail(new OperationEventValidationError(message, path, reason))
}

function requireTrustedNow(clock: LedgerClock) {
  const value = clock()
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
  ) {
    return value
  }
  throw new LedgerCorruptionError("Ledger clock returned a non-canonical timestamp")
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

function insertCapabilityReservation(
  db: QueryExecutor,
  authority: OperationAuthority,
  event: PersistedOperationEvent,
): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const existing = yield* db.all<{ capability_grant_id: string }>(sql`
      SELECT capability_grant_id FROM capability_reservation
      WHERE capability_grant_id = ${authority.capabilityGrantID}
        OR operation_id = ${event.operationID}
        OR attempt_id = ${authority.attemptID}
      LIMIT 1
    `)
    if (existing[0]) return yield* Effect.fail(new CapabilityConflictError(authority.capabilityGrantID))
    yield* db.run(sql`
      INSERT INTO capability_reservation (
        capability_grant_id, operation_id, attempt_id, baseline_digest, reserved_event_id, reserved_cursor
      ) VALUES (
        ${authority.capabilityGrantID}, ${event.operationID}, ${authority.attemptID}, ${authority.baselineDigest},
        ${event.eventID}, ${event.globalCursor}
      )
    `)
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to reserve the capability grant")))
}

function insertCapabilityConsumption(
  db: QueryExecutor,
  request: DispatchRequest,
  event: PersistedOperationEvent,
): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const consumed = yield* db.all<{ capability_grant_id: string }>(sql`
      SELECT capability_grant_id FROM capability_consumption
      WHERE capability_grant_id = ${request.capabilityGrantID}
        OR operation_id = ${request.operationID}
        OR attempt_id = ${request.attemptID}
        OR dispatch_request_id = ${request.dispatchRequestID}
      LIMIT 1
    `)
    if (consumed[0]) return yield* Effect.fail(new CapabilityConflictError(request.capabilityGrantID))
    yield* db.run(sql`
      INSERT INTO capability_consumption (
        capability_grant_id, operation_id, attempt_id, dispatch_request_id, consumed_event_id, consumed_cursor
      ) VALUES (
        ${request.capabilityGrantID}, ${request.operationID}, ${request.attemptID}, ${request.dispatchRequestID},
        ${event.eventID}, ${event.globalCursor}
      )
    `)
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to consume the capability grant")))
}

function validateCapabilityReservation(
  db: QueryExecutor,
  request: DispatchRequest,
): Effect.Effect<void, OperationLedgerError> {
  return Effect.gen(function* () {
    const rows = yield* db.all<CapabilityReservationRow>(sql`
      SELECT * FROM capability_reservation WHERE capability_grant_id = ${request.capabilityGrantID} LIMIT 1
    `)
    if (
      !rows[0] ||
      rows[0].operation_id !== request.operationID ||
      rows[0].attempt_id !== request.attemptID ||
      rows[0].baseline_digest !== request.baselineDigest
    ) {
      return yield* Effect.fail(new CapabilityConflictError(request.capabilityGrantID))
    }
    const consumed = yield* db.all<{ capability_grant_id: string }>(sql`
      SELECT capability_grant_id FROM capability_consumption
      WHERE capability_grant_id = ${request.capabilityGrantID} LIMIT 1
    `)
    if (consumed[0]) return yield* Effect.fail(new CapabilityConflictError(request.capabilityGrantID))
    return undefined
  }).pipe(Effect.mapError(mapStorageError("Failed to validate the reserved capability grant")))
}

function insertDispatchOutbox(
  db: QueryExecutor,
  request: DispatchRequest,
  event: PersistedOperationEvent,
): Effect.Effect<void, OperationLedgerError> {
  return db
    .run(
      sql`
      INSERT INTO dispatch_outbox (
        dispatch_request_id, operation_id, attempt_id, executor, idempotency_key,
        request_json, request_digest, created_event_id, created_cursor
      ) VALUES (
        ${request.dispatchRequestID}, ${request.operationID}, ${request.attemptID}, ${request.executor},
        ${request.idempotencyKey}, ${JSON.stringify(request)}, ${digestEvent({ ...request })},
        ${event.eventID}, ${event.globalCursor}
      )
    `,
    )
    .pipe(Effect.asVoid, Effect.mapError(mapStorageError("Failed to create the immutable dispatch outbox")))
}

function insertExecutorClaim(
  db: QueryExecutor,
  claim: ExecutorClaim,
  event: PersistedOperationEvent,
): Effect.Effect<void, OperationLedgerError> {
  return db
    .run(
      sql`
      INSERT INTO executor_claim (
        executor_claim_id, dispatch_request_id, operation_id, attempt_id, executor,
        fencing_token, claim_json, claim_digest, accepted_event_id, accepted_cursor
      ) VALUES (
        ${claim.executorClaimID}, ${claim.dispatchRequestID}, ${claim.operationID}, ${claim.attemptID},
        ${claim.executor}, ${claim.fencingToken}, ${JSON.stringify(claim)}, ${digestEvent({ ...claim })},
        ${event.eventID}, ${event.globalCursor}
      )
    `,
    )
    .pipe(Effect.asVoid, Effect.mapError(mapStorageError("Failed to consume the dispatch outbox")))
}

function insertOperationReceipt(
  db: QueryExecutor,
  receipt: OperationReceipt,
  receiptDigest: string,
  outcomeEventName: OperationEvent,
  event: PersistedOperationEvent,
): Effect.Effect<void, OperationLedgerError> {
  return db
    .run(
      sql`
      INSERT INTO operation_receipt (
        receipt_id, operation_id, attempt_id, dispatch_request_id, executor_claim_id,
        capability_grant_id, fencing_token, receipt_json, receipt_digest,
        outcome_event_name, event_id, event_cursor
      ) VALUES (
        ${receipt.receiptID}, ${receipt.operationID}, ${receipt.attemptID}, ${receipt.dispatchRequestID},
        ${receipt.executorClaimID}, ${receipt.capabilityGrantID}, ${receipt.fencingToken},
        ${JSON.stringify(receipt)}, ${receiptDigest}, ${outcomeEventName}, ${event.eventID}, ${event.globalCursor}
      )
    `,
    )
    .pipe(Effect.asVoid, Effect.mapError(mapStorageError("Failed to store the immutable operation receipt")))
}

function readReceiptConflictRows(db: QueryExecutor, receipt: OperationReceipt) {
  return db.all<ReceiptRow>(sql`
    SELECT * FROM operation_receipt
    WHERE receipt_id = ${receipt.receiptID}
      OR operation_id = ${receipt.operationID}
      OR attempt_id = ${receipt.attemptID}
      OR dispatch_request_id = ${receipt.dispatchRequestID}
      OR executor_claim_id = ${receipt.executorClaimID}
      OR capability_grant_id = ${receipt.capabilityGrantID}
    LIMIT 1
  `)
}

function decodeOperationReceiptJson(
  value: string,
  context: string,
): Effect.Effect<OperationReceipt, LedgerCorruptionError> {
  return Effect.try({
    try: () => {
      const result = parseOperationReceipt(JSON.parse(value))
      if (!result.ok) throw new Error(result.issue.reason)
      return result.value
    },
    catch: (cause) => new LedgerCorruptionError(`Operation receipt ${context} is malformed`, cause),
  })
}

function readDispatchRows(db: QueryExecutor, dispatchRequestID: DispatchRequestID) {
  return db.all<DispatchJoinRow>(sql`
    SELECT
      dispatch_outbox.*,
      executor_claim.executor_claim_id,
      executor_claim.fencing_token,
      executor_claim.claim_json,
      executor_claim.claim_digest,
      executor_claim.accepted_event_id,
      executor_claim.accepted_cursor,
      operation_receipt.receipt_id,
      operation_receipt.receipt_json,
      operation_receipt.receipt_digest,
      operation_receipt.event_cursor AS receipt_cursor
    FROM dispatch_outbox
    LEFT JOIN executor_claim USING (dispatch_request_id)
    LEFT JOIN operation_receipt USING (dispatch_request_id)
    WHERE dispatch_outbox.dispatch_request_id = ${dispatchRequestID}
    LIMIT 1
  `)
}

function decodeDispatchSnapshot(row: DispatchJoinRow): Effect.Effect<DispatchSnapshot, LedgerCorruptionError> {
  return Effect.try({
    try: () => {
      const requestResult = parseDispatchRequest(JSON.parse(row.request_json))
      if (!requestResult.ok || digestEvent({ ...requestResult.value }) !== row.request_digest) {
        throw new Error("dispatch_request_corrupted")
      }
      if (
        requestResult.value.dispatchRequestID !== row.dispatch_request_id ||
        requestResult.value.operationID !== row.operation_id ||
        requestResult.value.attemptID !== row.attempt_id ||
        requestResult.value.executor !== row.executor ||
        requestResult.value.idempotencyKey !== row.idempotency_key
      ) {
        throw new Error("dispatch_request_columns_mismatch")
      }
      if (row.executor_claim_id === null) {
        if (
          row.fencing_token !== null ||
          row.claim_json !== null ||
          row.claim_digest !== null ||
          row.accepted_event_id !== null ||
          row.accepted_cursor !== null ||
          row.receipt_id !== null ||
          row.receipt_json !== null ||
          row.receipt_digest !== null ||
          row.receipt_cursor !== null
        ) {
          throw new Error("partial_claim_row")
        }
        return {
          request: requestResult.value,
          claim: null,
          receipt: null,
          createdCursor: row.created_cursor,
          acceptedCursor: null,
          receiptCursor: null,
          recoveryStatus: "pending_outbox" as const,
        }
      }
      if (
        row.fencing_token === null ||
        row.claim_json === null ||
        row.claim_digest === null ||
        row.accepted_event_id === null ||
        row.accepted_cursor === null
      ) {
        throw new Error("partial_claim_row")
      }
      const claimResult = parseExecutorClaim(JSON.parse(row.claim_json))
      if (!claimResult.ok || digestEvent({ ...claimResult.value }) !== row.claim_digest) {
        throw new Error("executor_claim_corrupted")
      }
      if (
        claimResult.value.executorClaimID !== row.executor_claim_id ||
        claimResult.value.dispatchRequestID !== row.dispatch_request_id ||
        claimResult.value.operationID !== row.operation_id ||
        claimResult.value.attemptID !== row.attempt_id ||
        claimResult.value.executor !== row.executor ||
        claimResult.value.fencingToken !== row.fencing_token
      ) {
        throw new Error("executor_claim_columns_mismatch")
      }
      if (row.receipt_id === null) {
        if (row.receipt_json !== null || row.receipt_digest !== null || row.receipt_cursor !== null) {
          throw new Error("partial_receipt_row")
        }
        return {
          request: requestResult.value,
          claim: claimResult.value,
          receipt: null,
          createdCursor: row.created_cursor,
          acceptedCursor: row.accepted_cursor,
          receiptCursor: null,
          recoveryStatus: "claimed_no_receipt" as const,
        }
      }
      if (row.receipt_json === null || row.receipt_digest === null || row.receipt_cursor === null) {
        throw new Error("partial_receipt_row")
      }
      const receiptResult = parseOperationReceipt(JSON.parse(row.receipt_json))
      if (!receiptResult.ok || digestEvent({ ...receiptResult.value }) !== row.receipt_digest) {
        throw new Error("operation_receipt_corrupted")
      }
      if (
        receiptResult.value.receiptID !== row.receipt_id ||
        receiptResult.value.operationID !== requestResult.value.operationID ||
        receiptResult.value.attemptID !== requestResult.value.attemptID ||
        receiptResult.value.dispatchRequestID !== requestResult.value.dispatchRequestID ||
        receiptResult.value.executorClaimID !== claimResult.value.executorClaimID ||
        receiptResult.value.capabilityGrantID !== requestResult.value.capabilityGrantID ||
        receiptResult.value.fencingToken !== claimResult.value.fencingToken
      ) {
        throw new Error("operation_receipt_columns_mismatch")
      }
      return {
        request: requestResult.value,
        claim: claimResult.value,
        receipt: receiptResult.value,
        createdCursor: row.created_cursor,
        acceptedCursor: row.accepted_cursor,
        receiptCursor: row.receipt_cursor,
        recoveryStatus: "receipt_ingested" as const,
      }
    },
    catch: (cause) => new LedgerCorruptionError(`Dispatch ${row.dispatch_request_id} is malformed or corrupted`, cause),
  })
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
    const baselineTrustDigest = lifecycle.baselineTrustDigest ?? current?.baselineTrustDigest
    const baselineAdapterDigest = lifecycle.baselineAdapterDigest ?? current?.baselineAdapterDigest
    if (!baselineTrustDigest || !baselineAdapterDigest) {
      return yield* Effect.fail(new LedgerCorruptionError("Admission event did not provide complete baseline digests"))
    }
    const attemptID = lifecycle.authority?.attemptID ?? current?.attemptID ?? null
    const capabilityGrantID = lifecycle.authority?.capabilityGrantID ?? current?.capabilityGrantID ?? null
    const authorityExpiresAt = lifecycle.authority?.expiresAt ?? current?.authorityExpiresAt ?? null
    const dispatchRequestID = lifecycle.dispatchRequest?.dispatchRequestID ?? current?.dispatchRequestID ?? null
    const dispatchExecutor = lifecycle.dispatchRequest?.executor ?? current?.dispatchExecutor ?? null
    const dispatchAdapterDigest = lifecycle.dispatchRequest?.adapterDigest ?? current?.dispatchAdapterDigest ?? null
    if (!current) {
      yield* db.run(sql`
        INSERT INTO operation_projection (
          operation_id, admission_key, state, sequence, decision_id,
          baseline_trust_digest, baseline_adapter_digest,
          attempt_id, capability_grant_id, authority_expires_at, dispatch_request_id,
          dispatch_executor, dispatch_adapter_digest,
          last_event_id, last_cursor, last_digest, updated_at
        ) VALUES (
          ${event.operationID}, ${admission}, ${state}, ${event.sequence}, ${decisionID},
          ${baselineTrustDigest}, ${baselineAdapterDigest},
          ${attemptID}, ${capabilityGrantID}, ${authorityExpiresAt}, ${dispatchRequestID},
          ${dispatchExecutor}, ${dispatchAdapterDigest},
          ${event.eventID}, ${event.globalCursor}, ${event.digest}, ${event.recordedAt}
        )
      `)
    } else {
      yield* db.run(sql`
        UPDATE operation_projection SET
          state = ${state}, sequence = ${event.sequence}, decision_id = ${decisionID},
          baseline_trust_digest = ${baselineTrustDigest}, baseline_adapter_digest = ${baselineAdapterDigest},
          attempt_id = ${attemptID}, capability_grant_id = ${capabilityGrantID},
          authority_expires_at = ${authorityExpiresAt}, dispatch_request_id = ${dispatchRequestID},
          dispatch_executor = ${dispatchExecutor}, dispatch_adapter_digest = ${dispatchAdapterDigest},
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
    row.baseline_trust_digest === operation.baselineTrustDigest &&
    row.baseline_adapter_digest === operation.baselineAdapterDigest &&
    row.attempt_id === operation.attemptID &&
    row.capability_grant_id === operation.capabilityGrantID &&
    row.authority_expires_at === operation.authorityExpiresAt &&
    row.dispatch_request_id === operation.dispatchRequestID &&
    row.dispatch_executor === operation.dispatchExecutor &&
    row.dispatch_adapter_digest === operation.dispatchAdapterDigest &&
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
    baselineTrustDigest: requireStoredDigest(row.baseline_trust_digest, "baseline trust"),
    baselineAdapterDigest: requireStoredDigest(row.baseline_adapter_digest, "baseline adapter"),
    attemptID: row.attempt_id ? requireStoredAttemptID(row.attempt_id) : null,
    capabilityGrantID: row.capability_grant_id,
    authorityExpiresAt: row.authority_expires_at,
    dispatchRequestID: row.dispatch_request_id ? requireStoredDispatchRequestID(row.dispatch_request_id) : null,
    dispatchExecutor: row.dispatch_executor,
    dispatchAdapterDigest: row.dispatch_adapter_digest,
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

function requireStoredAttemptID(value: string): AttemptID {
  const result = parseAttemptID(value)
  if (result.ok) return result.value
  throw new LedgerCorruptionError(`Stored attempt ID ${value} is malformed`)
}

function requireStoredDispatchRequestID(value: string): DispatchRequestID {
  const result = parseDispatchRequestID(value)
  if (result.ok) return result.value
  throw new LedgerCorruptionError(`Stored dispatch request ID ${value} is malformed`)
}

function requireStoredDigest(value: string | null, label: string) {
  const result = parseContentDigest(value)
  if (result.ok) return result.value
  throw new LedgerCorruptionError(`Stored ${label} digest is malformed`)
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
  last_fencing_token: number
}>

type ProjectionRow = Readonly<{
  operation_id: string
  admission_key: string
  state: string
  sequence: number
  decision_id: string | null
  baseline_trust_digest: string | null
  baseline_adapter_digest: string | null
  attempt_id: string | null
  capability_grant_id: string | null
  authority_expires_at: string | null
  dispatch_request_id: string | null
  dispatch_executor: string | null
  dispatch_adapter_digest: string | null
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

type OutboxRow = Readonly<{
  dispatch_request_id: string
  operation_id: string
  attempt_id: string
  executor: string
  idempotency_key: string
  request_json: string
  request_digest: string
  created_event_id: string
  created_cursor: number
}>

type ClaimRow = Readonly<{
  executor_claim_id: string
  dispatch_request_id: string
  operation_id: string
  attempt_id: string
  executor: string
  fencing_token: number
  claim_json: string
  claim_digest: string
  accepted_event_id: string
  accepted_cursor: number
}>

type ReceiptRow = Readonly<{
  receipt_id: string
  operation_id: string
  attempt_id: string
  dispatch_request_id: string
  executor_claim_id: string
  capability_grant_id: string
  fencing_token: number
  receipt_json: string
  receipt_digest: string
  outcome_event_name: string
  event_id: string
  event_cursor: number
}>

type DispatchJoinRow = OutboxRow &
  Readonly<{
    executor_claim_id: string | null
    fencing_token: number | null
    claim_json: string | null
    claim_digest: string | null
    accepted_event_id: string | null
    accepted_cursor: number | null
    receipt_id: string | null
    receipt_json: string | null
    receipt_digest: string | null
    receipt_cursor: number | null
  }>

type CapabilityReservationRow = Readonly<{
  capability_grant_id: string
  operation_id: string
  attempt_id: string
  baseline_digest: string
  reserved_event_id: string
  reserved_cursor: number
}>

type CapabilityConsumptionRow = Readonly<{
  capability_grant_id: string
  operation_id: string
  attempt_id: string
  dispatch_request_id: string
  consumed_event_id: string
  consumed_cursor: number
}>
