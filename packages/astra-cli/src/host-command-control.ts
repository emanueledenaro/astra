import { createHash, randomUUID } from "node:crypto"
import {
  hostCommandBoundaryLabel,
  parseHostCommandControlPreview,
  parseHostCommandDecisionResult,
  parseHostCommandOutputSummary,
  parseHostCommandPrepareResult,
  parseHostCommandProgress,
  type HostCommandControlPreview,
  type HostCommandDecisionResult,
  type HostCommandOutputSummary,
  type HostCommandPrepareResult,
  type HostCommandProgress,
} from "@astra/domain/host-command-control"
import {
  executeHostCommand,
  proposeHostCommand,
  type DurableHostCommandResult,
  type ExecuteHostCommandInput,
  type HostCommandProposal,
  type ProposeHostCommandInput,
} from "@astra/runtime/host-command"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

const maximumPreparedOperations = 32
const maximumDisplayLines = 100
const maximumDisplayLineBytes = 512
const maximumDisplayBytes = 32_768

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type AstraHostCommandControl = Readonly<{
  prepare: (requestId: string, script: string) => Promise<HostCommandPrepareResult>
  decide: (
    requestId: string,
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: HostCommandProgress) => void,
  ) => Promise<HostCommandDecisionResult>
}>

type PendingProposal = Readonly<{
  proposalID: string
  preview: HostCommandControlPreview
  operationInput: ProposeHostCommandInput
  proposal: HostCommandProposal
}>

export type AstraHostCommandControlDependencies = Readonly<{
  now: () => number
  createID: () => string
  propose: (input: ProposeHostCommandInput) => Promise<HostCommandProposal>
  execute: (input: ExecuteHostCommandInput, onProcessEntered?: () => void) => Promise<DurableHostCommandResult>
}>

/** Owns the exact shell, workspace, durable state, and host adapter. The
 * child contributes only one bounded script and a later A/D decision. */
