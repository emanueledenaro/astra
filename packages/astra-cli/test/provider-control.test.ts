import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerObservedCompletionLabel } from "@astra/domain/provider-control"
import { parseContentDigest } from "@astra/domain/operation-contract"
import type { DurableProviderTurnResult } from "@astra/runtime/provider-turn-coordinator"
import { makeProviderTurnOperationFacts } from "@astra/runtime/provider-turn-operation-facts"
import type { TrustedObservedProviderCompletion } from "@astra/runtime/provider-turn-transport"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraProviderControl } from "../src/provider-control"
import {
  createParentProviderCredentialBroker,
  type ParentProviderCredentialBroker,
} from "../src/provider-credential-broker"
import type { TrustedPromptSkillBundle } from "../src/skill-activation-control"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("parent provider control", () => {
  test("preserves read-only denial without reading credentials or invoking transport", async () => {
    const fixture = await makeFixture("read-only")
    let issues = 0
    let executions = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker({ onIssue: () => issues++ }),
      async execute() {
        executions += 1
        throw new Error("read-only transport must not execute")
      },
    })

    expect(await control.prepare(modelID, "private prompt")).toEqual({ status: "blocked", reason: "read_only" })
    expect(issues).toBe(0)
    expect(executions).toBe(0)
  })

  test("fails closed when the API credential is unavailable", async () => {
    const fixture = await makeFixture("activate-once")
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: unavailableBroker(),
      execute: async () => {
        throw new Error("transport must not execute")
      },
    })

    expect(await control.prepare(modelID, "private prompt")).toEqual({
      status: "blocked",
      reason: "credential_unavailable",
    })
  })

  test("keeps prompt and key out of preview and takes the key only after approval authority", async () => {
    const fixture = await makeFixture("activate-once")
    const privatePrompt = "private prompt must never enter the preview"
    const secret = "sk-ant-parent-only"
    let tookCredential = 0
    let approvalObserved = false
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker({ secret, onTake: () => tookCredential++ }),
      randomUUID: uuidSequence(),
      execute: async (input, resolveWire, parse, dependencies) => {
        expect(tookCredential).toBe(0)
        expect(await dependencies.requestApproval(makeProviderTurnOperationFacts(input).preview)).toBe("approve")
        approvalObserved = true
        const wire = await resolveWire()
        expect(approvalObserved).toBeTrue()
        expect(new TextDecoder().decode(wire.body)).toContain(privatePrompt)
        expect(wire.credential.value).toBe(secret)
        dependencies.onNetworkDispatch?.()
        const completion = parse({
          statusCode: 200,
          headers: [["content-type", "text/event-stream"]],
          body: validSse("Hello Astra"),
        })
        return completed(input.plan.operationID, completion)
      },
    })

    const prepared = await control.prepare(modelID, privatePrompt)
    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error("Expected prepared provider turn")
    expect(JSON.stringify(prepared.preview)).not.toContain(privatePrompt)
    expect(JSON.stringify(prepared.preview)).not.toContain(secret)
    expect(prepared.preview).toMatchObject({
      providerID: "anthropic",
      modelID,
      destination: { origin: "https://api.anthropic.com", path: "/v1/messages" },
      credential: { headerName: "x-api-key" },
      hostBoundaryLabel: "HOST EXECUTION — NO SANDBOX",
      networkBoundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
      assurance: "NOT VERIFIED",
    })

    const progress: string[] = []
    const result = await control.decide(prepared.preview.proposalID, "approve", (event) => progress.push(event.status))
    expect(result).toMatchObject({
      status: "response_observed_not_verified",
      completionLabel: providerObservedCompletionLabel,
      response: { assistantText: "Hello Astra", finishReason: "stop" },
    })
    expect(tookCredential).toBe(1)
    expect(progress).toEqual([
      "recording_authority",
      "authority_claimed",
      "network_dispatch",
      "response_observed_not_verified",
      "receipt_acknowledged",
    ])
  })

  test("records rejection through the coordinator seam without taking credentials or dispatching", async () => {
    const fixture = await makeFixture("activate-once")
    let takes = 0
    let dispatches = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker({ onTake: () => takes++ }),
      randomUUID: uuidSequence(),
      execute: async (input, _resolveWire, _parse, dependencies) => {
        expect(await dependencies.requestApproval(makeProviderTurnOperationFacts(input).preview)).toBe("reject")
        dispatches += 0
        return {
          operationID: input.plan.operationID,
          state: "denied",
          status: "denied_without_effect",
          sequence: 3,
          lastCursor: 3,
          receiptID: null,
          response: null,
          boundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
        }
      },
    })
    const prepared = await control.prepare(modelID, "reject this")
    if (prepared.status !== "prepared") throw new Error("Expected prepared provider turn")
    const result = await control.decide(prepared.preview.proposalID, "reject", () => {})

    expect(result).toMatchObject({ status: "denied_without_effect", receiptID: null })
    expect(takes).toBe(0)
    expect(dispatches).toBe(0)
  })

  test("revokes every rejected credential so four denials do not block a fifth proposal", async () => {
    const fixture = await makeFixture("activate-once")
    const issued: Array<Readonly<{ credentialHandle: string; sessionID: string }>> = []
    const parentBroker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: "sk-ant-rejected-and-revoked" }) },
    })
    const credentialBroker: ParentProviderCredentialBroker = {
      async issueForSession(sessionID) {
        const result = await parentBroker.issueForSession(sessionID)
        if (result.ok) issued.push(result.grant)
        return result
      },
      revoke: parentBroker.revoke,
      takeForParentTransport: parentBroker.takeForParentTransport,
    }
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker,
      randomUUID: uuidSequence(),
      execute: async (input, _resolveWire, _parse, dependencies) => {
        expect(await dependencies.requestApproval(makeProviderTurnOperationFacts(input).preview)).toBe("reject")
        return denied(input.plan.operationID)
      },
    })

    for (let attempt = 0; attempt < 5; attempt++) {
      const prepared = await control.prepare(modelID, `reject ${attempt}`)
      if (prepared.status !== "prepared") throw new Error(`Attempt ${attempt}: ${prepared.reason}`)
      expect(prepared.status).toBe("prepared")
      expect(await control.decide(prepared.preview.proposalID, "reject", () => {})).toMatchObject({
        status: "denied_without_effect",
      })
      const grant = issued.at(-1)
      expect(grant).toBeDefined()
      if (!grant) throw new Error("Expected an issued credential grant")
      expect(parentBroker.takeForParentTransport(grant)).toMatchObject({ ok: false })
    }
  })

  test("binds one activated skill as metadata before consent and reveals instructions only to approved parent transport", async () => {
    const fixture = await makeFixture("activate-once")
    const bundle = promptSkillBundle(fixture.sessionID, fixture.session.report.root)
    let takes = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker(),
      skillBundleSource: {
        async takePromptBundle() {
          takes += 1
          return takes === 1 ? { status: "taken", bundle } : { status: "none" }
        },
      },
      randomUUID: uuidSequence(),
      execute: async (input, resolveWire, parse, dependencies) => {
        const runtimePreview = makeProviderTurnOperationFacts(input).preview
        expect(runtimePreview.logicalPayload.contextBindingDigest).toBeTruthy()
        expect(await dependencies.requestApproval(runtimePreview)).toBe("approve")
        const wire = await resolveWire()
        const privateBody = new TextDecoder().decode(wire.body)
        expect(privateBody).toContain(bundle.skill.instructions)
        expect(privateBody).toContain(bundle.source.instructionsDigest)
        const completion = parse({
          statusCode: 200,
          headers: [["content-type", "text/event-stream"]],
          body: validSse("Skill-aware response"),
        })
        return completed(input.plan.operationID, completion)
      },
    })

    const prepared = await control.prepare(modelID, "Use the activated skill")
    if (prepared.status !== "prepared") throw new Error(prepared.reason)
    expect(prepared.preview.skillContext).toMatchObject({
      kind: "activated_skill",
      name: bundle.skill.name,
      trust: "UNTRUSTED INSTRUCTION DATA",
      assurance: "OBSERVED NOT VERIFIED",
      disclosure: "included_in_provider_request",
    })
    expect(prepared.preview.logicalPayload.contextBindingDigest).toBeTruthy()
    expect(prepared.preview.providerCapabilityDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(prepared.preview)).not.toContain(bundle.skill.instructions)

    const result = await control.decide(prepared.preview.proposalID, "approve", () => {})
    expect(result).toMatchObject({ status: "response_observed_not_verified" })
    expect(takes).toBe(1)

    const next = await control.prepare(modelID, "A plain second turn")
    if (next.status !== "prepared") throw new Error(next.reason)
    expect(next.preview.skillContext).toBeNull()
    expect(next.preview.logicalPayload.contextBindingDigest).toBeNull()
    expect(takes).toBe(2)
  })

  test("releases an activated skill only after a proven zero-effect rejection", async () => {
    const fixture = await makeFixture("activate-once")
    const bundle = promptSkillBundle(fixture.sessionID, fixture.session.report.root)
    let takes = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker(),
      skillBundleSource: {
        async takePromptBundle() {
          takes += 1
          return { status: "taken", bundle }
        },
      },
      randomUUID: uuidSequence(),
      execute: async (input, _resolveWire, _parse, dependencies) => {
        expect(await dependencies.requestApproval(makeProviderTurnOperationFacts(input).preview)).toBe("reject")
        return denied(input.plan.operationID)
      },
    })

    const first = await control.prepare(modelID, "First explicit proposal")
    if (first.status !== "prepared") throw new Error(first.reason)
    expect(await control.decide(first.preview.proposalID, "reject", () => {})).toMatchObject({
      status: "denied_without_effect",
    })
    const second = await control.prepare(modelID, "Second explicit proposal")
    if (second.status !== "prepared") throw new Error(second.reason)
    expect(second.preview.skillContext?.activationOperationID).toBe(bundle.operationID)
    expect(takes).toBe(1)
  })

  test("fails closed when the skill handoff is unavailable without reading credentials or invoking transport", async () => {
    const fixture = await makeFixture("activate-once")
    let issues = 0
    let executions = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker({ onIssue: () => issues++ }),
      skillBundleSource: {
        async takePromptBundle() {
          return { status: "blocked", reason: "bundle_busy" }
        },
      },
      async execute() {
        executions += 1
        throw new Error("transport must not execute")
      },
    })

    expect(await control.prepare(modelID, "Do not continue")).toEqual({
      status: "blocked",
      reason: "skill_context_unavailable",
    })
    expect(issues).toBe(0)
    expect(executions).toBe(0)
  })

  test("rejects a skill bundle bound to another session or workspace before credentials and transport", async () => {
    const fixture = await makeFixture("activate-once")
    const foreign = promptSkillBundle("90000000-0000-4000-8000-000000000009", "/tmp/foreign-workspace")
    let issues = 0
    let executions = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker({ onIssue: () => issues++ }),
      skillBundleSource: {
        async takePromptBundle() {
          return { status: "taken", bundle: foreign }
        },
      },
      async execute() {
        executions += 1
        throw new Error("transport must not execute")
      },
    })

    expect(await control.prepare(modelID, "Do not cross session boundaries")).toEqual({
      status: "blocked",
      reason: "skill_context_unavailable",
    })
    expect(issues).toBe(0)
    expect(executions).toBe(0)
  })

  test("releases a reserved skill when the provider proposal expires before any effect", async () => {
    const fixture = await makeFixture("activate-once")
    const bundle = promptSkillBundle(fixture.sessionID, fixture.session.report.root)
    let now = 1_000
    let takes = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker({ expiresAt: 1_500 }),
      skillBundleSource: {
        async takePromptBundle() {
          takes += 1
          return { status: "taken", bundle }
        },
      },
      now: () => now,
      randomUUID: uuidSequence(),
    })

    const first = await control.prepare(modelID, "Proposal that will expire")
    if (first.status !== "prepared") throw new Error(first.reason)
    now = 2_000
    expect(await control.decide(first.preview.proposalID, "approve", () => {})).toEqual({
      proposalID: first.preview.proposalID,
      status: "blocked",
      reason: "proposal_expired",
    })
    const second = await control.prepare(modelID, "Explicit retry after expiry")
    if (second.status !== "prepared") throw new Error(second.reason)
    expect(second.preview.skillContext?.activationOperationID).toBe(bundle.operationID)
    expect(takes).toBe(1)
  })

  test("refuses a drifted runtime preview without revealing wire values and consumes uncertain context", async () => {
    const fixture = await makeFixture("activate-once")
    const bundle = promptSkillBundle(fixture.sessionID, fixture.session.report.root)
    let takes = 0
    let wireResolutions = 0
    const control = createAstraProviderControl(fixture.session, fixture.sessionID, fixture.state, {
      readCatalog: catalog,
      credentialBroker: broker(),
      skillBundleSource: {
        async takePromptBundle() {
          takes += 1
          return takes === 1 ? { status: "taken", bundle } : { status: "none" }
        },
      },
      randomUUID: uuidSequence(),
      execute: async (input, resolveWire, _parse, dependencies) => {
        const preview = makeProviderTurnOperationFacts(input).preview
        await dependencies.requestApproval({
          ...preview,
          logicalPayload: { ...preview.logicalPayload, contextBindingDigest: contentDigest("drift") },
        })
        await resolveWire()
        wireResolutions += 1
        return denied(input.plan.operationID)
      },
    })

    const first = await control.prepare(modelID, "Tampered preview")
    if (first.status !== "prepared") throw new Error(first.reason)
    expect(await control.decide(first.preview.proposalID, "approve", () => {})).toMatchObject({
      status: "reconciliation_required",
      reason: "effect_unknown",
    })
    expect(wireResolutions).toBe(0)
    const second = await control.prepare(modelID, "No implicit replay")
    if (second.status !== "prepared") throw new Error(second.reason)
    expect(second.preview.skillContext).toBeNull()
    expect(takes).toBe(2)
  })
})

