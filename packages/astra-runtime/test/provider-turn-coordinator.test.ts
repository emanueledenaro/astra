import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOperationID } from "@astra/domain/operation-contract"
import { Effect } from "effect"
import { digest } from "../src/controlled-write-authority"
import {
  providerTurnLoopbackPolicyDigest,
  providerTurnPublicDnsPolicyDigest,
  providerTurnResolverImplementationDigest,
  providerTurnTransportImplementationDigest,
} from "../src/provider-turn-network-policy"
import {
  executeProviderTurn,
  recoverProviderTurn,
  untrustedProviderTurnAdapterDescriptor,
  type ExecuteProviderTurnInput,
  type ProviderTurnCoordinatorDependencies,
  type UntrustedProviderTurnAdapter,
  type UntrustedProviderTurnAdapterFinishEvent,
} from "../src/provider-turn-coordinator"
import {
  makeProviderTurnOperationFacts,
  providerTurnAdapterDigest,
  providerTurnExecutor,
  type UntrustedProviderTurnAdapterRequest,
} from "../src/provider-turn-operation-facts"
import {
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithLedger,
  runWithReceiptSpool,
} from "../src/operation-storage"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("provider turn Operation coordinator", () => {
  test("records admission before consent and persists rejection without invoking the provider", async () => {
    const fixture = await operationInput()
    let providerCalls = 0
    const result = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval(preview) {
        expect(preview).toMatchObject({
          effectClass: "provider_turn",
          workspace: {
            canonicalPath: fixture.input.report.root,
            identity: fixture.input.report.identity,
          },
          session: {
            sessionID: fixture.input.plan.sessionID,
            messageID: fixture.input.plan.messageID,
          },
          provider: {
            providerID: fixture.input.plan.providerID,
            modelID: fixture.input.plan.modelID,
            variant: fixture.input.plan.variant,
            origin: fixture.input.plan.origin,
          },
          logicalPayload: fixture.input.plan.logicalPayload,
          executionBoundary: "network_egress_host_no_sandbox",
          boundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
        })
        expect(await operationState(fixture.input)).toBe("awaiting_approval")
        expect(await eventNames(fixture.input)).toEqual(["operation.admitted", "policy.ask"])
        return "reject"
      },
      untrustedAdapter: untrustedAdapter({
        async execute() {
          providerCalls += 1
          throw new Error("rejected provider adapter must not run")
        },
      }),
    })

    expect(result).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
      sequence: 3,
      receiptID: null,
    })
    expect(providerCalls).toBe(0)
    expect(await eventNames(fixture.input)).toEqual(["operation.admitted", "policy.ask", "approval.rejected"])
    expect(await fileExists(fixture.input.spoolFilename)).toBeFalse()
  })

  test("claims durably before one bounded adapter call and keeps the unenforced seam uncertain", async () => {
    const fixture = await operationInput()
    const facts = makeProviderTurnOperationFacts(fixture.input)
    let approvals = 0
    let providerCalls = 0
    const responseSecret = "raw provider response must never be persisted"
    const response = new TextEncoder().encode(responseSecret)
    const responseDigest = rawDigest(response)
    const result = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval() {
        approvals += 1
        return "approve"
      },
      untrustedAdapter: untrustedAdapter({
        async execute(request) {
          providerCalls += 1
          expect(request).toEqual(facts.adapterRequest)
          expect(Object.isFrozen(request)).toBeTrue()
          expect(Object.isFrozen(request.workspace.identity)).toBeTrue()
          const durable = await dispatchSnapshot(fixture.input, facts.dispatchRequestID)
          expect(await operationState(fixture.input)).toBe("dispatched")
          expect(durable?.claim).not.toBeNull()
          expect(durable?.receipt).toBeNull()
          return finishEvent(request, response)
        },
      }),
    })

    expect(result).toMatchObject({
      state: "reconciliation_required",
      status: "effect_unknown",
      sequence: 6,
      boundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
    })
    expect(approvals).toBe(1)
    expect(providerCalls).toBe(1)
    expect(await eventNames(fixture.input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])
    const receipt = (await dispatchSnapshot(fixture.input, facts.dispatchRequestID))?.receipt
    expect(receipt).toMatchObject({
      effectClass: "provider_turn",
      observation: { kind: "effect_unknown" },
      verificationContext: {
        activationGuard: "blocked",
        workspaceIdentity: fixture.input.report.identity,
      },
      output: { digest: responseDigest, bytes: response.byteLength },
    })
    expect(JSON.stringify(receipt)).not.toContain(responseSecret)
    expect(JSON.stringify(await events(fixture.input))).not.toContain(responseSecret)
    expect(JSON.stringify(await events(fixture.input))).not.toContain("succeeded")

    const replayed = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval() {
        approvals += 1
        throw new Error("consent must not be requested twice")
      },
      untrustedAdapter: untrustedAdapter({
        async execute() {
          providerCalls += 1
          throw new Error("provider must not be called twice")
        },
      }),
    })
    expect(replayed).toEqual(result)
    expect(approvals).toBe(1)
    expect(providerCalls).toBe(1)
  })

  test("turns adapter errors and malformed events into durable uncertainty without secret leakage or retry", async () => {
    const fixture = await operationInput()
    const secret = "sk-live-provider-key-and-private-prompt"
    let providerCalls = 0
    const result = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval() {
        return "approve"
      },
      untrustedAdapter: untrustedAdapter({
        async execute() {
          providerCalls += 1
          throw new Error(secret)
        },
      }),
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown", sequence: 6 })
    expect(providerCalls).toBe(1)
    expect(await eventNames(fixture.input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])
    const serialized = JSON.stringify(await events(fixture.input))
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("sk-live")
    expect(serialized).not.toContain("private-prompt")

    const replayed = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval() {
        throw new Error(secret)
      },
      untrustedAdapter: untrustedAdapter({
        async execute() {
          providerCalls += 1
          throw new Error(secret)
        },
      }),
    })
    expect(replayed).toEqual(result)
    expect(providerCalls).toBe(1)

    const incompleteFixture = await operationInput()
    const incomplete = await executeProviderTurn(incompleteFixture.input, {
      now: () => incompleteFixture.clock,
      async requestApproval() {
        return "approve"
      },
      untrustedAdapter: malformedAdapter(null),
    })
    expect(incomplete).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(await eventNames(incompleteFixture.input)).toContain("effect.unknown")
  })

  test("allows at most one provider callback when identical calls race", async () => {
    const fixture = await operationInput()
    let approvals = 0
    let providerCalls = 0
    let releaseApproval: (() => void) | undefined
    let markApprovalStarted: (() => void) | undefined
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve
    })
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    const dependencies = {
      now: () => fixture.clock,
      async requestApproval() {
        approvals += 1
        markApprovalStarted?.()
        await approvalGate
        return "approve" as const
      },
      untrustedAdapter: untrustedAdapter({
        async execute(request) {
          providerCalls += 1
          return finishEvent(request, new TextEncoder().encode("one response"))
        },
      }),
    } satisfies ProviderTurnCoordinatorDependencies

    const first = executeProviderTurn(fixture.input, dependencies)
    await approvalStarted
    const second = executeProviderTurn(fixture.input, dependencies).catch((cause) => cause)
    releaseApproval?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(secondResult).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(approvals).toBe(1)
    expect(providerCalls).toBe(1)
  })

  test("recovers an expired claimed turn as uncertain and never exposes a recovery callback", async () => {
    const fixture = await operationInput()
    const facts = makeProviderTurnOperationFacts(fixture.input)
    await prepareOperationStateFiles(
      fixture.input.report.root,
      fixture.input.ledgerFilename,
      fixture.input.spoolFilename,
    )
    const claimedAt = fixture.clock
    const decidedAt = new Date(claimedAt).toISOString()
    const claim = await runWithCoordinatorLedger(
      fixture.input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          yield* ledger.appendBatch(facts.admissionCommands)
          yield* ledger.appendBatch(facts.approvalCommands(decidedAt))
          return yield* ledger.claimDispatch({
            dispatchRequestID: facts.dispatchRequestID,
            operationID: facts.operationID,
            attemptID: facts.attemptID,
            executor: providerTurnExecutor,
            capabilityDigest: facts.capabilityDigest,
            executorClaimID: facts.executorClaimID,
            claimExpiresAt: new Date(claimedAt + 60_000).toISOString(),
            event: {
              eventID: facts.eventIDs.claim,
              schemaVersion: 1,
              actor: { kind: "system", subject: providerTurnExecutor, componentDigest: providerTurnAdapterDigest },
              correlationID: facts.correlationID,
              redaction: "internal",
              externalBlobDigest: null,
            },
          })
        }),
      () => decidedAt,
    )
    expect(claim.kind).toBe("claimed")

    const recovered = await recoverProviderTurn(fixture.input, { now: () => claimedAt + 60_001 })
    expect(recovered).toMatchObject({ state: "reconciliation_required", status: "effect_unknown", sequence: 6 })
    expect(await eventNames(fixture.input)).toEqual([
      "operation.admitted",
      "policy.ask",
      "approval.granted",
      "dispatch.requested",
      "executor.accepted",
      "effect.unknown",
    ])
    expect((await dispatchSnapshot(fixture.input, facts.dispatchRequestID))?.recoveryStatus).toBe("claim_uncertain")
  })

  test("binds every displayed provider-turn dimension into the capability and admits one attempt only", async () => {
    const fixture = await operationInput()
    const baseline = makeProviderTurnOperationFacts(fixture.input)
    const admitted = baseline.admissionCommands[0].event.payload
    expect(admitted).toMatchObject({
      retryBudget: { maxAttempts: 1, eligibleFailureClasses: [] },
      effectSpecification: { effectClass: "provider_turn", partialEffect: "reconciliation_required" },
    })

    const variants: Array<ExecuteProviderTurnInput> = [
      { ...fixture.input, plan: { ...fixture.input.plan, sessionID: "session-other" } },
      { ...fixture.input, plan: { ...fixture.input.plan, messageID: "message-other" } },
      { ...fixture.input, plan: { ...fixture.input.plan, providerID: "provider-other" } },
      { ...fixture.input, plan: { ...fixture.input.plan, modelID: "model-other" } },
      { ...fixture.input, plan: { ...fixture.input.plan, variant: "variant-other" } },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          origin: "https://other.example.test",
          networkPolicy: httpsNetworkPolicy("https://other.example.test"),
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          credential: { ...fixture.input.plan.credential, handle: "auth:openai:other" },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          credential: { ...fixture.input.plan.credential, accountFingerprint: digest("other account") },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          credential: { ...fixture.input.plan.credential, headerName: "x-api-key" },
          wireRequest: { ...fixture.input.plan.wireRequest, headerNames: ["content-type", "x-api-key"] },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          wireRequest: { ...fixture.input.plan.wireRequest, path: "/v1/responses" },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          wireRequest: {
            ...fixture.input.plan.wireRequest,
            headerNames: ["authorization", "content-type", "x-provider-feature"],
          },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          wireRequest: { ...fixture.input.plan.wireRequest, timeoutMilliseconds: 9_000 },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          wireRequest: { ...fixture.input.plan.wireRequest, maximumResponseBytes: 512_000 },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          logicalPayload: { digest: digest("other logical payload"), bytes: fixture.input.plan.logicalPayload.bytes },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          logicalPayload: { ...fixture.input.plan.logicalPayload, bytes: fixture.input.plan.logicalPayload.bytes + 1 },
        },
      },
      {
        ...fixture.input,
        report: {
          ...fixture.input.report,
          identity: { ...fixture.input.report.identity!, inode: `${fixture.input.report.identity!.inode}0` },
        },
      },
    ]
    for (const variant of variants) {
      expect(makeProviderTurnOperationFacts(variant).capabilityDigest).not.toBe(baseline.capabilityDigest)
    }
  })

  test("rejects divergent reuse of a durable Operation ID for every authority dimension", async () => {
    const fixture = await operationInput()
    const otherWorkspace = await operationInput()
    expect(
      await executeProviderTurn(fixture.input, {
        now: () => fixture.clock,
        async requestApproval() {
          return "reject"
        },
        untrustedAdapter: malformedAdapter(null),
      }),
    ).toMatchObject({ state: "denied" })

    const invalidBoundary = structuredClone(fixture.input)
    Object.defineProperty(invalidBoundary.plan, "executionBoundary", { value: "sandboxed" })
    const variants: Array<ExecuteProviderTurnInput> = [
      {
        ...fixture.input,
        report: otherWorkspace.input.report,
        plan: { ...fixture.input.plan, workspaceRoot: otherWorkspace.input.report.root },
      },
      { ...fixture.input, plan: { ...fixture.input.plan, sessionID: "session-divergent" } },
      { ...fixture.input, plan: { ...fixture.input.plan, messageID: "message-divergent" } },
      { ...fixture.input, plan: { ...fixture.input.plan, providerID: "provider-divergent" } },
      { ...fixture.input, plan: { ...fixture.input.plan, modelID: "model-divergent" } },
      { ...fixture.input, plan: { ...fixture.input.plan, variant: "variant-divergent" } },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          origin: "https://redirect.example.test",
          networkPolicy: httpsNetworkPolicy("https://redirect.example.test"),
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          credential: { ...fixture.input.plan.credential, handle: "auth:openai:divergent" },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          credential: { ...fixture.input.plan.credential, accountFingerprint: digest("divergent account") },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          credential: { ...fixture.input.plan.credential, headerName: "x-api-key" },
          wireRequest: { ...fixture.input.plan.wireRequest, headerNames: ["content-type", "x-api-key"] },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          wireRequest: { ...fixture.input.plan.wireRequest, path: "/v1/divergent" },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          wireRequest: {
            ...fixture.input.plan.wireRequest,
            headerNames: ["authorization", "content-type", "x-provider-feature"],
          },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          logicalPayload: { ...fixture.input.plan.logicalPayload, digest: digest("divergent payload") },
        },
      },
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          logicalPayload: { ...fixture.input.plan.logicalPayload, bytes: fixture.input.plan.logicalPayload.bytes + 1 },
        },
      },
      invalidBoundary,
      {
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          createdAt: new Date(Date.parse(fixture.input.plan.createdAt) + 1).toISOString(),
        },
      },
      {
        ...fixture.input,
        policyAskedAt: new Date(Date.parse(fixture.input.policyAskedAt) + 1).toISOString(),
      },
      {
        ...fixture.input,
        recordingStartedAt: new Date(Date.parse(fixture.input.recordingStartedAt) + 1).toISOString(),
      },
    ]
    let consentCalls = 0
    for (const variant of variants) {
      const error = await executeProviderTurn(variant, {
        now: () => fixture.clock,
        async requestApproval() {
          consentCalls += 1
          return "approve"
        },
        untrustedAdapter: malformedAdapter(null),
      }).catch((cause) => cause)
      expect(error).toMatchObject({ code: "invalid_input" })
    }
    expect(consentCalls).toBe(0)
  })

  test("snapshots and deep-freezes caller-owned report, preview, and adapter request", async () => {
    const fixture = await operationInput()
    const expected = makeProviderTurnOperationFacts(fixture.input)
    const originalInode = fixture.input.report.identity!.inode
    const originalDigest = fixture.input.plan.logicalPayload.digest
    let previewMutationBlocked = false
    let requestMutationBlocked = false
    const result = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval(preview) {
        previewMutationBlocked = !Reflect.set(preview.workspace.identity, "inode", "mutated-preview")
        Reflect.set(fixture.input.report.identity!, "inode", "mutated-caller-report")
        Reflect.set(fixture.input.plan.logicalPayload, "digest", digest("mutated caller payload"))
        return "approve"
      },
      untrustedAdapter: untrustedAdapter({
        async execute(request) {
          expect(request).toEqual(expected.adapterRequest)
          requestMutationBlocked = !Reflect.set(request.provider, "origin", "https://mutated.example.test")
          return finishEvent(request, new TextEncoder().encode("bounded response"))
        },
      }),
    })
    Reflect.set(fixture.input.report.identity!, "inode", originalInode)
    Reflect.set(fixture.input.plan.logicalPayload, "digest", originalDigest)

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(previewMutationBlocked).toBeTrue()
    expect(requestMutationBlocked).toBeTrue()
  })

  test("rejects malformed, redirected, origin-mismatched, and forged adapter terminal events", async () => {
    let oversizedResponseCopied = false
    const oversizedResponse = new Uint8Array(1_048_577)
    Object.defineProperty(oversizedResponse, Symbol.iterator, {
      value() {
        oversizedResponseCopied = true
        return Uint8Array.prototype[Symbol.iterator].call(this)
      },
    })
    const cases: Array<(request: UntrustedProviderTurnAdapterRequest) => unknown> = [
      () => undefined,
      () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("proxy trap secret")
            },
          },
        ),
      (request) => finishEvent(request, new TextEncoder().encode("redirected"), "https://redirect.example.test"),
      (request) => ({
        ...finishEvent(request, new TextEncoder().encode("binding mismatch")),
        requestBinding: {
          ...finishEvent(request, new Uint8Array()).requestBinding,
          operationID: crypto.randomUUID(),
        },
      }),
      (request) => ({
        ...finishEvent(request, new TextEncoder().encode("forged")),
        responseDigest: digest("forged digest"),
        responseBytes: 999,
      }),
      (request) => ({
        ...finishEvent(request, new TextEncoder().encode("invalid HTTP evidence")),
        httpEvidence: { statusCode: 101, contentType: "text/event-stream", headerBytes: 64 },
      }),
      (request) => finishEvent(request, oversizedResponse),
    ]
    for (const makeEvent of cases) {
      const fixture = await operationInput()
      const result = await executeProviderTurn(fixture.input, {
        now: () => fixture.clock,
        async requestApproval() {
          return "approve"
        },
        untrustedAdapter: malformedAdapterFactory(makeEvent),
      })
      expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
      const receipt = (
        await dispatchSnapshot(fixture.input, makeProviderTurnOperationFacts(fixture.input).dispatchRequestID)
      )?.receipt
      expect(receipt?.output.bytes).toBe(0)
      expect(receipt?.observation.kind).toBe("effect_unknown")
    }
    expect(oversizedResponseCopied).toBeFalse()
  })

  test("requires the exact untrusted seam descriptor and never treats it as completion authority", async () => {
    const fixture = await operationInput()
    let adapterCalls = 0
    const clonedDescriptor = structuredClone(untrustedProviderTurnAdapterDescriptor)
    const result = await executeProviderTurn(fixture.input, {
      now: () => fixture.clock,
      async requestApproval() {
        return "approve"
      },
      untrustedAdapter: {
        descriptor: clonedDescriptor,
        async execute(request) {
          adapterCalls += 1
          return finishEvent(request, new TextEncoder().encode("must not execute"))
        },
      },
    })

    expect(result).toMatchObject({ state: "reconciliation_required", status: "effect_unknown" })
    expect(adapterCalls).toBe(0)
    expect(await eventNames(fixture.input)).not.toContain("effect.completed")
  })

  test("requires HTTPS except for explicit test-only loopback origins", async () => {
    const fixture = await operationInput()
    expect(() =>
      makeProviderTurnOperationFacts({
        ...fixture.input,
        plan: { ...fixture.input.plan, origin: "http://provider.example.test" },
      }),
    ).toThrow()
    expect(() =>
      makeProviderTurnOperationFacts({
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          origin: "http://provider.example.test",
          transportPolicy: "test_only_loopback_http",
        },
      }),
    ).toThrow()
    for (const origin of ["http://localhost:8787", "http://127.0.0.2:8787"]) {
      expect(() =>
        makeProviderTurnOperationFacts({
          ...fixture.input,
          plan: { ...fixture.input.plan, origin, transportPolicy: "test_only_loopback_http" },
        }),
      ).toThrow()
    }
    for (const path of ["/unsafe path", "/line\nbreak", "/é", `/${"x".repeat(8_193)}`]) {
      expect(() =>
        makeProviderTurnOperationFacts({
          ...fixture.input,
          plan: {
            ...fixture.input.plan,
            wireRequest: { ...fixture.input.plan.wireRequest, path },
          },
        }),
      ).toThrow()
    }
    expect(
      makeProviderTurnOperationFacts({
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          origin: "http://127.0.0.1:8787",
          transportPolicy: "test_only_loopback_http",
          networkPolicy: loopbackNetworkPolicy("http://127.0.0.1:8787"),
        },
      }).preview.provider,
    ).toMatchObject({ origin: "http://127.0.0.1:8787", transportPolicy: "test_only_loopback_http" })
    expect(
      makeProviderTurnOperationFacts({
        ...fixture.input,
        plan: {
          ...fixture.input.plan,
          origin: "http://[::1]:8787",
          transportPolicy: "test_only_loopback_http",
          networkPolicy: loopbackNetworkPolicy("http://[::1]:8787"),
        },
      }).preview.provider,
    ).toMatchObject({ origin: "http://[::1]:8787", transportPolicy: "test_only_loopback_http" })
  })

  test("ignores an unrelated pending receipt while recovering the exact Operation", async () => {
    const source = await operationInput()
    const sourceFacts = makeProviderTurnOperationFacts(source.input)
    await executeProviderTurn(source.input, {
      now: () => source.clock,
      async requestApproval() {
        return "approve"
      },
      untrustedAdapter: untrustedAdapter({
        async execute(request) {
          return finishEvent(request, new TextEncoder().encode("unrelated response"))
        },
      }),
    })
    const unrelatedReceipt = (await dispatchSnapshot(source.input, sourceFacts.dispatchRequestID))?.receipt
    if (!unrelatedReceipt) throw new Error("Expected unrelated receipt fixture")

    const sharedState = await temporaryDirectory("astra-provider-turn-shared-spool-")
    const sharedSpool = join(sharedState, "receipts.sqlite")
    await runWithReceiptSpool(sharedSpool, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(unrelatedReceipt)
      }),
    )

    const target = await operationInput()
    const targetInput = { ...target.input, spoolFilename: sharedSpool }
    expect(
      await executeProviderTurn(targetInput, {
        now: () => target.clock,
        async requestApproval() {
          return "reject"
        },
        untrustedAdapter: malformedAdapter(null),
      }),
    ).toMatchObject({ state: "denied" })

    expect(await recoverProviderTurn(targetInput, { now: () => target.clock })).toMatchObject({
      state: "denied",
      status: "denied_without_effect",
    })
  })
})

