import {
  parseOperationReceipt,
  parseReceiptID,
  type OperationReceipt,
  type ReceiptID,
} from "@astra/domain/operation-contract"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { digestReceipt } from "./digest"
import {
  ReceiptSpoolConflictError,
  ReceiptSpoolCorruptionError,
  ReceiptSpoolInjectedFault,
  ReceiptSpoolReadLimitError,
  ReceiptSpoolValidationError,
  mapSpoolStorageError,
  type ReceiptSpoolError,
  type ReceiptSpoolFaultPoint,
} from "./error"

const maximumReadReceipts = 256
const maximumIntegrityReceipts = 100_000
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sha256Digest = /^sha256:[0-9a-f]{64}$/

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type Database = Effect.Success<typeof makeDatabase>
type QueryExecutor = Pick<Database, "all" | "run">

export type ReceiptAcknowledgement = Readonly<{
  receiptID: ReceiptID
  ledgerEventID: string
  ledgerEventDigest: string
  acknowledgedAt: string
}>

export type SpoolEntry = Readonly<{
  receipt: OperationReceipt
  receiptDigest: string
  receivedAt: string
  acknowledgement: ReceiptAcknowledgement | null
}>

export type PutReceiptResult = Readonly<{ kind: "inserted" | "replayed"; entry: SpoolEntry }>
export type MarkIngestedResult = Readonly<{ kind: "acknowledged" | "replayed"; entry: SpoolEntry }>

export type ReceiptSpoolDurability = Readonly<{
  journalMode: string
  foreignKeys: boolean
  busyTimeoutMilliseconds: number
  synchronous: "OFF" | "NORMAL" | "FULL" | "EXTRA"
}>

export interface ReceiptSpool {
  initialize(): Effect.Effect<void, ReceiptSpoolError>
  put(receipt: OperationReceipt): Effect.Effect<PutReceiptResult, ReceiptSpoolError>
  get(receiptID: ReceiptID): Effect.Effect<SpoolEntry | null, ReceiptSpoolError>
  listPending(options: Readonly<{ limit: number }>): Effect.Effect<ReadonlyArray<SpoolEntry>, ReceiptSpoolError>
  readDurability(): Effect.Effect<ReceiptSpoolDurability, ReceiptSpoolError>
}

export interface CoordinatorReceiptSpool extends ReceiptSpool {
  acknowledgeIngestedReceipt(
    input: Readonly<{
      receiptID: ReceiptID
      ledgerEventID: string
      ledgerEventDigest: string
    }>,
  ): Effect.Effect<MarkIngestedResult, ReceiptSpoolError>
}

type SpoolFault = (point: ReceiptSpoolFaultPoint) => Effect.Effect<void, ReceiptSpoolInjectedFault>
export type ReceiptSpoolClock = () => string

export function makeReceiptSpool(): Effect.Effect<
  ReceiptSpool,
  never,
  import("effect/unstable/sql/SqlClient").SqlClient
> {
  return Effect.map(
    makeReceiptSpoolInternal(
      () => Effect.void,
      () => new Date().toISOString(),
    ),
    publicReceiptSpool,
  )
}

export function makeReceiptSpoolInternal(
  injectFault: SpoolFault,
  clock: ReceiptSpoolClock = () => new Date().toISOString(),
): Effect.Effect<CoordinatorReceiptSpool, never, import("effect/unstable/sql/SqlClient").SqlClient> {
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    return {
      initialize: () => initialize(db),
      put: (receipt) => put(db, receipt, injectFault, clock),
      get: (receiptID) => get(db, receiptID),
      listPending: (options) => listPending(db, options.limit),
      acknowledgeIngestedReceipt: (input) => markIngested(db, input, injectFault, clock),
      readDurability: () => readDurability(db),
    }
  })
}

const coordinatorAuthority = Symbol("astra.executor.coordinator")

export function createCoordinatorReceiptSpoolFactory() {
  const authority = coordinatorAuthority
  return (): Effect.Effect<CoordinatorReceiptSpool, never, import("effect/unstable/sql/SqlClient").SqlClient> => {
    if (authority !== coordinatorAuthority) throw new TypeError("Receipt acknowledgement authority is invalid")
    return makeReceiptSpoolInternal(
      () => Effect.void,
      () => new Date().toISOString(),
    )
  }
}

function publicReceiptSpool(spool: CoordinatorReceiptSpool): ReceiptSpool {
  return {
    initialize: () => spool.initialize(),
    put: (receipt) => spool.put(receipt),
    get: (receiptID) => spool.get(receiptID),
    listPending: (options) => spool.listPending(options),
    readDurability: () => spool.readDurability(),
  }
}

