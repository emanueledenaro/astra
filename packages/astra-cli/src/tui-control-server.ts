import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, lstat, realpath, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { join, resolve } from "node:path"
import {
  parseGitControlInspectionSummary,
  type GitControlInspectionBlockReason,
  type GitControlInspectionSummary,
} from "@astra/domain/git-control-inspection"

const requestLimitBytes = 2_048
const maximumRequestsPerSession = 1_024
const maximumObservedEntries = 10_000
const defaultInspectionTimeoutMs = 30_000
const socketFilename = "control.sock"
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^sha256:[0-9a-f]{64}$/

type GitInspectRequest = Readonly<{
  schemaVersion: 1
  method: "git.inspect"
  requestId: string
  sessionID: string
  token: string
}>

export type AstraTuiControlServer = Readonly<{
  socketPath: string
  sessionID: string
  token: string
  close: () => Promise<void>
}>

export type AstraTuiControlServerInput = Readonly<{
  directory: string
  workspaceRoot: string
  sessionID: string
}>

export type AstraTuiControlServerDependencies = Readonly<{
  inspectGitWorkspace: (workspaceRoot: string) => Promise<unknown>
  inspectionTimeoutMs?: number
}>

/**
 * Exposes one session-bound read-only Git observation over a private Unix
 * socket. The request protocol has no workspace-path field by design.
 */
export async function startAstraTuiControlServer(
  input: AstraTuiControlServerInput,
  dependencies: AstraTuiControlServerDependencies = {
    async inspectGitWorkspace(workspaceRoot) {
      const git = await import("@astra/git")
      return git.inspectGitWorkspace(workspaceRoot)
    },
  },
): Promise<AstraTuiControlServer> {
  const directory = await requirePrivateDirectory(input.directory)
  if (!uuidPattern.test(input.sessionID)) throw new Error("The Astra control session identifier is invalid")
  const socketPath = join(directory, socketFilename)
  if (Buffer.byteLength(socketPath) > 100) throw new Error("The Astra control socket path is too long")
  if (await pathExists(socketPath)) throw new Error("The Astra control socket path already exists")

  const token = randomBytes(32).toString("base64url")
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const usedRequestIDs = new Set<string>()
  let activeRequestID: string | undefined
  let cancelActiveInspection: (() => void) | undefined
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
        const accepted = await write(socket, encodeAccepted(request.requestId))
        if (!accepted) {
          socket.destroy()
          return
        }
        if (usedRequestIDs.has(request.requestId)) {
          socket.end(encodeTerminal(request.requestId, blocked("request_replayed")))
          return
        }
        if (usedRequestIDs.size >= maximumRequestsPerSession) {
          socket.end(encodeTerminal(request.requestId, blocked("control_limit_reached")))
          return
        }
        usedRequestIDs.add(request.requestId)
        if (activeRequestID) {
          socket.end(encodeTerminal(request.requestId, blocked("control_busy")))
          return
        }

        activeRequestID = request.requestId
        ownedRequestID = request.requestId
        const inspection = runBoundedInspection(
          () => dependencies.inspectGitWorkspace(input.workspaceRoot),
          dependencies.inspectionTimeoutMs ?? defaultInspectionTimeoutMs,
        )
        cancelActiveInspection = inspection.cancel
        const result = await inspection.result
        cancelActiveInspection = undefined
        if (!accepting || activeRequestID !== request.requestId || result.status === "cancelled") return
        const summary =
          result.status === "timed_out"
            ? blocked("inspection_timed_out")
            : summarizeInspection(result.status === "complete" ? result.value : null, input.workspaceRoot)
        activeRequestID = undefined
        socket.end(encodeTerminal(request.requestId, summary))
      })
      .catch(() => {
        if (activeRequestID === ownedRequestID) activeRequestID = undefined
        socket.destroy()
      })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  server.maxConnections = 16

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
      cancelActiveInspection?.()
      cancelActiveInspection = undefined
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
      await Promise.allSettled(pending)
      await rm(socketPath, { force: true })
    },
  }
}

function receiveRequest(socket: Socket) {
  return new Promise<GitInspectRequest | null>((complete) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (request: GitInspectRequest | null) => {
      if (settled) return
      settled = true
      complete(request)
    }

    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > requestLimitBytes) {
        socket.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
      const input = Buffer.concat(chunks).toString("utf8")
      if (!input.includes("\n")) return
      socket.off("data", onData)
      finish(parseRequest(input))
    }
    socket.on("data", onData)
    socket.once("error", () => finish(null))
    socket.once("end", () => finish(null))
    socket.once("close", () => finish(null))
  })
}