async function operationInput() {
  const workspace = await temporaryDirectory("astra-provider-turn-workspace-")
  const state = await temporaryDirectory("astra-provider-turn-state-")
  await writeFile(join(workspace, "package.json"), "{}\n")
  const report = await scanWorkspace(workspace)
  const base = Date.now() - 2_000
  const clock = base + 500
  const input = {
    ledgerFilename: join(state, "operations.sqlite"),
    spoolFilename: join(state, "receipts.sqlite"),
    plan: {
      operationID: crypto.randomUUID(),
      workspaceRoot: report.root,
      sessionID: "session-1",
      messageID: "message-1",
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
      origin: "https://api.example.test",
      transportPolicy: "https_only",
      networkPolicy: httpsNetworkPolicy("https://api.example.test"),
      credential: {
        handle: "auth:openai:primary",
        accountFingerprint: digest("provider-account:fixture@example.test"),
        headerName: "authorization",
      },
      wireRequest: {
        method: "POST",
        path: "/v1/chat/completions",
        headerNames: ["authorization", "content-type"],
        timeoutMilliseconds: 10_000,
        maximumResponseBytes: 1_048_576,
      },
      logicalPayload: { digest: digest("logical payload without raw prompt storage"), bytes: 47 },
      executionBoundary: "network_egress_host_no_sandbox",
      createdAt: new Date(base).toISOString(),
    },
    report,
    policyAskedAt: new Date(base + 100).toISOString(),
    recordingStartedAt: new Date(base + 200).toISOString(),
  } satisfies ExecuteProviderTurnInput
  return { input, clock }
}

