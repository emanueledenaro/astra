import { describe, expect, test } from "bun:test"
import {
  parseOperationEffectUncertainty,
  parseOperationEvidence,
  parseOperationReceipt,
  type OperationEffectUncertainty,
  type OperationEvidence,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import {
  ClaimUncertaintyConflictError,
  ClaimUncertaintyError,
  EvidenceConflictError,
  EvidenceIngestionError,
} from "../src"
import { makeOperationLedger } from "../src"
import {
  makeOperationLedgerWithClock,
  makeVerificationLedgerWithClock,
  makeVerificationLedgerWithFault,
} from "../src/testing"
import {
  admittedPayload,
  attemptID,
  authorizedLifecycle,
  capabilityGrantID,
  contentDigest,
  dispatchRequest,
  dispatchRequestID,
  eventIDs,
  executorClaimID,
  operationID,
  receiptVerificationContext,
  verificationPlanID,
} from "./ledger.fixture"

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

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
  observation: { kind: "effect_observed", beforeDigest: null, afterDigest: contentDigest },
  verificationContext: receiptVerificationContext,
  output: { digest: contentDigest, bytes: 5, preview: "wrote marker.txt" },
})

const receiptEvent = {
  eventID: eventIDs(66),
  schemaVersion: 1,
  correlationID: authorizedLifecycle[3].event.correlationID,
  redaction: "internal" as const,
  externalBlobDigest: null,
} as const

const evidenceEvents = {
  startedEvent: {
    eventID: eventIDs(67),
    schemaVersion: 1,
    correlationID: authorizedLifecycle[3].event.correlationID,
    redaction: "internal" as const,
    externalBlobDigest: null,
  },
  terminalEvent: {
    eventID: eventIDs(68),
    schemaVersion: 1,
    correlationID: authorizedLifecycle[3].event.correlationID,
    redaction: "internal" as const,
    externalBlobDigest: null,
  },
} as const

