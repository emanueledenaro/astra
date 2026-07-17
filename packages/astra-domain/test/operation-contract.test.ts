import { describe, expect, test } from "bun:test"
import {
  parseActorRef,
  parseAdmissionKey,
  parseDispatchRequest,
  parseDispatchRequestID,
  parseExecutorClaim,
  parseExecutorClaimID,
  parseOperationAuthority,
  parseOperationDispatch,
  parseOperationEventEnvelope,
  parseOperationEvidence,
  parseOperationID,
  parseOperationIdentity,
  parseOperationIntent,
  parseOperationReceipt,
  parseRetryBudget,
  parseWorkspaceBaseline,
} from "../src/operation-contract"

const operationID = "0196e4cb-5d80-7b1d-8fb2-263b81670431"
const attemptID = "0196e4cb-5d80-7b1d-8fb2-263b81670432"
const eventID = "0196e4cb-5d80-7b1d-8fb2-263b81670433"
const decisionID = "0196e4cb-5d80-7b1d-8fb2-263b81670434"
const capabilityGrantID = "0196e4cb-5d80-7b1d-8fb2-263b81670435"
const receiptID = "0196e4cb-5d80-7b1d-8fb2-263b81670436"
const evidenceID = "0196e4cb-5d80-7b1d-8fb2-263b81670437"
const verificationPlanID = "0196e4cb-5d80-7b1d-8fb2-263b81670438"
const correlationID = "0196e4cb-5d80-7b1d-8fb2-263b81670439"
const digest = `sha256:${"a".repeat(64)}`
const nextDigest = `sha256:${"b".repeat(64)}`
const capabilityDigest = `sha256:${"c".repeat(64)}`

