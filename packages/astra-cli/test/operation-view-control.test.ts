import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import {
  parseOperationEffectUncertainty,
  parseOperationEvidence,
  parseOperationReceipt,
} from "../../astra-domain/src/operation-contract"
import { operationSemanticKey } from "../../astra-domain/src/operation"
import { makeVerificationLedgerWithClock } from "../../astra-ledger/src/testing"
import {
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
  verificationPlanID,
} from "../../astra-ledger/test/ledger.fixture"
import { createAstraOperationViewControl } from "../src/operation-view-control"
import { createAstraOperationViewControlHandler } from "../src/operation-view-control-handler"

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

const receipt = requireReceipt({
  receiptID: "0196e4cb-5d80-7b1d-8fb2-263b81670436",
  operationID,
  attemptID,
  dispatchRequestID,
  executorClaimID,
  capabilityGrantID,
  capabilityDigest,
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

const evidence = requireEvidence({
  evidenceID: "0196e4cb-5d80-7b1d-8fb2-263b81670437",
  operationID,
  receiptID: receipt.receiptID,
  verificationPlanID,
  verifier: admittedPayload.verificationPlan.verifier,
  snapshotDigest: contentDigest,
  observedAt: "2026-07-17T10:00:07.000Z",
  criteria: [{ criterionID: "marker_exact_bytes", result: "passed", observationDigest: contentDigest }],
  limitations: [],
})

const uncertainty = requireUncertainty({
  uncertaintyID: "0196e4cb-5d80-7b1d-8fb2-263b81670470",
  operationID,
  attemptID,
  dispatchRequestID,
  executorClaimID,
  capabilityGrantID,
  capabilityDigest,
  fencingToken: 1,
  reason: "claimed_without_receipt",
  observedAt: "2026-07-17T10:04:01.000Z",
  targetObservation: { state: "absent", digest: contentDigest },
})

let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "astra-operation-view-"))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function seedLedger(name: string, scenario: "verified" | "observed" | "reconciliation") {
  const filename = join(directory, `${name}.sqlite`)
  await Effect.runPromise(withLedger(scenario).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  return filename
}

function withLedger(
  scenario: "verified" | "observed" | "reconciliation",
): Effect.Effect<void, unknown, SqlClientService> {
  return Effect.gen(function* () {
    let now = "2026-07-17T10:00:04.000Z"
    const ledger = yield* makeVerificationLedgerWithClock(() => now)
    yield* ledger.initialize()
    yield* ledger.appendBatch(authorizedLifecycle)
    yield* ledger.claimDispatch(claimCommand)
    if (scenario === "reconciliation") {
      now = "2026-07-17T10:04:01.000Z"
      yield* ledger.recordClaimUncertainty({
        uncertainty,
        event: {
          eventID: eventIDs(69),
          schemaVersion: 1,
          actor: { kind: "system", subject: "astra-coordinator:recovery", componentDigest: contentDigest },
          correlationID: authorizedLifecycle[3].event.correlationID,
          redaction: "internal",
          externalBlobDigest: null,
        },
      })
      return
    }
    now = "2026-07-17T10:00:06.000Z"
    yield* ledger.ingestReceipt({ receipt, event: receiptEvent })
    if (scenario === "observed") return
    now = "2026-07-17T10:00:08.000Z"
    yield* ledger.ingestEvidence({ evidence, ...evidenceEvents })
  })
}

describe("operation view control projections", () => {
  test("projects a verified operation exactly and never weaker or stronger", async () => {
    const filename = await seedLedger("verified", "verified")
    const control = createAstraOperationViewControl({ ledgerFilename: filename })

    const listed = await control.list(randomUUID())
    expect(listed.status).toBe("listed")
    if (listed.status !== "listed") return
    expect(listed.coverage).toBe("dispatched_operations_only")
    expect(listed.operations).toHaveLength(1)
    expect(listed.operations[0]).toMatchObject({
      operationID,
      intentKind: "controlled_write",
      state: "succeeded",
      semanticKey: "VERIFIED",
    })
    expect(listed.operations[0]?.semanticKey).toBe(operationSemanticKey("succeeded"))

    const detailed = await control.detail(randomUUID(), operationID)
    expect(detailed.status).toBe("detailed")
    if (detailed.status !== "detailed") return
    expect(detailed.operation.semanticKey).toBe("VERIFIED")
    expect(detailed.dispatch).toMatchObject({
      dispatchRequestID,
      recoveryStatus: "receipt_ingested",
      executor: dispatchRequest.executor,
      receipt: { receiptID: receipt.receiptID, outcome: "effect_observed" },
      uncertainty: null,
    })
    expect(detailed.verification).toMatchObject({
      evidenceID: evidence.evidenceID,
      verifier: "workspace-marker",
      criteria: [{ criterionID: "marker_exact_bytes", result: "passed" }],
    })
    expect(detailed.events.map((event) => event.name)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.observed",
      "verification.started",
      "verification.passed",
    ])
    expect(detailed.events.every((event, index) => index === 0 || event.previousDigest !== null)).toBeTrue()
  })

  test("projects an observed effect as EFFECT_OBSERVED with no verification evidence", async () => {
    const filename = await seedLedger("observed", "observed")
    const control = createAstraOperationViewControl({ ledgerFilename: filename })

    const listed = await control.list(randomUUID())
    if (listed.status !== "listed") throw new Error("Expected a listed projection")
    expect(listed.operations[0]).toMatchObject({ state: "effect_observed", semanticKey: "EFFECT_OBSERVED" })

    const detailed = await control.detail(randomUUID(), operationID)
    if (detailed.status !== "detailed") throw new Error("Expected a detailed projection")
    expect(detailed.operation.semanticKey).toBe("EFFECT_OBSERVED")
    expect(detailed.verification).toBeNull()
    expect(detailed.dispatch).toMatchObject({
      recoveryStatus: "receipt_ingested",
      receipt: { outcome: "effect_observed" },
    })
  })

  test("projects claim uncertainty as RECONCILIATION_REQUIRED and surfaces the recovery candidate", async () => {
    const filename = await seedLedger("reconciliation", "reconciliation")
    const control = createAstraOperationViewControl({ ledgerFilename: filename })

    const listed = await control.list(randomUUID())
    if (listed.status !== "listed") throw new Error("Expected a listed projection")
    expect(listed.operations[0]).toMatchObject({
      state: "reconciliation_required",
      semanticKey: "RECONCILIATION_REQUIRED",
    })

    const detailed = await control.detail(randomUUID(), operationID)
    if (detailed.status !== "detailed") throw new Error("Expected a detailed projection")
    expect(detailed.verification).toBeNull()
    expect(detailed.dispatch).toMatchObject({
      recoveryStatus: "claim_uncertain",
      receipt: null,
      uncertainty: { reason: "claimed_without_receipt", observedAt: "2026-07-17T10:04:01.000Z" },
    })

    const recovery = await control.recovery(randomUUID())
    if (recovery.status !== "listed") throw new Error("Expected listed recovery candidates")
    expect(recovery.note).toBe("recovery_is_not_retry_ambiguity_is_preserved")
    expect(recovery.candidates).toHaveLength(1)
    expect(recovery.candidates[0]).toMatchObject({
      dispatchRequestID,
      operationID,
      recoveryStatus: "claim_uncertain",
      executor: dispatchRequest.executor,
    })
  })

  test("returns not_found for an unknown operation and blocks a non-canonical ID", async () => {
    const filename = await seedLedger("not-found", "observed")
    const control = createAstraOperationViewControl({ ledgerFilename: filename })
    const missing = "0196e4cb-5d80-7b1d-8fb2-263b816704ff"
    expect(await control.detail(randomUUID(), missing)).toMatchObject({ status: "not_found", operationID: missing })
    expect(await control.detail(randomUUID(), "not-an-operation")).toMatchObject({
      status: "blocked",
      reason: "invalid_operation_id",
    })
  })

  test("fails closed when the ledger does not exist and reports no operations", async () => {
    const control = createAstraOperationViewControl({ ledgerFilename: join(directory, "absent.sqlite") })
    expect(await control.list(randomUUID())).toMatchObject({ status: "blocked", reason: "ledger_unavailable" })
    expect(await control.detail(randomUUID(), operationID)).toMatchObject({
      status: "blocked",
      reason: "ledger_unavailable",
    })
    expect(await control.recovery(randomUUID())).toMatchObject({ status: "blocked", reason: "ledger_unavailable" })
  })
})