describe("specialized independent verification evidence ingestion", () => {
  test("does not expose success-producing evidence ingestion on the generic ledger", async () => {
    await withDatabase(
      Effect.gen(function* () {
        const ledger = yield* makeOperationLedger()
        yield* ledger.initialize()
        expect("ingestEvidence" in ledger).toBeFalse()
      }),
    )
  })

  test("is the only boundary that can reach succeeded and replays exact evidence", async () => {
    await withDatabase(
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeVerificationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        yield* ledger.ingestReceipt({ receipt, event: receiptEvent })

        const evidence = makeEvidence("passed")
        const generic = yield* ledger
          .append({
            expectedState: "effect_observed",
            expectedSequence: 6,
            event: {
              eventID: evidenceEvents.startedEvent.eventID,
              operationID,
              name: "verification.started",
              schemaVersion: 1,
              recordedAt: evidence.observedAt,
              observedAt: evidence.observedAt,
              actor: { kind: "system", subject: evidence.verifier.identity, componentDigest: evidence.verifier.digest },
              causationID: receiptEvent.eventID,
              correlationID: evidenceEvents.startedEvent.correlationID,
              attemptID,
              payload: {
                evidenceID: evidence.evidenceID,
                operationID,
                receiptID: receipt.receiptID,
                verificationPlanID,
                verifier: evidence.verifier,
                snapshotDigest: evidence.snapshotDigest,
                observedAt: evidence.observedAt,
              },
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
          .pipe(Effect.flip)
        expect(generic).toBeInstanceOf(EvidenceIngestionError)

        now = "2026-07-17T10:00:08.000Z"
        const ingested = yield* ledger.ingestEvidence({ evidence, ...evidenceEvents })
        expect(ingested).toMatchObject({
          kind: "ingested",
          startedEvent: { name: "verification.started", sequence: 7 },
          terminalEvent: { name: "verification.passed", sequence: 8 },
          operation: { state: "succeeded", sequence: 8 },
        })
        expect(yield* ledger.ingestEvidence({ evidence, ...evidenceEvents })).toEqual({
          ...ingested,
          kind: "replayed",
        })
        expect(yield* ledger.getVerification(operationID)).toEqual({
          evidence: ingested.evidence,
          evidenceDigest: ingested.evidenceDigest,
          startedEvent: ingested.startedEvent,
          terminalEvent: ingested.terminalEvent,
        })
      }),
    )
  })

  test("rejects a forged verifier, mismatched passed criterion, and divergent replay", async () => {
    await withDatabase(
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeVerificationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:00:06.000Z"
        yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
        now = "2026-07-17T10:00:08.000Z"

        const valid = makeEvidence("passed")
        const forged = requireEvidence({ ...valid, verifier: { ...valid.verifier, identity: "other-verifier" } })
        expect(yield* ledger.ingestEvidence({ evidence: forged, ...evidenceEvents }).pipe(Effect.flip)).toMatchObject({
          code: "binding_mismatch",
        })
        const wrongDigest = requireEvidence({
          ...valid,
          criteria: [{ ...valid.criteria[0], observationDigest: `sha256:${"9".repeat(64)}` }],
        })
        expect(
          yield* ledger.ingestEvidence({ evidence: wrongDigest, ...evidenceEvents }).pipe(Effect.flip),
        ).toMatchObject({ code: "criteria_mismatch" })

        yield* ledger.ingestEvidence({ evidence: valid, ...evidenceEvents })
        const divergent = requireEvidence({ ...valid, limitations: ["different"] })
        expect(
          yield* ledger.ingestEvidence({ evidence: divergent, ...evidenceEvents }).pipe(Effect.flip),
        ).toBeInstanceOf(EvidenceConflictError)
        expect(yield* ledger.readGlobalCursor()).toBe(8)
      }),
    )
  })

  for (const point of [
    "after_verification_started_insert",
    "after_verification_terminal_insert",
    "after_evidence_insert",
  ] as const) {
    test(`rolls back the complete verification transaction on ${point}`, async () => {
      await withDatabase(
        Effect.gen(function* () {
          const ledger = yield* makeVerificationLedgerWithFault(point)
          yield* ledger.initialize()
          yield* ledger.appendBatch(authorizedLifecycle)
          yield* ledger.claimDispatch(claimCommand)
          yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
          expect(
            yield* ledger
              .ingestEvidence({ evidence: makeEvidence("passed", "2026-07-17T10:00:04.000Z"), ...evidenceEvents })
              .pipe(Effect.flip),
          ).toMatchObject({
            point,
          })
          expect(yield* ledger.getOperation(operationID)).toMatchObject({ state: "effect_observed", sequence: 6 })
          expect(yield* ledger.getVerification(operationID)).toBeNull()
        }),
      )
    })
  }
})

