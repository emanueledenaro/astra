import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DispatchClaimError } from "../src"
import type { AppendOperationEvent } from "../src"
import { digestEvent } from "../src/digest"
import { makeOperationLedgerWithClock, makeOperationLedgerWithFault } from "../src/testing"
import {
  alternateContentDigest,
  admissionKey,
  attemptID,
  appendCommand,
  authorizedLifecycle,
  decisionID,
  dispatchRequest,
  dispatchRequestID,
  eventIDs,
  executorClaimID,
  operationID,
  secondExecutorClaimID,
  secondAdmissionKey,
  secondAttemptID,
  secondDecisionID,
  secondOperationID,
} from "./ledger.fixture"

const withDatabase = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const claimCommand = {
  dispatchRequestID,
  operationID,
  attemptID,
  executor: dispatchRequest.executor,
  executorClaimID,
  claimExpiresAt: "2026-07-17T10:04:00.000Z",
  event: {
    eventID: eventIDs(65),
    schemaVersion: 1,
    actor: {
      kind: "system" as const,
      subject: dispatchRequest.executor,
      componentDigest: dispatchRequest.adapterDigest,
    },
    correlationID: authorizedLifecycle[3].event.correlationID,
    redaction: "internal" as const,
    externalBlobDigest: null,
  },
} as const

const makeTestLedger = () => makeOperationLedgerWithClock(() => "2026-07-17T10:00:04.000Z")

