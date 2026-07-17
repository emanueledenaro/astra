import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { parseOperationReceipt, type OperationReceipt } from "@astra/domain/operation-contract"
import { makeReceiptSpool } from "@astra/executor"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { makeOperationLedger, type IngestReceiptResult } from "../src"
import { makeOperationLedgerWithClock } from "../src/testing"
import {
  attemptID,
  authorizedLifecycle,
  capabilityGrantID,
  contentDigest,
  dispatchRequest,
  dispatchRequestID,
  eventIDs,
  executorClaimID,
  operationID,
} from "./ledger.fixture"

const withDatabase = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const receipt = requireReceipt({
  receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670436",
  operationID,
  attemptID,
  dispatchRequestID,
  executorClaimID,
  capabilityGrantID,
  fencingToken: 1,
  adapter: { identity: dispatchRequest.executor, version: "1", digest: contentDigest },
  effectClass: "workspace_write",
  resources: ["workspace:marker.txt"],
  startedAt: "2026-07-17T10:00:04.000Z",
  endedAt: "2026-07-17T10:00:04.000Z",
  observation: {
    kind: "effect_observed",
    beforeDigest: null,
    afterDigest: `sha256:${"8".repeat(64)}`,
  },
  output: { digest: `sha256:${"7".repeat(64)}`, bytes: 5, preview: "wrote marker.txt" },
})

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

const receiptCommand = {
  receipt,
  event: {
    eventID: eventIDs(66),
    schemaVersion: 1,
    correlationID: authorizedLifecycle[3].event.correlationID,
    redaction: "internal" as const,
    externalBlobDigest: null,
  },
} as const

test("recovers an unacknowledged spool receipt through exact ledger replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "astra-receipt-recovery-"))
  const spoolFilename = join(directory, "receipt-spool.sqlite")
  const ledgerFilename = join(directory, "operation-ledger.sqlite")
  let ingested: IngestReceiptResult | undefined
  try {
    await withDatabase(
      spoolFilename,
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        yield* spool.put(receipt)
      }),
    )

    ingested = await withDatabase(
      ledgerFilename,
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        return yield* ledger.ingestReceipt(receiptCommand)
      }),
    )

    await withDatabase(
      spoolFilename,
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        expect(yield* spool.listPending({ limit: 10 })).toHaveLength(1)
      }),
    )

    const replayed = await withDatabase(
      ledgerFilename,
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        return yield* ledger.ingestReceipt(receiptCommand)
      }),
    )
    expect(replayed).toEqual({ ...ingested, kind: "replayed" })

    await withDatabase(
      spoolFilename,
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        yield* spool.markIngested({
          receiptID: receipt.receiptID,
          ledgerEventID: replayed.event.eventID,
          ledgerEventDigest: replayed.event.digest,
        })
      }),
    )

    await withDatabase(
      spoolFilename,
      Effect.gen(function* () {
        const spool = yield* makeReceiptSpool()
        yield* spool.initialize()
        expect(yield* spool.listPending({ limit: 10 })).toEqual([])
        expect((yield* spool.get(receipt.receiptID))?.acknowledgement).toMatchObject({
          ledgerEventID: replayed.event.eventID,
          ledgerEventDigest: replayed.event.digest,
        })
      }),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function requireReceipt(input: unknown): OperationReceipt {
  const result = parseOperationReceipt(input)
  if (!result.ok) throw new Error(`Invalid receipt fixture at ${result.issue.path}`)
  return result.value
}
