import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { isAbsolute } from "node:path"
import {
  parseGitStageDecisionResult,
  parseGitStageInventoryResult,
  parseGitStagePrepareResult,
  parseGitStageProgress,
  type GitStageControlCandidate,
  type GitStageControlInventory,
  type GitStageControlPreview,
  type GitStageDecisionResult,
  type GitStageInventoryResult,
  type GitStagePrepareResult,
  type GitStageProgress,
} from "../../../astra-domain/src/git-stage-control"
import { AstraControlClientError } from "./control-client"

export type {
  GitStageControlPreview,
  GitStageDecisionResult,
  GitStageInventoryResult,
  GitStagePrepareResult,
  GitStageProgress,
}
export type GitStageInventoryPreview = GitStageControlInventory

const responseLimitBytes = 128 * 1024
const defaultResponseTimeoutMs = 65_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type RequestOptions = Readonly<{ signal?: AbortSignal; onAccepted?: (requestID: string) => void }>

export type AstraGitStageClient = Readonly<{
  inventory: (options?: RequestOptions) => Promise<GitStageInventoryResult>
  prepare: (
    inventoryID: string,
    candidateIDs: ReadonlyArray<string>,
    options?: RequestOptions,
  ) => Promise<GitStagePrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    options?: RequestOptions & Readonly<{ onProgress?: (progress: GitStageProgress) => void }>,
  ) => Promise<GitStageDecisionResult>
  dispose: () => void
}>

/** Creates a lazy client whose mutation requests contain only parent-issued opaque identifiers. */
export function createAstraGitStageClient(
  environment: Readonly<Record<string, string | undefined>>,
  sessionID: string,
  options: Readonly<{
    responseTimeoutMs?: number
    expectedWorkspaceRoot?: string
    expectedBaselineSnapshotDigest?: string
    now?: () => Date
  }> = {},
): AstraGitStageClient {
  const socketPath = environment.ASTRA_CONTROL_SOCKET
  const token = environment.ASTRA_CONTROL_TOKEN
  const available =
    typeof socketPath === "string" &&
    isAbsolute(socketPath) &&
    Buffer.byteLength(socketPath) <= 100 &&
    !/\p{C}/u.test(socketPath) &&
    typeof token === "string" &&
    tokenPattern.test(token) &&
    uuidPattern.test(sessionID)
  const timeoutMs =
    typeof options.responseTimeoutMs === "number" &&
    Number.isSafeInteger(options.responseTimeoutMs) &&
    options.responseTimeoutMs > 0
      ? options.responseTimeoutMs
      : defaultResponseTimeoutMs
  let activeRequest: { cancel?: () => void } | undefined
  let inventoryBinding: InventoryBinding | undefined
  const proposals = new Map<string, ProposalBinding>()
  const attemptedProposals = new Set<string>()

  function request<Result>(input: ExchangeInput<Result>) {
    if (!available || !socketPath || !token) return Promise.reject(new AstraControlClientError("unavailable"))
    if (activeRequest) return Promise.reject(new AstraControlClientError("busy"))
    if (input.signal?.aborted) return Promise.reject(new AstraControlClientError("cancelled"))
    const requestID = randomUUID()
    const active: { cancel?: () => void } = {}
    activeRequest = active
    return exchange({ ...input, socketPath, token, sessionID, requestID, timeoutMs }, (cancel) => {
      if (activeRequest === active) active.cancel = cancel
    }).finally(() => {
      if (activeRequest === active) activeRequest = undefined
    })
  }

  return {
    inventory(requestOptions = {}) {
      return request({ method: "git-stage.inventory", parseTerminal: parseInventoryTerminal, ...requestOptions }).then(
        (result) => {
          if (result.status !== "inventory") return result
          if (
            options.expectedBaselineSnapshotDigest !== undefined &&
            result.inventory.baselineSnapshotDigest !== options.expectedBaselineSnapshotDigest
          ) {
            throw new AstraControlClientError("protocol_invalid")
          }
          if (Date.parse(result.inventory.expiresAt) <= (options.now?.() ?? new Date()).getTime()) {
            throw new AstraControlClientError("protocol_invalid")
          }
          const candidateIDs = result.inventory.candidates.map((candidate) => candidate.candidateID)
          if (new Set(candidateIDs).size !== candidateIDs.length) throw new AstraControlClientError("protocol_invalid")
          inventoryBinding = {
            inventoryID: result.inventory.inventoryID,
            inventoryDigest: result.inventory.inventoryDigest,
            baselineSnapshotDigest: result.inventory.baselineSnapshotDigest,
            expiresAt: result.inventory.expiresAt,
            candidates: new Map(result.inventory.candidates.map((candidate) => [candidate.candidateID, candidate])),
          }
          return result
        },
      )
    },
    prepare(inventoryID, candidateIDs, requestOptions = {}) {
      const binding = inventoryBinding
      if (
        !binding ||
        inventoryID !== binding.inventoryID ||
        Date.parse(binding.expiresAt) <= (options.now?.() ?? new Date()).getTime() ||
        candidateIDs.length === 0 ||
        new Set(candidateIDs).size !== candidateIDs.length ||
        candidateIDs.some((candidateID) => !uuidPattern.test(candidateID) || !binding.candidates.has(candidateID))
      ) {
        return Promise.reject(new AstraControlClientError("protocol_invalid"))
      }
      const requestedIDs = new Set(candidateIDs)
      const selectedIDs = [...binding.candidates.keys()].filter((candidateID) => requestedIDs.has(candidateID))
      return request({
        method: "git-stage.prepare",
        inventoryID,
        candidateIDs: selectedIDs,
        parseTerminal: parsePrepareTerminal,
        ...requestOptions,
      }).then((result) => {
        if (result.status !== "prepared") return result
        const authority = result.preview.authority
        const now = (options.now?.() ?? new Date()).getTime()
        const valid =
          Date.parse(binding.expiresAt) > now &&
          Date.parse(authority.expiresAt) > now &&
          authority.inventoryDigest === binding.inventoryDigest &&
          authority.baselineSnapshotDigest === binding.baselineSnapshotDigest &&
          (options.expectedWorkspaceRoot === undefined || authority.workspaceRoot === options.expectedWorkspaceRoot) &&
          sameStrings(authority.selection.candidateIDs, selectedIDs) &&
          authority.candidates.length === selectedIDs.length &&
          authority.candidates.every((candidate) => {
            const inventoryCandidate = binding.candidates.get(candidate.candidateID)
            return (
              inventoryCandidate?.candidateID === candidate.candidateID &&
              inventoryCandidate.path === candidate.path &&
              candidateChange(candidate) === inventoryCandidate.change
            )
          })
        if (!valid) throw new AstraControlClientError("protocol_invalid")
        proposals.set(result.preview.proposalID, {
          proposalID: result.preview.proposalID,
          proposalDigest: authority.proposalDigest,
        })
        return result
      })
    },
    decide(proposalID, decision, requestOptions = {}) {
      const binding = proposals.get(proposalID)
      if (!binding || attemptedProposals.has(proposalID) || !uuidPattern.test(proposalID))
        return Promise.reject(new AstraControlClientError("protocol_invalid"))
      attemptedProposals.add(proposalID)
      return request({
        method: "git-stage.decide",
        proposalID,
        decision,
        binding,
        parseTerminal: parseDecisionTerminal,
        ...requestOptions,
      }).then((result) => {
        proposals.delete(proposalID)
        attemptedProposals.delete(proposalID)
        return result
      })
    },
    dispose() {
      const active = activeRequest
      activeRequest = undefined
      active?.cancel?.()
    },
  }
}