describe("claimed dispatch uncertainty", () => {
  test("records claimed-without-receipt as reconciliation required and never retries", async () => {
    await withDatabase(
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        const uncertainty = makeUncertainty()
        const event = {
          eventID: eventIDs(69),
          schemaVersion: 1,
          actor: { kind: "system" as const, subject: "astra-coordinator:recovery", componentDigest: contentDigest },
          correlationID: authorizedLifecycle[3].event.correlationID,
          redaction: "internal" as const,
          externalBlobDigest: null,
        }
        expect(yield* ledger.recordClaimUncertainty({ uncertainty, event }).pipe(Effect.flip)).toMatchObject({
          code: "claim_still_active",
        })
        now = "2026-07-17T10:04:01.000Z"
        const recorded = yield* ledger.recordClaimUncertainty({ uncertainty, event })
        expect(recorded).toMatchObject({
          kind: "recorded",
          event: { name: "effect.unknown", sequence: 6 },
          operation: { state: "reconciliation_required" },
        })
        expect(yield* ledger.recordClaimUncertainty({ uncertainty, event })).toEqual({
          ...recorded,
          kind: "replayed",
        })
        expect(yield* ledger.getDispatchSnapshot(dispatchRequestID)).toMatchObject({
          receipt: null,
          uncertainty,
          recoveryStatus: "claim_uncertain",
        })
        expect(yield* ledger.claimDispatch(claimCommand)).toMatchObject({
          kind: "replayed",
          operation: { state: "reconciliation_required" },
        })
      }),
    )
  })

  test("rejects generic uncertainty and immutable binding conflicts", async () => {
    await withDatabase(
      Effect.gen(function* () {
        let now = "2026-07-17T10:00:04.000Z"
        const ledger = yield* makeOperationLedgerWithClock(() => now)
        yield* ledger.initialize()
        yield* ledger.appendBatch(authorizedLifecycle)
        yield* ledger.claimDispatch(claimCommand)
        now = "2026-07-17T10:04:01.000Z"
        const uncertainty = makeUncertainty()
        const event = {
          eventID: eventIDs(69),
          schemaVersion: 1,
          actor: { kind: "system" as const, subject: "astra-coordinator:recovery", componentDigest: contentDigest },
          correlationID: authorizedLifecycle[3].event.correlationID,
          redaction: "internal" as const,
          externalBlobDigest: null,
        }
        const generic = yield* ledger
          .append({
            expectedState: "dispatched",
            expectedSequence: 5,
            event: {
              ...event,
              operationID,
              name: "effect.unknown",
              recordedAt: uncertainty.observedAt,
              observedAt: uncertainty.observedAt,
              causationID: claimCommand.event.eventID,
              attemptID,
              payload: uncertainty,
            },
          })
          .pipe(Effect.flip)
        expect(generic).toBeInstanceOf(ClaimUncertaintyError)
        yield* ledger.recordClaimUncertainty({ uncertainty, event })
        const divergent = requireUncertainty({
          ...uncertainty,
          targetObservation: { ...uncertainty.targetObservation, state: "present" },
        })
        expect(
          yield* ledger.recordClaimUncertainty({ uncertainty: divergent, event }).pipe(Effect.flip),
        ).toBeInstanceOf(ClaimUncertaintyConflictError)
      }),
    )
  })
})

function makeEvidence(
  result: "passed" | "failed" | "unknown",
  observedAt = "2026-07-17T10:00:07.000Z",
): OperationEvidence {
  return requireEvidence({
    evidenceID: "0196e4cb-5d80-7b1d-8fb2-263b81670437",
    operationID,
    receiptID: receipt.receiptID,
    verificationPlanID,
    verifier: admittedPayload.verificationPlan.verifier,
    snapshotDigest: contentDigest,
    observedAt,
    criteria: [{ criterionID: "marker_exact_bytes", result, observationDigest: contentDigest }],
    limitations: [],
  })
}

function makeUncertainty(): OperationEffectUncertainty {
  return requireUncertainty({
    uncertaintyID: "0196e4cb-5d80-7b1d-8fb2-263b81670470",
    operationID,
    attemptID,
    dispatchRequestID,
    executorClaimID,
    capabilityGrantID,
    fencingToken: 1,
    reason: "claimed_without_receipt",
    observedAt: "2026-07-17T10:04:01.000Z",
    targetObservation: { state: "absent", digest: contentDigest },
  })
}

function requireReceipt(input: unknown): OperationReceipt {
  const result = parseOperationReceipt(input)
  if (!result.ok) throw new Error(`Invalid receipt fixture at ${result.issue.path}`)
  return result.value
}

function requireEvidence(input: unknown): OperationEvidence {
  const result = parseOperationEvidence(input)
  if (!result.ok) throw new Error(`Invalid evidence fixture at ${result.issue.path}`)
  return result.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const result = parseOperationEffectUncertainty(input)
  if (!result.ok) throw new Error(`Invalid uncertainty fixture at ${result.issue.path}`)
  return result.value
}
