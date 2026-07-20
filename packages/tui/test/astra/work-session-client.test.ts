import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import {
  createAstraWorkSessionEvent,
  makeAstraWorkSessionEvent,
  projectAstraWorkSessionEvent,
} from "@astra/domain/work-session"
import { createAstraWorkSessionClient } from "../../src/astra/work-session-client"

const authoritySessionID = "00000000-0000-4000-8000-000000000001"

test("is lazy and renders only parent snapshots and consecutive events", async () => {
  const [initial, event, next] = chain()
  const fixture = await controlFixture((socket, request) => {
    if (request.method === "work-session.snapshot") return snapshotExchange(socket, request.requestId, initial)
    socket.write(frame("accepted", request.requestId))
    socket.write(snapshotFrame(request.requestId, initial))
    socket.write(eventFrame(request.requestId, event, next))
  })
  const client = createAstraWorkSessionClient(fixture.environment, authoritySessionID)
  const states: unknown[] = []
  const abort = new AbortController()
  try {
    expect(fixture.connections()).toBe(0)
    const snapshot = await client.snapshot()
    expect(snapshot).toMatchObject({ status: "available", projection: { phase: "idle", sequence: 1 } })
    const subscription = client.subscribe((state) => {
      states.push(state)
      if (state.status === "available" && state.projection.sequence === 2) abort.abort()
    }, { signal: abort.signal })
    await subscription
    expect(states).toEqual([
      expect.objectContaining({ status: "available", projection: expect.objectContaining({ sequence: 1 }) }),
      expect.objectContaining({ status: "available", projection: expect.objectContaining({ sequence: 2, phase: "analyzing" }) }),
    ])
    expect(states.some((state) => (state as { status?: string }).status === "state_unavailable")).toBe(false)
  } finally {
    client.dispose()
    await fixture.close()
  }
})

test("fails closed on invalid order, digest, sequence, cross-session, and disconnect", async () => {
  const [initial, event, next] = chain()
  const cases: Array<(requestId: unknown) => string> = [
    (requestId) => snapshotFrame(requestId, initial),
    (requestId) => frame("accepted", requestId) + eventFrame(requestId, event, next),
    (requestId) => frame("accepted", requestId) + snapshotFrame(requestId, initial) + snapshotFrame(requestId, initial),
    (requestId) => frame("accepted", requestId) + snapshotFrame(requestId, initial) + eventFrame(requestId, { ...event, previousDigest: digest("f") }, next),
    (requestId) => frame("accepted", requestId) + snapshotFrame(requestId, initial) + eventFrame(requestId, event, { ...next, sessionID: "other-session" }),
    (requestId) => frame("accepted", requestId) + snapshotFrame(requestId, initial),
  ]

  for (const response of cases) {
    const fixture = await controlFixture((socket, request) => socket.end(response(request.requestId)))
    const client = createAstraWorkSessionClient(fixture.environment, authoritySessionID)
    const states: unknown[] = []
    try {
      const failure = await client.subscribe((state) => {
        states.push(state)
      }).then(() => null, (error) => error)
      expect(failure).toMatchObject({ code: expect.stringMatching(/protocol_invalid|transport_failed/) })
      expect(states.at(-1)).toMatchObject({ status: "state_unavailable" })
      expect(states.some((state) => (state as { phase?: string }).phase === "completed")).toBe(false)
    } finally {
      client.dispose()
      await fixture.close()
    }
  }
})

test("consumer failure and bounded backpressure become STATE UNAVAILABLE", async () => {
  const [initial] = chain()
  const fixture = await controlFixture((socket, request) => {
    if (request.method === "work-session.snapshot") return snapshotExchange(socket, request.requestId, initial)
    socket.write(frame("accepted", request.requestId))
    for (let index = 0; index < 40; index++) socket.write(snapshotFrame(request.requestId, initial))
  })
  const client = createAstraWorkSessionClient(fixture.environment, authoritySessionID, { maximumQueuedFrames: 4 })
  const states: unknown[] = []
  try {
    const failure = await client.subscribe(async (state) => {
      states.push(state)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }).then(() => null, (error) => error)
    expect(failure).toMatchObject({ code: "protocol_invalid" })
    expect(states.at(-1)).toMatchObject({ status: "state_unavailable", reason: "backpressure_overflow" })
  } finally {
    client.dispose()
    await fixture.close()
  }

  const callbackFixture = await controlFixture((socket, request) => {
    if (request.method === "work-session.snapshot") return snapshotExchange(socket, request.requestId, initial)
    socket.write(frame("accepted", request.requestId))
    socket.write(snapshotFrame(request.requestId, initial))
  })
  const callbackClient = createAstraWorkSessionClient(callbackFixture.environment, authoritySessionID)
  const callbackStates: unknown[] = []
  try {
    const failure = await callbackClient.subscribe((state) => {
      callbackStates.push(state)
      if (state.status === "available") throw new Error("consumer failed")
    }).then(() => null, (error) => error)
    expect(failure).toMatchObject({ code: "protocol_invalid" })
    expect(callbackStates.at(-1)).toMatchObject({ status: "state_unavailable", reason: "consumer_failed" })
  } finally {
    callbackClient.dispose()
    await callbackFixture.close()
  }
})