export function createAstraHostCommandControl(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraHostCommandControlDependencies = defaultDependencies(),
): AstraHostCommandControl {
  let pending: PendingProposal | undefined
  const consumed = new Set<string>()
  let prepared = 0

  return {
    async prepare(requestId, script) {
      if (session.mode !== "activate-once") return blockedPrepare(requestId, "read_only")
      if (pending) {
        if (Date.parse(pending.preview.expiresAt) > dependencies.now()) return blockedPrepare(requestId, "control_busy")
        consumed.add(pending.proposalID)
        pending = undefined
      }
      if (prepared >= maximumPreparedOperations) return blockedPrepare(requestId, "control_limit_reached")

      const operationInput = {
        operationID: dependencies.createID(),
        request: { command: "shell", script, scriptBytes: Buffer.byteLength(script) },
        report: session.report,
        ...(session.repositoryBaseline ? { repositoryBaseline: session.repositoryBaseline } : {}),
        policyAskedAt: canonicalTimestamp(dependencies.now()),
      } as const satisfies ProposeHostCommandInput
      const proposal = await dependencies.propose(operationInput).catch(() => null)
      if (!proposal) return blockedPrepare(requestId, "preparation_unavailable")

      const proposalID = dependencies.createID()
      const candidate = {
        schemaVersion: 1,
        proposalID,
        operationID: operationInput.operationID,
        script: operationInput.request.script,
        scriptBytes: operationInput.request.scriptBytes,
        scriptDigest: proposal.preview.scriptDigest,
        capabilityDigest: proposal.capability.capabilityDigest,
        expiresAt: proposal.capability.manifest.grant.expiresAt,
        boundaryLabel: hostCommandBoundaryLabel,
        workspaceRoot: proposal.preview.workingDirectory,
        executable: proposal.preview.executable.requestedPath,
        argvPrefix: proposal.preview.argv.slice(1, 3),
        environment: proposal.preview.environment,
        resources: proposal.preview.resources,
        filesystem: "host_unrestricted",
        network: "host_unrestricted",
        writes: ["command_defined"],
        verification: "not_verified",
      } as const
      const parsed = parseHostCommandControlPreview(candidate)
      if (
        !parsed.ok ||
        parsed.value.workspaceRoot !== session.report.root ||
        parsed.value.executable !== "/bin/zsh" ||
        parsed.value.scriptDigest !== proposal.preview.scriptDigest ||
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
      if (!selected || selected.proposalID !== proposalID)
        return blockedDecision(requestId, proposalID, "proposal_unknown")
      pending = undefined
      consumed.add(proposalID)
      const decidedAt = canonicalTimestamp(dependencies.now())
      if (Date.parse(selected.preview.expiresAt) <= Date.parse(decidedAt)) {
        return blockedDecision(requestId, proposalID, "proposal_expired")
      }
      const executionInput: ExecuteHostCommandInput = {
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

      if (!result || result.operationID !== binding.operationID) {
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
      if (result.status === "denied_without_effect") {
        return decision === "reject"
          ? requireDecisionResult({ ...binding, status: "denied_without_effect" })
          : blockedDecision(requestId, proposalID, "protocol_invalid")
      }
      if (decision === "reject") return blockedDecision(requestId, proposalID, "durable_rejection_unavailable")
      if (result.status === "completed_observed_not_verified" && result.receiptID && result.output) {
        const output = summarizeOutput(result.output)
        notify(onProgress, {
          ...binding,
          status: "effect_observed_not_verified",
          receiptID: result.receiptID,
          outputDigest: output.outputDigest,
          digestScope: "stdout_stderr_exit",
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

function summarizeOutput(output: NonNullable<DurableHostCommandResult["output"]>): HostCommandOutputSummary {
  const raw = JSON.stringify({ exitCode: output.exitCode, stderr: output.stderr, stdout: output.stdout })
  const stdout = displayLines(output.stdout)
  const stderr = displayLines(output.stderr)
  const candidate = {
    outputDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    digestScope: "stdout_stderr_exit",
    exitCode: output.exitCode,
    stdoutLines: stdout.lines,
    stderrLines: stderr.lines,
    truncated: stdout.truncated || stderr.truncated,
  } as const
  const parsed = parseHostCommandOutputSummary(candidate)
  if (!parsed.ok) throw new Error("Invalid host command output summary")
  return parsed.value
}

function displayLines(input: string) {
  const source = input.split("\n")
  if (source.at(-1) === "") source.pop()
  const lines: string[] = []
  let bytes = 0
  let truncated = false
  for (const raw of source) {
    if (lines.length >= maximumDisplayLines) {
      truncated = true
      break
    }
    const line = safeLine(raw)
    const bounded = truncateUtf8(line, maximumDisplayLineBytes)
    if (bounded !== line) truncated = true
    const nextBytes = Buffer.byteLength(bounded) + (lines.length ? 1 : 0)
    if (bytes + nextBytes > maximumDisplayBytes) {
      truncated = true
      break
    }
    lines.push(bounded)
    bytes += nextBytes
  }
  return { lines: Object.freeze(lines), truncated }
}

function safeLine(input: string) {
  const normalized = input.replaceAll("\t", "    ")
  if (/\p{C}/u.test(normalized)) return "[unsafe output blocked]"
  return normalized
}

function truncateUtf8(input: string, maximumBytes: number) {
  if (Buffer.byteLength(input) <= maximumBytes) return input
  let result = ""
  for (const character of input) {
    if (Buffer.byteLength(result + character) > maximumBytes - 3) break
    result += character
  }
  return `${result}...`
}

function defaultDependencies(): AstraHostCommandControlDependencies {
  return {
    now: Date.now,
    createID: randomUUID,
    propose: proposeHostCommand,
    execute: (input, onProcessEntered) =>
      executeHostCommand(input, onProcessEntered ? { onProcessEntered } : undefined),
  }
}

function notify(callback: (progress: HostCommandProgress) => void, progress: HostCommandProgress) {
  const parsed = parseHostCommandProgress(progress)
  if (parsed.ok) callback(parsed.value)
}

function blockedPrepare(requestId: string, reason: string): HostCommandPrepareResult {
  return requirePrepareResult({ schemaVersion: 1, requestId, status: "blocked", reason })
}

function blockedDecision(requestId: string, proposalID: string, reason: string): HostCommandDecisionResult {
  return requireDecisionResult({ schemaVersion: 1, requestId, proposalID, status: "blocked", reason })
}

function requirePrepareResult(input: HostCommandPrepareResult) {
  const parsed = parseHostCommandPrepareResult(input)
  if (!parsed.ok) throw new Error("Invalid host command prepare result")
  return parsed.value
}

function requireDecisionResult(input: HostCommandDecisionResult) {
  const parsed = parseHostCommandDecisionResult(input)
  if (!parsed.ok) throw new Error("Invalid host command decision result")
  return parsed.value
}

function canonicalTimestamp(milliseconds: number) {
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid host command clock")
  return new Date(milliseconds).toISOString()
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}
