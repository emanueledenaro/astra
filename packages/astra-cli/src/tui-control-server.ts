import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, lstat, realpath, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { join, resolve } from "node:path"
import {
  parseGitControlInspectionSummary,
  type GitControlInspectionBlockReason,
  type GitControlInspectionSummary,
} from "@astra/domain/git-control-inspection"
import { parseGitUnstageControlRequest, type GitUnstageControlRequest } from "@astra/domain/git-unstage-control"
import { parseGitStageControlRequest, type GitStageControlRequest } from "@astra/domain/git-stage-control"
import {
  parseWorkspaceSearchControlRequest,
  type WorkspaceSearchControlRequest,
} from "@astra/domain/governed-workspace-search-control"
import {
  parseExtensionInventoryControlRequest,
  type ExtensionInventoryControlRequest,
} from "@astra/domain/extension-inventory-control"
import {
  parseMcpActivationControlRequest,
  type McpActivationControlRequest,
} from "@astra/domain/mcp-activation-control"
import {
  controlledWriteBoundaryLabel,
  controlledWriteNetworkWarning,
  parseControlledWriteDecisionRequest,
  parseControlledWriteDecisionResult,
  parseControlledWritePrepareRequest,
  parseControlledWritePrepareResult,
  parseControlledWriteProgress,
  type ControlledWriteDecisionRequest,
  type ControlledWriteDecisionResult,
  type ControlledWritePrepareRequest,
  type ControlledWritePrepareResult,
  type ControlledWriteProgress,
} from "@astra/domain/controlled-write-control"
import type {
  AstraControlledWriteControl,
  ControlledWriteDecisionResult as InternalControlledWriteDecisionResult,
  ControlledWritePrepareResult as InternalControlledWritePrepareResult,
  ControlledWriteProgress as InternalControlledWriteProgress,
} from "./controlled-write-control"
import {
  parseSkillControlRequest,
  parseSkillActivationDecisionResult,
  parseSkillActivationPrepareResult,
  parseSkillActivationProgress,
  parseSkillInventoryResult,
  type SkillActivationDecisionRequest,
  type SkillActivationDecisionResult,
  type SkillActivationPrepareResult,
  type SkillActivationProgress,
  type SkillControlRequest,
  type SkillInventoryResult,
} from "../../astra-domain/src/skill-activation-control"
import { createAstraSkillActivationRegistration, type AstraSkillActivationControl } from "./skill-activation-control"
import type { AstraGitUnstageControl } from "./git-unstage-control"
import { createAstraGitUnstageControlHandler } from "./git-unstage-control-handler"
import { serveAstraGitUnstageControlRequest } from "./git-unstage-control-server-hook"
import type { AstraGitStageControl } from "./git-stage-control"
import { createAstraGitStageControlHandler } from "./git-stage-control-handler"
import { serveAstraGitStageControlRequest } from "./git-stage-control-server-hook"
import type { AstraGovernedWorkspaceSearchControl } from "./governed-workspace-search-control"
import { createAstraGovernedWorkspaceSearchControlHandler } from "./governed-workspace-search-control-handler"
import { serveAstraGovernedWorkspaceSearchControlRequest } from "./governed-workspace-search-control-server-hook"
import type { AstraExtensionInventoryControl } from "./extension-inventory-control"
import { createAstraExtensionInventoryControlHandler } from "./extension-inventory-control-handler"
import { serveAstraExtensionInventoryControlRequest } from "./extension-inventory-control-server-hook"
import type { AstraMcpActivationControl } from "./mcp-activation-control"
import { createAstraMcpActivationControlHandler } from "./mcp-activation-control-handler"
import { serveAstraMcpActivationControlRequest } from "./mcp-activation-control-server-hook"

const requestLimitBytes = 32 * 1_024
const maximumRequestsPerSession = 1_024
const maximumObservedEntries = 10_000
const defaultInspectionTimeoutMs = 30_000
const defaultControlledWriteTimeoutMs = 60_000
const defaultSkillActivationTimeoutMs = 60_000
const defaultExtensionInventoryTimeoutMs = 10_000
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