describe("Operation contract decoding", () => {
  test("rejects malformed identities and keeps admission keys distinct", () => {
    expect(parseOperationID("not-an-operation-id")).toEqual({
      ok: false,
      issue: { path: "$", reason: "expected_canonical_uuid" },
    })
    expect(parseAdmissionKey(operationID).ok).toBeFalse()
    expect(
      parseOperationIdentity({
        operationID,
        admissionKey: digest,
      }),
    ).toMatchObject({ ok: true, value: { operationID, admissionKey: digest } })
    expect(parseOperationIdentity({ operationID, admissionKey: digest, reused: true })).toEqual({
      ok: false,
      issue: { path: "$.reused", reason: "unexpected_field" },
    })
  })

  test("accepts only named user, system, or agent actors", () => {
    expect(parseActorRef({ kind: "user", subject: "user:emanuele" })).toMatchObject({
      ok: true,
      value: { kind: "user", subject: "user:emanuele" },
    })
    expect(parseActorRef({ kind: "system", subject: "astra:policy", componentDigest: digest }).ok).toBeTrue()
    expect(parseActorRef({ kind: "agent", subject: "astra:lead", sessionID: "session-1" }).ok).toBeTrue()
    expect(parseActorRef({ kind: "model", subject: "untrusted" })).toEqual({
      ok: false,
      issue: { path: "$.kind", reason: "unsupported_actor_kind" },
    })
    expect(parseActorRef({ kind: "user", subject: " " }).ok).toBeFalse()
  })

  test("normalizes intent data and rejects embedded lifecycle authority", () => {
    expect(
      parseOperationIntent({
        kind: "controlled_write",
        schemaVersion: 1,
        parameters: { target: "marker.txt", expected: { contentDigest: digest, bytes: 5 } },
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "controlled_write",
        schemaVersion: 1,
        parameters: { expected: { bytes: 5, contentDigest: digest }, target: "marker.txt" },
      },
    })
    expect(
      parseOperationIntent({
        kind: "controlled_write",
        schemaVersion: 1,
        parameters: {},
        authority: { allow: true },
      }),
    ).toEqual({
      ok: false,
      issue: { path: "$.authority", reason: "unexpected_field" },
    })
    expect(parseOperationIntent({ kind: "controlled_write", schemaVersion: 0, parameters: {} }).ok).toBeFalse()
    expect(
      parseOperationIntent({ kind: "controlled_write", schemaVersion: 1, parameters: { value: undefined } }).ok,
    ).toBeFalse()
  })

  test("rejects array accessors without executing them", () => {
    let getterCalls = 0
    const values = [undefined]
    Object.defineProperty(values, "0", {
      enumerable: true,
      get() {
        getterCalls += 1
        return "must-not-run"
      },
    })

    expect(
      parseOperationIntent({
        kind: "controlled_write",
        schemaVersion: 1,
        parameters: { values },
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.parameters.values[0]", reason: "accessor_field_not_allowed" } })
    expect(getterCalls).toBe(0)
  })

  test("requires an exact workspace and repository baseline", () => {
    const baseline = {
      kind: "workspace",
      locationID: "local:fixture",
      workspaceIdentity: { device: "16777233", inode: "42" },
      trustDigest: digest,
      repository: {
        kind: "git",
        repositoryIdentity: "repo:fixture",
        head: "453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d",
        indexTreeDigest: digest,
        trackedWorktreeDigest: digest,
        untrackedDigest: digest,
      },
      policyDigest: digest,
      adapterDigest: digest,
    }

    expect(parseWorkspaceBaseline(baseline)).toMatchObject({ ok: true, value: baseline })
    expect(
      parseWorkspaceBaseline({
        ...baseline,
        repository: { ...baseline.repository, untrackedDigest: undefined },
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.repository.untrackedDigest" } })
    expect(parseWorkspaceBaseline({ ...baseline, trustDigest: "sha256:short" }).ok).toBeFalse()
    expect(
      parseWorkspaceBaseline({
        ...baseline,
        repository: { kind: "non_git", markerDigest: digest },
      }),
    ).toMatchObject({ ok: true, value: { repository: { kind: "non_git", markerDigest: digest } } })

    const snapshotBaseline = {
      ...baseline,
      repository: {
        kind: "git",
        schemaVersion: 1,
        snapshotDigest: digest,
        observationDigest: nextDigest,
        root: { canonicalPath: "/workspace", device: "16777233", inode: "42" },
        head: {
          kind: "symbolic",
          symbolicRef: "refs/heads/durable-coordinator",
          oid: "453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d",
        },
        verification: "not_verified",
      },
    }

    expect(parseWorkspaceBaseline(snapshotBaseline)).toMatchObject({ ok: true, value: snapshotBaseline })
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: { ...snapshotBaseline.repository, observationDigest: undefined },
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.repository.observationDigest" } })
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: { ...snapshotBaseline.repository, trackedWorktreeDigest: digest },
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.repository.trackedWorktreeDigest", reason: "unexpected_field" } })
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: { ...snapshotBaseline.repository, head: { kind: "unborn", symbolicRef: "refs/heads/main" } },
      }).ok,
    ).toBeTrue()
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: {
          ...snapshotBaseline.repository,
          head: { kind: "detached", oid: "453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d" },
        },
      }).ok,
    ).toBeTrue()
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: { ...snapshotBaseline.repository, verification: "verified" },
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.repository.verification" } })
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: {
          ...snapshotBaseline.repository,
          root: { ...snapshotBaseline.repository.root, canonicalPath: "relative/workspace" },
        },
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.repository.root.canonicalPath" } })
    expect(
      parseWorkspaceBaseline({
        ...snapshotBaseline,
        repository: {
          ...snapshotBaseline.repository,
          root: { ...snapshotBaseline.repository.root, inode: "43" },
        },
      }),
    ).toMatchObject({
      ok: false,
      issue: { path: "$.repository.root", reason: "workspace_identity_mismatch" },
    })
  })

  test("bounds retries and makes retry safety explicit", () => {
    expect(
      parseRetryBudget({
        maxAttempts: 2,
        eligibleFailureClasses: ["transient_transport"],
        retrySafety: { kind: "proof_of_no_effect_required" },
        prohibitedWhen: ["effect_unknown", "baseline_changed"],
      }).ok,
    ).toBeTrue()
    expect(
      parseRetryBudget({
        maxAttempts: 2,
        eligibleFailureClasses: ["rate_limited"],
        retrySafety: { kind: "semantic_idempotency", contractDigest: digest },
        prohibitedWhen: [],
      }).ok,
    ).toBeTrue()
    expect(
      parseRetryBudget({
        maxAttempts: 0,
        eligibleFailureClasses: [],
        retrySafety: { kind: "proof_of_no_effect_required" },
        prohibitedWhen: [],
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.maxAttempts" } })
    expect(
      parseRetryBudget({
        maxAttempts: 2,
        eligibleFailureClasses: ["transient_transport", "transient_transport"],
        retrySafety: { kind: "proof_of_no_effect_required" },
        prohibitedWhen: [],
      }),
    ).toMatchObject({ ok: false, issue: { reason: "duplicate_value" } })
  })

  test("keeps authority and dispatch as separately decoded facts", () => {
    expect(
      parseOperationAuthority({
        decisionID,
        capabilityGrantID,
        capabilityDigest,
        attemptID,
        baselineDigest: digest,
        expiresAt: "2026-07-17T12:00:00.000Z",
      }).ok,
    ).toBeTrue()
    expect(
      parseOperationDispatch({
        attemptID,
        executor: "astra-executor:local",
        adapterDigest: digest,
        idempotencyKey: nextDigest,
        capabilityGrantID,
        capabilityDigest,
      }).ok,
    ).toBeTrue()
    expect(
      parseOperationDispatch({
        attemptID,
        executor: "astra-executor:local",
        adapterDigest: digest,
        idempotencyKey: nextDigest,
        capabilityDigest,
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.capabilityGrantID" } })
  })

  test("decodes exact dispatch requests and executor claims", () => {
    const dispatchRequestID = "0196e4cb-5d80-7b1d-8fb2-263b81670440"
    const executorClaimID = "0196e4cb-5d80-7b1d-8fb2-263b81670441"
    const dispatchRequest = {
      dispatchRequestID,
      operationID,
      attemptID,
      capabilityGrantID,
      capabilityDigest,
      baselineDigest: digest,
      executor: "astra-executor:local",
      adapterDigest: digest,
      idempotencyKey: nextDigest,
      requestedAt: "2026-07-17T10:00:01.000Z",
      authorizationExpiresAt: "2026-07-17T10:05:00.000Z",
    }
    const claim = {
      executorClaimID,
      dispatchRequestID,
      operationID,
      attemptID,
      capabilityDigest,
      executor: "astra-executor:local",
      fencingToken: 1,
      acceptedAt: "2026-07-17T10:00:02.000Z",
      claimExpiresAt: "2026-07-17T10:01:02.000Z",
    }

    expect(parseDispatchRequestID(dispatchRequestID)).toMatchObject({ ok: true, value: dispatchRequestID })
    expect(parseExecutorClaimID(executorClaimID)).toMatchObject({ ok: true, value: executorClaimID })
    expect(parseDispatchRequest(dispatchRequest)).toMatchObject({ ok: true, value: dispatchRequest })
    expect(parseExecutorClaim(claim)).toMatchObject({ ok: true, value: claim })
    expect(parseDispatchRequest({ ...dispatchRequest, capabilityDigest: undefined })).toMatchObject({
      ok: false,
      issue: { path: "$.capabilityDigest" },
    })
    expect(parseExecutorClaim({ ...claim, capabilityDigest: undefined })).toMatchObject({
      ok: false,
      issue: { path: "$.capabilityDigest" },
    })
    expect(
      parseDispatchRequest({ ...dispatchRequest, requestedAt: dispatchRequest.authorizationExpiresAt }),
    ).toMatchObject({
      ok: false,
      issue: { path: "$.authorizationExpiresAt", reason: "not_after_requested_at" },
    })
    expect(parseExecutorClaim({ ...claim, fencingToken: 0 })).toMatchObject({
      ok: false,
      issue: { path: "$.fencingToken" },
    })
    expect(parseExecutorClaim({ ...claim, acceptedAt: claim.claimExpiresAt })).toMatchObject({
      ok: false,
      issue: { path: "$.claimExpiresAt", reason: "not_after_accepted_at" },
    })
    expect(parseExecutorClaim({ ...claim, reclaimed: true })).toEqual({
      ok: false,
      issue: { path: "$.reclaimed", reason: "unexpected_field" },
    })
  })

  test("decodes receipts as observations without turning them into verification", () => {
    const receipt = {
      receiptID,
      operationID,
      attemptID,
      dispatchRequestID: "0196e4cb-5d80-7b1d-8fb2-263b81670440",
      executorClaimID: "0196e4cb-5d80-7b1d-8fb2-263b81670441",
      capabilityGrantID,
      capabilityDigest,
      fencingToken: 1,
      adapter: { identity: "controlled-write", version: "1", digest },
      effectClass: "workspace_write",
      resources: ["workspace:marker.txt"],
      startedAt: "2026-07-17T10:00:00.000Z",
      endedAt: "2026-07-17T10:00:00.010Z",
      observation: { kind: "effect_observed", beforeDigest: null, afterDigest: nextDigest },
      verificationContext: {
        admittedBaselineDigest: digest,
        postEffectWorkspaceDigest: nextDigest,
        workspaceIdentity: { device: "1", inode: "2" },
        targetIdentity: { device: "1", inode: "3" },
        preflightLimits: { maxEntries: 128, maxFileBytes: 65536, maxTotalBytes: 262144, maxDurationMs: 1000 },
        activationGuard: "allowed",
      },
      output: { digest, bytes: 0, preview: "" },
    }

    expect(parseOperationReceipt(receipt)).toMatchObject({ ok: true, value: receipt })
    expect(parseOperationReceipt({ ...receipt, endedAt: "2026-07-17T09:59:59.000Z" })).toMatchObject({
      ok: false,
      issue: { path: "$.endedAt", reason: "precedes_started_at" },
    })
    expect(parseOperationReceipt({ ...receipt, verified: true })).toEqual({
      ok: false,
      issue: { path: "$.verified", reason: "unexpected_field" },
    })

    const gitReceipt = {
      ...receipt,
      verificationContext: {
        schemaVersion: 2,
        admittedBaselineDigest: digest,
        admittedRepositorySnapshotDigest: digest,
        postEffectWorkspaceDigest: nextDigest,
        postEffectRepositorySnapshotDigest: nextDigest,
        workspaceIdentity: { device: "1", inode: "2" },
        targetIdentity: { device: "1", inode: "3" },
        preflightLimits: { maxEntries: 128, maxFileBytes: 65536, maxTotalBytes: 262144, maxDurationMs: 1000 },
        activationGuard: "allowed",
      },
    }
    expect(parseOperationReceipt(gitReceipt)).toMatchObject({ ok: true, value: gitReceipt })
    expect(
      parseOperationReceipt({
        ...gitReceipt,
        verificationContext: { ...gitReceipt.verificationContext, schemaVersion: 1 },
      }),
    ).toMatchObject({
      ok: false,
      issue: { path: "$.verificationContext.schemaVersion", reason: "unsupported_schema_version" },
    })
  })

  test("requires snapshot-bound criterion evidence and never accepts verified as a criterion", () => {
    const evidence = {
      evidenceID,
      operationID,
      receiptID,
      verificationPlanID,
      verifier: { identity: "workspace-marker", version: "1", digest },
      snapshotDigest: nextDigest,
      observedAt: "2026-07-17T10:00:01.000Z",
      criteria: [{ criterionID: "marker_exists", result: "passed", observationDigest: nextDigest }],
      limitations: [],
    }

    expect(parseOperationEvidence(evidence)).toMatchObject({ ok: true, value: evidence })
    expect(parseOperationEvidence({ ...evidence, criteria: [] })).toMatchObject({
      ok: false,
      issue: { path: "$.criteria", reason: "expected_non_empty_array" },
    })
    expect(
      parseOperationEvidence({
        ...evidence,
        criteria: [{ criterionID: "marker_exists", result: "verified", observationDigest: nextDigest }],
      }),
    ).toMatchObject({ ok: false, issue: { path: "$.criteria[0].result" } })
  })

  test("fails closed on malformed durable event envelopes", () => {
    const envelope = {
      eventID,
      operationID,
      sequence: 1,
      name: "operation.admitted",
      schemaVersion: 1,
      recordedAt: "2026-07-17T10:00:00.000Z",
      observedAt: "2026-07-17T09:59:59.000Z",
      actor: { kind: "user", subject: "user:emanuele" },
      causationID: null,
      correlationID,
      attemptID: null,
      payload: { intentDigest: digest },
      previousDigest: null,
      digest,
      redaction: "internal",
      externalBlobDigest: null,
    }

    expect(parseOperationEventEnvelope(envelope)).toMatchObject({ ok: true, value: envelope })
    expect(parseOperationEventEnvelope({ ...envelope, sequence: 0 })).toMatchObject({
      ok: false,
      issue: { path: "$.sequence" },
    })
    expect(parseOperationEventEnvelope({ ...envelope, name: "operation.finished" })).toMatchObject({
      ok: false,
      issue: { path: "$.name", reason: "unknown_operation_event" },
    })
    expect(parseOperationEventEnvelope({ ...envelope, schemaVersion: 0 })).toMatchObject({
      ok: false,
      issue: { path: "$.schemaVersion" },
    })
    expect(parseOperationEventEnvelope({ ...envelope, payload: { secret: Symbol("secret") } }).ok).toBeFalse()
  })

  test("keeps all new contracts free of runtime and effect dependencies", async () => {
    const sources = await Promise.all(
      ["operation-contract.ts", "operation-contract-validation.ts"].map((name) =>
        Bun.file(new URL(`../src/${name}`, import.meta.url)).text(),
      ),
    )
    const forbiddenDependencies = [
      "node:fs",
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:dns",
      "node:process",
      "@opencode-ai/",
      "@astra/ledger",
    ]

    for (const source of sources) {
      for (const dependency of forbiddenDependencies) {
        expect(source).not.toContain(dependency)
      }
    }
  })
})