function initialize(db: Database): Effect.Effect<void, ReceiptSpoolError> {
  return Effect.gen(function* () {
    yield* db.run(sql`PRAGMA journal_mode = WAL`)
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* db.run(sql`PRAGMA busy_timeout = 5000`)
    yield* db.run(sql`PRAGMA synchronous = FULL`)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS receipt_spool (
        receipt_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        dispatch_request_id TEXT NOT NULL UNIQUE,
        executor_claim_id TEXT NOT NULL UNIQUE,
        capability_grant_id TEXT NOT NULL UNIQUE,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        receipt_json TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        received_at TEXT NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS receipt_ingestion_ack (
        receipt_id TEXT PRIMARY KEY,
        ledger_event_id TEXT NOT NULL UNIQUE,
        ledger_event_digest TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL,
        FOREIGN KEY (receipt_id) REFERENCES receipt_spool(receipt_id)
      )
    `)
    yield* verifyIntegrity(db)
  }).pipe(Effect.mapError(mapSpoolStorageError("Failed to initialize the receipt spool")))
}

function put(
  db: Database,
  input: OperationReceipt,
  injectFault: SpoolFault,
  clock: ReceiptSpoolClock,
): Effect.Effect<PutReceiptResult, ReceiptSpoolError> {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) {
    return Effect.fail(
      new ReceiptSpoolValidationError("Invalid operation receipt", parsed.issue.path, parsed.issue.reason),
    )
  }
  const receipt = parsed.value
  const receiptDigest = digestReceipt({ ...receipt })
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* verifyIntegrity(tx)
          const rows = yield* tx.all<SpoolJoinRow>(sql`
            SELECT receipt_spool.*, receipt_ingestion_ack.ledger_event_id,
              receipt_ingestion_ack.ledger_event_digest, receipt_ingestion_ack.acknowledged_at
            FROM receipt_spool LEFT JOIN receipt_ingestion_ack USING (receipt_id)
            WHERE receipt_spool.receipt_id = ${receipt.receiptID}
              OR receipt_spool.attempt_id = ${receipt.attemptID}
              OR receipt_spool.dispatch_request_id = ${receipt.dispatchRequestID}
              OR receipt_spool.executor_claim_id = ${receipt.executorClaimID}
              OR receipt_spool.capability_grant_id = ${receipt.capabilityGrantID}
            LIMIT 1
          `)
          if (rows[0]) {
            const entry = yield* decodeEntry(rows[0])
            if (entry.receipt.receiptID === receipt.receiptID && entry.receiptDigest === receiptDigest) {
              return { kind: "replayed" as const, entry }
            }
            return yield* Effect.fail(new ReceiptSpoolConflictError(receipt.receiptID))
          }
          const receivedAt = yield* readClock(clock)
          yield* tx.run(sql`
            INSERT INTO receipt_spool (
              receipt_id, operation_id, attempt_id, dispatch_request_id, executor_claim_id,
              capability_grant_id, fencing_token, receipt_json, receipt_digest, received_at
            ) VALUES (
              ${receipt.receiptID}, ${receipt.operationID}, ${receipt.attemptID}, ${receipt.dispatchRequestID},
              ${receipt.executorClaimID}, ${receipt.capabilityGrantID}, ${receipt.fencingToken},
              ${JSON.stringify(receipt)}, ${receiptDigest}, ${receivedAt}
            )
          `)
          yield* injectFault("after_receipt_insert")
          return {
            kind: "inserted" as const,
            entry: { receipt, receiptDigest, receivedAt, acknowledgement: null },
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapSpoolStorageError("Failed to store the executor receipt")))
}

function markIngested(
  db: Database,
  input: Readonly<{ receiptID: ReceiptID; ledgerEventID: string; ledgerEventDigest: string }>,
  injectFault: SpoolFault,
  clock: ReceiptSpoolClock,
): Effect.Effect<MarkIngestedResult, ReceiptSpoolError> {
  const receiptID = parseReceiptID(input.receiptID, "$.receiptID")
  if (!receiptID.ok) {
    return Effect.fail(
      new ReceiptSpoolValidationError("Invalid receipt ID", receiptID.issue.path, receiptID.issue.reason),
    )
  }
  if (!canonicalUuid.test(input.ledgerEventID)) {
    return Effect.fail(new ReceiptSpoolValidationError("Invalid ledger event ID", "$.ledgerEventID", "expected_uuid"))
  }
  if (!sha256Digest.test(input.ledgerEventDigest)) {
    return Effect.fail(
      new ReceiptSpoolValidationError("Invalid ledger event digest", "$.ledgerEventDigest", "expected_digest"),
    )
  }
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* verifyIntegrity(tx)
          const rows = yield* readEntryRows(tx, input.receiptID)
          if (!rows[0]) {
            return yield* Effect.fail(new ReceiptSpoolValidationError("Receipt not found", "$.receiptID", "not_found"))
          }
          const entry = yield* decodeEntry(rows[0])
          if (entry.acknowledgement) {
            if (
              entry.acknowledgement.ledgerEventID === input.ledgerEventID &&
              entry.acknowledgement.ledgerEventDigest === input.ledgerEventDigest
            ) {
              return { kind: "replayed" as const, entry }
            }
            return yield* Effect.fail(new ReceiptSpoolConflictError(input.receiptID))
          }
          const acknowledgementOwners = yield* tx.all<{ receipt_id: string }>(sql`
            SELECT receipt_id FROM receipt_ingestion_ack
            WHERE ledger_event_id = ${input.ledgerEventID}
            LIMIT 1
          `)
          if (acknowledgementOwners[0] && acknowledgementOwners[0].receipt_id !== input.receiptID) {
            return yield* Effect.fail(new ReceiptSpoolConflictError(input.receiptID))
          }
          const acknowledgedAt = yield* readClock(clock)
          yield* tx.run(sql`
            INSERT INTO receipt_ingestion_ack (
              receipt_id, ledger_event_id, ledger_event_digest, acknowledged_at
            ) VALUES (
              ${input.receiptID}, ${input.ledgerEventID}, ${input.ledgerEventDigest}, ${acknowledgedAt}
            )
          `)
          yield* injectFault("after_acknowledgement_insert")
          return {
            kind: "acknowledged" as const,
            entry: {
              ...entry,
              acknowledgement: {
                receiptID: input.receiptID,
                ledgerEventID: input.ledgerEventID,
                ledgerEventDigest: input.ledgerEventDigest,
                acknowledgedAt,
              },
            },
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.mapError(mapSpoolStorageError("Failed to acknowledge the ingested receipt")))
}

function get(db: Database, receiptID: ReceiptID): Effect.Effect<SpoolEntry | null, ReceiptSpoolError> {
  const parsed = parseReceiptID(receiptID, "$.receiptID")
  if (!parsed.ok) {
    return Effect.fail(new ReceiptSpoolValidationError("Invalid receipt ID", parsed.issue.path, parsed.issue.reason))
  }
  return Effect.gen(function* () {
    yield* verifyIntegrity(db)
    const rows = yield* readEntryRows(db, parsed.value)
    return rows[0] ? yield* decodeEntry(rows[0]) : null
  }).pipe(Effect.mapError(mapSpoolStorageError("Failed to read the receipt spool entry")))
}

function listPending(db: Database, limit: number): Effect.Effect<ReadonlyArray<SpoolEntry>, ReceiptSpoolError> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumReadReceipts) {
    return Effect.fail(new ReceiptSpoolReadLimitError(limit))
  }
  return Effect.gen(function* () {
    yield* verifyIntegrity(db)
    const rows = yield* db.all<SpoolJoinRow>(sql`
      SELECT receipt_spool.*, NULL AS ledger_event_id, NULL AS ledger_event_digest, NULL AS acknowledged_at
      FROM receipt_spool LEFT JOIN receipt_ingestion_ack USING (receipt_id)
      WHERE receipt_ingestion_ack.receipt_id IS NULL
      ORDER BY receipt_spool.received_at ASC, receipt_spool.receipt_id ASC
      LIMIT ${limit}
    `)
    const entries: Array<SpoolEntry> = []
    for (const row of rows) entries.push(yield* decodeEntry(row))
    return entries
  }).pipe(Effect.mapError(mapSpoolStorageError("Failed to list pending receipts")))
}

function verifyIntegrity(db: QueryExecutor): Effect.Effect<void, ReceiptSpoolError> {
  return Effect.gen(function* () {
    const rows = yield* db.all<SpoolJoinRow>(sql`
      SELECT receipt_spool.*, receipt_ingestion_ack.ledger_event_id,
        receipt_ingestion_ack.ledger_event_digest, receipt_ingestion_ack.acknowledged_at
      FROM receipt_spool LEFT JOIN receipt_ingestion_ack USING (receipt_id)
      ORDER BY receipt_spool.receipt_id ASC
      LIMIT ${maximumIntegrityReceipts + 1}
    `)
    if (rows.length > maximumIntegrityReceipts) {
      return yield* Effect.fail(new ReceiptSpoolCorruptionError("Receipt spool exceeds integrity scan bounds"))
    }
    for (const row of rows) yield* decodeEntry(row)
    const acknowledgementCount = yield* db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM receipt_ingestion_ack
    `)
    const joinedAcknowledgements = rows.filter((row) => row.ledger_event_id !== null).length
    if (!acknowledgementCount[0] || acknowledgementCount[0].count !== joinedAcknowledgements) {
      return yield* Effect.fail(new ReceiptSpoolCorruptionError("Receipt acknowledgements contain orphaned rows"))
    }
    return undefined
  }).pipe(Effect.mapError(mapSpoolStorageError("Failed to verify receipt spool integrity")))
}