function parseRequest(input: string): GitInspectRequest | null {
  if (!input.endsWith("\n") || input.slice(0, -1).includes("\n")) return null
  try {
    const value: unknown = JSON.parse(input.slice(0, -1))
    const record = exactRecord(value, ["schemaVersion", "method", "requestId", "sessionID", "token"])
    if (
      !record ||
      record.schemaVersion !== 1 ||
      record.method !== "git.inspect" ||
      typeof record.requestId !== "string" ||
      !uuidPattern.test(record.requestId) ||
      typeof record.sessionID !== "string" ||
      !uuidPattern.test(record.sessionID) ||
      typeof record.token !== "string" ||
      !tokenPattern.test(record.token)
    ) {
      return null
    }
    return {
      schemaVersion: 1,
      method: "git.inspect",
      requestId: record.requestId,
      sessionID: record.sessionID,
      token: record.token,
    }
  } catch {
    return null
  }
}

function authorized(request: GitInspectRequest, sessionID: string, token: string) {
  return sameSecret(request.sessionID, sessionID) && sameSecret(request.token, token)
}

function runBoundedInspection(operation: () => Promise<unknown>, timeoutMs: number) {
  const duration = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultInspectionTimeoutMs
  let cancel!: () => void
  let timeout: ReturnType<typeof setTimeout> | undefined
  const cancelled = new Promise<{ status: "cancelled" }>((complete) => {
    cancel = () => complete({ status: "cancelled" })
  })
  const timedOut = new Promise<{ status: "timed_out" }>((complete) => {
    timeout = setTimeout(() => complete({ status: "timed_out" }), duration)
  })
  const execution = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ status: "complete" as const, value }),
      () => ({ status: "failed" as const }),
    )
  return {
    cancel,
    result: Promise.race([execution, timedOut, cancelled]).finally(() => {
      if (timeout) clearTimeout(timeout)
    }),
  }
}

function summarizeInspection(input: unknown, workspaceRoot: string): GitControlInspectionSummary {
  try {
    return unsafeSummarizeInspection(input, workspaceRoot)
  } catch {
    return blocked("inspection_failed")
  }
}

function unsafeSummarizeInspection(input: unknown, workspaceRoot: string): GitControlInspectionSummary {
  const record = plainRecord(input)
  if (!record || !validCommonInspection(record, workspaceRoot)) return blocked("inspection_failed")
  if (record.status === "blocked") return blocked(mapBlockedReason(record.reason))
  if (record.status !== "complete") return blocked("inspection_failed")

  const staged = boundedArray(record.staged)
  const unstaged = boundedArray(record.unstaged)
  const untracked = boundedArray(record.untracked)
  const conflicts = boundedArray(record.conflicts)
  const diff = plainRecord(record.diff)
  if (
    !staged ||
    !unstaged ||
    !untracked ||
    !conflicts ||
    !isBoundedCount(record.entryCount) ||
    record.entryCount < Math.max(staged.length, unstaged.length, untracked.length, conflicts.length) ||
    !isDigest(record.outputDigest) ||
    !isDigest(record.reportDigest) ||
    !diff ||
    diff.source !== "status_porcelain_v2" ||
    diff.format !== "metadata_only" ||
    diff.renames !== "disabled" ||
    diff.durability !== "ephemeral" ||
    diff.verification !== "not_verified" ||
    diff.untrackedContent !== "not_inspected" ||
    diff.conflictContent !== "not_inspected" ||
    diff.observationDigest !== record.outputDigest
  ) {
    return blocked("inspection_failed")
  }

  const summary = {
    schemaVersion: 1,
    status: "complete",
    mode: "bounded_read_only",
    verification: "not_verified",
    baseline: "not_captured",
    activationAllowed: false,
    submodules: "not_inspected",
    counts: {
      total: record.entryCount,
      staged: staged.length,
      unstaged: unstaged.length,
      untracked: untracked.length,
      conflicts: conflicts.length,
    },
    observationDigest: record.outputDigest,
    reportDigest: record.reportDigest,
  } as const
  const parsed = parseGitControlInspectionSummary(summary)
  return parsed.ok ? parsed.value : blocked("inspection_failed")
}

