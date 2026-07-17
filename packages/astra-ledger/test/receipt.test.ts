import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { parseOperationReceipt, type OperationReceipt } from "@astra/domain/operation-contract"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { makeOperationLedger, ReceiptConflictError, ReceiptIngestionError } from "../src"
import {
  makeOperationLedgerWithClock,
  makeOperationLedgerWithDeferredFault,
  makeOperationLedgerWithFault,
} from "../src/testing"
import {
  alternateContentDigest,
  admittedPayload,
  attemptID,
  authorizedLifecycle,
  capabilityDigest,
  capabilityGrantID,
  contentDigest,
  dispatchRequest,
  dispatchRequestID,
  eventIDs,
  executorClaimID,
  operationID,
  receiptVerificationContext,
} from "./ledger.fixture"

const withDatabase = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const claimCommand = {
  dispatchRequestID,
  operationID,
  attemptID,
  capabilityDigest,
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

const receiptEvent = {
  eventID: eventIDs(66),
  schemaVersion: 1,
  correlationID: authorizedLifecycle[3].event.correlationID,
  redaction: "internal" as const,
  externalBlobDigest: null,
} as const

const observedCompletionContext = {
  schemaVersion: 3,
  admittedBaselineDigest: contentDigest,
  workspaceIdentity: { device: "16777233", inode: "42" },
  executionBoundary: "host_no_sandbox",
  observationDigest: contentDigest,
  limitations: ["provider response observed; semantic correctness not independently verified"],
} as const satisfies OperationReceipt["verificationContext"]

const providerResources = ["provider:turn"] as const
const providerAuthorizedLifecycle = [
  {
    ...authorizedLifecycle[0],
    event: {
      ...authorizedLifecycle[0].event,
      payload: {
        ...admittedPayload,
        effectSpecification: {
          ...admittedPayload.effectSpecification,
          effectClass: "provider_turn",
          targetDescriptors: [{ resource: "provider:turn", mode: "request_response" }],
          completionCriteria: ["provider_turn_response_observed"],
        },
        resources: providerResources,
      },
    },
  },
  ...authorizedLifecycle.slice(1),
] as const

describe("specialized operation receipt ingestion", () => {
  test("maps observations to honest lifecycle states without claiming verification", async () => {
    const cases = [
      {
        observation: {
          kind: "effect_observed" as const,
          beforeDigest: null,
          afterDigest: contentDigest,
        },
        eventName: "effect.observed",
        state: "effect_observed",
      },
      {
        observation: { kind: "no_effect_proved" as const, proofDigest: contentDigest },
        eventName: "execution.failed_without_effect",
        state: "failed",
      },
      {
        observation: { kind: "effect_unknown" as const, observationDigest: contentDigest },
        eventName: "effect.unknown",
        state: "reconciliation_required",
      },
    ]

    for (const candidate of cases) {
      await withDatabase(
        ":memory:",
        Effect.gen(function* () {
          let now = "2026-07-17T10:00:04.000Z"
          const ledger = yield* makeOperationLedgerWithClock(() => now)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          now = "2026-07-17T10:00:06.000Z"
          const receipt = makeReceipt(candidate.observation)
          const result = yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
          expect(result).toMatchObject({
            kind: "ingested",
            event: { name: candidate.eventName },
            operation: { state: candidate.state },
          })
          expect(JSON.stringify(result)).not.toContain("VERIFIED")
          expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
            receipt,
            receiptCursor: 6,
            recoveryStatus: "receipt_ingested",
          })
        }),
      )
    }
  })

  test("accepts observed completion only for an admitted provider turn", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(providerAuthorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        const receipt = makeReceipt(
          {
            kind: "effect_completed",
            completionDigest: contentDigest,
            assurance: "observed_not_verified",
          },
          observedCompletionContext,
          { effectClass: "provider_turn", resources: providerResources },
        )
        const result = yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        expect(result).toMatchObject({
          kind: "ingested",
          event: { name: "effect.completed" },
          operation: { state: "completed" },
        })
        expect(JSON.stringify(result)).not.toContain("VERIFIED")
      }),
    )
  })

  test("rejects observed completion for workspace writes without terminating the operation", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        const receipt = makeReceipt(
          {
            kind: "effect_completed",
            completionDigest: contentDigest,
            assurance: "observed_not_verified",
          },
          observedCompletionContext,
        )
        expect(yield* ledger.ingestReceipt({ receipt, event: receiptEvent }).pipe(Effect.flip)).toMatchObject({
          _tag: "ReceiptIngestionError",
          code: "binding_mismatch",
        })
        expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "dispatched", sequence: 5 })
        expect(yield* ledger.readGlobalCursor()).toBe(5)
      }),
    )
  })

  test("replays the exact receipt and rejects divergent immutable facts", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        const receipt = makeReceipt({
          kind: "effect_observed",
          beforeDigest: null,
          afterDigest: contentDigest,
        })
        const ingested = yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        expect(yield* ledger.ingestReceipt({ receipt, event: receiptEvent })).toEqual({
          ...ingested,
          kind: "replayed",
        })
        const divergent = requireReceipt({
          ...receipt,
          output: { ...receipt.output, preview: "different" },
        })
        expect(
          yield* ledger.ingestReceipt({ receipt: divergent, event: receiptEvent }).pipe(Effect.flip),
        ).toBeInstanceOf(ReceiptConflictError)
        expect(yield* ledger.readGlobalCursor()).toBe(6)
      }),
    )
  })

  test("rejects pre-claim, forged, and stale receipts without appending an event", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        const valid = makeReceipt({
          kind: "effect_observed",
          beforeDigest: null,
          afterDigest: contentDigest,
        })
        const preClaim = yield* ledger.ingestReceipt({ receipt: valid, event: receiptEvent }).pipe(Effect.flip)
        expect(preClaim).toBeInstanceOf(ReceiptIngestionError)
        expect(preClaim).toMatchObject({ code: "claim_not_accepted" })

        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        const forged = [
          { ...valid, executorClaimID: "0196e4cb-5d80-7b1d-8fb2-263b81670443" },
          { ...valid, capabilityGrantID: "0196e4cb-5d80-7b1d-8fb2-263b81670444" },
          { ...valid, fencingToken: 2 },
          { ...valid, adapter: { ...valid.adapter, identity: "other-executor" } },
          { ...valid, attemptID: "0196e4cb-5d80-7b1d-8fb2-263b81670445" },
          { ...valid, effectClass: "process_execution" },
          { ...valid, resources: ["workspace:other.txt"] },
          {
            ...valid,
            verificationContext: {
              ...receiptVerificationContext,
              admittedRepositorySnapshotDigest: alternateContentDigest,
            },
          },
          {
            ...valid,
            verificationContext: {
              admittedBaselineDigest: receiptVerificationContext.admittedBaselineDigest,
              postEffectWorkspaceDigest: receiptVerificationContext.postEffectWorkspaceDigest,
              workspaceIdentity: receiptVerificationContext.workspaceIdentity,
              targetIdentity: receiptVerificationContext.targetIdentity,
              preflightLimits: receiptVerificationContext.preflightLimits,
              activationGuard: receiptVerificationContext.activationGuard,
            },
          },
          { ...valid, verificationContext: observedCompletionContext },
          {
            ...valid,
            observation: {
              kind: "effect_completed",
              completionDigest: contentDigest,
              assurance: "observed_not_verified",
            },
            verificationContext: {
              ...observedCompletionContext,
              observationDigest: alternateContentDigest,
            },
          },
        ].map(requireReceipt)
        for (const candidate of forged) {
          const error = yield* ledger.ingestReceipt({ receipt: candidate, event: receiptEvent }).pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "ReceiptIngestionError", code: "binding_mismatch" })
        }
        const stale = requireReceipt({
          ...valid,
          startedAt: "2026-07-17T10:00:03.000Z",
          endedAt: "2026-07-17T10:00:04.000Z",
        })
        expect(yield* ledger.ingestReceipt({ receipt: stale, event: receiptEvent }).pipe(Effect.flip)).toMatchObject({
          _tag: "ReceiptIngestionError",
          code: "stale_claim",
        })
        expect(yield* ledger.readGlobalCursor()).toBe(5)
        expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
          receipt: null,
          recoveryStatus: "claimed_no_receipt",
        })
      }),
    )
  })

  test("rejects a Git-aware receipt context for a non-Git admitted baseline", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        const nonGitAdmission = {
          ...authorizedLifecycle[0],
          event: {
            ...authorizedLifecycle[0].event,
            payload: {
              ...admittedPayload,
              baseline: {
                ...admittedPayload.baseline,
                repository: { kind: "non_git" as const, markerDigest: contentDigest },
              },
            },
          },
        }
        yield* ledger.appendBatch([nonGitAdmission, ...authorizedLifecycle.slice(1)])
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"

        const error = yield* ledger
          .ingestReceipt({
            receipt: makeReceipt({ kind: "effect_observed", beforeDigest: null, afterDigest: contentDigest }),
            event: receiptEvent,
          })
          .pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "ReceiptIngestionError", code: "binding_mismatch" })
        expect(yield* ledger.readGlobalCursor()).toBe(5)
      }),
    )
  })

  test("rolls back event, receipt, and projection at each receipt fault boundary", async () => {
    for (const point of ["after_receipt_event_insert", "after_receipt_insert", "after_projection_update"] as const) {
      await withDatabase(
        ":memory:",
        Effect.gen(function* () {
          const ledger = yield* point === "after_projection_update"
            ? makeOperationLedgerWithDeferredFault(point, 5)
            : makeOperationLedgerWithFault(point)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          const receipt = makeReceipt({
            kind: "effect_observed",
            beforeDigest: null,
            afterDigest: contentDigest,
          })
          expect(yield* ledger.ingestReceipt({ receipt, event: receiptEvent }).pipe(Effect.flip)).toMatchObject({
            _tag: "LedgerInjectedFault",
            point,
          })
          expect(yield* ledger.readGlobalCursor()).toBe(5)
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "dispatched", sequence: 5 })
          expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
            receipt: null,
            recoveryStatus: "claimed_no_receipt",
          })
        }),
      )
    }
  })

  test("reopens an authentic ingested receipt and retains its recovery classification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-receipt-"))
    const filename = join(directory, "ledger.sqlite")
    const receipt = makeReceipt({
      kind: "effect_observed",
      beforeDigest: null,
      afterDigest: contentDigest,
    })
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          let now = "2026-07-17T10:00:04.000Z"
          const ledger = yield* makeOperationLedgerWithClock(() => now)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          now = "2026-07-17T10:00:06.000Z"
          yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        }),
      )
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "effect_observed", sequence: 6 })
          expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
            receipt,
            recoveryStatus: "receipt_ingested",
          })
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reopens an observed completion as completed without upgrading it to verified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-completed-receipt-"))
    const filename = join(directory, "ledger.sqlite")
    const receipt = makeReceipt(
      {
        kind: "effect_completed",
        completionDigest: contentDigest,
        assurance: "observed_not_verified",
      },
      observedCompletionContext,
      { effectClass: "provider_turn", resources: providerResources },
    )
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          let now = "2026-07-17T10:00:04.000Z"
          const ledger = yield* makeOperationLedgerWithClock(() => now)
          yield* ledger.initialize()
          yield* ledger.appendBatch(providerAuthorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          now = "2026-07-17T10:00:06.000Z"
          yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        }),
      )
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "completed", sequence: 6 })
          expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
            receipt,
            recoveryStatus: "receipt_ingested",
          })
          expect(JSON.stringify(yield* ledger.readEvents(operationID, { limit: 10 }))).not.toContain("VERIFIED")
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("migrates a non-empty v6 receipt table without losing durable observations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-receipt-v6-"))
    const filename = join(directory, "ledger.sqlite")
    const receipt = makeReceipt({ kind: "effect_observed", beforeDigest: null, afterDigest: contentDigest })
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          let now = "2026-07-17T10:00:04.000Z"
          const ledger = yield* makeOperationLedgerWithClock(() => now)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          now = "2026-07-17T10:00:06.000Z"
          yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        }),
      )
      downgradeReceiptTablesToV6(filename)

      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          yield* ledger.initialize()
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "effect_observed", sequence: 6 })
          expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
            receipt,
            recoveryStatus: "receipt_ingested",
          })
        }),
      )

      const native = new Database(filename, { readonly: true })
      expect(native.query<{ schema_version: number }, []>("SELECT schema_version FROM ledger_meta").get()).toEqual({
        schema_version: 7,
      })
      expect(
        native.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'operation_receipt'").get()?.sql,
      ).toContain("'effect.completed'")
      native.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fails closed when an immutable receipt is corrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-ledger-receipt-corruption-"))
    const filename = join(directory, "ledger.sqlite")
    const receipt = makeReceipt({
      kind: "effect_observed",
      beforeDigest: null,
      afterDigest: contentDigest,
    })
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          let now = "2026-07-17T10:00:04.000Z"
          const ledger = yield* makeOperationLedgerWithClock(() => now)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          now = "2026-07-17T10:00:06.000Z"
          yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        }),
      )
      const native = new Database(filename)
      native.run("UPDATE operation_receipt SET receipt_digest = ?", [`sha256:${"0".repeat(64)}`])
      native.close()

      await withDatabase(
        filename,
        Effect.gen(function* () {
          const ledger = yield* makeOperationLedger()
          expect((yield* ledger.initialize().pipe(Effect.flip))._tag).toBe("LedgerCorruptionError")
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function makeReceipt(
  observation: OperationReceipt["observation"],
  verificationContext: OperationReceipt["verificationContext"] = receiptVerificationContext,
  effect: Readonly<{
    effectClass: string
    resources: ReadonlyArray<string>
  }> = { effectClass: "workspace_write", resources: ["workspace:marker.txt"] },
): OperationReceipt {
  return requireReceipt({
    receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670436",
    operationID,
    attemptID,
    dispatchRequestID,
    executorClaimID,
    capabilityGrantID,
    capabilityDigest,
    fencingToken: 1,
    adapter: { identity: dispatchRequest.executor, version: "1", digest: contentDigest },
    effectClass: effect.effectClass,
    resources: effect.resources,
    startedAt: "2026-07-17T10:00:04.000Z",
    endedAt: "2026-07-17T10:00:04.000Z",
    observation,
    verificationContext,
    output: { digest: `sha256:${"7".repeat(64)}`, bytes: 5, preview: "wrote marker.txt" },
  })
}

function requireReceipt(input: unknown): OperationReceipt {
  const result = parseOperationReceipt(input)
  if (!result.ok) throw new Error(`Invalid receipt fixture at ${result.issue.path}`)
  return result.value
}

function downgradeReceiptTablesToV6(filename: string) {
  const native = new Database(filename)
  const receiptSchema = native
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operation_receipt'")
    .get()?.sql
  const evidenceSchema = native
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operation_evidence'")
    .get()?.sql
  if (!receiptSchema || !evidenceSchema) throw new Error("Current receipt schema is unavailable")
  native.exec("PRAGMA foreign_keys = OFF")
  const downgrade = native.transaction(() => {
    native.exec(receiptSchema.replace("operation_receipt", "operation_receipt_v6").replace("'effect.completed', ", ""))
    native.exec("INSERT INTO operation_receipt_v6 SELECT * FROM operation_receipt")
    native.exec(evidenceSchema.replace("operation_evidence", "operation_evidence_v6"))
    native.exec("INSERT INTO operation_evidence_v6 SELECT * FROM operation_evidence")
    native.exec("DROP TABLE operation_evidence")
    native.exec("DROP TABLE operation_receipt")
    native.exec("ALTER TABLE operation_receipt_v6 RENAME TO operation_receipt")
    native.exec("ALTER TABLE operation_evidence_v6 RENAME TO operation_evidence")
    native.run("UPDATE ledger_meta SET schema_version = 6")
  })
  downgrade()
  native.close()
}