function readEntryRows(db: QueryExecutor, receiptID: ReceiptID) {
  return db.all<SpoolJoinRow>(sql`
    SELECT receipt_spool.*, receipt_ingestion_ack.ledger_event_id,
      receipt_ingestion_ack.ledger_event_digest, receipt_ingestion_ack.acknowledged_at
    FROM receipt_spool LEFT JOIN receipt_ingestion_ack USING (receipt_id)
    WHERE receipt_spool.receipt_id = ${receiptID}
    LIMIT 1
  `)
}

function decodeEntry(row: SpoolJoinRow): Effect.Effect<SpoolEntry, ReceiptSpoolCorruptionError> {
  return Effect.try({
    try: () => {
      const receipt = requireReceipt(JSON.parse(row.receipt_json))
      if (
        digestReceipt({ ...receipt }) !== row.receipt_digest ||
        receipt.receiptID !== row.receipt_id ||
        receipt.operationID !== row.operation_id ||
        receipt.attemptID !== row.attempt_id ||
        receipt.dispatchRequestID !== row.dispatch_request_id ||
        receipt.executorClaimID !== row.executor_claim_id ||
        receipt.capabilityGrantID !== row.capability_grant_id ||
        receipt.fencingToken !== row.fencing_token
      ) {
        throw new Error("receipt_columns_mismatch")
      }
      const acknowledged = row.ledger_event_id !== null
      if (
        acknowledged !== (row.ledger_event_digest !== null) ||
        acknowledged !== (row.acknowledged_at !== null) ||
        (row.ledger_event_id !== null && !canonicalUuid.test(row.ledger_event_id)) ||
        (row.ledger_event_digest !== null && !sha256Digest.test(row.ledger_event_digest))
      ) {
        throw new Error("acknowledgement_malformed")
      }
      return {
        receipt,
        receiptDigest: row.receipt_digest,
        receivedAt: requireTimestamp(row.received_at),
        acknowledgement:
          row.ledger_event_id && row.ledger_event_digest && row.acknowledged_at
            ? {
                receiptID: receipt.receiptID,
                ledgerEventID: row.ledger_event_id,
                ledgerEventDigest: row.ledger_event_digest,
                acknowledgedAt: requireTimestamp(row.acknowledged_at),
              }
            : null,
      }
    },
    catch: (cause) => new ReceiptSpoolCorruptionError(`Receipt ${row.receipt_id} is malformed`, cause),
  })
}