describe("durable dispatch outbox and one-shot executor claim", () => {
  test("creates an immutable pending outbox atomically with dispatch.requested", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeTestLedger()
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toEqual({
          request: dispatchRequest,
          claim: null,
          receipt: null,
          createdCursor: 4,
          acceptedCursor: null,
          receiptCursor: null,
          recoveryStatus: "pending_outbox",
        })
        expect(yield* ledger.getOperation(operationID)).toMatchObject({
          baselineTrustDigest: dispatchRequest.baselineDigest,
          baselineAdapterDigest: dispatchRequest.adapterDigest,
        })
        expect(yield* ledger.listRecoveryCandidates({ limit: 10 })).toHaveLength(1)
        expect((yield* ledger.listRecoveryCandidates({ limit: 0 }).pipe(Effect.flip))._tag).toBe("LedgerReadLimitError")
        expect("delete" in ledger).toBeFalse()
      }),
    )
  })

  test("allocates one fencing token, consumes the exact request, and replays exactly", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeTestLedger()
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        const claimed = yield* ledger.claimDispatch(claimCommand)
        expect(claimed).toMatchObject({
          kind: "claimed",
          claim: { fencingToken: 1 },
          operation: { state: "dispatched" },
        })
        expect(yield* ledger.claimDispatch(claimCommand)).toEqual({ ...claimed, kind: "replayed" })
        expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
          claim: { executorClaimID, fencingToken: 1 },
          acceptedCursor: 5,
        })
      }),
    )
  })

  test("rejects competing, wrong, and expired claims without consuming the request", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeTestLedger()
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        const wrong = yield* ledger.claimDispatch({ ...claimCommand, executor: "other-executor" }).pipe(Effect.flip)
        expect(wrong).toBeInstanceOf(DispatchClaimError)
        const expired = yield* ledger
          .claimDispatch({
            ...claimCommand,
            claimExpiresAt: "2026-07-17T10:06:00.000Z",
          })
          .pipe(Effect.flip)
        expect(expired).toBeInstanceOf(DispatchClaimError)
        expect((yield* ledger.getDispatchSnapshot(dispatchRequestID))?.claim).toBeNull()
        yield* ledger.claimDispatch(claimCommand)
        const competing = yield* ledger
          .claimDispatch({
            ...claimCommand,
            executorClaimID: secondExecutorClaimID,
            claimExpiresAt: "2026-07-17T10:04:45.000Z",
          })
          .pipe(Effect.flip)
        expect(competing).toBeInstanceOf(DispatchClaimError)
      }),
    )
  })

  test("uses trusted time for approval, dispatch, and claim expiry", async () => {
    for (const stage of ["approval", "dispatch", "claim"] as const) {
      await withDatabase(
        ":memory:",
        Effect.gen(function* () {
          let now = "2026-07-17T10:00:04.000Z"
          const ledger = yield* makeOperationLedgerWithClock(() => now)
          yield* ledger.initialize()
          const prefix = stage === "approval" ? 2 : stage === "dispatch" ? 3 : 4
          yield* ledger.appendBatch(authorizedLifecycle.slice(0, prefix))
          now = "2026-07-17T10:06:00.000Z"
          const error =
            stage === "approval"
              ? yield* ledger.append(authorizedLifecycle[2]).pipe(Effect.flip)
              : stage === "dispatch"
                ? yield* ledger.append(authorizedLifecycle[3]).pipe(Effect.flip)
                : yield* ledger.claimDispatch(claimCommand).pipe(Effect.flip)
          expect(error._tag).toMatch(/OperationEventValidationError|DispatchClaimError/)
          expect((yield* ledger.getDispatchSnapshot(dispatchRequestID))?.claim ?? null).toBeNull()
        }),
      )
    }
  })

  test("binds trust baseline, adapter, attempt, timestamps, and causation before creating an outbox", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeTestLedger()
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle.slice(0, 2))
        const badApproval = yield* ledger
          .append({
            ...authorizedLifecycle[2],
            event: {
              ...authorizedLifecycle[2].event,
              eventID: eventIDs(71),
              payload: { ...authorizedLifecycle[2].event.payload, baselineDigest: alternateContentDigest },
            },
          })
          .pipe(Effect.flip)
        expect(badApproval._tag).toBe("OperationEventValidationError")
        const badAttempt = yield* ledger
          .append({
            ...authorizedLifecycle[2],
            event: { ...authorizedLifecycle[2].event, eventID: eventIDs(72), attemptID: secondAttemptID },
          })
          .pipe(Effect.flip)
        expect(badAttempt._tag).toBe("OperationEventValidationError")
        const badApprovalCausation = yield* ledger
          .append({
            ...authorizedLifecycle[2],
            event: { ...authorizedLifecycle[2].event, eventID: eventIDs(70), causationID: null },
          })
          .pipe(Effect.flip)
        expect(badApprovalCausation._tag).toBe("OperationEventValidationError")
        yield* ledger.append(authorizedLifecycle[2])

        for (const event of [
          {
            ...authorizedLifecycle[3].event,
            eventID: eventIDs(73),
            payload: { ...dispatchRequest, baselineDigest: alternateContentDigest },
          },
          {
            ...authorizedLifecycle[3].event,
            eventID: eventIDs(74),
            payload: { ...dispatchRequest, adapterDigest: alternateContentDigest },
          },
          { ...authorizedLifecycle[3].event, eventID: eventIDs(75), attemptID: secondAttemptID },
          {
            ...authorizedLifecycle[3].event,
            eventID: eventIDs(76),
            observedAt: "2026-07-17T10:00:02.000Z",
          },
          {
            ...authorizedLifecycle[3].event,
            eventID: eventIDs(69),
            recordedAt: "2026-07-17T10:00:02.000Z",
          },
          {
            ...authorizedLifecycle[3].event,
            eventID: eventIDs(68),
            recordedAt: "2026-07-17T10:00:05.000Z",
          },
          { ...authorizedLifecycle[3].event, eventID: eventIDs(77), causationID: null },
        ]) {
          expect((yield* ledger.append({ ...authorizedLifecycle[3], event }).pipe(Effect.flip))._tag).toBe(
            "OperationEventValidationError",
          )
        }
        expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toBeNull()
      }),
    )
  })

  test("reserves one capability globally and consumes it only with executor acceptance", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const ledger = yield* makeTestLedger()
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle.slice(0, 3))
        const secondAdmission = {
          ...authorizedLifecycle[0],
          event: {
            ...authorizedLifecycle[0].event,
            eventID: eventIDs(78),
            operationID: secondOperationID,
            payload: { ...authorizedLifecycle[0].event.payload, admissionKey: secondAdmissionKey },
          },
        }
        const secondPolicy = {
          ...authorizedLifecycle[1],
          event: {
            ...authorizedLifecycle[1].event,
            eventID: eventIDs(79),
            operationID: secondOperationID,
            payload: { ...authorizedLifecycle[1].event.payload, decisionID: secondDecisionID },
          },
        }
        yield* ledger.appendBatch([secondAdmission, secondPolicy])
        const conflict = yield* ledger
          .append({
            ...authorizedLifecycle[2],
            event: {
              ...authorizedLifecycle[2].event,
              eventID: eventIDs(80),
              operationID: secondOperationID,
              attemptID: secondAttemptID,
              causationID: secondPolicy.event.eventID,
              payload: {
                ...authorizedLifecycle[2].event.payload,
                decisionID: secondDecisionID,
                attemptID: secondAttemptID,
              },
            },
          })
          .pipe(Effect.flip)
        expect(conflict._tag).toBe("CapabilityConflictError")

        yield* ledger.append(authorizedLifecycle[3])
        expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "dispatch_pending" })
        yield* ledger.claimDispatch(claimCommand)
        expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "dispatched" })
      }),
    )
  })

  test("does not consume a reserved capability until the claim commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-capability-"))
    const filename = join(directory, "operations.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeTestLedger()
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
        }),
      )
      const pending = new Database(filename, { readonly: true })
      expect(pending.query("SELECT count(*) AS count FROM capability_reservation").get()).toEqual({ count: 1 })
      expect(pending.query("SELECT count(*) AS count FROM capability_consumption").get()).toEqual({ count: 0 })
      pending.close()
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeTestLedger()
          yield* ledger.initialize()
          yield* ledger.claimDispatch(claimCommand)
          yield* ledger.claimDispatch(claimCommand)
        }),
      )
      const accepted = new Database(filename, { readonly: true })
      expect(accepted.query("SELECT count(*) AS count FROM capability_consumption").get()).toEqual({ count: 1 })
      accepted.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects an executor actor or adapter mismatch and a claim before requestedAt", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        const wrongActor = yield* ledger
          .claimDispatch({
            ...claimCommand,
            event: { ...claimCommand.event, actor: { kind: "user", subject: "user:untrusted" } },
          })
          .pipe(Effect.flip)
        expect(wrongActor._tag).toBe("OperationEventValidationError")
        const wrongAdapter = yield* ledger
          .claimDispatch({
            ...claimCommand,
            event: {
              ...claimCommand.event,
              actor: { ...claimCommand.event.actor, componentDigest: alternateContentDigest },
            },
          })
          .pipe(Effect.flip)
        expect(wrongAdapter._tag).toBe("OperationEventValidationError")
        now = "2026-07-17T10:00:02.000Z"
        expect((yield* ledger.claimDispatch(claimCommand).pipe(Effect.flip))._tag).toBe("DispatchClaimError")
        expect((yield* ledger.getDispatchSnapshot(dispatchRequestID))?.claim).toBeNull()
      }),
    )
  })

  for (const fault of ["after_dispatch_event_insert", "after_outbox_insert"] as const) {
    test(`rolls back dispatch and outbox on ${fault}`, async () => {
      await withDatabase(
        ":memory:",
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedgerWithFault(fault)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle.slice(0, 3))
          expect((yield* ledger.append(authorizedLifecycle[3]).pipe(Effect.flip))._tag).toBe("LedgerInjectedFault")
          expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toBeNull()
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "authorized", sequence: 3 })
        }),
      )
    })
  }

  for (const fault of ["after_claim_event_insert", "after_claim_insert", "after_capability_consumption"] as const) {
    test(`rolls back claim and acceptance on ${fault}`, async () => {
      await withDatabase(
        ":memory:",
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedgerWithFault(fault)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          expect((yield* ledger.claimDispatch(claimCommand).pipe(Effect.flip))._tag).toBe("LedgerInjectedFault")
          expect((yield* ledger.getDispatchSnapshot(dispatchRequestID))?.claim).toBeNull()
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "dispatch_pending", sequence: 4 })
        }),
      )
    })
  }

  test("allows exactly one of two concurrent claims", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-claim-"))
    const filename = join(directory, "operations.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeTestLedger()
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
        }),
      )
      const results = await Promise.allSettled([
        withDatabase(
          filename,
          Effect.gen(function* () {
            const ledger = yield* makeTestLedger()
            return yield* ledger.claimDispatch(claimCommand)
          }),
        ),
        withDatabase(
          filename,
          Effect.gen(function* () {
            const ledger = yield* makeTestLedger()
            return yield* ledger.claimDispatch({
              ...claimCommand,
              executorClaimID: secondExecutorClaimID,
              event: { ...claimCommand.event, eventID: eventIDs(66) },
            })
          }),
        ),
      ])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("migrates a v1 denial ledger in place without losing its events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-migration-"))
    const filename = join(directory, "operations.sqlite")
    try {
      createLegacyV1DenialLedger(filename, [
        ...authorizedLifecycle.slice(0, 2),
        appendCommand({
          eventID: eventIDs(67),
          name: "approval.rejected",
          payload: { decisionID, reasonCode: "user_rejected" },
          expectedState: "awaiting_approval",
          expectedSequence: 2,
        }),
      ])

      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeTestLedger()
          yield* ledger.initialize()
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "denied", sequence: 3 })
          expect(yield* ledger.readEvents(operationID, { limit: 10 })).toHaveLength(3)
          expect(yield* ledger.listRecoveryCandidates({ limit: 10 })).toEqual([])
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function createLegacyV1DenialLedger(filename: string, commands: ReadonlyArray<AppendOperationEvent>) {
  const native = new Database(filename, { create: true })
  native.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE ledger_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      last_cursor INTEGER NOT NULL CHECK (last_cursor >= 0)
    );
    CREATE TABLE operation_event (
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
    );
    CREATE INDEX operation_event_operation_cursor ON operation_event (operation_id, sequence);
    CREATE TABLE operation_projection (
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
    );
  `)
  native.query("INSERT INTO ledger_meta VALUES (1, 1, ?)").run(commands.length)
  const insert = native.query(`
    INSERT INTO operation_event VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let previousDigest: string | null = null
  const events = commands.map((command, index) => {
    const sequence = index + 1
    const unsigned = { ...command.event, sequence, previousDigest, digest: `sha256:${"0".repeat(64)}` }
    const { digest: _, ...withoutDigest } = unsigned
    const digest = digestEvent({ globalCursor: sequence, ...withoutDigest })
    previousDigest = digest
    const event = { ...unsigned, digest, globalCursor: sequence }
    insert.run(
      event.eventID,
      event.globalCursor,
      event.operationID,
      event.sequence,
      event.name,
      event.schemaVersion,
      event.recordedAt,
      event.observedAt,
      JSON.stringify(event.actor),
      event.causationID,
      event.correlationID,
      event.attemptID,
      JSON.stringify(event.payload),
      event.previousDigest,
      event.digest,
      event.redaction,
      event.externalBlobDigest,
    )
    return event
  })
  const last = events.at(-1)
  if (!last) throw new Error("Legacy fixture requires events")
  native
    .query("INSERT INTO operation_projection VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      operationID,
      admissionKey,
      "denied",
      last.sequence,
      decisionID,
      last.eventID,
      last.globalCursor,
      last.digest,
      last.recordedAt,
    )
  native.close()
}
