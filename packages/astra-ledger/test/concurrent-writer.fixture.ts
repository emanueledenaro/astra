/**
 * Fault-injection writer used by the concurrent-read test. It runs as a
 * separate process so its committed appends land between the read statements
 * of the observing process, which is the seam that used to produce spurious
 * LedgerCorruptionError reads from paired autocommit reads.
 */
import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { parseOperationID } from "@astra/domain/operation-contract"
import { makeOperationLedgerWithClock } from "../src/testing"
import { admittedPayload, appendCommand } from "./ledger.fixture"

const filename = process.argv[2]
const appends = Number(process.argv[3])
if (!filename || !Number.isSafeInteger(appends) || appends < 1) {
  throw new Error("Usage: concurrent-writer.fixture.ts <ledger-filename> <appends>")
}

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

for (let index = 0; index < appends; index++) {
  const id = crypto.randomUUID()
  const parsed = parseOperationID(id)
  if (!parsed.ok) throw new Error("The generated operation ID is not canonical")
  const admissionKey = `sha256:${createHash("sha256").update(`concurrent-writer:${index}:${id}`).digest("hex")}`
  await withDatabase(
    Effect.gen(function* () {
      const ledger = yield* makeOperationLedgerWithClock(() => new Date().toISOString())
      yield* ledger.append(
        appendCommand({
          operationID: parsed.value,
          eventID: crypto.randomUUID(),
          name: "operation.admitted",
          payload: { ...admittedPayload, admissionKey },
          expectedState: null,
          expectedSequence: 0,
        }),
      )
    }),
  )
}
