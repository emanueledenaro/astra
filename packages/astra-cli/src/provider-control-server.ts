import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, lstat, realpath, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { join, resolve } from "node:path"
import {
  parseProviderControlRequest,
  providerControlRequestWireLimitBytes,
  providerControlResponseWireLimitBytes,
  type ProviderControlRequest,
  type ProviderTurnProgress,
} from "@astra/domain/provider-control"
import type { AstraProviderControl } from "./provider-control"

const maximumRequestsPerSession = 64
const requestTimeoutMilliseconds = 35_000
const socketFilename = "provider.sock"
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export type AstraProviderControlServer = Readonly<{
  socketPath: string
  sessionID: string
  token: string
  close: () => Promise<void>
}>

export type AstraProviderControlServerInput = Readonly<{
  directory: string
  sessionID: string
  control: AstraProviderControl
}>

/** Exposes the parent provider control over one dedicated private Unix socket. */
export async function startAstraProviderControlServer(
  input: AstraProviderControlServerInput,
): Promise<AstraProviderControlServer> {
  const directory = await requirePrivateDirectory(input.directory)
  if (!uuidPattern.test(input.sessionID)) throw new Error("The Astra provider session identifier is invalid")
  const socketPath = join(directory, socketFilename)
  if (Buffer.byteLength(socketPath) > 100) throw new Error("The Astra provider socket path is too long")
  if (await pathExists(socketPath)) throw new Error("The Astra provider socket path already exists")

  const token = randomBytes(32).toString("base64url")
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const usedRequestIDs = new Set<string>()
  const prepared = new Map<string, string>()
  let activeRequestID: string | undefined
  let accepting = true

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let ownedRequestID: string | undefined
    sockets.add(socket)
    socket.setTimeout(5_000, () => socket.destroy())
    socket.once("close", () => sockets.delete(socket))

    const task = receiveRequest(socket)
      .then(async (request) => {
        if (!accepting || !request || !authorized(request, input.sessionID, token)) {
          socket.end()
          return
        }
        socket.setTimeout(0)
        if (!(await write(socket, encode({ schemaVersion: 1, type: "accepted", requestId: request.requestId })))) {
          socket.destroy()
          return
        }
        if (usedRequestIDs.has(request.requestId)) {
          socket.end(blocked(request, "request_replayed"))
          return
        }
        if (usedRequestIDs.size >= maximumRequestsPerSession) {
          socket.end(blocked(request, "control_limit_reached"))
          return
        }
        usedRequestIDs.add(request.requestId)
        if (activeRequestID) {
          socket.end(blocked(request, "control_busy"))
          return
        }
        activeRequestID = request.requestId
        ownedRequestID = request.requestId
        await handleRequest(socket, request, input.control, prepared)
        if (activeRequestID === request.requestId) activeRequestID = undefined
      })
      .catch(() => {
        if (activeRequestID === ownedRequestID) activeRequestID = undefined
        socket.destroy()
      })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  server.maxConnections = 8

  try {
    await listen(server, socketPath)
    await chmod(socketPath, 0o600)
  } catch (error) {
    if (server.listening) await closeServer(server)
    await rm(socketPath, { force: true })
    throw error
  }

  let closed = false
  return {
    socketPath,
    sessionID: input.sessionID,
    token,
    async close() {
      if (closed) return
      closed = true
      accepting = false
      sockets.forEach((socket) => socket.destroy())
      await closeServer(server)
      await Promise.allSettled(pending)
      await rm(socketPath, { force: true })
    },
  }
}