test("an active subscription does not block snapshot, decide, or cancel", async () => {
  const [initial] = chain()
  let subscription: Socket | undefined
  const methods: string[] = []
  const fixture = await controlFixture((socket, request) => {
    methods.push(String(request.method))
    if (request.method === "work-session.subscribe") {
      subscription = socket
      socket.write(frame("accepted", request.requestId))
      socket.write(snapshotFrame(request.requestId, initial))
      return
    }
    if (request.method === "work-session.snapshot") return snapshotExchange(socket, request.requestId, initial)
    socket.write(frame("accepted", request.requestId))
    socket.end(terminal(request.requestId, "request_complete"))
  })
  const client = createAstraWorkSessionClient(fixture.environment, authoritySessionID)
  const abort = new AbortController()
  try {
    await client.snapshot()
    const watching = client.subscribe(() => {}, { signal: abort.signal })
    await until(() => subscription !== undefined)
    const [snapshot, decision, cancellation] = await Promise.all([
      client.snapshot(),
      client.decide("decision-1", "approved"),
      client.cancel(),
    ])
    expect(snapshot.status).toBe("available")
    expect(decision.status).toBe("request_complete")
    expect(cancellation.status).toBe("request_complete")
    abort.abort()
    await watching
    expect(methods).toEqual(expect.arrayContaining([
      "work-session.subscribe",
      "work-session.snapshot",
      "work-session.decide",
      "work-session.cancel",
    ]))
  } finally {
    client.dispose()
    await fixture.close()
  }
})

function chain() {
  const created = createAstraWorkSessionEvent({
    sessionID: "work-session-1",
    workspaceRoot: "/private/tmp/astra-work-session",
    workspaceIdentity: { device: "1", inode: "2" },
    objective: "Observable work",
    intent: { summary: "Inspect", next: "Report" },
    observedAt: "2026-07-20T10:00:00.000Z",
    actor: { kind: "system", actorID: "astra-parent" },
  })
  if (!created.ok) throw new Error("fixture rejected")
  const initial = projectAstraWorkSessionEvent(null, created.value)
  if (!initial.ok) throw new Error("fixture rejected")
  const event = makeAstraWorkSessionEvent(initial.value, {
    observedAt: "2026-07-20T10:00:01.000Z",
    actor: { kind: "system", actorID: "astra-parent" },
    draft: { type: "phase.changed", payload: { phase: "analyzing" } },
  })
  if (!event.ok) throw new Error("fixture rejected")
  const next = projectAstraWorkSessionEvent(initial.value, event.value)
  if (!next.ok) throw new Error("fixture rejected")
  return [initial.value, event.value, next.value] as const
}

async function controlFixture(handler: (socket: Socket, request: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "astra-work-session-client-"))
  const socketPath = join(directory, "control.sock")
  let count = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    count += 1
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let buffered = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffered += chunk
      if (!buffered.endsWith("\n")) return
      const request: unknown = JSON.parse(buffered.slice(0, -1))
      if (typeof request !== "object" || request === null || Array.isArray(request)) return socket.destroy()
      handler(socket, request as Record<string, unknown>)
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

function snapshotExchange(socket: Socket, requestId: unknown, projection: ReturnType<typeof chain>[0]) {
  socket.write(frame("accepted", requestId))
  socket.write(snapshotFrame(requestId, projection))
  socket.end(terminal(requestId, "request_complete"))
}

function frame(type: "accepted", requestId: unknown) {
  return JSON.stringify({ schemaVersion: 1, type, requestId }) + "\n"
}

function snapshotFrame(requestId: unknown, projection: ReturnType<typeof chain>[0]) {
  return JSON.stringify({
    schemaVersion: 1,
    type: "work-session.snapshot",
    requestId,
    projection,
    cursor: cursor(projection),
  }) + "\n"
}

function eventFrame(requestId: unknown, event: ReturnType<typeof chain>[1], projection: ReturnType<typeof chain>[2]) {
  return JSON.stringify({
    schemaVersion: 1,
    type: "work-session.event",
    requestId,
    event,
    projection,
    cursor: cursor(projection),
  }) + "\n"
}

function terminal(requestId: unknown, status: "request_complete") {
  return JSON.stringify({ schemaVersion: 1, type: "work-session.terminal", requestId, status }) + "\n"
}

function cursor(projection: ReturnType<typeof chain>[0] | ReturnType<typeof chain>[2]) {
  return {
    sequence: projection.sequence,
    lastEventDigest: projection.lastEventDigest,
    projectionDigest: projection.projectionDigest,
  }
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
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

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("condition not met")
}
