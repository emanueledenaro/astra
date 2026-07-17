import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import {
  AdmissionConflictError,
  EventConflictError,
  LedgerCorruptionError,
  OperationConcurrencyError,
  OperationTransitionError,
  makeOperationLedger,
} from "../src"
import { makeOperationLedgerWithFault } from "../src/testing"
import {
  admittedPayload,
  admissionKey,
  appendCommand,
  decisionID,
  eventIDs,
  operationID,
  policyDigest,
  previewDigest,
  secondAdmissionKey,
  secondOperationID,
} from "./ledger.fixture"

const withDatabase = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const lifecycle = [
  appendCommand({
    eventID: eventIDs(51),
    name: "operation.admitted",
    payload: admittedPayload,
    expectedState: null,
    expectedSequence: 0,
  }),
  appendCommand({
    eventID: eventIDs(52),
    name: "policy.ask",
    payload: {
      decisionID,
      ruleID: "controlled-write-explicit-consent",
      policyDigest,
      previewDigest,
      approverClass: "workspace-user",
      expiresAt: "2026-07-17T10:05:00.000Z",
    },
    expectedState: "proposed",
    expectedSequence: 1,
    recordedAt: "2026-07-17T10:00:01.000Z",
  }),
  appendCommand({
    eventID: eventIDs(53),
    name: "approval.rejected",
    payload: { decisionID, reasonCode: "user_rejected" },
    expectedState: "awaiting_approval",
    expectedSequence: 2,
    recordedAt: "2026-07-17T10:00:02.000Z",
  }),
] as const

