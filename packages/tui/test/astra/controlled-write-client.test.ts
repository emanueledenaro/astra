import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createAstraControlledWriteClient } from "../../src/astra/controlled-write-client"

test("stays disconnected until prepare and sends no caller-controlled effect scope", async () => {
  let observed: Record<string, unknown> | undefined
  const fixture = await controlFixture((socket, request) => {
    observed = request
    socket.write(message("accepted", request.requestId))
    socket.end(message("controlled-write.terminal", request.requestId, "result", preparedResult(request.requestId)))
  })
  const client = createAstraControlledWriteClient(fixture.environment, sessionID)

  try {
    expect(fixture.connections()).toBe(0)
    const result = await client.prepare()
    expect(result.status).toBe("prepared")
    expect(fixture.connections()).toBe(1)
    expect(Object.keys(observed ?? {}).sort()).toEqual(["method", "requestId", "schemaVersion", "sessionID", "token"])
    expect(JSON.stringify(observed)).not.toContain(".astra-demo-marker")
    expect(JSON.stringify(observed)).not.toContain("workspace")
    expect(JSON.stringify(observed)).not.toContain("content")
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("accepts the ordered operation phases without calling observed effects verified", async () => {
  const states: string[] = []
  const fixture = await controlFixture((socket, request) => {
    if (request.method === "controlled-write.prepare") {
      socket.write(message("accepted", request.requestId))
      socket.end(message("controlled-write.terminal", request.requestId, "result", preparedResult(request.requestId)))
      return
    }
    socket.write(message("accepted", request.requestId))
    socket.write(
      message(
        "controlled-write.progress",
        request.requestId,
        "progress",
        phase(request.requestId, "recording_authority"),
      ),
    )
    socket.write(
      message(
        "controlled-write.progress",
        request.requestId,
        "progress",
        phase(request.requestId, "host_adapter_validating"),
      ),
    )
    socket.write(message("controlled-write.progress", request.requestId, "progress", progress(request.requestId)))
    socket.write(
      message("controlled-write.progress", request.requestId, "progress", phase(request.requestId, "verifying")),
    )
    socket.end(message("controlled-write.terminal", request.requestId, "result", verifiedResult(request.requestId)))
  })
  const client = createAstraControlledWriteClient(fixture.environment, sessionID)

  try {
    await client.prepare()
    const result = await client.decide(proposalID, "approve", {
      onAccepted: () => states.push("running_not_verified"),
      onProgress: (value) => states.push(value.status),
    })
    states.push(result.status)
    expect(states).toEqual([
      "running_not_verified",
      "recording_authority",
      "host_adapter_validating",
      "effect_observed_not_verified",
      "verifying",
      "verified",
    ])
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects duplicate or out-of-order operation progress", async () => {
  const fixture = await controlFixture((socket, request) => {
    if (request.method === "controlled-write.prepare") {
      socket.write(message("accepted", request.requestId))
      socket.end(message("controlled-write.terminal", request.requestId, "result", preparedResult(request.requestId)))
      return
    }
    socket.write(message("accepted", request.requestId))
    socket.write(
      message(
        "controlled-write.progress",
        request.requestId,
        "progress",
        phase(request.requestId, "host_adapter_validating"),
      ),
    )
  })
  const client = createAstraControlledWriteClient(fixture.environment, sessionID)

  try {
    await client.prepare()
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("fails closed on progress before accepted or a malformed terminal", async () => {
  let attempt = 0
  const fixture = await controlFixture((socket, request) => {
    attempt++
    if (attempt === 1) {
      socket.write(message("accepted", request.requestId))
      socket.end(message("controlled-write.terminal", request.requestId, "result", preparedResult(request.requestId)))
      return
    }
    if (attempt === 2) {
      socket.end(message("controlled-write.progress", request.requestId, "progress", progress(request.requestId)))
      return
    }
    socket.write(message("accepted", request.requestId))
    socket.end(
      message("controlled-write.terminal", request.requestId, "result", {
        ...preparedResult(request.requestId),
        root: "/tmp",
      }),
    )
  })
  const client = createAstraControlledWriteClient(fixture.environment, sessionID)

  try {
    await client.prepare()
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
    expect(await rejected(client.prepare())).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects a misbound nested request, receipt, or exact readback", async () => {
  let attempt = 0
  const fixture = await controlFixture((socket, request) => {
    attempt++
    if (attempt === 1 || attempt === 3 || attempt === 5) {
      socket.write(message("accepted", request.requestId))
      socket.end(message("controlled-write.terminal", request.requestId, "result", preparedResult(request.requestId)))
      return
    }
    const terminal = verifiedResult(attempt === 2 ? "70000000-0000-4000-8000-000000000007" : request.requestId)
    if (attempt === 4) terminal.receiptID = "80000000-0000-4000-8000-000000000008"
    if (attempt === 6) terminal.readback = { ...terminal.readback, contentDigest: digest("f") }
    writeVerifiedFlow(socket, request.requestId, terminal)
  })
  const client = createAstraControlledWriteClient(fixture.environment, sessionID)

  try {
    for (let index = 0; index < 3; index++) {
      await client.prepare()
      expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
    }
  } finally {
    client.dispose()
    await fixture.close()
  }
})

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-write-control-"))
  const socketPath = join(directory, "control.sock")
  let count = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    count++
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
    connections: () => count,
    async close() {
      for (const socket of sockets) socket.destroy()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function message(type: string, requestId: unknown, field?: string, value?: unknown) {
  return JSON.stringify({ schemaVersion: 1, type, requestId, ...(field ? { [field]: value } : {}) }) + "\n"
}

function preparedResult(requestId: unknown) {
  return {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      schemaVersion: 1,
      operation: "controlled_write_create_only",
      operationID,
      proposalID,
      expiresAt: "2026-07-17T14:00:00.000Z",
      boundary: { mode: "host_no_sandbox", label: "HOST EXECUTION — NO SANDBOX" },
      resource: {
        kind: "workspace_relative_file",
        mode: "create_only",
        relativeTarget: ".astra-demo-marker",
        bytes: markerBytes,
        contentDigest: markerDigest,
      },
      capabilityDigest: digest("b"),
      network: { mode: "host_unrestricted", warning: "HOST NETWORK UNRESTRICTED — NOT ISOLATED" },
      verification: "not_verified",
    },
  }
}

function progress(requestId: unknown) {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    operationID,
    status: "effect_observed_not_verified",
    verification: "not_verified",
    receiptID,
    observation: { relativeTarget: ".astra-demo-marker", bytes: markerBytes, contentDigest: markerDigest },
  }
}

function phase(requestId: unknown, status: "recording_authority" | "host_adapter_validating" | "verifying") {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    operationID,
    status,
    verification: "not_verified",
  }
}

function writeVerifiedFlow(socket: Socket, requestId: unknown, terminal: ReturnType<typeof verifiedResult>) {
  socket.write(message("accepted", requestId))
  socket.write(message("controlled-write.progress", requestId, "progress", phase(requestId, "recording_authority")))
  socket.write(message("controlled-write.progress", requestId, "progress", phase(requestId, "host_adapter_validating")))
  socket.write(message("controlled-write.progress", requestId, "progress", progress(requestId)))
  socket.write(message("controlled-write.progress", requestId, "progress", phase(requestId, "verifying")))
  socket.end(message("controlled-write.terminal", requestId, "result", terminal))
}

function verifiedResult(requestId: unknown) {
  return {
    schemaVersion: 1,
    requestId,
    proposalID,
    operationID,
    status: "verified",
    verification: "exact_readback",
    receiptID,
    evidenceID,
    readback: { relativeTarget: ".astra-demo-marker", bytes: markerBytes, contentDigest: markerDigest },
  }
}

function digest(character: string) {
  return `sha256:${character.repeat(64)}`
}

function rejected<T>(promise: Promise<T>) {
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

const sessionID = "00000000-0000-4000-8000-000000000001"
const proposalID = "10000000-0000-4000-8000-000000000001"
const operationID = "20000000-0000-4000-8000-000000000002"
const receiptID = "36eb4a8c-2db5-8b06-a09c-4b85fe5ff4f7"
const evidenceID = "cebf0e2f-a0d3-89e6-bcba-8350a86bf5a5"
const markerContent = `Astra controlled host write\noperation_id=${operationID}\n`
const markerBytes = Buffer.byteLength(markerContent)
const markerDigest = `sha256:${createHash("sha256").update(markerContent).digest("hex")}`
