import { createHash, randomUUID } from "node:crypto"
import {
  parseWorkspaceSearchControlPreview,
  parseWorkspaceSearchDecisionResult,
  parseWorkspaceSearchPrepareResult,
  parseWorkspaceSearchProgress,
  workspaceSearchBoundaryLabel,
  type WorkspaceSearchControlPreview,
  type WorkspaceSearchDecisionResult,
  type WorkspaceSearchOutputSummary,
  type WorkspaceSearchPrepareResult,
  type WorkspaceSearchProgress,
} from "@astra/domain/governed-workspace-search-control"
import { governedWorkspaceSearchTaskID } from "@astra/domain/governed-workspace-search"
import {
  executeGovernedWorkspaceSearch,
  proposeGovernedWorkspaceSearch,
  type DurableGovernedWorkspaceSearchResult,
  type ExecuteGovernedWorkspaceSearchInput,
  type GovernedWorkspaceSearchProposal,
  type ProposeGovernedWorkspaceSearchInput,
} from "@astra/runtime/governed-workspace-search"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

const maximumPreparedOperations = 32
const maximumDisplayLines = 100
const maximumDisplayLineBytes = 512
const maximumDisplayBytes = 16_384

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type AstraGovernedWorkspaceSearchControl = Readonly<{
  prepare: (requestId: string, query: string) => Promise<WorkspaceSearchPrepareResult>
  decide: (
    requestId: string,
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: WorkspaceSearchProgress) => void,
  ) => Promise<WorkspaceSearchDecisionResult>
}>

type PendingProposal = Readonly<{
  proposalID: string
  preview: WorkspaceSearchControlPreview
  operationInput: ProposeGovernedWorkspaceSearchInput
  proposal: GovernedWorkspaceSearchProposal
}>

export type AstraGovernedWorkspaceSearchControlDependencies = Readonly<{
  now: () => number
  createID: () => string
  propose: (input: ProposeGovernedWorkspaceSearchInput) => Promise<GovernedWorkspaceSearchProposal>
  execute: (
    input: ExecuteGovernedWorkspaceSearchInput,
    onProcessEntered?: () => void,
  ) => Promise<DurableGovernedWorkspaceSearchResult>
}>

/** Owns workspace scope, executable authority, operation state, and host execution.
 * The child contributes only one bounded literal query and an A/D decision. */
