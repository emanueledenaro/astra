import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAstraGitStageClient } from "../../src/astra/git-stage-client"
import {
  inventoryID,
  inventoryResult,
  preparedResult,
  progress,
  proposalID,
  sessionID,
  stagePreview,
  trackedCandidateID,
  transitionTamperedPreparedResult,
  verifiedResult,
} from "./git-stage-fixture"

test("sends only parent-owned IDs and accepts one exactly bound verified flow", async () => {
  const requests: Record<string, unknown>[] = []
  const states: string[] = []
  const fixture = await controlFixture((socket, request) => {
    requests.push(request)
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-stage.inventory") {
      socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
      return
    }
    if (request.method === "git-stage.prepare") {
      socket.end(message("git-stage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    for (const status of [
      "recording_authority",
      "host_adapter_validating",
      "effect_observed_not_verified",
      "verifying",
    ] as const) {
      socket.write(message("git-stage.progress", requestId, "progress", progress(status, requestId)))
    }
    socket.end(message("git-stage.terminal", requestId, "result", verifiedResult(requestId)))
  })
  const client = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:01:00.000Z"),
  })

  try {
    expect(fixture.connections()).toBe(0)
    const inventory = await client.inventory()
    expect(inventory.status).toBe("inventory")
    await client.prepare(inventoryID, [trackedCandidateID])
    const result = await client.decide(proposalID, "approve", {
      onAccepted: () => states.push("accepted"),
      onProgress: (value) => states.push(value.status),
    })
    expect(result.status).toBe("verified")
    expect(states).toEqual([
      "accepted",
      "recording_authority",
      "host_adapter_validating",
      "effect_observed_not_verified",
      "verifying",
    ])
    expect(requests.map((request) => request.method)).toEqual([
      "git-stage.inventory",
      "git-stage.prepare",
      "git-stage.decide",
    ])
    expect(requests[1]?.inventoryID).toBe(inventoryID)
    expect(requests[1]?.candidateIDs).toEqual([trackedCandidateID])
    expect(JSON.stringify(requests)).not.toContain("tracked.ts")
    expect(JSON.stringify(requests)).not.toContain("workspaceRoot")
    expect(JSON.stringify(requests)).not.toContain("argv")
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects free or stale selection authority before transport", async () => {
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
  })
  const current = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:01:00.000Z"),
  })
  const stale = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:06:00.000Z"),
  })
  try {
    await current.inventory()
    const beforeUnknown = fixture.connections()
    expect(await rejected(current.prepare(inventoryID, ["c0000000-0000-4000-8000-00000000000c"]))).toMatchObject({
      code: "protocol_invalid",
    })
    expect(fixture.connections()).toBe(beforeUnknown)

    expect(await rejected(stale.inventory())).toMatchObject({ code: "protocol_invalid" })
    const beforeStale = fixture.connections()
    expect(await rejected(stale.prepare(inventoryID, [trackedCandidateID]))).toMatchObject({ code: "protocol_invalid" })
    expect(fixture.connections()).toBe(beforeStale)
  } finally {
    current.dispose()
    stale.dispose()
    await fixture.close()
  }
})

test("rejects out-of-order progress instead of inventing a terminal state", async () => {
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-stage.inventory") {
      socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
      return
    }
    if (request.method === "git-stage.prepare") {
      socket.end(message("git-stage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    socket.end(message("git-stage.progress", requestId, "progress", progress("host_adapter_validating", requestId)))
  })
  const client = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:01:00.000Z"),
  })
  try {
    await client.inventory()
    await client.prepare(inventoryID, [trackedCandidateID])
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects a valid preview whose candidate transition contradicts the inventory", async () => {
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-stage.inventory") {
      socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
      return
    }
    socket.end(message("git-stage.terminal", requestId, "result", transitionTamperedPreparedResult(requestId)))
  })
  const client = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:01:00.000Z"),
  })
  try {
    await client.inventory()
    expect(await rejected(client.prepare(inventoryID, [trackedCandidateID]))).toMatchObject({
      code: "protocol_invalid",
    })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects a prepare terminal that arrives after its inventory authority expires", async () => {
  let now = new Date("2027-01-01T12:01:00.000Z")
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-stage.inventory") {
      socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
      return
    }
    now = new Date("2027-01-01T12:06:00.000Z")
    socket.end(message("git-stage.terminal", requestId, "result", preparedResult(requestId)))
  })
  const client = createAstraGitStageClient(fixture.environment, sessionID, { now: () => now })
  try {
    await client.inventory()
    expect(await rejected(client.prepare(inventoryID, [trackedCandidateID]))).toMatchObject({
      code: "protocol_invalid",
    })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects a false no-effect terminal after an observed effect", async () => {
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-stage.inventory") {
      socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
      return
    }
    if (request.method === "git-stage.prepare") {
      socket.end(message("git-stage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    for (const status of ["recording_authority", "host_adapter_validating", "effect_observed_not_verified"] as const) {
      socket.write(message("git-stage.progress", requestId, "progress", progress(status, requestId)))
    }
    socket.end(
      message("git-stage.terminal", requestId, "result", {
        schemaVersion: 1,
        requestId,
        proposalID,
        proposalDigest: stagePreview.proposalDigest,
        status: "failed_without_effect",
        operationID: "60000000-0000-4000-8000-000000000006",
        reason: "adapter_failed",
      }),
    )
  })
  const client = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:01:00.000Z"),
  })
  try {
    await client.inventory()
    await client.prepare(inventoryID, [trackedCandidateID])
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("preserves reconciliation binding but prevents blind replay after approved transport loss", async () => {
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-stage.inventory") {
      socket.end(message("git-stage.terminal", requestId, "result", inventoryResult(requestId)))
      return
    }
    if (request.method === "git-stage.prepare") {
      socket.end(message("git-stage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    socket.destroy()
  })
  const client = createAstraGitStageClient(fixture.environment, sessionID, {
    now: () => new Date("2027-01-01T12:01:00.000Z"),
  })
  try {
    await client.inventory()
    await client.prepare(inventoryID, [trackedCandidateID])
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "transport_failed" })
    const beforeReplay = fixture.connections()
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
    expect(fixture.connections()).toBe(beforeReplay)
  } finally {
    client.dispose()
    await fixture.close()
  }
})

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-git-stage-client-"))
  const socketPath = join(directory, "control.sock")
  const sockets = new Set<Socket>()
  let connections = 0
  const server = createServer((socket) => {
    connections++
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let buffered = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffered += chunk
      if (!buffered.endsWith("\n")) return
      const parsed: unknown = JSON.parse(buffered.slice(0, -1))
      if (isRecord(parsed)) handler(socket, parsed)
      else socket.destroy()
    })
  })
  await listen(server, socketPath)
  return {
    environment: { ASTRA_CONTROL_SOCKET: socketPath, ASTRA_CONTROL_TOKEN: "x".repeat(43) },
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function message(type: string, requestId: string, field?: string, value?: unknown) {
  return JSON.stringify({ schemaVersion: 1, type, requestId, ...(field ? { [field]: value } : {}) }) + "\n"
}
function rejected<Value>(promise: Promise<Value>) {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}
function listen(server: Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
}
function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
