import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { parseGitControlInspectionSummary } from "@astra/domain/git-control-inspection"
import type { AstraControlledWriteControl } from "../src/controlled-write-control"
import type { AstraGitUnstageControl } from "../src/git-unstage-control"
import type { AstraGitStageControl } from "../src/git-stage-control"
import type { AstraSkillActivationControl } from "../src/skill-activation-control"
import { startAstraTuiControlServer, type AstraTuiControlServer } from "../src/tui-control-server"

test("does not inspect before an authenticated explicit request and excludes raw Git data", async () => {
  const fixture = await makeFixture()
  const hostilePath = "raw-secret-name-\u001b]2;owned\u0007"
  const calls: string[] = []
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace(root) {
      calls.push(root)
      return completeInspection(root, hostilePath)
    },
  })

  try {
    expect((await stat(control.socketPath)).mode & 0o777).toBe(0o600)
    expect(calls).toEqual([])
    const messages = await sendRequest(control, request(control))

    expect(messages.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(messages[0]).toMatchObject({ requestId: messages[1]?.requestId })
    expect(parseGitControlInspectionSummary(messages[1]?.summary)).toMatchObject({
      ok: true,
      value: {
        status: "complete",
        verification: "not_verified",
        counts: { total: 4, staged: 1, unstaged: 1, untracked: 1, conflicts: 1 },
      },
    })
    expect(JSON.stringify(messages)).not.toContain("raw-secret-name")
    expect(JSON.stringify(messages)).not.toContain(fixture.root)
    expect(calls).toEqual([fixture.root])
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("fails closed for a wrong token, wrong session, or caller-supplied root", async () => {
  const fixture = await makeFixture()
  const calls: string[] = []
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace(root) {
      calls.push(root)
      return completeInspection(root)
    },
  })

  try {
    expect(await sendRequest(control, { ...request(control), token: "x".repeat(43) })).toEqual([])
    expect(await sendRequest(control, { ...request(control), sessionID: randomUUID() })).toEqual([])
    expect(await sendRequest(control, { ...request(control), workspaceRoot: "/tmp/attacker-selected" })).toEqual([])
    expect(calls).toEqual([])
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("allows one in-flight inspection and rejects replayed request identifiers", async () => {
  const fixture = await makeFixture()
  let complete!: (value: unknown) => void
  const result = new Promise<unknown>((resolve) => {
    complete = resolve
  })
  let calls = 0
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace() {
      calls++
      return result
    },
  })
  const firstRequest = request(control)
  let accepted!: () => void
  const firstAccepted = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const first = sendRequest(control, firstRequest, (message) => {
      if (message.type === "accepted") accepted()
    })
    await firstAccepted

    const busy = await sendRequest(control, request(control))
    expect(busy.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(busy[1]).toMatchObject({ type: "terminal", summary: { status: "blocked", reason: "control_busy" } })
    expect(calls).toBe(1)

    complete(completeInspection(fixture.root))
    expect(await first).toHaveLength(2)

    const replayed = await sendRequest(control, firstRequest)
    expect(replayed.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(replayed[1]).toMatchObject({
      type: "terminal",
      summary: { status: "blocked", reason: "request_replayed" },
    })
    expect(calls).toBe(1)
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("times out an inspector that never resolves and ignores its late result", async () => {
  const fixture = await makeFixture()
  let finishLate!: (value: unknown) => void
  const late = new Promise<unknown>((resolve) => {
    finishLate = resolve
  })
  let calls = 0
  const control = await startAstraTuiControlServer(fixture.input, {
    inspectionTimeoutMs: 20,
    async inspectGitWorkspace(root) {
      calls++
      if (calls === 1) return late
      return completeInspection(root)
    },
  })

  try {
    const timedOut = await sendRequest(control, request(control))
    expect(timedOut.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(timedOut[1]).toMatchObject({
      summary: { status: "blocked", reason: "inspection_timed_out", verification: "not_verified" },
    })

    finishLate(completeInspection(fixture.root, "late-private-path"))
    await Promise.resolve()
    const next = await sendRequest(control, request(control))
    expect(next.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(next[1]).toMatchObject({ summary: { status: "complete", verification: "not_verified" } })
    expect(JSON.stringify(next)).not.toContain("late-private-path")
    expect(calls).toBe(2)
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("closes within a bound even while an authenticated inspector never resolves", async () => {
  const fixture = await makeFixture()
  const control = await startAstraTuiControlServer(fixture.input, {
    inspectionTimeoutMs: 60_000,
    async inspectGitWorkspace() {
      return new Promise(() => {})
    },
  })
  let accepted!: () => void
  const didAccept = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const requestPromise = sendRequest(control, request(control), (message) => {
      if (message.type === "accepted") accepted()
    })
    await didAccept
    await completeWithin(control.close(), 250)
    expect((await requestPromise).map((message) => message.type)).toEqual(["accepted"])
    expect(stat(control.socketPath)).rejects.toThrow()
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("reports adapter failures without details and removes its socket on close", async () => {
  const fixture = await makeFixture()
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace() {
      throw new Error("private adapter detail")
    },
  })

  try {
    const messages = await sendRequest(control, request(control))
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      type: "terminal",
      summary: { status: "blocked", reason: "inspection_failed", verification: "not_verified" },
    })
    expect(JSON.stringify(messages)).not.toContain("private adapter detail")
  } finally {
    await control.close()
    expect(stat(control.socketPath)).rejects.toThrow()
    await fixture.close()
  }
})

test("keeps controlled-write scope server-owned and maps explicit rejection durably", async () => {
  const fixture = await makeFixture()
  let prepareCalls = 0
  let decisionCalls = 0
  const proposalID = randomUUID()
  const operationID = randomUUID()
  const writeControl = {
    async prepare() {
      prepareCalls++
      return internalPrepared(proposalID, operationID)
    },
    async decide(id, decision) {
      decisionCalls++
      expect(id).toBe(proposalID)
      expect(decision).toBe("reject")
      return { status: "denied_without_workspace_effect", operationID, sequence: 4, lastCursor: 4 }
    },
  } satisfies AstraControlledWriteControl
  const control = await startAstraTuiControlServer(
    { ...fixture.input, controlledWriteControl: writeControl },
    {
      async inspectGitWorkspace(root) {
        return completeInspection(root)
      },
    },
  )

  try {
    expect(prepareCalls).toBe(0)
    const prepareRequest = controlledRequest(control, "controlled-write.prepare")
    expect(await sendRequest(control, { ...prepareRequest, workspaceRoot: fixture.root })).toEqual([])
    expect(prepareCalls).toBe(0)

    const prepared = await sendRequest(control, prepareRequest)
    expect(prepared.map((message) => message.type)).toEqual(["accepted", "controlled-write.terminal"])
    expect(prepared[1]).toMatchObject({
      result: {
        status: "prepared",
        preview: {
          operationID,
          proposalID,
          boundary: { label: "HOST EXECUTION — NO SANDBOX" },
          resource: { relativeTarget: ".astra-demo-marker", mode: "create_only" },
          verification: "not_verified",
        },
      },
    })
    expect(JSON.stringify(prepareRequest)).not.toContain(".astra-demo-marker")
    expect(JSON.stringify(prepareRequest)).not.toContain(fixture.root)

    const rejected = await sendRequest(control, {
      ...controlledRequest(control, "controlled-write.decide"),
      proposalID,
      decision: "reject",
    })
    expect(rejected.map((message) => message.type)).toEqual(["accepted", "controlled-write.terminal"])
    expect(rejected[1]).toMatchObject({ result: { status: "denied_without_workspace_effect", operationID } })
    expect(prepareCalls).toBe(1)
    expect(decisionCalls).toBe(1)
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("emits ordered operation progress before an independently verified terminal", async () => {
  const fixture = await makeFixture()
  const proposalID = randomUUID()
  const operationID = randomUUID()
  const receiptID = randomUUID()
  const evidenceID = randomUUID()
  const marker = markerFacts(operationID)
  const writeControl = {
    async prepare() {
      return internalPrepared(proposalID, operationID)
    },
    async decide(id, decision, onProgress) {
      expect(id).toBe(proposalID)
      expect(decision).toBe("approve")
      onProgress?.({ status: "recording_authority" })
      onProgress?.({ status: "host_adapter_validating" })
      onProgress?.({
        status: "effect_observed_not_verified",
        operationID,
        receiptID,
        relativeTarget: ".astra-demo-marker",
        bytes: marker.bytes,
        contentDigest: marker.contentDigest,
      })
      onProgress?.({ status: "verifying" })
      return {
        status: "verified",
        operationID,
        sequence: 8,
        lastCursor: 8,
        receiptID,
        evidenceID,
        evidenceDigest: `sha256:${"b".repeat(64)}`,
        relativeTarget: ".astra-demo-marker",
        bytes: marker.bytes,
        contentDigest: marker.contentDigest,
      }
    },
  } satisfies AstraControlledWriteControl
  const control = await startAstraTuiControlServer({ ...fixture.input, controlledWriteControl: writeControl })

  try {
    await sendRequest(control, controlledRequest(control, "controlled-write.prepare"))
    const messages = await sendRequest(control, {
      ...controlledRequest(control, "controlled-write.decide"),
      proposalID,
      decision: "approve",
    })
    expect(messages.map((message) => message.type)).toEqual([
      "accepted",
      "controlled-write.progress",
      "controlled-write.progress",
      "controlled-write.progress",
      "controlled-write.progress",
      "controlled-write.terminal",
    ])
    expect(messages[1]).toMatchObject({ progress: { status: "recording_authority" } })
    expect(messages[2]).toMatchObject({ progress: { status: "host_adapter_validating" } })
    expect(messages[3]).toMatchObject({
      progress: { status: "effect_observed_not_verified", verification: "not_verified", receiptID },
    })
    expect(messages[4]).toMatchObject({ progress: { status: "verifying" } })
    expect(messages[5]).toMatchObject({
      result: { status: "verified", verification: "exact_readback", receiptID, evidenceID },
    })
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("retains single-flight ownership after an approved response timeout until the operation settles", async () => {
  const fixture = await makeFixture()
  const proposalID = randomUUID()
  const operationID = randomUUID()
  let settle!: (value: Awaited<ReturnType<AstraControlledWriteControl["decide"]>>) => void
  const pendingDecision = new Promise<Awaited<ReturnType<AstraControlledWriteControl["decide"]>>>((resolve) => {
    settle = resolve
  })
  const writeControl = {
    async prepare() {
      return internalPrepared(proposalID, operationID)
    },
    async decide() {
      return pendingDecision
    },
  } satisfies AstraControlledWriteControl
  const control = await startAstraTuiControlServer(
    { ...fixture.input, controlledWriteControl: writeControl },
    {
      controlledWriteTimeoutMs: 20,
      async inspectGitWorkspace(root) {
        return completeInspection(root)
      },
    },
  )

  try {
    await sendRequest(control, controlledRequest(control, "controlled-write.prepare"))
    const timedOut = await sendRequest(control, {
      ...controlledRequest(control, "controlled-write.decide"),
      proposalID,
      decision: "approve",
    })
    expect(timedOut[1]).toMatchObject({
      result: { status: "reconciliation_required", operationID, reason: "durable_state_unavailable" },
    })

    const busy = await sendRequest(control, controlledRequest(control, "controlled-write.prepare"))
    expect(busy[1]).toMatchObject({ result: { status: "blocked", reason: "control_busy" } })

    let closed = false
    const closing = control.close().then(() => {
      closed = true
    })
    await Bun.sleep(10)
    expect(closed).toBeFalse()
    settle({
      status: "reconciliation_required",
      operationID,
      sequence: null,
      lastCursor: null,
      reason: "effect_unknown",
    })
    await completeWithin(closing, 250)
    expect(closed).toBeTrue()
  } finally {
    settle({
      status: "reconciliation_required",
      operationID,
      sequence: null,
      lastCursor: null,
      reason: "effect_unknown",
    })
    await control.close()
    await fixture.close()
  }
})

test("authenticates skill requests and enforces replay plus single-flight before inventory", async () => {
  const fixture = await makeFixture()
  let finishInventory!: (value: Awaited<ReturnType<AstraSkillActivationControl["inventory"]>>) => void
  const pendingInventory = new Promise<Awaited<ReturnType<AstraSkillActivationControl["inventory"]>>>((resolve) => {
    finishInventory = resolve
  })
  let calls = 0
  const skillControl = {
    async inventory() {
      calls++
      return pendingInventory
    },
    async prepare(requestId) {
      return { schemaVersion: 1, requestId, status: "blocked", reason: "not_used" }
    },
    async decide(requestId, proposalID) {
      return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "not_used" }
    },
    async takePromptBundle() {
      return { status: "none" as const }
    },
  } satisfies AstraSkillActivationControl
  const control = await startAstraTuiControlServer({ ...fixture.input, skillActivationControl: skillControl })
  const firstRequest = skillRequest(control, "skill.inventory")
  let accepted!: () => void
  const didAccept = new Promise<void>((resolve) => (accepted = resolve))

  try {
    expect(await sendRequest(control, { ...skillRequest(control, "skill.inventory"), token: "x".repeat(43) })).toEqual(
      [],
    )
    expect(
      await sendRequest(control, { ...skillRequest(control, "skill.inventory"), workspaceRoot: fixture.root }),
    ).toEqual([])
    expect(calls).toBe(0)

    const first = sendRequest(control, firstRequest, (message) => {
      if (message.type === "accepted") accepted()
    })
    await didAccept
    const busy = await sendRequest(control, skillRequest(control, "skill.inventory"))
    expect(busy[1]).toMatchObject({ type: "skill.terminal", result: { status: "blocked", reason: "control_busy" } })
    expect(calls).toBe(1)

    finishInventory({
      schemaVersion: 1,
      requestId: firstRequest.requestId,
      status: "complete",
      inventoryID: randomUUID(),
      candidates: [],
      verification: "not_verified",
    })
    expect((await first).map((message) => message.type)).toEqual(["accepted", "skill.terminal"])

    const replay = await sendRequest(control, firstRequest)
    expect(replay[1]).toMatchObject({
      type: "skill.terminal",
      result: { status: "blocked", reason: "request_replayed" },
    })
    expect(calls).toBe(1)
  } finally {
    finishInventory({
      schemaVersion: 1,
      requestId: firstRequest.requestId,
      status: "blocked",
      reason: "control_closed",
    })
    await control.close()
    await fixture.close()
  }
})

test("keeps skill decision ownership after timeout until the durable task settles", async () => {
  const fixture = await makeFixture()
  const proposalID = randomUUID()
  const operationID = randomUUID()
  let settle!: (value: Awaited<ReturnType<AstraSkillActivationControl["decide"]>>) => void
  const pendingDecision = new Promise<Awaited<ReturnType<AstraSkillActivationControl["decide"]>>>((resolve) => {
    settle = resolve
  })
  const skillControl = {
    async inventory(requestId) {
      return { schemaVersion: 1, requestId, status: "blocked", reason: "not_used" }
    },
    async prepare(requestId) {
      return preparedSkillResult(requestId, proposalID, operationID)
    },
    async decide() {
      return pendingDecision
    },
    async takePromptBundle() {
      return { status: "none" as const }
    },
  } satisfies AstraSkillActivationControl
  const control = await startAstraTuiControlServer(
    { ...fixture.input, skillActivationControl: skillControl },
    {
      skillActivationTimeoutMs: 20,
      async inspectGitWorkspace(root) {
        return completeInspection(root)
      },
    },
  )
  const candidateID = `sha256:${"c".repeat(64)}`

  try {
    const prepared = await sendRequest(control, {
      ...skillRequest(control, "skill.prepare"),
      inventoryID: randomUUID(),
      candidateID,
    })
    expect(prepared[1]).toMatchObject({ result: { status: "prepared", preview: { proposalID, operationID } } })
    const decisionRequest = {
      ...skillRequest(control, "skill.decide"),
      proposalID,
      decision: "approve",
    } as const
    const timedOut = await sendRequest(control, decisionRequest)
    expect(timedOut[1]).toMatchObject({
      result: { status: "reconciliation_required", operationID, reason: "durable_state_unavailable" },
    })
    const busy = await sendRequest(control, skillRequest(control, "skill.inventory"))
    expect(busy[1]).toMatchObject({ result: { status: "blocked", reason: "control_busy" } })

    let closed = false
    const closing = control.close().then(() => {
      closed = true
    })
    await Bun.sleep(10)
    expect(closed).toBeFalse()
    settle({
      schemaVersion: 1,
      requestId: decisionRequest.requestId,
      proposalID,
      operationID,
      status: "reconciliation_required",
      reason: "effect_unknown",
      verification: "not_verified",
    })
    await completeWithin(closing, 250)
    expect(closed).toBeTrue()
  } finally {
    settle({
      schemaVersion: 1,
      requestId: randomUUID(),
      proposalID,
      operationID,
      status: "reconciliation_required",
      reason: "effect_unknown",
      verification: "not_verified",
    })
    await control.close()
    await fixture.close()
  }
})

test("routes Git Unstage through its dedicated authenticated handler exactly once", async () => {
  const fixture = await makeFixture()
  let prepares = 0
  const gitUnstageControl = {
    async prepare(requestId) {
      prepares++
      return { schemaVersion: 1, requestId, status: "blocked", reason: "test_complete" }
    },
    async decide(requestId, proposalID) {
      return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "not_used" }
    },
  } satisfies AstraGitUnstageControl
  const control = await startAstraTuiControlServer({ ...fixture.input, gitUnstageControl })
  const firstRequest = gitUnstageRequest(control)

  try {
    expect(await sendRequest(control, { ...gitUnstageRequest(control), token: "x".repeat(43) })).toEqual([])
    expect(await sendRequest(control, { ...gitUnstageRequest(control), workspaceRoot: fixture.root })).toEqual([])
    expect(prepares).toBe(0)

    const first = await sendRequest(control, firstRequest)
    expect(first.map((message) => message.type)).toEqual(["accepted", "git-unstage.terminal"])
    expect(first.filter((message) => message.type === "accepted")).toHaveLength(1)
    expect(first[1]).toMatchObject({
      requestId: firstRequest.requestId,
      result: { status: "blocked", reason: "test_complete" },
    })
    expect(prepares).toBe(1)

    const replay = await sendRequest(control, firstRequest)
    expect(replay.map((message) => message.type)).toEqual(["accepted", "git-unstage.terminal"])
    expect(replay[1]).toMatchObject({ result: { status: "blocked", reason: "request_replayed" } })
    expect(prepares).toBe(1)
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("routes Git Stage through its dedicated authenticated handler before acceptance", async () => {
  const fixture = await makeFixture()
  let inventories = 0
  const gitStageControl = {
    async inventory(requestId) {
      inventories++
      return { schemaVersion: 1, requestId, status: "blocked", reason: "test_complete" }
    },
    async prepare(requestId) {
      return { schemaVersion: 1, requestId, status: "blocked", reason: "not_used" }
    },
    async decide(requestId, proposalID) {
      return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason: "not_used" }
    },
  } satisfies AstraGitStageControl
  const control = await startAstraTuiControlServer({ ...fixture.input, gitStageControl })
  const firstRequest = gitStageRequest(control)

  try {
    expect(await sendRequest(control, { ...gitStageRequest(control), token: "x".repeat(43) })).toEqual([])
    expect(await sendRequest(control, { ...gitStageRequest(control), workspaceRoot: fixture.root })).toEqual([])
    expect(inventories).toBe(0)

    const first = await sendRequest(control, firstRequest)
    expect(first.map((message) => message.type)).toEqual(["accepted", "git-stage.terminal"])
    expect(first.filter((message) => message.type === "accepted")).toHaveLength(1)
    expect(first[1]).toMatchObject({
      requestId: firstRequest.requestId,
      result: { status: "blocked", reason: "test_complete" },
    })
    expect(inventories).toBe(1)

    const replay = await sendRequest(control, firstRequest)
    expect(replay.map((message) => message.type)).toEqual(["accepted", "git-stage.terminal"])
    expect(replay[1]).toMatchObject({ result: { status: "blocked", reason: "request_replayed" } })
    expect(inventories).toBe(1)
  } finally {
    await control.close()
    await fixture.close()
  }
})

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "astra-control-test-"))
  const root = join(directory, "workspace")
  await Bun.write(join(directory, "keep"), "private directory")
  return {
    root,
    input: { directory, workspaceRoot: root, sessionID: randomUUID() },
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

function request(control: AstraTuiControlServer) {
  return {
    schemaVersion: 1,
    method: "git.inspect",
    requestId: randomUUID(),
    sessionID: control.sessionID,
    token: control.token,
  } as const
}

function controlledRequest(
  control: AstraTuiControlServer,
  method: "controlled-write.prepare" | "controlled-write.decide",
) {
  return {
    schemaVersion: 1,
    method,
    requestId: randomUUID(),
    sessionID: control.sessionID,
    token: control.token,
  } as const
}

function skillRequest(control: AstraTuiControlServer, method: "skill.inventory" | "skill.prepare" | "skill.decide") {
  return {
    schemaVersion: 1,
    method,
    requestId: randomUUID(),
    sessionID: control.sessionID,
    token: control.token,
  } as const
}

function gitUnstageRequest(control: AstraTuiControlServer) {
  return {
    schemaVersion: 1,
    method: "git-unstage.prepare",
    requestId: randomUUID(),
    sessionID: control.sessionID,
    token: control.token,
  } as const
}

function gitStageRequest(control: AstraTuiControlServer) {
  return {
    schemaVersion: 1,
    method: "git-stage.inventory",
    requestId: randomUUID(),
    sessionID: control.sessionID,
    token: control.token,
  } as const
}

function internalPrepared(proposalID: string, operationID: string) {
  const marker = markerFacts(operationID)
  return {
    status: "awaiting_approval",
    preview: {
      schemaVersion: 1,
      proposalID,
      operationID,
      executionBoundary: "HOST EXECUTION — NO SANDBOX",
      target: ".astra-demo-marker",
      resource: "workspace:.astra-demo-marker",
      bytes: marker.bytes,
      contentDigest: marker.contentDigest,
      capabilityDigest: `sha256:${"b".repeat(64)}`,
      expiresAt: "2026-07-17T14:00:00.000Z",
      effect: "create_only",
      network: "host_unrestricted_not_isolated",
    },
  } as const
}

function preparedSkillResult(requestId: string, proposalID: string, operationID: string) {
  const digest = `sha256:${"c".repeat(64)}` as const
  const relativePath = ".opencode/skills/safe-skill/SKILL.md"
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      operationID,
      proposalID,
      expiresAt: "2026-07-17T18:00:00.000Z",
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      capabilityDigest: digest,
      skill: {
        candidateID: digest,
        name: "safe-skill",
        relativePath,
        fileDigest: digest,
        fileBytes: 128,
        instructionsDigest: digest,
        instructionsBytes: 64,
        provenance: "workspace_opencode",
        trust: "UNTRUSTED INSTRUCTION DATA",
      },
      effects: {
        workspaceRead: relativePath,
        workspaceWrite: "none",
        runtimeWrite: "private_session_skill_bundle",
        process: "none",
        network: "none",
        plugins: "none",
        mcp: "none",
        tools: "none",
      },
      verification: "not_verified",
    },
  } as const
}

function markerFacts(operationID: string) {
  const content = `Astra controlled host write\noperation_id=${operationID}\n`
  return {
    bytes: Buffer.byteLength(content),
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const,
  }
}

function sendRequest(
  control: AstraTuiControlServer,
  payload: Readonly<Record<string, unknown>>,
  onMessage?: (message: Record<string, unknown>) => void,
) {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    let buffered = ""
    const socket = createConnection(control.socketPath)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"))
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) throw new Error("The control server returned a non-object message")
        const message = parsed
        messages.push(message)
        onMessage?.(message)
      }
    })
    socket.on("error", reject)
    socket.on("close", () => resolve(messages))
  })
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function completeWithin(operation: Promise<void>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("The control server did not close within the bound")), milliseconds)
  })
  return Promise.race([operation, expired]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function completeInspection(root: string, path = "src/index.ts") {
  const observationDigest = `sha256:${"a".repeat(64)}`
  return {
    status: "complete",
    mode: "bounded_read_only",
    baseline: "not_captured",
    activationAllowed: false,
    verification: "not_verified",
    submodules: "not_inspected",
    workspaceRoot: root,
    branch: {
      oid: null,
      head: null,
      upstream: null,
      ahead: null,
      behind: null,
      stashCount: 0,
      aheadBehindScope: "local_ref_only",
    },
    staged: [{ path, index: "M", worktree: "." }],
    unstaged: [{ path, index: ".", worktree: "M" }],
    untracked: [path],
    conflicts: [{ path, code: "UU" }],
    entryCount: 4,
    outputDigest: observationDigest,
    diff: {
      source: "status_porcelain_v2",
      format: "metadata_only",
      renames: "disabled",
      durability: "ephemeral",
      verification: "not_verified",
      untrackedContent: "not_inspected",
      conflictContent: "not_inspected",
      observationDigest,
      staged: [],
      unstaged: [],
    },
    reportDigest: `sha256:${"b".repeat(64)}`,
  }
}