const modelID = "claude-sonnet-4-5-20250929"

async function makeFixture(mode: "read-only" | "activate-once") {
  const root = await mkdtemp(join(tmpdir(), "astra-provider-control-"))
  roots.push(root)
  const report = await scanWorkspace(root)
  return {
    sessionID: "10000000-0000-4000-8000-000000000001",
    session: { status: "opened", mode, report } as const,
    state: {
      ledgerFilename: join(root, "state", "operations.sqlite"),
      spoolFilename: join(root, "state", "receipts.sqlite"),
    },
  }
}

function catalog() {
  return {
    ok: true as const,
    catalog: {
      providerID: "anthropic" as const,
      providerName: "Anthropic" as const,
      models: [{ id: modelID, name: "Claude Sonnet", limits: { context: 200_000, output: 8_192 } }],
      provenance: {
        sourceURL: "https://models.dev/api.json" as const,
        sourceContentDigest: digest("source"),
        providerContentDigest: digest("provider"),
      },
    },
  }
}

function broker(
  input: Readonly<{ secret?: string; expiresAt?: number; onIssue?: () => void; onTake?: () => void }> = {},
) {
  const grant = {
    providerID: "anthropic" as const,
    credentialHandle: `cred_${"1".repeat(64)}`,
    accountFingerprint: `sha256:${"2".repeat(64)}`,
    headerName: "x-api-key" as const,
    expiresAt: input.expiresAt ?? Date.now() + 60_000,
    sessionID: "10000000-0000-4000-8000-000000000001",
  }
  return {
    async issueForSession() {
      input.onIssue?.()
      return { ok: true as const, grant }
    },
    revoke() {
      return true
    },
    takeForParentTransport() {
      input.onTake?.()
      return {
        ok: true as const,
        credential: {
          providerID: "anthropic" as const,
          headerName: "x-api-key" as const,
          headerValue: input.secret ?? "fixture-secret",
          accountFingerprint: grant.accountFingerprint,
        },
      }
    },
  } satisfies ParentProviderCredentialBroker
}