type InventoryBinding = Readonly<{
  inventoryID: string
  inventoryDigest: string
  baselineSnapshotDigest: string
  expiresAt: string
  candidates: ReadonlyMap<string, GitStageControlCandidate>
}>
type ProposalBinding = Readonly<{ proposalID: string; proposalDigest: string }>
type Method = "git-stage.inventory" | "git-stage.prepare" | "git-stage.decide"
type ExchangeInput<Result> = Readonly<{
  method: Method
  inventoryID?: string
  candidateIDs?: ReadonlyArray<string>
  proposalID?: string
  decision?: "approve" | "reject"
  binding?: ProposalBinding
  parseTerminal: (input: unknown) => Result | null
  signal?: AbortSignal
  onAccepted?: (requestID: string) => void
  onProgress?: (progress: GitStageProgress) => void
}>
type CompleteExchangeInput<Result> = ExchangeInput<Result> &
  Readonly<{ socketPath: string; token: string; sessionID: string; requestID: string; timeoutMs: number }>

function exchange<Result>(input: CompleteExchangeInput<Result>, registerCancel: (cancel: () => void) => void) {
  return new Promise<Result>((complete, reject) => {
    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let accepted = false
    let bytes = 0
    let buffered = ""
    let progressIndex = 0
    let observation: Readonly<{ operationID: string; receiptID: string; snapshotDigest: string }> | undefined
    const finish = (
      result: Readonly<{ ok: true; value: Result }> | Readonly<{ ok: false; code: AstraControlClientError["code"] }>,
    ) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
      socket?.destroy()
      if (result.ok) complete(result.value)
      else reject(new AstraControlClientError(result.code))
    }
    const abort = () => finish({ ok: false, code: "cancelled" })
    registerCancel(abort)
    input.signal?.addEventListener("abort", abort, { once: true })
    timeout = setTimeout(() => finish({ ok: false, code: "timed_out" }), input.timeoutMs)
    try {
      socket = createConnection(input.socketPath)
    } catch {
      finish({ ok: false, code: "transport_failed" })
      return
    }
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket?.write(
        JSON.stringify({
          schemaVersion: 1,
          method: input.method,
          requestId: input.requestID,
          sessionID: input.sessionID,
          token: input.token,
          ...(input.method === "git-stage.prepare"
            ? { inventoryID: input.inventoryID, candidateIDs: input.candidateIDs }
            : input.method === "git-stage.decide"
              ? { proposalID: input.proposalID, decision: input.decision }
              : {}),
        }) + "\n",
      )
    })
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > responseLimitBytes) return finish({ ok: false, code: "protocol_invalid" })
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line || settled) continue
        const message = parseMessage(line, input.requestID, input.parseTerminal)
        if (!message) return finish({ ok: false, code: "protocol_invalid" })
        if (message.type === "accepted") {
          if (accepted) return finish({ ok: false, code: "protocol_invalid" })
          accepted = true
          try {
            input.onAccepted?.(input.requestID)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        if (!accepted) return finish({ ok: false, code: "protocol_invalid" })
        if (message.type === "progress") {
          if (
            input.method !== "git-stage.decide" ||
            input.decision !== "approve" ||
            !input.binding ||
            message.progress.proposalID !== input.binding.proposalID ||
            message.progress.proposalDigest !== input.binding.proposalDigest ||
            message.progress.status !== progressOrder[progressIndex]
          )
            return finish({ ok: false, code: "protocol_invalid" })
          progressIndex++
          if (message.progress.status === "effect_observed_not_verified") observation = message.progress
          try {
            input.onProgress?.(message.progress)
          } catch {
            return finish({ ok: false, code: "protocol_invalid" })
          }
          continue
        }
        if (!validTerminal(message.result, input, progressIndex, observation)) {
          return finish({ ok: false, code: "protocol_invalid" })
        }
        finish({ ok: true, value: message.result })
      }
    })
    socket.once("error", () => finish({ ok: false, code: "transport_failed" }))
    socket.once("close", () => {
      if (!settled) finish({ ok: false, code: "transport_failed" })
    })
  })
}

