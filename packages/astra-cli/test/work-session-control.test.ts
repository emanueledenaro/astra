import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { expect, test } from "bun:test"
import {
  createAstraWorkSessionEvent,
  makeAstraWorkSessionEvent,
  projectAstraWorkSessionEvent,
} from "@astra/domain/work-session"
import { cursorForAstraWorkSessionProjection } from "@astra/domain/work-session-control"
import type { AstraDurableWorkSession } from "@astra/runtime/work-session-store"
import { createAstraWorkSessionControlHandler } from "../src/work-session-control-handler"
import { startAstraTuiControlServer } from "../src/tui-control-server"
import type { AstraWorkSessionControl } from "../src/work-session-control"
import { createAstraWorkSessionControl } from "../src/work-session-control"

const authoritySessionID = "00000000-0000-4000-8000-000000000001"
const token = "x".repeat(43)

test("handler rejects wrong authority and replay without invoking parent control", async () => {
  let snapshots = 0
  const control = fixtureControl({ snapshot: async () => (snapshots++, record()) })
  const handler = createAstraWorkSessionControlHandler({ sessionID: authoritySessionID, token, control })
  const request = authorityRequest("work-session.snapshot")

  expect(handler.dispatch({ ...request, token: "y".repeat(43) }).status).toBe("rejected")
  expect(snapshots).toBe(0)
  const first = handler.dispatch(request)
  expect(first.status).toBe("accepted")
  if (first.status !== "accepted") return
  await first.run(new AbortController().signal, async () => {})
  expect(snapshots).toBe(1)
  const replay = handler.dispatch(request)
  expect(replay.status).toBe("accepted")
  if (replay.status !== "accepted") return
  expect(await replay.run(new AbortController().signal, async () => {})).toMatchObject({ status: "blocked", reason: "request_replayed" })
  expect(snapshots).toBe(1)
})