function validCommonInspection(input: Readonly<Record<string, unknown>>, workspaceRoot: string) {
  return (
    input.mode === "bounded_read_only" &&
    input.baseline === "not_captured" &&
    input.activationAllowed === false &&
    input.verification === "not_verified" &&
    input.submodules === "not_inspected" &&
    input.workspaceRoot === workspaceRoot
  )
}

function blocked(reason: GitControlInspectionBlockReason): GitControlInspectionSummary {
  return {
    schemaVersion: 1,
    status: "blocked",
    mode: "bounded_read_only",
    verification: "not_verified",
    baseline: "not_captured",
    activationAllowed: false,
    submodules: "not_inspected",
    reason,
  }
}

function mapBlockedReason(input: unknown): GitControlInspectionBlockReason {
  if (input === "unsupported_platform") return "unsupported_platform"
  if (
    input === "workspace_identity_changed" ||
    input === "git_metadata_identity_changed" ||
    input === "git_ephemeral_identity_changed" ||
    input === "observation_changed"
  ) {
    return "observation_changed"
  }
  if (
    input === "boundary_entry_limit_exceeded" ||
    input === "boundary_time_limit_exceeded" ||
    input === "git_process_timeout" ||
    input === "git_stdout_limit_exceeded" ||
    input === "git_stderr_limit_exceeded" ||
    input === "git_entry_limit_exceeded"
  ) {
    return "inspection_limit_reached"
  }
  if (
    input === "git_binary_untrusted" ||
    input === "sandbox_binary_untrusted" ||
    input === "sandbox_profile_rejected" ||
    input === "developer_directory_untrusted"
  ) {
    return "git_unavailable"
  }
  if (
    input === "git_commondir_unsupported" ||
    input === "git_alternates_unsupported" ||
    input === "git_metadata_symlink" ||
    input === "git_worktree_metadata_unsupported" ||
    input === "git_modules_metadata_unsupported" ||
    input === "ancestor_git_repository" ||
    input === "nested_git_repository" ||
    input === "git_index_assume_unchanged" ||
    input === "git_index_skip_worktree" ||
    input === "git_index_fsmonitor_valid" ||
    input === "git_index_fsmonitor_uninspectable" ||
    input === "submodules_uninspected"
  ) {
    return "repository_unsupported"
  }
  if (typeof input === "string" && (input.startsWith("workspace_") || input.startsWith("git_metadata_"))) {
    return "workspace_unavailable"
  }
  return "inspection_failed"
}

function encodeAccepted(requestId: string) {
  return JSON.stringify({ schemaVersion: 1, type: "accepted", requestId }) + "\n"
}

function encodeTerminal(requestId: string, summary: GitControlInspectionSummary) {
  return JSON.stringify({ schemaVersion: 1, type: "terminal", requestId, summary }) + "\n"
}

function write(socket: Socket, value: string) {
  return new Promise<boolean>((complete) => {
    socket.write(value, (error) => complete(error === undefined || error === null))
  })
}

function listen(server: Server, socketPath: string) {
  return new Promise<void>((complete, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(socketPath, () => {
      server.off("error", onError)
      server.on("error", () => {})
      complete()
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>((complete) => server.close(() => complete()))
}

async function requirePrivateDirectory(input: string) {
  const directory = resolve(input)
  const [canonical, facts] = await Promise.all([realpath(directory), lstat(directory)])
  const owner = process.getuid?.()
  if (
    owner === undefined ||
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    facts.uid !== owner ||
    (facts.mode & 0o077) !== 0
  ) {
    throw new Error("The Astra control directory is not private")
  }
  return canonical
}

async function pathExists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false
    throw error
  }
}

function exactRecord(input: unknown, fields: ReadonlyArray<string>) {
  const record = plainRecord(input)
  if (
    !record ||
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    return null
  }
  return Object.keys(record).some((field) => !fields.includes(field)) ? null : record
}

function plainRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    record[key] = descriptor.value
  }
  return record
}

function boundedArray(input: unknown): ReadonlyArray<unknown> | null {
  return Array.isArray(input) && input.length <= maximumObservedEntries ? input : null
}

function isBoundedCount(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= maximumObservedEntries
}

function isDigest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}

function sameSecret(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
