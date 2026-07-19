import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { parseOperationReceipt, type OperationReceipt } from "@astra/domain/operation-contract"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { makeReceiptSpool } from "../src"
import { makeReceiptSpoolWithClock, makeReceiptSpoolWithFault } from "../src/testing"

const withDatabase = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const receipt = requireReceipt({
  receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670436",
  operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670431",
  attemptID: "0196e4cb-5d80-7b1d-8fb2-263b81670432",
  dispatchRequestID: "0196e4cb-5d80-7b1d-8fb2-263b81670440",
  executorClaimID: "0196e4cb-5d80-7b1d-8fb2-263b81670442",
  capabilityGrantID: "0196e4cb-5d80-7b1d-8fb2-263b81670435",
  capabilityDigest: `sha256:${"8".repeat(64)}`,
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
  verificationContext: {
    admittedBaselineDigest: `sha256:${"d".repeat(64)}`,
    postEffectWorkspaceDigest: `sha256:${"e".repeat(64)}`,
    workspaceIdentity: { device: "1", inode: "2" },
    targetIdentity: { device: "1", inode: "3" },
    preflightLimits: { maxEntries: 128, maxFileBytes: 65536, maxTotalBytes: 262144, maxDurationMs: 1000 },
    activationGuard: "allowed",
  },
  output: {
    digest: `sha256:${"7".repeat(64)}`,
    bytes: 5,
    preview: "wrote marker.txt",
  },
})

const completedReceipt = requireReceipt({
  ...receipt,
  receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670437",
  effectClass: "provider_turn",
  resources: ["provider:turn"],
  observation: {
    kind: "effect_completed",
    completionDigest: `sha256:${"8".repeat(64)}`,
    assurance: "observed_not_verified",
  },
  verificationContext: {
    schemaVersion: 3,
    admittedBaselineDigest: `sha256:${"d".repeat(64)}`,
    workspaceIdentity: { device: "1", inode: "2" },
    executionBoundary: "host_no_sandbox",
    observationDigest: `sha256:${"8".repeat(64)}`,
    limitations: ["provider response observed; semantic correctness not independently verified"],
  },
  output: { digest: `sha256:${"8".repeat(64)}`, bytes: 12, preview: "provider reply" },
})

const acknowledgement = {
  receiptID: receipt.receiptID,
  ledgerEventID: "0196e4cb-5d80-7b1d-8fb2-263b81670499",
  ledgerEventDigest: `sha256:${"6".repeat(64)}`,
} as const

describe("durable executor receipt spool", () => {
  test("round-trips observed completion without upgrading its assurance", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        yield* spool.put(completedReceipt)
        expect((yield* spool.get(completedReceipt.receiptID))?.receipt).toEqual(completedReceipt)
        expect(JSON.stringify(yield* spool.listPending({ limit: 10 }))).not.toContain("VERIFIED")
      }),
    )
  })

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
          expect("markIngested" in spool).toBeFalse()
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
        const differentCapability = requireReceipt({
          ...receipt,
          capabilityDigest: `sha256:${"9".repeat(64)}`,
        })
        expect((yield* spool.put(differentCapability).pipe(Effect.flip))._tag).toBe("ReceiptSpoolConflictError")
        expect(yield* spool.listPending({ limit: 10 })).toHaveLength(1)
        expect((yield* spool.listPending({ limit: 0 }).pipe(Effect.flip))._tag).toBe("ReceiptSpoolReadLimitError")
      }),
    )
  })

  test("acknowledges exactly once and preserves the receipt as immutable history", async () => {
    await withDatabase(
      ":memory:",
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpoolWithClock(() => "2026-07-17T10:00:06.000Z")
        yield* spool.initialize()
        yield* spool.put(receipt)
        const acknowledged = yield* spool.acknowledgeIngestedReceipt(acknowledgement)
        expect(acknowledged.kind).toBe("acknowledged")
        expect((yield* spool.acknowledgeIngestedReceipt(acknowledgement)).kind).toBe("replayed")
        expect(yield* spool.listPending({ limit: 10 })).toEqual([])
        expect((yield* spool.get(receipt.receiptID))?.receipt).toEqual(receipt)

        const conflict = yield* spool
          .acknowledgeIngestedReceipt({ ...acknowledgement, ledgerEventDigest: `sha256:${"5".repeat(64)}` })
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
        expect(
          (yield* acknowledgementFaultSpool.acknowledgeIngestedReceipt(acknowledgement).pipe(Effect.flip))._tag,
        ).toBe("ReceiptSpoolInjectedFault")
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

  test("fails closed when the normalized capability digest is corrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-receipt-capability-"))
    const filename = join(directory, "receipts.sqlite")
    try {
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const spool = yield* makeReceiptSpool()
          yield* spool.initialize()
          yield* spool.put(receipt)
        }),
      )
      const native = new Database(filename)
      native.run("UPDATE receipt_spool SET capability_digest = ?", [`sha256:${"9".repeat(64)}`])
      native.close()
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const spool = yield* makeReceiptSpool()
          expect((yield* spool.initialize().pipe(Effect.flip))._tag).toBe("ReceiptSpoolCorruptionError")
        }),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("does not invent capability authority for a non-empty legacy spool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astra-receipt-legacy-"))
    const filename = join(directory, "receipts.sqlite")
    try {
      const native = new Database(filename)
      native.run(`
        CREATE TABLE receipt_spool (
          receipt_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL UNIQUE,
          dispatch_request_id TEXT NOT NULL UNIQUE,
          executor_claim_id TEXT NOT NULL UNIQUE,
          capability_grant_id TEXT NOT NULL UNIQUE,
          fencing_token INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          receipt_digest TEXT NOT NULL,
          received_at TEXT NOT NULL
        )
      `)
      native.run(`INSERT INTO receipt_spool VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        receipt.receiptID,
        receipt.operationID,
        receipt.attemptID,
        receipt.dispatchRequestID,
        receipt.executorClaimID,
        receipt.capabilityGrantID,
        receipt.fencingToken,
        JSON.stringify(receipt),
        `sha256:${"7".repeat(64)}`,
        "2026-07-17T10:00:06.000Z",
      ])
      native.close()
      await withDatabase(
        filename,
        Effect.gen(function* () {
          const spool = yield* makeReceiptSpool()
          expect((yield* spool.initialize().pipe(Effect.flip))._tag).toBe("ReceiptSpoolCorruptionError")
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