test("actual control socket streams parent state while decide and cancel remain concurrent and exact-once", async () => {
  const directory = await mkdtemp("/tmp/astra-ws-control-")
  await chmod(directory, 0o700)
  const calls = { decide: 0, cancel: 0 }
  let release!: () => void
  const watching = new Promise<void>((resolve) => {
    release = resolve
  })
  const control = fixtureControl({
    subscribe: async (_cursor, signal) => {
      await Promise.race([watching, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))])
    },
    decide: async () => {
      calls.decide += 1
    },
    cancel: async () => {
      calls.cancel += 1
    },
  })
  const server = await startAstraTuiControlServer(
    {
      directory,
      workspaceRoot: "/private/tmp/astra-work-session",
      sessionID: authoritySessionID,
      workSessionControl: control,
    },
    { async inspectGitWorkspace() { return null } },
  )
  const sockets = new Set<Socket>()
  try {
    const subscription = await open(server.socketPath, {
      ...authorityRequest("work-session.subscribe"),
      token: server.token,
      cursor: cursorForAstraWorkSessionProjection(record().projection),
    })
    sockets.add(subscription.socket)
    expect(subscription.frames.map((frame) => frame.type)).toEqual(["accepted", "work-session.snapshot"])

    const [snapshot, decision, cancellation] = await Promise.all([
      exchange(server.socketPath, { ...authorityRequest("work-session.snapshot"), token: server.token }),
      exchange(server.socketPath, {
        ...authorityRequest("work-session.decide"),
        token: server.token,
        decisionID: "decision-1",
        outcome: "approved",
      }),
      exchange(server.socketPath, { ...authorityRequest("work-session.cancel"), token: server.token }),
    ])
    expect(snapshot.map((frame) => frame.type)).toEqual(["accepted", "work-session.snapshot", "work-session.terminal"])
    expect(decision.at(-1)).toMatchObject({ type: "work-session.terminal", status: "request_complete" })
    expect(cancellation.at(-1)).toMatchObject({ type: "work-session.terminal", status: "request_complete" })
    expect(calls).toEqual({ decide: 1, cancel: 1 })

    const unauthorized = await exchange(server.socketPath, { ...authorityRequest("work-session.snapshot"), token })
    expect(unauthorized).toEqual([])
    expect(calls).toEqual({ decide: 1, cancel: 1 })
    release()
  } finally {
    for (const socket of sockets) socket.destroy()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("parent adapter validates reconnect cursors and replays only new durable events", async () => {
  const initial = record()
  const advanced = advancedRecord(initial)
  let current: AstraDurableWorkSession = initial
  const control = createAstraWorkSessionControl("work-session-1", {
    async load() {
      return current
    },
    async decide() {},
    async cancel() {},
    pollIntervalMs: 1,
  })
  await expect(
    control.snapshot({ ...cursorForAstraWorkSessionProjection(initial.projection), projectionDigest: `sha256:${"f".repeat(64)}` }),
  ).rejects.toThrow()

  const abort = new AbortController()
  const observed: number[] = []
  const subscription = control.subscribe(
    cursorForAstraWorkSessionProjection(initial.projection),
    abort.signal,
    async (_event, projection) => {
      observed.push(projection.sequence)
      abort.abort()
    },
  )
  current = advanced
  await subscription
  expect(observed).toEqual([2])
})

function fixtureControl(overrides: Partial<AstraWorkSessionControl> = {}): AstraWorkSessionControl {
  return {
    async snapshot() {
      return record()
    },
    async subscribe(_cursor, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    },
    async decide() {},
    async cancel() {},
    ...overrides,
  }
}

function record() {
  const event = createAstraWorkSessionEvent({
    sessionID: "work-session-1",
    workspaceRoot: "/private/tmp/astra-work-session",
    workspaceIdentity: { device: "1", inode: "2" },
    objective: null,
    intent: { summary: "Workspace open", next: "Await objective" },
    observedAt: "2026-07-20T10:00:00.000Z",
    actor: { kind: "system", actorID: "astra-parent" },
  })
  if (!event.ok) throw new Error("fixture rejected")
  const projection = projectAstraWorkSessionEvent(null, event.value)
  if (!projection.ok) throw new Error("fixture rejected")
  return { projection: projection.value, events: [event.value] } as const
}

function advancedRecord(initial: ReturnType<typeof record>) {
  const event = makeAstraWorkSessionEvent(initial.projection, {
    observedAt: "2026-07-20T10:00:01.000Z",
    actor: { kind: "system", actorID: "astra-parent" },
    draft: { type: "phase.changed", payload: { phase: "analyzing" } },
  })
  if (!event.ok) throw new Error("fixture rejected")
  const projection = projectAstraWorkSessionEvent(initial.projection, event.value)
  if (!projection.ok) throw new Error("fixture rejected")
  return { projection: projection.value, events: [...initial.events, event.value] } as const
}

function authorityRequest(
  method: "work-session.snapshot" | "work-session.subscribe" | "work-session.decide" | "work-session.cancel",
) {
  return { schemaVersion: 1, method, requestId: randomUUID(), sessionID: authoritySessionID, token } as const
}

function exchange(socketPath: string, request: Readonly<Record<string, unknown>>) {
  return new Promise<Record<string, unknown>[]>((resolve) => {
    const socket = createConnection(socketPath)
    const frames: Record<string, unknown>[] = []
    let buffered = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) if (line) frames.push(JSON.parse(line))
    })
    socket.once("close", () => resolve(frames))
  })
}

function open(socketPath: string, request: Readonly<Record<string, unknown>>) {
  return new Promise<{ socket: Socket; frames: Record<string, unknown>[] }>((resolve) => {
    const socket = createConnection(socketPath)
    const frames: Record<string, unknown>[] = []
    let buffered = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) if (line) frames.push(JSON.parse(line))
      if (frames.length >= 2) resolve({ socket, frames })
    })
  })
}