export function createAstraGovernedWorkspaceSearchControl(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraGovernedWorkspaceSearchControlDependencies = defaultDependencies(),
): AstraGovernedWorkspaceSearchControl {
  let pending: PendingProposal | undefined
  const consumed = new Set<string>()
  let prepared = 0

  return {
    async prepare(requestId, query) {
      if (session.mode !== "activate-once") return blockedPrepare(requestId, "read_only")
      if (pending) {
        if (Date.parse(pending.preview.expiresAt) > dependencies.now()) {
          return blockedPrepare(requestId, "control_busy")
        }
        consumed.add(pending.proposalID)
        pending = undefined
      }
      if (prepared >= maximumPreparedOperations) return blockedPrepare(requestId, "control_limit_reached")

      const operationInput = {
        operationID: dependencies.createID(),
        request: { taskID: governedWorkspaceSearchTaskID, query, queryBytes: Buffer.byteLength(query) },
        report: session.report,
        ...(session.repositoryBaseline ? { repositoryBaseline: session.repositoryBaseline } : {}),
        policyAskedAt: canonicalTimestamp(dependencies.now()),
      } as const satisfies ProposeGovernedWorkspaceSearchInput
      const proposal = await dependencies.propose(operationInput).catch(() => null)
      if (!proposal) return blockedPrepare(requestId, "preparation_unavailable")

      const proposalID = dependencies.createID()
      const candidate = {
        schemaVersion: 1,
        proposalID,
        operationID: operationInput.operationID,
        query: operationInput.request.query,
        queryBytes: operationInput.request.queryBytes,
        capabilityDigest: proposal.capability.capabilityDigest,
        expiresAt: proposal.capability.manifest.grant.expiresAt,
        boundaryLabel: workspaceSearchBoundaryLabel,
        workspaceRoot: proposal.preview.workingDirectory,
        executable: proposal.preview.executable.requestedPath,
        mode: "recursive_fixed_string",
        resources: proposal.preview.resources,
        network: "host_unrestricted_not_requested",
        writes: [],
        verification: "not_verified",
      } as const
      const parsed = parseWorkspaceSearchControlPreview(candidate)
      if (
        !parsed.ok ||
        parsed.value.workspaceRoot !== session.report.root ||
        parsed.value.executable !== "/usr/bin/grep" ||
        parsed.value.capabilityDigest !== proposal.capability.capabilityDigest ||
        Date.parse(parsed.value.expiresAt) <= dependencies.now()
      ) {
        return blockedPrepare(requestId, "preparation_unavailable")
      }

      pending = deepFreeze({ proposalID, preview: parsed.value, operationInput, proposal })
      prepared++
      return requirePrepareResult({ schemaVersion: 1, requestId, status: "prepared", preview: parsed.value })
    },

    async decide(requestId, proposalID, decision, onProgress = () => {}) {
      const selected = pending
      if (consumed.has(proposalID)) return blockedDecision(requestId, proposalID, "proposal_consumed")
      if (!selected || selected.proposalID !== proposalID) {
        return blockedDecision(requestId, proposalID, "proposal_unknown")
      }
      pending = undefined
      consumed.add(proposalID)
      const decidedAt = canonicalTimestamp(dependencies.now())
      if (Date.parse(selected.preview.expiresAt) <= Date.parse(decidedAt)) {
        return blockedDecision(requestId, proposalID, "proposal_expired")
      }

      const executionInput: ExecuteGovernedWorkspaceSearchInput = {
        ...selected.operationInput,
        ledgerFilename: state.ledgerFilename,
        spoolFilename: state.spoolFilename,
        proposal: selected.proposal,
        consent:
          decision === "approve"
            ? { decision: "approved", decidedAt }
            : { decision: "rejected", decidedAt, reason: "user_rejected" },
        recordingStartedAt: decidedAt,
      }
      const binding = {
        schemaVersion: 1,
        requestId,
        proposalID,
        operationID: selected.preview.operationID,
        capabilityDigest: selected.preview.capabilityDigest,
        verification: "not_verified",
      } as const

      if (decision === "approve") notify(onProgress, { ...binding, status: "recording_authority" })
      const result = await dependencies
        .execute(executionInput, () => {
          if (decision === "approve") notify(onProgress, { ...binding, status: "executing_host" })
        })
        .catch(() => null)

      if (!result) {
        return decision === "reject"
          ? blockedDecision(requestId, proposalID, "durable_rejection_unavailable")
          : requireDecisionResult({
              ...binding,
              status: "reconciliation_required",
              reason: "durable_state_unavailable",
              receiptID: null,
              output: null,
            })
      }
      if (result.operationID !== binding.operationID) {
        return requireDecisionResult({
          ...binding,
          status: "reconciliation_required",
          reason: "durable_state_unavailable",
          receiptID: null,
          output: null,
        })
      }
      if (result.status === "denied_without_effect") {
        return decision === "reject"
          ? requireDecisionResult({ ...binding, status: "denied_without_effect" })
          : blockedDecision(requestId, proposalID, "protocol_invalid")
      }
      if (decision === "reject") return blockedDecision(requestId, proposalID, "durable_rejection_unavailable")
      if (result.status === "completed_observed_not_verified" && result.receiptID && result.output) {
        const output = summarizeOutput(result.output)
        if (output.outcome === "unknown") {
          return requireDecisionResult({
            ...binding,
            status: "reconciliation_required",
            reason: "effect_unknown",
            receiptID: result.receiptID,
            output,
          })
        }
        notify(onProgress, {
          ...binding,
          status: "effect_observed_not_verified",
          receiptID: result.receiptID,
          outputDigest: output.outputDigest,
          digestScope: "stdout_only",
          outputLineCount: output.outputLineCount,
          outcome: output.outcome,
        })
        return requireDecisionResult({
          ...binding,
          status: "completed_observed_not_verified",
          receiptID: result.receiptID,
          output,
        })
      }
      if (result.status === "failed_without_effect") {
        return requireDecisionResult({ ...binding, status: "failed_without_effect", reason: "kernel_proved_no_effect" })
      }
      return requireDecisionResult({
        ...binding,
        status: "reconciliation_required",
        reason: "effect_unknown",
        receiptID: result.receiptID,
        output: result.output ? summarizeOutput(result.output) : null,
      })
    },
  }
}