async function operationState(input: ExecuteProviderTurnInput) {
  const operationID = requireOperationID(input.plan.operationID)
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return (yield* ledger.getOperation(operationID))?.state ?? null
    }),
  )
}

async function events(input: ExecuteProviderTurnInput) {
  const operationID = requireOperationID(input.plan.operationID)
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.readEvents(operationID, { limit: 20 })
    }),
  )
}

async function eventNames(input: ExecuteProviderTurnInput) {
  return (await events(input)).map((event) => event.name)
}

async function dispatchSnapshot(input: ExecuteProviderTurnInput, dispatchRequestID: string) {
  const facts = makeProviderTurnOperationFacts(input)
  if (facts.dispatchRequestID !== dispatchRequestID) throw new Error("Dispatch fixture mismatch")
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
    }),
  )
}

function requireOperationID(input: string) {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new Error("Invalid test Operation ID")
  return parsed.value
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function httpsNetworkPolicy(origin: string) {
  const url = new URL(origin)
  return {
    mode: "https_public_pinned" as const,
    hostname: url.hostname,
    port: Number(url.port || 443),
    dnsPolicyDigest: providerTurnPublicDnsPolicyDigest,
    resolverImplementationDigest: providerTurnResolverImplementationDigest,
    transportImplementationDigest: providerTurnTransportImplementationDigest,
  }
}

function loopbackNetworkPolicy(origin: string) {
  const url = new URL(origin)
  return {
    mode: "test_literal_loopback" as const,
    hostname: url.hostname,
    port: Number(url.port || 80),
    dnsPolicyDigest: providerTurnLoopbackPolicyDigest,
    resolverImplementationDigest: providerTurnResolverImplementationDigest,
    transportImplementationDigest: providerTurnTransportImplementationDigest,
  }
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function finishEvent(
  request: UntrustedProviderTurnAdapterRequest,
  response: Uint8Array,
  finalOrigin = request.expectedOrigin,
): UntrustedProviderTurnAdapterFinishEvent {
  return {
    type: "provider.finish",
    requestBinding: {
      operationID: request.operationID,
      attemptID: request.capability.attemptID,
      capabilityGrantID: request.capability.capabilityGrantID,
      capabilityDigest: request.capability.capabilityDigest,
      expectedOrigin: request.expectedOrigin,
      logicalPayloadDigest: request.logicalPayload.digest,
      logicalPayloadBytes: request.logicalPayload.bytes,
    },
    finalOrigin,
    networkEvidence: networkEvidence(request),
    httpEvidence: { statusCode: 200, contentType: "application/json", headerBytes: 64 },
    finishReason: "stop",
    response,
  }
}

function networkEvidence(request: UntrustedProviderTurnAdapterRequest) {
  const loopback = request.provider.transportPolicy === "test_only_loopback_http"
  const address = loopback
    ? request.networkPolicy.hostname === "[::1]"
      ? { address: "::1", family: 6 as const }
      : { address: "127.0.0.1", family: 4 as const }
    : { address: "93.184.216.34", family: 4 as const }
  return {
    hostname: request.networkPolicy.hostname,
    port: request.networkPolicy.port,
    addresses: [address],
    selectedAddress: address,
    connectedPeer: address,
    resolvedAt: new Date().toISOString(),
    dnsPolicyDigest: request.networkPolicy.dnsPolicyDigest,
    resolverImplementationDigest: request.networkPolicy.resolverImplementationDigest,
    transportImplementationDigest: request.networkPolicy.transportImplementationDigest,
  }
}

function untrustedAdapter(adapter: Omit<UntrustedProviderTurnAdapter, "descriptor">): UntrustedProviderTurnAdapter {
  return { descriptor: untrustedProviderTurnAdapterDescriptor, ...adapter }
}

function malformedAdapter(value: unknown): UntrustedProviderTurnAdapter {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- adversarial test violates the adapter contract
  return untrustedAdapter({ execute: async () => value as UntrustedProviderTurnAdapterFinishEvent })
}

function malformedAdapterFactory(
  makeEvent: (request: UntrustedProviderTurnAdapterRequest) => unknown,
): UntrustedProviderTurnAdapter {
  return untrustedAdapter({
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- adversarial test violates the adapter contract
    execute: async (request) => makeEvent(request) as UntrustedProviderTurnAdapterFinishEvent,
  })
}

function rawDigest(input: Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