type ControlRequest =
  | GitInspectRequest
  | GitStageControlRequest
  | GitUnstageControlRequest
  | WorkspaceSearchControlRequest
  | ControlledWritePrepareRequest
  | ControlledWriteDecisionRequest
  | SkillControlRequest
  | ExtensionInventoryControlRequest
  | McpActivationControlRequest

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
  controlledWriteControl?: AstraControlledWriteControl
  gitStageControl?: AstraGitStageControl
  gitUnstageControl?: AstraGitUnstageControl
  skillActivationControl?: AstraSkillActivationControl
  governedWorkspaceSearchControl?: AstraGovernedWorkspaceSearchControl
  extensionInventoryControl?: AstraExtensionInventoryControl
  mcpActivationControl?: AstraMcpActivationControl
}>

export type AstraTuiControlServerDependencies = Readonly<{
  inspectGitWorkspace: (workspaceRoot: string) => Promise<unknown>
  inspectionTimeoutMs?: number
  controlledWriteTimeoutMs?: number
  skillActivationTimeoutMs?: number
  extensionInventoryTimeoutMs?: number
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
  const preparedOperations = new Map<string, string>()
  const preparedSkillOperations = new Map<string, string>()
  const skillRegistration = input.skillActivationControl
    ? createAstraSkillActivationRegistration(input.skillActivationControl)
    : undefined
  const gitUnstageHandler = input.gitUnstageControl
    ? createAstraGitUnstageControlHandler({ sessionID: input.sessionID, token, control: input.gitUnstageControl })
    : undefined
  const gitStageHandler = input.gitStageControl
    ? createAstraGitStageControlHandler({ sessionID: input.sessionID, token, control: input.gitStageControl })
    : undefined
  const workspaceSearchHandler = input.governedWorkspaceSearchControl
    ? createAstraGovernedWorkspaceSearchControlHandler({
        sessionID: input.sessionID,
        token,
        control: input.governedWorkspaceSearchControl,
      })
    : undefined
  const extensionInventoryHandler = input.extensionInventoryControl
    ? createAstraExtensionInventoryControlHandler({
        sessionID: input.sessionID,
        token,
        control: input.extensionInventoryControl,
        timeoutMs: dependencies.extensionInventoryTimeoutMs ?? defaultExtensionInventoryTimeoutMs,
      })
    : undefined
  const mcpActivationHandler = input.mcpActivationControl
    ? createAstraMcpActivationControlHandler({
        sessionID: input.sessionID,
        token,
        control: input.mcpActivationControl,
      })
    : undefined
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
        if (!accepting || !request) {
          socket.end()
          return
        }
        if (isWorkspaceSearchRequest(request)) {
          if (!workspaceSearchHandler) {
            socket.end()
            return
          }
          socket.setTimeout(0)
          await serveAstraGovernedWorkspaceSearchControlRequest(socket, request, workspaceSearchHandler)
          return
        }
        if (isGitUnstageRequest(request)) {
          if (!gitUnstageHandler) {
            socket.end()
            return
          }
          socket.setTimeout(0)
          await serveAstraGitUnstageControlRequest(socket, request, gitUnstageHandler)
          return
        }
        if (isGitStageRequest(request)) {
          if (!gitStageHandler) {
            socket.end()
            return
          }
          socket.setTimeout(0)
          await serveAstraGitStageControlRequest(socket, request, gitStageHandler)
          return
        }
        if (isExtensionInventoryRequest(request)) {
          if (!extensionInventoryHandler) {
            socket.end()
            return
          }
          socket.setTimeout(0)
          await serveAstraExtensionInventoryControlRequest(socket, request, extensionInventoryHandler)
          return
        }
        if (isMcpActivationRequest(request)) {
          if (!mcpActivationHandler) {
            socket.end()
            return
          }
          socket.setTimeout(0)
          await serveAstraMcpActivationControlRequest(socket, request, mcpActivationHandler)
          return
        }
        if (!authorized(request, input.sessionID, token)) {
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
          socket.end(encodeBlockedTerminal(request, "request_replayed"))
          return
        }
        if (usedRequestIDs.size >= maximumRequestsPerSession) {
          socket.end(encodeBlockedTerminal(request, "control_limit_reached"))
          return
        }
        usedRequestIDs.add(request.requestId)
        if (activeRequestID) {
          socket.end(encodeBlockedTerminal(request, "control_busy"))
          return
        }

        activeRequestID = request.requestId
        ownedRequestID = request.requestId
        if (isSkillRequest(request)) {
          await handleSkillActivationRequest(
            socket,
            request,
            skillRegistration,
            dependencies.skillActivationTimeoutMs ?? defaultSkillActivationTimeoutMs,
            preparedSkillOperations,
          )
          if (activeRequestID === request.requestId) activeRequestID = undefined
          return
        }
        if (request.method !== "git.inspect") {
          await handleControlledWriteRequest(
            socket,
            request,
            input.controlledWriteControl,
            dependencies.controlledWriteTimeoutMs ?? defaultControlledWriteTimeoutMs,
            preparedOperations,
          )
          if (activeRequestID === request.requestId) activeRequestID = undefined
          return
        }
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
      await mcpActivationHandler?.close()
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
      await Promise.race([Promise.allSettled(pending), boundedDelay(5_000)])
      await rm(socketPath, { force: true })
    },
  }
}