describe("Operation ledger denial lifecycle", () => {
  test("persists an append-only denial lifecycle and reopens it without false verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-"))
    const filename = join(directory, "operations.sqlite")
    try {
      const written = await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          return yield* ledger.appendBatch(lifecycle)
        }),
      )

      expect(written.map((result) => result.kind)).toEqual(["appended", "appended", "appended"])
      expect(written.map((result) => result.operation.state)).toEqual(["proposed", "awaiting_approval", "denied"])
      expect(written.map((result) => result.event.globalCursor)).toEqual([1, 2, 3])
      expect(written[0]?.event.previousDigest).toBeNull()
      expect(written[1]?.event.previousDigest).toBe(written[0]?.event.digest)
      expect(written[2]?.event.previousDigest).toBe(written[1]?.event.digest)

      const reopened = await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          return yield* ledger.getOperation(operationID)
        }),
      )

      expect(reopened).toMatchObject({ operationID, admissionKey, state: "denied", sequence: 3, lastCursor: 3 })
      expect(JSON.stringify(reopened)).not.toContain("VERIFIED")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("returns an exact event replay and rejects a divergent duplicate", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        const first = yield* ledger.append(lifecycle[0])
        const replay = yield* ledger.append(lifecycle[0])
        expect(replay).toEqual({ ...first, kind: "replayed" })

        const error = yield* ledger
          .append({
            ...lifecycle[0],
            event: { ...lifecycle[0].event, observedAt: "2026-07-17T09:59:58.000Z" },
          })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(EventConflictError)
        expect((yield* ledger.readEvents(operationID, { limit: 10 })).length).toBe(1)
      }),
    )
  })

  test("rolls back an entire batch when a later event is rejected", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        const rejected = yield* ledger
          .appendBatch([
            lifecycle[0],
            appendCommand({
              eventID: eventIDs(58),
              name: "approval.rejected",
              payload: { decisionID, reasonCode: "user_rejected" },
              expectedState: "proposed",
              expectedSequence: 1,
            }),
          ])
          .pipe(Effect.flip)

        expect(rejected).toBeInstanceOf(OperationTransitionError)
        expect(yield* ledger.getOperation(operationID)).toBeNull()
        expect(yield* ledger.readGlobalCursor()).toBe(0)
        expect(yield* ledger.readEvents(operationID, { limit: 10 })).toEqual([])
      }),
    )
  })

  test("rejects illegal transitions and stale compare-and-swap without changing the database", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        yield* ledger.append(lifecycle[0])

        const illegal = yield* ledger
          .append(
            appendCommand({
              eventID: eventIDs(54),
              name: "approval.rejected",
              payload: { decisionID, reasonCode: "user_rejected" },
              expectedState: "proposed",
              expectedSequence: 1,
            }),
          )
          .pipe(Effect.flip)
        expect(illegal).toBeInstanceOf(OperationTransitionError)

        const stale = yield* ledger.append({ ...lifecycle[1], expectedSequence: 0 }).pipe(Effect.flip)
        expect(stale).toBeInstanceOf(OperationConcurrencyError)
        expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "proposed", sequence: 1, lastCursor: 1 })
        expect((yield* ledger.readEvents(operationID, { limit: 10 })).length).toBe(1)
      }),
    )
  })

  test("enforces admission key uniqueness across operations", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        yield* ledger.append(lifecycle[0])
        const conflict = yield* ledger
          .append({
            ...lifecycle[0],
            event: {
              ...lifecycle[0].event,
              eventID: eventIDs(55),
              operationID: secondOperationID,
            },
          })
          .pipe(Effect.flip)
        expect(conflict).toBeInstanceOf(AdmissionConflictError)
        expect(yield* ledger.getOperation(secondOperationID)).toBeNull()
      }),
    )
  })

  test("allocates one monotonic global cursor across operations", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        const first = yield* ledger.append(lifecycle[0])
        const second = yield* ledger.append({
          ...lifecycle[0],
          event: {
            ...lifecycle[0].event,
            eventID: eventIDs(56),
            operationID: secondOperationID,
            payload: { ...admittedPayload, admissionKey: secondAdmissionKey },
          },
        })

        expect([first.event.globalCursor, second.event.globalCursor]).toEqual([1, 2])
        expect(yield* ledger.readGlobalCursor()).toBe(2)
      }),
    )
  })

  test("validates supported payloads strictly before writing", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        const error = yield* ledger
          .append({
            ...lifecycle[0],
            event: { ...lifecycle[0].event, payload: { ...admittedPayload, automaticAuthority: true } },
          })
          .pipe(Effect.flip)
        expect(error._tag).toBe("OperationEventValidationError")
        expect(yield* ledger.getOperation(operationID)).toBeNull()
      }),
    )
  })

  test("rejects admission without the complete immutable operation facts", async () => {
    const { verificationPlan: _, ...incompletePayload } = admittedPayload
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        const error = yield* ledger
          .append({
            ...lifecycle[0],
            event: { ...lifecycle[0].event, payload: incompletePayload },
          })
          .pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "OperationEventValidationError",
          path: "$.payload.verificationPlan",
          reason: "missing_field",
        })
        expect(yield* ledger.getOperation(operationID)).toBeNull()
      }),
    )
  })

  test("keeps reads bounded and exposes no delete API", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        expect("delete" in ledger).toBeFalse()
        expect("remove" in ledger).toBeFalse()
        expect((yield* ledger.readEvents(operationID, { limit: 0 }).pipe(Effect.flip))._tag).toBe(
          "LedgerReadLimitError",
        )
        expect((yield* ledger.readEvents(operationID, { limit: 257 }).pipe(Effect.flip))._tag).toBe(
          "LedgerReadLimitError",
        )
      }),
    )
  })

  test("uses WAL, foreign keys, a busy timeout, and FULL synchronous durability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-"))
    try {
      await withDatabase(
        join(directory, "operations.sqlite"),
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          expect(yield* ledger.readDurability()).toEqual({
            journalMode: "wal",
            foreignKeys: true,
            busyTimeoutMilliseconds: 5_000,
            synchronous: "FULL",
          })
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("Operation ledger atomicity and integrity", () => {
  for (const fault of ["after_event_insert", "after_projection_update"] as const) {
    test(`rolls back every durable write on ${fault}`, async () => {
      await withDatabase(
        ":memory:",
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedgerWithFault(fault)
          yield* ledger.initialize()
          expect((yield* ledger.append(lifecycle[0]).pipe(Effect.flip))._tag).toBe("LedgerInjectedFault")
          expect(yield* ledger.getOperation(operationID)).toBeNull()
          expect(yield* ledger.readGlobalCursor()).toBe(0)
          expect(yield* ledger.readEvents(operationID, { limit: 10 })).toEqual([])
        }),
      )
    })
  }

  test("fails closed when an event payload is corrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-"))
    const filename = join(directory, "operations.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          yield* ledger.append(lifecycle[0])
        }),
      )
      const native = new Database(filename)
      native.run("update operation_event set payload_json = '{broken' where operation_id = ?", [operationID])
      native.close()

      const error = await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          return yield* ledger.initialize().pipe(Effect.flip)
        }),
      )
      expect(error).toBeInstanceOf(LedgerCorruptionError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fails closed on an unknown durable schema version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-"))
    const filename = join(directory, "operations.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          yield* ledger.append(lifecycle[0])
        }),
      )
      const native = new Database(filename)
      native.run("update operation_event set schema_version = 2 where operation_id = ?", [operationID])
      native.close()

      const error = await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          return yield* ledger.initialize().pipe(Effect.flip)
        }),
      )
      expect(error).toBeInstanceOf(LedgerCorruptionError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("blocks every mutation when another operation is corrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-"))
    const filename = join(directory, "operations.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          yield* ledger.append(lifecycle[0])
        }),
      )
      const native = new Database(filename)
      native.run("update operation_event set payload_json = '{broken' where operation_id = ?", [operationID])
      native.close()

      const error = await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize().pipe(Effect.ignore)
          return yield* ledger
            .append({
              ...lifecycle[0],
              event: {
                ...lifecycle[0].event,
                eventID: eventIDs(57),
                operationID: secondOperationID,
                payload: { ...admittedPayload, admissionKey: secondAdmissionKey },
              },
            })
            .pipe(Effect.flip)
        }),
      )
      expect(error).toBeInstanceOf(LedgerCorruptionError)

      const nativeAfter = new Database(filename, { readonly: true })
      expect(nativeAfter.query("select count(*) as count from operation_event").get()).toEqual({ count: 1 })
      nativeAfter.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