async function handleRequest(
  socket: Socket,
  request: ProviderControlRequest,
  control: AstraProviderControl,
  prepared: Map<string, string>,
) {
  if (request.method === "provider.catalog") {
    const result = control.catalog()
    socket.end(
      encode(
        result.status === "available"
          ? { schemaVersion: 1, requestId: request.requestId, status: "available", catalog: result.catalog }
          : { schemaVersion: 1, requestId: request.requestId, status: "unavailable", reason: result.reason },
      ),
    )
    return
  }
  if (request.method === "provider.turn.prepare") {
    const outcome = await bounded(() => control.prepare(request.modelID, request.userText))
    const result = outcome ?? { status: "blocked" as const, reason: "control_unavailable" as const }
    if (result.status === "prepared") prepared.set(result.preview.proposalID, result.preview.operationID)
    socket.end(encode({ schemaVersion: 1, requestId: request.requestId, ...result }))
    return
  }

  const operationID = prepared.get(request.proposalID)
  if (!operationID) {
    socket.end(
      encode({
        schemaVersion: 1,
        requestId: request.requestId,
        proposalID: request.proposalID,
        status: "blocked",
        reason: "proposal_unknown",
      }),
    )
    return
  }
  prepared.delete(request.proposalID)
  const task = control.decide(request.proposalID, request.decision, (progress) => {
    void write(socket, encode({ schemaVersion: 1, requestId: request.requestId, ...progress } satisfies ProviderTurnProgress))
  })
  const result = await bounded(() => task)
  if (result) {
    socket.end(encode({ schemaVersion: 1, requestId: request.requestId, ...result }))
    return
  }
  socket.end(
    encode(
      request.decision === "approve"
        ? {
            schemaVersion: 1,
            requestId: request.requestId,
            proposalID: request.proposalID,
            operationID,
            status: "reconciliation_required",
            receiptID: null,
            reason: "client_disconnected_after_approval",
          }
        : {
            schemaVersion: 1,
            requestId: request.requestId,
            proposalID: request.proposalID,
            status: "blocked",
            reason: "control_failed",
          },
    ),
  )
  await task.catch(() => undefined)
}

function receiveRequest(socket: Socket) {
  return new Promise<ProviderControlRequest | null>((complete) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (request: ProviderControlRequest | null) => {
      if (settled) return
      settled = true
      complete(request)
    }
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > providerControlRequestWireLimitBytes) {
        socket.destroy()
        finish(null)
        return
      }
      chunks.push(Buffer.from(chunk))
      const value = Buffer.concat(chunks).toString("utf8")
      if (!value.includes("\n")) return
      socket.off("data", onData)
      if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) return finish(null)
      try {
        finish(parseProviderControlRequest(JSON.parse(value.slice(0, -1))))
      } catch {
        finish(null)
      }
    }
    socket.on("data", onData)
    socket.once("error", () => finish(null))
    socket.once("end", () => finish(null))
    socket.once("close", () => finish(null))
  })
}

function blocked(request: ProviderControlRequest, reason: string) {
  if (request.method === "provider.catalog") {
    return encode({ schemaVersion: 1, requestId: request.requestId, status: "unavailable", reason: "control_unavailable" })
  }
  if (request.method === "provider.turn.prepare") {
    return encode({
      schemaVersion: 1,
      requestId: request.requestId,
      status: "blocked",
      reason: reason === "control_limit_reached" ? "control_limit_reached" : "control_busy",
    })
  }
  return encode({
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    status: "blocked",
    reason: reason === "request_replayed" ? "proposal_replayed" : "control_busy",
  })
}

function bounded<Value>(operation: () => Promise<Value>) {
  return new Promise<Value | null>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, requestTimeoutMilliseconds)
    timer.unref()
    void operation().then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

function authorized(request: ProviderControlRequest, sessionID: string, token: string) {
  return sameSecret(request.sessionID, sessionID) && sameSecret(request.token, token)
}

function sameSecret(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

function encode(input: unknown) {
  const encoded = `${JSON.stringify(input)}\n`
  if (Buffer.byteLength(encoded) > providerControlResponseWireLimitBytes) {
    throw new Error("The Astra provider control response exceeds the wire limit")
  }
  return encoded
}

function write(socket: Socket, input: string) {
  return new Promise<boolean>((resolve) => {
    if (socket.destroyed || !socket.writable) return resolve(false)
    socket.write(input, (error) => resolve(!error && !socket.destroyed))
  })
}

async function requirePrivateDirectory(input: string) {
  const expected = resolve(input)
  const [entry, canonical] = await Promise.all([lstat(expected), realpath(expected)])
  if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== expected) {
    throw new Error("The Astra provider authority directory is invalid")
  }
  if ((entry.mode & 0o077) !== 0) throw new Error("The Astra provider authority directory must be private")
  return canonical
}

async function pathExists(path: string) {
  return Boolean(await lstat(path).catch(() => null))
}

function listen(server: Server, socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}
