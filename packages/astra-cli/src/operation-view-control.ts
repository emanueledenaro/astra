import {
  operationViewCoverage,
  operationViewRecoveryNote,
  parseOperationViewDetailResult,
  parseOperationViewListResult,
  parseOperationViewRecoveryResult,
  type OperationViewDetailResult,
  type OperationViewListResult,
  type OperationViewRecoveryResult,
} from "@astra/domain/operation-view-control"
import {
  listOperationRecoveryCandidates,
  listOperationViews,
  readOperationViewDetail,
  OperationViewError,
} from "@astra/runtime/operation-view"

export type AstraOperationViewControl = Readonly<{
  list: (requestId: string) => Promise<OperationViewListResult>
  detail: (requestId: string, operationID: string) => Promise<OperationViewDetailResult>
  recovery: (requestId: string) => Promise<OperationViewRecoveryResult>
}>

export type AstraOperationViewControlDependencies = Readonly<{
  listOperationViews: typeof listOperationViews
  readOperationViewDetail: typeof readOperationViewDetail
  listOperationRecoveryCandidates: typeof listOperationRecoveryCandidates
}>

/**
 * Read-only projection of the durable Operation ledger for display. This
 * control has no path to any mutation: it opens the ledger read-only, computes
 * semantic keys from durable state through the domain projection, and encodes
 * everything exact-key before it crosses the private socket.
 */
export function createAstraOperationViewControl(
  state: Readonly<{ ledgerFilename: string }>,
  dependencies: AstraOperationViewControlDependencies = {
    listOperationViews,
    readOperationViewDetail,
    listOperationRecoveryCandidates,
  },
): AstraOperationViewControl {
  return Object.freeze({
    async list(requestId) {
      try {
        const facts = await dependencies.listOperationViews(state.ledgerFilename)
        return requireList({
          schemaVersion: 1,
          requestId,
          status: "listed",
          coverage: operationViewCoverage,
          operations: facts.operations,
        })
      } catch (cause) {
        return requireList(blocked(requestId, blockReason(cause)))
      }
    },

    async detail(requestId, operationID) {
      try {
        const facts = await dependencies.readOperationViewDetail(state.ledgerFilename, operationID)
        if (!facts) {
          return requireDetail({ schemaVersion: 1, requestId, status: "not_found", operationID })
        }
        return requireDetail({
          schemaVersion: 1,
          requestId,
          status: "detailed",
          operation: facts.operation,
          events: facts.events,
          dispatch: facts.dispatch,
          verification: facts.verification,
        })
      } catch (cause) {
        return requireDetail(blocked(requestId, blockReason(cause)))
      }
    },

    async recovery(requestId) {
      try {
        const candidates = await dependencies.listOperationRecoveryCandidates(state.ledgerFilename)
        return requireRecovery({
          schemaVersion: 1,
          requestId,
          status: "listed",
          note: operationViewRecoveryNote,
          candidates,
        })
      } catch (cause) {
        return requireRecovery(blocked(requestId, blockReason(cause)))
      }
    },
  })
}

function blockReason(cause: unknown) {
  if (cause instanceof OperationViewError) return cause.code
  return "ledger_unavailable"
}

function blocked(requestId: string, reason: string) {
  return { schemaVersion: 1, requestId, status: "blocked", reason } as const
}

function requireList(input: unknown): OperationViewListResult {
  const parsed = parseOperationViewListResult(input)
  if (parsed.ok) return parsed.value
  const fallback = parseOperationViewListResult(blocked(requestIdOf(input), "projection_invalid"))
  if (!fallback.ok) throw new TypeError("Invalid operation view list terminal")
  return fallback.value
}

function requireDetail(input: unknown): OperationViewDetailResult {
  const parsed = parseOperationViewDetailResult(input)
  if (parsed.ok) return parsed.value
  const fallback = parseOperationViewDetailResult(blocked(requestIdOf(input), "projection_invalid"))
  if (!fallback.ok) throw new TypeError("Invalid operation view detail terminal")
  return fallback.value
}

function requireRecovery(input: unknown): OperationViewRecoveryResult {
  const parsed = parseOperationViewRecoveryResult(input)
  if (parsed.ok) return parsed.value
  const fallback = parseOperationViewRecoveryResult(blocked(requestIdOf(input), "projection_invalid"))
  if (!fallback.ok) throw new TypeError("Invalid operation view recovery terminal")
  return fallback.value
}

function requestIdOf(input: unknown) {
  if (typeof input === "object" && input !== null && "requestId" in input) {
    const candidate = (input as Record<string, unknown>).requestId
    if (typeof candidate === "string") return candidate
  }
  throw new TypeError("Invalid operation view terminal binding")
}
