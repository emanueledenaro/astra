import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAstraGitUnstageClient } from "../../src/astra/git-unstage-client"
import { preparedResult, progress, proposalID, sessionID, verifiedResult } from "./git-unstage-fixture"

test("is lazy, sends no effect scope, and accepts one strictly ordered verified flow", async () => {
  const requests: Record<string, unknown>[] = []
  const states: string[] = []
  const fixture = await controlFixture((socket, request) => {
    requests.push(request)
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-unstage.prepare") {
      socket.end(message("git-unstage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    for (const status of [
      "recording_authority",
      "host_adapter_validating",
      "effect_observed_not_verified",
      "verifying",
    ] as const) {
      socket.write(message("git-unstage.progress", requestId, "progress", progress(status, requestId)))
    }
    socket.end(message("git-unstage.terminal", requestId, "result", verifiedResult(requestId)))
  })
  const client = createAstraGitUnstageClient(fixture.environment, sessionID)

  try {
    expect(fixture.connections()).toBe(0)
    await client.prepare()
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
    expect(requests).toHaveLength(2)
    expect(Object.keys(requests[0] ?? {}).sort()).toEqual([
      "method",
      "requestId",
      "schemaVersion",
      "sessionID",
      "token",
    ])
    expect(Object.keys(requests[1] ?? {}).sort()).toEqual([
      "decision",
      "method",
      "proposalID",
      "requestId",
      "schemaVersion",
      "sessionID",
      "token",
    ])
    expect(JSON.stringify(requests)).not.toContain("workspaceRoot")
    expect(JSON.stringify(requests)).not.toContain("argv")
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("rejects out-of-order progress and a terminal not bound to the observed receipt", async () => {
  let attempt = 0
  const fixture = await controlFixture((socket, request) => {
    attempt++
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-unstage.prepare") {
      socket.end(message("git-unstage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    if (attempt === 2) {
      socket.end(message("git-unstage.progress", requestId, "progress", progress("host_adapter_validating", requestId)))
      return
    }
    for (const status of [
      "recording_authority",
      "host_adapter_validating",
      "effect_observed_not_verified",
      "verifying",
    ] as const) {
      socket.write(message("git-unstage.progress", requestId, "progress", progress(status, requestId)))
    }
    socket.end(
      message("git-unstage.terminal", requestId, "result", {
        ...verifiedResult(requestId),
        receiptID: "90000000-0000-4000-8000-000000000009",
      }),
    )
  })
  const client = createAstraGitUnstageClient(fixture.environment, sessionID)

  try {
    await client.prepare()
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
    await client.prepare()
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "protocol_invalid" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("reports transport loss after approval instead of inventing a terminal", async () => {
  const fixture = await controlFixture((socket, request) => {
    const requestId = String(request.requestId)
    socket.write(message("accepted", requestId))
    if (request.method === "git-unstage.prepare") {
      socket.end(message("git-unstage.terminal", requestId, "result", preparedResult(requestId)))
      return
    }
    socket.destroy()
  })
  const client = createAstraGitUnstageClient(fixture.environment, sessionID)

  try {
    await client.prepare()
    expect(await rejected(client.decide(proposalID, "approve"))).toMatchObject({ code: "transport_failed" })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-git-unstage-client-"))
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
