import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { AstraControlClientError, createAstraGitInspectionClient } from "../../src/astra/control-client"

test("stays disconnected until inspect and accepts only accepted-then-terminal", async () => {
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
    socket.end(message("terminal", request.requestId, completeSummary))
  })
  const client = createAstraGitInspectionClient(fixture.environment, sessionID)
  const states: string[] = []

  try {
    expect(fixture.connections()).toBe(0)
    const result = await client.inspect({ onAccepted: () => states.push("running") })
    states.push(result.summary.status)
    expect(states).toEqual(["running", "complete"])
    expect(result.summary).toEqual(completeSummary)
    expect(fixture.connections()).toBe(1)
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("fails closed when terminal arrives before accepted", async () => {
  const fixture = await controlFixture((socket, request) => {
    socket.end(message("terminal", request.requestId, completeSummary))
  })
  const client = createAstraGitInspectionClient(fixture.environment, sessionID)

  try {
    const failure: unknown = await client.inspect().then(
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

test("contains an onAccepted callback failure and fails closed", async () => {
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
    socket.end(message("terminal", request.requestId, completeSummary))
  })
  const client = createAstraGitInspectionClient(fixture.environment, sessionID)

  try {
    const failure: unknown = await client
      .inspect({
        onAccepted() {
          throw new Error("consumer callback failed")
        },
      })
      .then(
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

test("keeps one request in flight and validates blocked timeout summaries", async () => {
  let terminal!: () => void
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
    terminal = () => socket.end(message("terminal", request.requestId, timeoutSummary))
  })
  const client = createAstraGitInspectionClient(fixture.environment, sessionID)
  let accepted!: () => void
  const didAccept = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const first = client.inspect({ onAccepted: accepted })
    await didAccept
    const busy: unknown = await client.inspect().then(
      () => null,
      (error: unknown) => error,
    )
    expect(busy).toMatchObject({ code: "busy" })
    terminal()
    expect(await first).toMatchObject({ summary: timeoutSummary })
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("aborts an active socket and ignores any later response", async () => {
  let terminal!: () => void
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
    terminal = () => socket.end(message("terminal", request.requestId, completeSummary))
  })
  const client = createAstraGitInspectionClient(fixture.environment, sessionID)
  const abort = new AbortController()
  let accepted!: () => void
  const didAccept = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const request = client.inspect({ signal: abort.signal, onAccepted: accepted })
    await didAccept
    abort.abort()
    const failure: unknown = await request.then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: "cancelled" })
    terminal()
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("keeps cancellation scoped when dispose and inspect run synchronously", async () => {
  const fixture = await controlFixture((socket, request) => {
    socket.write(message("accepted", request.requestId))
  })
  const client = createAstraGitInspectionClient(fixture.environment, sessionID, { responseTimeoutMs: 500 })
  let accepted!: () => void
  const didAccept = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const first = client.inspect()
    client.dispose()
    const second = client.inspect({ onAccepted: accepted })

    expect(await rejected(first)).toMatchObject({ code: "cancelled" })
    await didAccept
    expect(fixture.openSockets()).toBe(1)
    client.dispose()
    expect(await rejected(second)).toMatchObject({ code: "cancelled" })
    await waitFor(() => fixture.openSockets() === 0)
  } finally {
    client.dispose()
    await fixture.close()
  }
})

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-tui-control-"))
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
    openSockets: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function rejected<T>(promise: Promise<T>) {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 500
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state")
    await Bun.sleep(5)
  }
}

function message(type: "accepted" | "terminal", requestId: unknown, summary?: unknown) {
  return JSON.stringify({ schemaVersion: 1, type, requestId, ...(summary ? { summary } : {}) }) + "\n"
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

const completeSummary = {
  schemaVersion: 1,
  status: "complete",
  mode: "bounded_read_only",
  verification: "not_verified",
  baseline: "not_captured",
  activationAllowed: false,
  submodules: "not_inspected",
  counts: { total: 1, staged: 0, unstaged: 1, untracked: 0, conflicts: 0 },
  observationDigest: `sha256:${"a".repeat(64)}`,
  reportDigest: `sha256:${"b".repeat(64)}`,
} as const

const timeoutSummary = {
  schemaVersion: 1,
  status: "blocked",
  mode: "bounded_read_only",
  verification: "not_verified",
  baseline: "not_captured",
  activationAllowed: false,
  submodules: "not_inspected",
  reason: "inspection_timed_out",
} as const