function requireReceipt(input: unknown): OperationReceipt {
  const result = parseOperationReceipt(input)
  if (result.ok) return result.value
  throw new ReceiptSpoolValidationError("Invalid operation receipt", result.issue.path, result.issue.reason)
}

function readClock(clock: ReceiptSpoolClock): Effect.Effect<string, ReceiptSpoolCorruptionError> {
  return Effect.try({
    try: () => requireTimestamp(clock()),
    catch: (cause) => new ReceiptSpoolCorruptionError("Receipt spool clock is not canonical", cause),
  })
}

function requireTimestamp(value: string) {
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
  ) {
    return value
  }
  throw new ReceiptSpoolCorruptionError("Receipt spool timestamp is not canonical")
}

function readDurability(db: Database): Effect.Effect<ReceiptSpoolDurability, ReceiptSpoolError> {
  return Effect.gen(function* () {
    const journal = yield* db.all<{ journal_mode: string }>(sql`PRAGMA journal_mode`)
    const foreignKeys = yield* db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
    const busyTimeout = yield* db.all<{ timeout: number }>(sql`PRAGMA busy_timeout`)
    const synchronous = yield* db.all<{ synchronous: number }>(sql`PRAGMA synchronous`)
    const synchronousName = (["OFF", "NORMAL", "FULL", "EXTRA"] as const)[synchronous[0]?.synchronous ?? -1]
    if (!journal[0] || !foreignKeys[0] || !busyTimeout[0] || !synchronousName) {
      return yield* Effect.fail(new ReceiptSpoolCorruptionError("SQLite durability pragmas are malformed"))
    }
    return {
      journalMode: journal[0].journal_mode.toLowerCase(),
      foreignKeys: foreignKeys[0].foreign_keys === 1,
      busyTimeoutMilliseconds: busyTimeout[0].timeout,
      synchronous: synchronousName,
    }
  }).pipe(Effect.mapError(mapSpoolStorageError("Failed to read receipt spool durability")))
}

type SpoolJoinRow = Readonly<{
  receipt_id: string
  operation_id: string
  attempt_id: string
  dispatch_request_id: string
  executor_claim_id: string
  capability_grant_id: string
  fencing_token: number
  receipt_json: string
  receipt_digest: string
  received_at: string
  ledger_event_id: string | null
  ledger_event_digest: string | null
  acknowledged_at: string | null
}>