function unavailableBroker(): ParentProviderCredentialBroker {
  return {
    async issueForSession() {
      return {
        ok: false,
        error: { code: "credential_unavailable", message: "Anthropic API credential is unavailable." },
      }
    },
    revoke() {
      return false
    },
    takeForParentTransport() {
      return {
        ok: false,
        error: { code: "credential_invalid", message: "Credential handle is invalid or expired." },
      }
    },
  }
}

function completed(operationID: string, completion: TrustedObservedProviderCompletion): DurableProviderTurnResult {
  const assistantTextDigest = parseContentDigest(completion.evidence.assistantTextDigest)
  if (!assistantTextDigest.ok) throw new Error("Invalid completion digest fixture")
  return {
    operationID,
    state: "completed",
    status: "response_observed_not_verified",
    sequence: 6,
    lastCursor: 6,
    receiptID: "30000000-0000-4000-8000-000000000003",
    response: {
      assistantText: completion.assistantText,
      assistantTextDigest: assistantTextDigest.value,
      assistantTextBytes: completion.evidence.assistantTextBytes,
      finishReason: completion.finishReason,
    },
    boundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
  }
}

function denied(operationID: string): DurableProviderTurnResult {
  return {
    operationID,
    state: "denied",
    status: "denied_without_effect",
    sequence: 3,
    lastCursor: 3,
    receiptID: null,
    response: null,
    boundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
  }
}

function promptSkillBundle(sessionID: string, workspaceRoot: string): TrustedPromptSkillBundle {
  const instructions = "Private skill instruction that must never enter public preview."
  return {
    session: { sessionID, workspaceRoot },
    operationID: "70000000-0000-4000-8000-000000000007",
    capabilityDigest: digest("skill-capability"),
    source: {
      provenance: "workspace_opencode",
      relativePath: ".opencode/skills/safe-skill/SKILL.md",
      fileDigest: digest("skill-file"),
      instructionsDigest: digest(instructions),
    },
    skill: {
      name: "safe-skill",
      instructions,
      trust: "untrusted_instruction_data",
      resourceDiscovery: "none",
    },
    assurance: "observed_not_verified",
  }
}

function validSse(text: string) {
  const events = [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]
  return new TextEncoder().encode(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  )
}

function uuidSequence() {
  let value = 1
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`
}

function digest(value: string) {
  return `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}` as const
}

function contentDigest(value: string) {
  const parsed = parseContentDigest(digest(value))
  if (!parsed.ok) throw new Error("Invalid digest fixture")
  return parsed.value
}
