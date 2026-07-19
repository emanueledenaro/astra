import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { AstraControlClientError } from "../../src/astra/control-client"
import { createAstraOperationViewClient } from "../../src/astra/operation-view-client"

const sessionID = "00000000-0000-4000-8000-000000000001"
const operationID = "0196e4cb-5d80-7b1d-8fb2-263b81670431"

const listedResult = (requestId: unknown) => ({
  schemaVersion: 1,
  requestId,
  status: "listed",
  coverage: "dispatched_operations_only",
  operations: [
    {
      operationID,
      intentKind: "controlled_write",
      state: "succeeded",
      semanticKey: "VERIFIED",
      sequence: 8,
      updatedAt: "2026-07-17T10:00:08.000Z",
    },
  ],
})

test("fails closed without the control environment and opens no socket", async () => {
  const client = createAstraOperationViewClient({}, sessionID)
  for (const request of [client.list(), client.detail(operationID), client.recovery()]) {
    const failure: unknown = await request.then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AstraControlClientError)
    expect(failure).toMatchObject({ code: "unavailable" })
  }
  client.dispose()
})

test("fails closed for a malformed session identifier", async () => {
  const fixture = await controlFixture(() => {})
  const client = createAstraOperationViewClient(fixture.environment, "not-a-session")
  try {
    const failure: unknown = await client.list().then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: "unavailable" })
    expect(fixture.connections()).toBe(0)
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("stays disconnected until a request and returns only a parsed exact-key terminal", async () => {
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
    socket.end(message("operation-view.terminal", request.requestId, listedResult(request.requestId)))
  })
  const client = createAstraOperationViewClient(fixture.environment, sessionID)
  try {
    expect(fixture.connections()).toBe(0)
    const result = await client.list()
    expect(result.status).toBe("listed")
    if (result.status !== "listed") return
    expect(result.operations[0]).toMatchObject({ operationID, state: "succeeded", semanticKey: "VERIFIED" })
    expect(fixture.connections()).toBe(1)
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects a terminal whose semantic key is stronger than its durable state", async () => {
  const fixture = await controlFixture((socket, request) => {
    const forged = listedResult(request.requestId)
    forged.operations[0] = { ...forged.operations[0]!, state: "effect_observed", semanticKey: "VERIFIED" } as never
    socket.write(message("accepted", request.requestId))
    socket.end(message("operation-view.terminal", request.requestId, forged))
  })
  const client = createAstraOperationViewClient(fixture.environment, sessionID)
  try {
    const failure: unknown = await client.list().then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AstraControlClientError)
    expect(failure).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects a detail terminal bound to another operation", async () => {
  const other = "0196e4cb-5d80-7b1d-8fb2-263b816704ff"
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
    socket.end(
      message("operation-view.terminal", request.requestId, {
        schemaVersion: 1,
        requestId: request.requestId,
        status: "not_found",
        operationID: other,
      }),
    )
  })
  const client = createAstraOperationViewClient(fixture.environment, sessionID)
  try {
    const failure: unknown = await client.detail(operationID).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-operation-view-client-"))
  const socketPath = join(directory, "control.sock")
  let connectionCount = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    connectionCount++
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let buffered = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffered += chunk
      if (!buffered.endsWith("\n")) return
      const parsed: unknown = JSON.parse(buffered.slice(0, -1))
      if (!isRecord(parsed)) {
        socket.destroy()
        return
      }
      handler(socket, parsed)
    })
  })
  await listen(server, socketPath)
  return {
    environment: { ASTRA_CONTROL_SOCKET: socketPath, ASTRA_CONTROL_TOKEN: "x".repeat(43) },
    connections: () => connectionCount,
    async close() {
      for (const socket of sockets) socket.destroy()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function message(type: "accepted" | "operation-view.terminal", requestId: unknown, result?: unknown) {
  return JSON.stringify({ schemaVersion: 1, type, requestId, ...(result ? { result } : {}) }) + "\n"
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