describe("operation view control handler", () => {
  const sessionID = randomUUID()
  const token = "a".repeat(43)

  function handlerWith(
    control = createAstraOperationViewControl({ ledgerFilename: join(directory, "absent.sqlite") }),
  ) {
    return createAstraOperationViewControlHandler({ sessionID, token, control, timeoutMs: 5_000 })
  }

  function listRequest(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      method: "operation-view.list",
      requestId: randomUUID(),
      sessionID,
      token,
      ...overrides,
    }
  }

  test("rejects a wrong token, wrong session, malformed request, and extra fields", () => {
    const handler = handlerWith()
    expect(handler.dispatch(listRequest({ token: "b".repeat(43) }))).toEqual({ status: "rejected" })
    expect(handler.dispatch(listRequest({ sessionID: randomUUID() }))).toEqual({ status: "rejected" })
    expect(handler.dispatch(listRequest({ extra: true }))).toEqual({ status: "rejected" })
    expect(handler.dispatch({ method: "operation-view.mutate" })).toEqual({ status: "rejected" })
    expect(handler.dispatch(null)).toEqual({ status: "rejected" })
  })

  test("never replays a request ID and stays read-only fail-closed", async () => {
    const handler = handlerWith()
    const request = listRequest()
    const first = handler.dispatch(request)
    expect(first.status).toBe("accepted")
    if (first.status !== "accepted") return
    expect(await first.terminal).toMatchObject({ status: "blocked", reason: "ledger_unavailable" })
    const replay = handler.dispatch(request)
    expect(replay.status).toBe("accepted")
    if (replay.status !== "accepted") return
    expect(await replay.terminal).toMatchObject({ status: "blocked", reason: "request_replayed" })
  })

  test("serves an authenticated detail request bound to its operation", async () => {
    const filename = await seedLedger("handler-detail", "verified")
    const handler = handlerWith(createAstraOperationViewControl({ ledgerFilename: filename }))
    const dispatch = handler.dispatch({
      schemaVersion: 1,
      method: "operation-view.detail",
      requestId: randomUUID(),
      sessionID,
      token,
      operationID,
    })
    expect(dispatch.status).toBe("accepted")
    if (dispatch.status !== "accepted") return
    const terminal = await dispatch.terminal
    expect(terminal).toMatchObject({ status: "detailed" })
    if (terminal.status !== "detailed" || !("operation" in terminal)) return
    expect(terminal.operation.semanticKey).toBe("VERIFIED")
  })
})

function requireReceipt(input: unknown) {
  const result = parseOperationReceipt(input)
  if (!result.ok) throw new Error(`Invalid receipt fixture at ${result.issue.path}`)
  return result.value
}

function requireEvidence(input: unknown) {
  const result = parseOperationEvidence(input)
  if (!result.ok) throw new Error(`Invalid evidence fixture at ${result.issue.path}`)
  return result.value
}

function requireUncertainty(input: unknown) {
  const result = parseOperationEffectUncertainty(input)
  if (!result.ok) throw new Error(`Invalid uncertainty fixture at ${result.issue.path}`)
  return result.value
}