const progressOrder = [
  "recording_authority",
  "host_adapter_validating",
  "effect_observed_not_verified",
  "verifying",
] as const

function validTerminal<Result>(
  result: Result,
  input: CompleteExchangeInput<Result>,
  progressIndex: number,
  observation: Readonly<{ operationID: string; receiptID: string; snapshotDigest: string }> | undefined,
) {
  const record = plainRecord(result)
  if (!record || record.requestId !== input.requestID) return false
  if (input.method !== "git-stage.decide") return progressIndex === 0
  if (!input.binding || record.proposalID !== input.binding.proposalID) return false
  if ("proposalDigest" in record && record.proposalDigest !== input.binding.proposalDigest) return false
  if (input.decision === "reject")
    return progressIndex === 0 && (record.status === "denied_without_git_effect" || record.status === "blocked")
  if (record.status === "blocked") return progressIndex === 0
  if (record.status === "failed_without_effect") {
    return progressIndex >= 1 && progressIndex <= 2 && observation === undefined
  }
  if (record.status === "reconciliation_required") return progressIndex >= 1
  return (
    record.status === "verified" &&
    progressIndex === progressOrder.length &&
    observation !== undefined &&
    record.operationID === observation.operationID &&
    record.receiptID === observation.receiptID &&
    record.snapshotDigest === observation.snapshotDigest
  )
}

type ControlMessage<Result> =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "progress"; progress: GitStageProgress }>
  | Readonly<{ type: "terminal"; result: Result }>

function parseMessage<Result>(
  input: string,
  requestID: string,
  parseTerminal: (input: unknown) => Result | null,
): ControlMessage<Result> | null {
  try {
    const record = plainRecord(JSON.parse(input))
    if (!record || record.schemaVersion !== 1 || record.requestId !== requestID) return null
    if (record.type === "accepted")
      return exactKeys(record, ["schemaVersion", "type", "requestId"]) ? { type: "accepted" } : null
    if (record.type === "git-stage.progress") {
      const parsed = parseGitStageProgress(record.progress)
      const progress = parsed.ok ? parsed.value : null
      return exactKeys(record, ["schemaVersion", "type", "requestId", "progress"]) && progress?.requestId === requestID
        ? { type: "progress", progress }
        : null
    }
    if (record.type !== "git-stage.terminal" || !exactKeys(record, ["schemaVersion", "type", "requestId", "result"]))
      return null
    const result = parseTerminal(record.result)
    return result ? { type: "terminal", result } : null
  } catch {
    return null
  }
}

function parseInventoryTerminal(input: unknown): GitStageInventoryResult | null {
  const parsed = parseGitStageInventoryResult(input)
  return parsed.ok ? parsed.value : null
}

function parsePrepareTerminal(input: unknown): GitStagePrepareResult | null {
  const parsed = parseGitStagePrepareResult(input)
  return parsed.ok ? parsed.value : null
}

function parseDecisionTerminal(input: unknown): GitStageDecisionResult | null {
  const parsed = parseGitStageDecisionResult(input)
  return parsed.ok ? parsed.value : null
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function candidateChange(candidate: GitStageControlPreview["authority"]["candidates"][number]) {
  if (candidate.action === "delete" && candidate.before.state === "object" && candidate.after.state === "absent") {
    return "delete"
  }
  if (candidate.action !== "upsert" || candidate.after.state !== "object") return null
  return candidate.before.state === "absent" ? "add" : "modify"
}

function plainRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  return Object.fromEntries(Object.entries(input))
}

function exactKeys(input: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) {
  return Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))
}