function defaultDependencies(): AstraGovernedWorkspaceSearchControlDependencies {
  return {
    now: Date.now,
    createID: randomUUID,
    propose: proposeGovernedWorkspaceSearch,
    execute: (input, onProcessEntered) =>
      executeGovernedWorkspaceSearch(input, onProcessEntered ? { onProcessEntered } : {}),
  }
}

function summarizeOutput(
  input: NonNullable<DurableGovernedWorkspaceSearchResult["output"]>,
): WorkspaceSearchOutputSummary {
  const rawLines = input.stdout.split("\n")
  if (rawLines.at(-1) === "") rawLines.pop()
  const displayLines: string[] = []
  let displayBytes = 0
  let truncated = false
  for (const rawLine of rawLines) {
    if (displayLines.length >= maximumDisplayLines) {
      truncated = true
      break
    }
    const sanitized = sanitizeLine(rawLine)
    const bounded = truncateUtf8(sanitized || " ", maximumDisplayLineBytes)
    if (bounded !== sanitized) truncated = true
    const separatorBytes = displayLines.length === 0 ? 0 : 1
    if (displayBytes + separatorBytes + Buffer.byteLength(bounded) > maximumDisplayBytes) {
      truncated = true
      break
    }
    displayLines.push(bounded)
    displayBytes += separatorBytes + Buffer.byteLength(bounded)
  }
  if (displayLines.length < rawLines.length) truncated = true
  return {
    outputDigest: `sha256:${createHash("sha256").update(input.stdout).digest("hex")}`,
    digestScope: "stdout_only",
    outputLineCount: input.outputLineCount,
    outcome: input.outcome,
    exitCode: input.exitCode,
    displayLines: Object.freeze(displayLines),
    truncated,
  }
}

function sanitizeLine(input: string) {
  return Array.from(input, (character) => (/\p{C}/u.test(character) ? "�" : character)).join("")
}

function truncateUtf8(input: string, maximumBytes: number) {
  if (Buffer.byteLength(input) <= maximumBytes) return input
  let bytes = 0
  let output = ""
  for (const character of input) {
    const next = Buffer.byteLength(character)
    if (bytes + next > maximumBytes) break
    output += character
    bytes += next
  }
  return output || " "
}

function notify(callback: (progress: WorkspaceSearchProgress) => void, input: WorkspaceSearchProgress) {
  const parsed = parseWorkspaceSearchProgress(input)
  if (!parsed.ok) return
  try {
    callback(parsed.value)
  } catch {
    // Display progress cannot change parent-owned operation authority.
  }
}

function blockedPrepare(requestId: string, reason: string): WorkspaceSearchPrepareResult {
  return requirePrepareResult({ schemaVersion: 1, requestId, status: "blocked", reason })
}

function blockedDecision(requestId: string, proposalID: string, reason: string): WorkspaceSearchDecisionResult {
  return requireDecisionResult({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason })
}

function requirePrepareResult(input: unknown) {
  const parsed = parseWorkspaceSearchPrepareResult(input)
  if (!parsed.ok) throw new TypeError("Invalid workspace search prepare result")
  return parsed.value
}

function requireDecisionResult(input: unknown) {
  const parsed = parseWorkspaceSearchDecisionResult(input)
  if (!parsed.ok) throw new TypeError("Invalid workspace search decision result")
  return parsed.value
}

function canonicalTimestamp(input: number) {
  return new Date(input).toISOString()
}

function deepFreeze<Value>(input: Value): Value {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}
