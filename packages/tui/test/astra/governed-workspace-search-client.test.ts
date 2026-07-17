import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAstraGovernedWorkspaceSearchClient } from "../../src/astra/governed-workspace-search-client"

const fixtures: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

test("sends only the literal query and binds the terminal to observed receipt and outcome", async () => {
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const proposalID = randomUUID()
  const operationID = randomUUID()
  const receiptID = randomUUID()
  const capabilityDigest = `sha256:${"a".repeat(64)}`
  const outputDigest = `sha256:${"b".repeat(64)}`
  const requests: Array<Record<string, unknown>> = []
  const fixture = await controlFixture((socket, request) => {
    requests.push(request)
    accepted(socket, request.requestId)
    if (request.method === "search.prepare") {
      terminal(socket, request.requestId, prepared(request.requestId, proposalID, operationID, capabilityDigest))
      return
    }
    const binding = {
      schemaVersion: 1,
      requestId: request.requestId,
      proposalID,
      operationID,
      capabilityDigest,
      verification: "not_verified",
    }
    progress(socket, request.requestId, { ...binding, status: "recording_authority" })
    progress(socket, request.requestId, { ...binding, status: "executing_host" })
    progress(socket, request.requestId, {
      ...binding,
      status: "effect_observed_not_verified",
      receiptID,
      outputDigest,
      digestScope: "stdout_only",
      outputLineCount: 1,
      outcome: "matches",
    })
    terminal(socket, request.requestId, {
      ...binding,
      status: "completed_observed_not_verified",
      receiptID,
      output: output(outputDigest),
    })
  })
  fixtures.push(fixture)
  const client = createAstraGovernedWorkspaceSearchClient(
    { ASTRA_CONTROL_SOCKET: fixture.socketPath, ASTRA_CONTROL_TOKEN: token },
    sessionID,
    { expectedWorkspaceRoot: "/workspace" },
  )

  const prepare = await client.prepare("$(literal); * ?")
  if (prepare.status !== "prepared") throw new Error("Expected prepared search")
  const result = await client.decide(prepare.preview.proposalID, "approve")

  expect(result).toMatchObject({ status: "completed_observed_not_verified", receiptID })
  expect(requests[0]).toEqual({
    schemaVersion: 1,
    method: "search.prepare",
    requestId: expect.any(String),
    sessionID,
    token,
    query: "$(literal); * ?",
  })
  expect(requests[1]).toEqual({
    schemaVersion: 1,
    method: "search.decide",
    requestId: expect.any(String),
    sessionID,
    token,
    proposalID,
    decision: "approve",
  })
  expect(JSON.stringify(requests)).not.toContain("workspaceRoot")
  expect(JSON.stringify(requests)).not.toContain("argv")
  client.dispose()
})

test("rejects duplicate accepted frames and mismatched terminal observations", async () => {
  const sessionID = randomUUID()
  const token = "x".repeat(43)
  const proposalID = randomUUID()
  const operationID = randomUUID()
  const capabilityDigest = `sha256:${"a".repeat(64)}`
  const duplicate = await controlFixture((socket, request) => {
    accepted(socket, request.requestId)
    accepted(socket, request.requestId)
  })
  fixtures.push(duplicate)
  const duplicateClient = createAstraGovernedWorkspaceSearchClient(
    { ASTRA_CONTROL_SOCKET: duplicate.socketPath, ASTRA_CONTROL_TOKEN: token },
    sessionID,
  )
  expect(duplicateClient.prepare("needle")).rejects.toMatchObject({ code: "protocol_invalid" })

  const receiptID = randomUUID()
  const outputDigest = `sha256:${"b".repeat(64)}`
  const mismatch = await controlFixture((socket, request) => {
    accepted(socket, request.requestId)
    if (request.method === "search.prepare") {
      terminal(socket, request.requestId, prepared(request.requestId, proposalID, operationID, capabilityDigest))
      return
    }
    const binding = {
      schemaVersion: 1,
      requestId: request.requestId,
      proposalID,
      operationID,
      capabilityDigest,
      verification: "not_verified",
    }
    progress(socket, request.requestId, { ...binding, status: "recording_authority" })
    progress(socket, request.requestId, { ...binding, status: "executing_host" })
    progress(socket, request.requestId, {
      ...binding,
      status: "effect_observed_not_verified",
      receiptID,
      outputDigest,
      digestScope: "stdout_only",
      outputLineCount: 1,
      outcome: "matches",
    })
    terminal(socket, request.requestId, {
      ...binding,
      status: "completed_observed_not_verified",
      receiptID: randomUUID(),
      output: output(outputDigest),
    })
  })
  fixtures.push(mismatch)
  const mismatchClient = createAstraGovernedWorkspaceSearchClient(
    { ASTRA_CONTROL_SOCKET: mismatch.socketPath, ASTRA_CONTROL_TOKEN: token },
    sessionID,
  )
  const preparedResult = await mismatchClient.prepare("needle")
  if (preparedResult.status !== "prepared") throw new Error("Expected prepared search")
  expect(mismatchClient.decide(proposalID, "approve")).rejects.toMatchObject({ code: "protocol_invalid" })
  duplicateClient.dispose()
  mismatchClient.dispose()
})

function prepared(requestId: unknown, proposalID: string, operationID: string, capabilityDigest: string) {
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      schemaVersion: 1,
      proposalID,
      operationID,
      query: "needle",
      queryBytes: 6,
      capabilityDigest,
      expiresAt: "2026-07-17T23:59:59.000Z",
      boundaryLabel: "HOST EXECUTION — NO SANDBOX",
      workspaceRoot: "/workspace",
      executable: "/usr/bin/grep",
      mode: "recursive_fixed_string",
      resources: ["process:/usr/bin/grep", "workspace:/workspace"],
      network: "host_unrestricted_not_requested",
      writes: [],
      verification: "not_verified",
    },
  }
}

function output(outputDigest: string) {
  return {
    outputDigest,
    digestScope: "stdout_only",
    outputLineCount: 1,
    outcome: "matches",
    exitCode: 0,
    displayLines: ["./source.txt:1:needle"],
    truncated: false,
  }
}

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-search-client-"))
  const socketPath = join(directory, "control.sock")
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let buffered = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      try {
        const request: unknown = JSON.parse(line)
        if (isRecord(request)) handler(socket, request)
        else socket.destroy()
      } catch {
        socket.destroy()
      }
    })
  })
  await listen(server, socketPath)
  await chmod(socketPath, 0o600)
  return {
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function accepted(socket: Socket, requestId: unknown) {
  socket.write(`${JSON.stringify({ schemaVersion: 1, type: "accepted", requestId })}\n`)
}

function progress(socket: Socket, requestId: unknown, value: unknown) {
  socket.write(`${JSON.stringify({ schemaVersion: 1, type: "search.progress", requestId, progress: value })}\n`)
}

function terminal(socket: Socket, requestId: unknown, result: unknown) {
  socket.end(`${JSON.stringify({ schemaVersion: 1, type: "search.terminal", requestId, result })}\n`)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
