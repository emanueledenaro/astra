import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parseOperationReceipt, type OperationReceipt } from "@astra/domain/operation-contract"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { makeReceiptSpool } from "../src"
import { makeReceiptSpoolWithFault } from "../src/testing"

const withDatabase = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const receipt = requireReceipt({
  receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670436",
  operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670431",
  attemptID: "0196e4cb-5d80-7b1d-8fb2-263b81670432",
  dispatchRequestID: "0196e4cb-5d80-7b1d-8fb2-263b81670440",
  executorClaimID: "0196e4cb-5d80-7b1d-8fb2-263b81670442",
  capabilityGrantID: "0196e4cb-5d80-7b1d-8fb2-263b81670435",
  fencingToken: 1,
  adapter: {
    identity: "astra-executor:local",
    version: "1",
    digest: `sha256:${"d".repeat(64)}`,
  },
  effectClass: "workspace_write",
  resources: ["workspace:marker.txt"],
  startedAt: "2026-07-17T10:00:04.000Z",
  endedAt: "2026-07-17T10:00:05.000Z",
  observation: {
    kind: "effect_observed",
    beforeDigest: null,
    afterDigest: `sha256:${"8".repeat(64)}`,
  },
  output: {
    digest: `sha256:${"7".repeat(64)}`,
    bytes: 5,
    preview: "wrote marker.txt",
  },
})

const acknowledgement = {
  receiptID: receipt.receiptID,
  ledgerEventID: "0196e4cb-5d80-7b1d-8fb2-263b81670499",
  ledgerEventDigest: `sha256:${"6".repeat(64)}`,
} as const

describe("durable executor receipt spool", () => {
  test("keeps an unacknowledged receipt pending across a database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-receipt-spool-"))
    const filename = join(directory, "receipts.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const spool = yield* makeReceiptSpool()
          yield* spool.initialize()
          expect((yield* spool.put(receipt)).kind).toBe("inserted")
          expect((yield* spool.put(receipt)).kind).toBe("replayed")
          expect("delete" in spool).toBeFalse()
        }),
      )
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const spool = yield* makeReceiptSpool()
          yield* spool.initialize()
          expect((yield* spool.get(receipt.receiptID))?.receipt).toEqual(receipt)
          expect((yield* spool.listPending({ limit: 10 })).map((entry) => entry.receipt.receiptID)).toEqual([
            receipt.receiptID,
          ])
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects divergent receipt identity without changing durable facts", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        yield* spool.put(receipt)

        const divergent = requireReceipt({
          ...receipt,
          receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670437",
          output: { ...receipt.output, preview: "different" },
        })
        expect((yield* spool.put(divergent).pipe(Effect.flip))._tag).toBe("ReceiptSpoolConflictError")
        expect(yield* spool.listPending({ limit: 10 })).toHaveLength(1)
        expect((yield* spool.listPending({ limit: 0 }).pipe(Effect.flip))._tag).toBe("ReceiptSpoolReadLimitError")
      }),
    )
  })

  test("acknowledges exactly once and preserves the receipt as immutable history", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        yield* spool.put(receipt)
        const acknowledged = yield* spool.markIngested(acknowledgement)
        expect(acknowledged.kind).toBe("acknowledged")
        expect((yield* spool.markIngested(acknowledgement)).kind).toBe("replayed")
        expect(yield* spool.listPending({ limit: 10 })).toEqual([])
        expect((yield* spool.get(receipt.receiptID))?.receipt).toEqual(receipt)

        const conflict = yield* spool
          .markIngested({ ...acknowledgement, ledgerEventDigest: `sha256:${"5".repeat(64)}` })
          .pipe(Effect.flip)
        expect(conflict._tag).toBe("ReceiptSpoolConflictError")
      }),
    )
  })

  test("rolls back injected faults before receipt or acknowledgement commit", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const receiptFaultSpool = yield* makeReceiptSpoolWithFault("after_receipt_insert")
        yield* receiptFaultSpool.initialize()
        expect((yield* receiptFaultSpool.put(receipt).pipe(Effect.flip))._tag).toBe("ReceiptSpoolInjectedFault")

        const spool = yield* makeReceiptSpool()
        expect(yield* spool.get(receipt.receiptID)).toBeNull()
        yield* spool.put(receipt)

        const acknowledgementFaultSpool = yield* makeReceiptSpoolWithFault("after_acknowledgement_insert")
        expect((yield* acknowledgementFaultSpool.markIngested(acknowledgement).pipe(Effect.flip))._tag).toBe(
          "ReceiptSpoolInjectedFault",
        )
        expect(yield* spool.listPending({ limit: 10 })).toHaveLength(1)
      }),
    )
  })

  test("uses WAL, foreign keys, a busy timeout, and FULL synchronous durability", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-receipt-durability-"))
    const filename = join(directory, "receipts.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const spool = yield* makeReceiptSpool()
          yield* spool.initialize()
          expect(yield* spool.readDurability()).toEqual({
            journalMode: "wal",
            foreignKeys: true,
            busyTimeoutMilliseconds: 5000,
            synchronous: "FULL",
          })
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function requireReceipt(input: unknown): OperationReceipt {
  const result = parseOperationReceipt(input)
  if (!result.ok) throw new Error(`Invalid receipt fixture at ${result.issue.path}`)
  return result.value
}