function receiveRequest(socket: Socket) {
  return new Promise<ControlRequest | null>((complete) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (request: ControlRequest | null) => {
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

function parseRequest(input: string): ControlRequest | null {
  if (!input.endsWith("\n") || input.slice(0, -1).includes("\n")) return null
  try {
    const value: unknown = JSON.parse(input.slice(0, -1))
    const gitStage = parseGitStageControlRequest(value)
    if (gitStage.ok) return gitStage.value
    const workspaceSearch = parseWorkspaceSearchControlRequest(value)
    if (workspaceSearch.ok) return workspaceSearch.value
    const extensionInventory = parseExtensionInventoryControlRequest(value)
    if (extensionInventory.ok) return extensionInventory.value
    const mcpActivation = parseMcpActivationControlRequest(value)
    if (mcpActivation.ok) return mcpActivation.value
    const gitUnstage = parseGitUnstageControlRequest(value)
    if (gitUnstage.ok) return gitUnstage.value
    const prepare = parseControlledWritePrepareRequest(value)
    if (prepare.ok) return prepare.value
    const decision = parseControlledWriteDecisionRequest(value)
    if (decision.ok) return decision.value
    const skill = parseSkillControlRequest(value)
    if (skill.ok) return skill.value
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

function authorized(request: ControlRequest, sessionID: string, token: string) {
  return sameSecret(request.sessionID, sessionID) && sameSecret(request.token, token)
}

function isGitUnstageRequest(request: ControlRequest): request is GitUnstageControlRequest {
  return request.method === "git-unstage.prepare" || request.method === "git-unstage.decide"
}

function isGitStageRequest(request: ControlRequest): request is GitStageControlRequest {
  return (
    request.method === "git-stage.inventory" ||
    request.method === "git-stage.prepare" ||
    request.method === "git-stage.decide"
  )
}

function isWorkspaceSearchRequest(request: ControlRequest): request is WorkspaceSearchControlRequest {
  return request.method === "search.prepare" || request.method === "search.decide"
}

function isExtensionInventoryRequest(request: ControlRequest): request is ExtensionInventoryControlRequest {
  return request.method === "extension-inventory.prepare" || request.method === "extension-inventory.decide"
}

function isMcpActivationRequest(request: ControlRequest): request is McpActivationControlRequest {
  return request.method === "mcp-activation.prepare" || request.method === "mcp-activation.decide" || request.method === "mcp-activation.stop"
}

function isSkillRequest(request: ControlRequest): request is SkillControlRequest {
  return request.method === "skill.inventory" || request.method === "skill.prepare" || request.method === "skill.decide"
}

async function handleControlledWriteRequest(
  socket: Socket,
  request: ControlledWritePrepareRequest | ControlledWriteDecisionRequest,
  control: AstraControlledWriteControl | undefined,
  timeoutMs: number,
  preparedOperations: Map<string, string>,
) {
  if (!control) {
    socket.end(encodeBlockedTerminal(request, "control_unavailable"))
    return
  }

  if (request.method === "controlled-write.prepare") {
    const operation = runBoundedOperation(() => control.prepare(), timeoutMs)
    const bounded = await operation.outcome
    const result =
      bounded.status === "complete"
        ? mapPrepareResult(request.requestId, bounded.value)
        : blockedPrepareResult(
            request.requestId,
            bounded.status === "timed_out" ? "control_response_timed_out" : "control_failed",
          )
    if (result.status === "prepared") {
      preparedOperations.set(result.preview.proposalID, result.preview.operationID)
    }
    socket.end(encodeControlledWriteTerminal(request.requestId, result))
    await operation.settled
    return
  }

  const operationID = preparedOperations.get(request.proposalID)
  const operation = runBoundedOperation(
    () =>
      control.decide(request.proposalID, request.decision, (progress) => {
        const publicProgress = mapProgress(request, operationID, progress)
        if (publicProgress) void write(socket, encodeControlledWriteProgress(request.requestId, publicProgress))
      }),
    timeoutMs,
  )
  const bounded = await operation.outcome
  const result =
    bounded.status === "complete"
      ? mapDecisionResult(request, bounded.value)
      : request.decision === "approve" && operationID
        ? reconciliationResult(request, operationID, "durable_state_unavailable")
        : blockedDecisionResult(
            request,
            bounded.status === "timed_out" ? "control_response_timed_out" : "control_failed",
          )
  socket.end(encodeControlledWriteTerminal(request.requestId, result))
  await operation.settled
  preparedOperations.delete(request.proposalID)
}

async function handleSkillActivationRequest(
  socket: Socket,
  request: SkillControlRequest,
  registration: ReturnType<typeof createAstraSkillActivationRegistration> | undefined,
  timeoutMs: number,
  preparedOperations: Map<string, string>,
) {
  if (!registration) {
    socket.end(encodeSkillTerminal(request.requestId, blockedSkillResult(request, "control_unavailable")))
    return
  }

  const operation = runBoundedOperation(
    () =>
      registration.handle(stripSkillAuthority(request), (progress) => {
        const operationID = request.method === "skill.decide" ? preparedOperations.get(request.proposalID) : undefined
        if (
          request.method !== "skill.decide" ||
          !operationID ||
          progress.requestId !== request.requestId ||
          progress.proposalID !== request.proposalID ||
          progress.operationID !== operationID
        )
          return
        const parsed = parseSkillActivationProgress(progress)
        if (parsed.ok) void write(socket, encodeSkillProgress(request.requestId, parsed.value))
      }),
    timeoutMs,
  )
  const bounded = await operation.outcome
  const result =
    bounded.status === "complete"
      ? requirePublicSkillResult(request, bounded.value, preparedOperations)
      : skillOperationUnavailable(
          request,
          preparedOperations,
          bounded.status === "timed_out" ? "control_response_timed_out" : "control_failed",
        )
  if (request.method === "skill.prepare" && result.status === "prepared") {
    preparedOperations.set(result.preview.proposalID, result.preview.operationID)
  }
  socket.end(encodeSkillTerminal(request.requestId, result))
  await operation.settled
  if (request.method === "skill.decide") preparedOperations.delete(request.proposalID)
}

function stripSkillAuthority(request: SkillControlRequest) {
  if (request.method === "skill.inventory") {
    return { method: request.method, requestId: request.requestId } as const
  }
  if (request.method === "skill.prepare") {
    return {
      method: request.method,
      requestId: request.requestId,
      inventoryID: request.inventoryID,
      candidateID: request.candidateID,
    } as const
  }
  return {
    method: request.method,
    requestId: request.requestId,
    proposalID: request.proposalID,
    decision: request.decision,
  } as const
}

function requirePublicSkillResult(
  request: SkillControlRequest,
  input: unknown,
  preparedOperations: Map<string, string>,
): SkillInventoryResult | SkillActivationPrepareResult | SkillActivationDecisionResult {
  if (request.method === "skill.inventory") {
    const parsed = parseSkillInventoryResult(input)
    return parsed.ok && parsed.value.requestId === request.requestId
      ? parsed.value
      : blockedSkillResult(request, "protocol_invalid")
  }
  if (request.method === "skill.prepare") {
    const parsed = parseSkillActivationPrepareResult(input)
    return parsed.ok && parsed.value.requestId === request.requestId
      ? parsed.value
      : blockedSkillResult(request, "protocol_invalid")
  }
  const parsed = parseSkillActivationDecisionResult(input)
  const operationID = preparedOperations.get(request.proposalID)
  if (
    parsed.ok &&
    parsed.value.requestId === request.requestId &&
    parsed.value.proposalID === request.proposalID &&
    (!("operationID" in parsed.value) || parsed.value.operationID === operationID)
  )
    return parsed.value
  return operationID
    ? skillReconciliation(request, operationID, "durable_state_unavailable")
    : blockedSkillResult(request, "protocol_invalid")
}

function skillOperationUnavailable(
  request: SkillControlRequest,
  preparedOperations: Map<string, string>,
  reason: "control_response_timed_out" | "control_failed",
): SkillInventoryResult | SkillActivationPrepareResult | SkillActivationDecisionResult {
  if (request.method !== "skill.decide") return blockedSkillResult(request, reason)
  const operationID = preparedOperations.get(request.proposalID)
  return operationID
    ? skillReconciliation(request, operationID, "durable_state_unavailable")
    : blockedSkillResult(request, "proposal_unknown")
}

function blockedSkillResult(
  request: SkillControlRequest,
  reason: string,
): SkillInventoryResult | SkillActivationPrepareResult | SkillActivationDecisionResult {
  const common = { schemaVersion: 1 as const, requestId: request.requestId, status: "blocked" as const, reason }
  return request.method === "skill.decide" ? { ...common, proposalID: request.proposalID } : common
}

function skillReconciliation(
  request: SkillActivationDecisionRequest,
  operationID: string,
  reason: "effect_unknown" | "durable_state_unavailable",
): SkillActivationDecisionResult {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    operationID,
    status: "reconciliation_required",
    reason,
    verification: "not_verified",
  }
}

function mapPrepareResult(
  requestId: string,
  input: InternalControlledWritePrepareResult,
): ControlledWritePrepareResult {
  if (input.status === "blocked") return blockedPrepareResult(requestId, input.reason)
  const candidate = {
    schemaVersion: 1,
    requestId,
    status: "prepared",
    preview: {
      schemaVersion: 1,
      operation: "controlled_write_create_only",
      operationID: input.preview.operationID,
      proposalID: input.preview.proposalID,
      expiresAt: input.preview.expiresAt,
      boundary: { mode: "host_no_sandbox", label: controlledWriteBoundaryLabel },
      resource: {
        kind: "workspace_relative_file",
        mode: "create_only",
        relativeTarget: input.preview.target,
        bytes: input.preview.bytes,
        contentDigest: input.preview.contentDigest,
      },
      capabilityDigest: input.preview.capabilityDigest,
      network: { mode: "host_unrestricted", warning: controlledWriteNetworkWarning },
      verification: "not_verified",
    },
  } as const
  const parsed = parseControlledWritePrepareResult(candidate)
  return parsed.ok ? parsed.value : blockedPrepareResult(requestId, "protocol_invalid")
}

function mapDecisionResult(
  request: ControlledWriteDecisionRequest,
  input: InternalControlledWriteDecisionResult,
): ControlledWriteDecisionResult {
  let candidate: unknown
  if (input.status === "blocked") return blockedDecisionResult(request, input.reason)
  if (input.status === "denied_without_workspace_effect") {
    candidate = decisionBinding(request, input.operationID, input.status)
  } else if (input.status === "failed_without_effect") {
    candidate = { ...decisionBinding(request, input.operationID, input.status), reason: input.reason }
  } else if (input.status === "reconciliation_required") {
    candidate = { ...decisionBinding(request, input.operationID, input.status), reason: input.reason }
  } else {
    candidate = {
      ...decisionBinding(request, input.operationID, "verified"),
      verification: "exact_readback",
      receiptID: input.receiptID,
      evidenceID: input.evidenceID,
      readback: {
        relativeTarget: input.relativeTarget,
        bytes: input.bytes,
        contentDigest: input.contentDigest,
      },
    }
  }
  const parsed = parseControlledWriteDecisionResult(candidate)
  if (parsed.ok) return parsed.value
  return input.status === "reconciliation_required" || request.decision === "approve"
    ? reconciliationResult(request, input.operationID, "durable_state_unavailable")
    : blockedDecisionResult(request, "protocol_invalid")
}

function mapProgress(
  request: ControlledWriteDecisionRequest,
  preparedOperationID: string | undefined,
  input: InternalControlledWriteProgress,
): ControlledWriteProgress | null {
  if (!preparedOperationID) return null
  const binding = {
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    operationID: preparedOperationID,
  } as const
  const candidate =
    input.status === "effect_observed_not_verified"
      ? {
          ...binding,
          status: input.status,
          verification: "not_verified",
          receiptID: input.receiptID,
          observation: {
            relativeTarget: input.relativeTarget,
            bytes: input.bytes,
            contentDigest: input.contentDigest,
          },
        }
      : {
          ...binding,
          status: input.status,
          verification: "not_verified",
        }
  if (input.status === "effect_observed_not_verified" && input.operationID !== preparedOperationID) return null
  const parsed = parseControlledWriteProgress(candidate)
  return parsed.ok ? parsed.value : null
}

function decisionBinding(request: ControlledWriteDecisionRequest, operationID: string, status: string) {
  return {
    schemaVersion: 1 as const,
    requestId: request.requestId,
    proposalID: request.proposalID,
    operationID,
    status,
  }
}

function blockedPrepareResult(requestId: string, reason: string): ControlledWritePrepareResult {
  const parsed = parseControlledWritePrepareResult({ schemaVersion: 1, requestId, status: "blocked", reason })
  if (!parsed.ok) throw new Error("Invalid controlled-write prepare terminal")
  return parsed.value
}

function blockedDecisionResult(request: ControlledWriteDecisionRequest, reason: string): ControlledWriteDecisionResult {
  const parsed = parseControlledWriteDecisionResult({
    schemaVersion: 1,
    requestId: request.requestId,
    proposalID: request.proposalID,
    status: "blocked",
    reason,
  })
  if (!parsed.ok) throw new Error("Invalid controlled-write decision terminal")
  return parsed.value
}

function reconciliationResult(
  request: ControlledWriteDecisionRequest,
  operationID: string,
  reason: string,
): ControlledWriteDecisionResult {
  const parsed = parseControlledWriteDecisionResult({
    ...decisionBinding(request, operationID, "reconciliation_required"),
    reason,
  })
  if (!parsed.ok) throw new Error("Invalid controlled-write reconciliation terminal")
  return parsed.value
}

function runBoundedOperation<Value>(operation: () => Promise<Value>, timeoutMs: number) {
  const duration = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultControlledWriteTimeoutMs
  let timeout: ReturnType<typeof setTimeout> | undefined
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
    outcome: Promise.race([execution, timedOut]).finally(() => {
      if (timeout) clearTimeout(timeout)
    }),
    settled: execution.then(() => undefined),
  }
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

function encodeControlledWriteProgress(requestId: string, progress: ControlledWriteProgress) {
  return JSON.stringify({ schemaVersion: 1, type: "controlled-write.progress", requestId, progress }) + "\n"
}

function encodeControlledWriteTerminal(
  requestId: string,
  result: ControlledWritePrepareResult | ControlledWriteDecisionResult,
) {
  return JSON.stringify({ schemaVersion: 1, type: "controlled-write.terminal", requestId, result }) + "\n"
}

function encodeSkillProgress(requestId: string, progress: SkillActivationProgress) {
  return JSON.stringify({ schemaVersion: 1, type: "skill.progress", requestId, progress }) + "\n"
}

function encodeSkillTerminal(
  requestId: string,
  result: SkillInventoryResult | SkillActivationPrepareResult | SkillActivationDecisionResult,
) {
  return JSON.stringify({ schemaVersion: 1, type: "skill.terminal", requestId, result }) + "\n"
}

function encodeBlockedTerminal(request: ControlRequest, reason: string) {
  if (isWorkspaceSearchRequest(request))
    throw new Error("Workspace search requests are owned by their dedicated handler")
  if (isGitUnstageRequest(request)) throw new Error("Git Unstage requests are owned by their dedicated handler")
  if (isGitStageRequest(request)) throw new Error("Git Stage requests are owned by their dedicated handler")
  if (isExtensionInventoryRequest(request)) {
    throw new Error("Extension inventory requests are owned by their dedicated handler")
  }
  if (isMcpActivationRequest(request)) {
    throw new Error("MCP activation requests are owned by their dedicated handler")
  }
  if (request.method === "git.inspect") return encodeTerminal(request.requestId, blocked(mapControlBlockReason(reason)))
  if (isSkillRequest(request)) return encodeSkillTerminal(request.requestId, blockedSkillResult(request, reason))
  if (request.method === "controlled-write.prepare") {
    return encodeControlledWriteTerminal(request.requestId, blockedPrepareResult(request.requestId, reason))
  }
  return encodeControlledWriteTerminal(request.requestId, blockedDecisionResult(request, reason))
}

function mapControlBlockReason(reason: string): GitControlInspectionBlockReason {
  if (reason === "control_busy") return "control_busy"
  if (reason === "control_limit_reached") return "control_limit_reached"
  if (reason === "request_replayed") return "request_replayed"
  return "inspection_failed"
}

function write(socket: Socket, value: string) {
  return new Promise<boolean>((complete) => {
    socket.write(value, (error) => complete(error === undefined || error === null))
  })
}

function boundedDelay(milliseconds: number) {
  return new Promise<void>((complete) => {
    const timer = setTimeout(complete, milliseconds)
    timer.unref?.()
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
