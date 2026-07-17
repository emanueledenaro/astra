import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseContentDigest } from "@astra/domain/operation-contract"
import type { DurableProviderTurnResult } from "@astra/runtime/provider-turn-coordinator"
import { makeProviderTurnOperationFacts } from "@astra/runtime/provider-turn-operation-facts"
import type { TrustedObservedProviderCompletion } from "@astra/runtime/provider-turn-transport"
import { scanWorkspace } from "@astra/runtime/preflight"
import { createAstraProviderClient } from "../../tui/src/astra/provider-client"
import { createAstraSkillActivationClient } from "../../tui/src/astra/skill-activation-client"
import { createAstraProviderControl } from "../src/provider-control"
import { startAstraProviderControlServer } from "../src/provider-control-server"
import { createAstraSkillActivationControl } from "../src/skill-activation-control"
import { startAstraTuiControlServer } from "../src/tui-control-server"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("hands one activated skill into governed chat and reuses it only after proven rejection", async () => {
  const fakeHome = await realpath(await mkdtemp("/tmp/as-h-"))
  roots.push(fakeHome)
  const workspace = join(fakeHome, "workspace")
  const state = join(fakeHome, ".local/state/astra")
  const privateRuntime = join(fakeHome, ".local/run/astra")
  await mkdir(privateRuntime, { recursive: true, mode: 0o700 })
  await chmod(privateRuntime, 0o700)
  const privateInstructions = "Use concise answers. Never request tools or run commands."
  const skillPath = join(workspace, ".opencode/skills/safe-skill/SKILL.md")
  await mkdir(dirname(skillPath), { recursive: true })
  await writeFile(
    skillPath,
    ["---", "name: safe-skill", "description: Safe smoke skill.", "---", "", privateInstructions, ""].join("\n"),
  )
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(", "))
  const sessionID = crypto.randomUUID()
  const session = { status: "opened", mode: "activate-once", report } as const
  const skillControl = createAstraSkillActivationControl(
    session,
    { sessionID },
    {
      ledgerFilename: join(state, "skill-operations.sqlite"),
      spoolFilename: join(state, "skill-receipts.sqlite"),
      privateRuntimeDirectory: privateRuntime,
    },
  )
  const controlServer = await startAstraTuiControlServer({
    directory: privateRuntime,
    workspaceRoot: workspace,
    sessionID,
    skillActivationControl: skillControl,
  })
  const skillClient = createAstraSkillActivationClient(
    { ASTRA_CONTROL_SOCKET: controlServer.socketPath, ASTRA_CONTROL_TOKEN: controlServer.token },
    sessionID,
  )
  let dispatched = 0
  let privateWireBody = ""
  const providerControl = createAstraProviderControl(
    session,
    sessionID,
    {
      ledgerFilename: join(state, "provider-operations.sqlite"),
      spoolFilename: join(state, "provider-receipts.sqlite"),
    },
    {
      readCatalog: catalog,
      credentialBroker: broker(sessionID),
      skillBundleSource: skillControl,
      execute: async (input, resolveWire, parse, dependencies) => {
        const decision = await dependencies.requestApproval(makeProviderTurnOperationFacts(input).preview)
        if (decision === "reject") return denied(input.plan.operationID)
        const wire = await resolveWire()
        privateWireBody = new TextDecoder().decode(wire.body)
        dispatched += 1
        dependencies.onNetworkDispatch?.()
        const completion = parse({
          statusCode: 200,
          headers: [["content-type", "text/event-stream"]],
          body: validSse("Skill bridge observed"),
        })
        return completed(input.plan.operationID, completion)
      },
    },
  )
  const providerServer = await startAstraProviderControlServer({
    directory: privateRuntime,
    sessionID,
    control: providerControl,
  })
  const providerClient = createAstraProviderClient(
    { ASTRA_PROVIDER_SOCKET: providerServer.socketPath, ASTRA_PROVIDER_TOKEN: providerServer.token },
    sessionID,
  )

  try {
    const inventory = await skillClient.inventory()
    if (inventory.status !== "complete" || !inventory.candidates[0]) throw new Error("Skill inventory failed")
    const activation = await skillClient.prepare(inventory.inventoryID, inventory.candidates[0].candidateID)
    if (activation.status !== "prepared") throw new Error(activation.reason)
    expect(await skillClient.decide(activation.preview.proposalID, "approve")).toMatchObject({
      status: "completed_observed_not_verified",
    })

    const first = await providerClient.prepare(modelID, "First proposal")
    if (first.status !== "prepared") throw new Error(first.reason)
    expect(first.preview.skillContext).toMatchObject({ name: "safe-skill", trust: "UNTRUSTED INSTRUCTION DATA" })
    expect(JSON.stringify(first)).not.toContain(privateInstructions)
    expect(await providerClient.decide(first.preview.proposalID, "reject")).toMatchObject({
      status: "denied_without_effect",
    })
    expect(dispatched).toBe(0)

    const second = await providerClient.prepare(modelID, "Second explicit proposal")
    if (second.status !== "prepared") throw new Error(second.reason)
    expect(second.preview.skillContext?.activationOperationID).toBe(first.preview.skillContext?.activationOperationID)
    expect(JSON.stringify(second)).not.toContain(privateInstructions)
    expect(await providerClient.decide(second.preview.proposalID, "approve")).toMatchObject({
      status: "response_observed_not_verified",
      response: { assistantText: "Skill bridge observed" },
    })
    expect(dispatched).toBe(1)
    expect(privateWireBody).toContain(privateInstructions)
    expect(await skillControl.takePromptBundle()).toEqual({ status: "none" })
    expect((await readdir(privateRuntime)).toSorted()).toEqual(["control.sock", "provider.sock"])
    for (const filename of await readdir(state)) {
      const bytes = await readFile(join(state, filename))
      expect(bytes.includes(Buffer.from(privateInstructions))).toBeFalse()
    }
  } finally {
    skillClient.dispose()
    providerClient.dispose()
    await providerServer.close()
    await controlServer.close()
  }
})

const modelID = "claude-sonnet-4-5-20250929"

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

function broker(sessionID: string) {
  const grant = {
    providerID: "anthropic" as const,
    credentialHandle: `cred_${"1".repeat(64)}`,
    accountFingerprint: `sha256:${"2".repeat(64)}`,
    headerName: "x-api-key" as const,
    expiresAt: Date.now() + 60_000,
    sessionID,
  }
  return {
    async issueForSession() {
      return { ok: true as const, grant }
    },
    takeForParentTransport() {
      return {
        ok: true as const,
        credential: {
          providerID: "anthropic" as const,
          headerName: "x-api-key" as const,
          headerValue: "fake-home-secret",
          accountFingerprint: grant.accountFingerprint,
        },
      }
    },
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

function completed(operationID: string, completion: TrustedObservedProviderCompletion): DurableProviderTurnResult {
  const assistantTextDigest = parseContentDigest(completion.evidence.assistantTextDigest)
  if (!assistantTextDigest.ok) throw new Error("Invalid completion digest fixture")
  return {
    operationID,
    state: "completed",
    status: "response_observed_not_verified",
    sequence: 6,
    lastCursor: 6,
    receiptID: crypto.randomUUID(),
    response: {
      assistantText: completion.assistantText,
      assistantTextDigest: assistantTextDigest.value,
      assistantTextBytes: completion.evidence.assistantTextBytes,
      finishReason: completion.finishReason,
    },
    boundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
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

function digest(value: string) {
  return `sha256:${Bun.CryptoHasher.hash("sha256", value, "hex")}` as const
}
