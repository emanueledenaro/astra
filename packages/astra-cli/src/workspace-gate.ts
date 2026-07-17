import { Operation, WorkspaceTrust } from "@astra/domain"
import type { OperationEvent, OperationState } from "@astra/domain/operation"
import type { WorkspaceTrustEvent, WorkspaceTrustReport, WorkspaceTrustState } from "@astra/domain/workspace-trust"
import type { GitInspectionResult } from "@astra/git"
import { createControlledWritePlan } from "@astra/runtime/controlled-write-plan"
import { checkWorkspaceActivation, revalidateWorkspaceSnapshot, scanWorkspace } from "@astra/runtime/preflight"
import {
  renderControlledWritePreview,
  renderHeader,
  renderOperationState,
  renderWorkspaceReport,
  renderWorkspaceState,
  sanitizeTerminalText,
} from "./terminal"

export type WorkspaceDecision = "read-only" | "inspect-git" | "activate-once" | "exit"
export type EffectApproval = "approve" | "deny"

export type WorkspaceGateIO = Readonly<{
  write: (line: string) => void
  chooseWorkspaceDecision: (activationAllowed: boolean, gitInspectionAllowed: boolean) => Promise<WorkspaceDecision>
  approveControlledWrite: () => Promise<EffectApproval>
}>

export type WorkspaceGateResult = Readonly<{
  exitCode: number
  workspaceState: WorkspaceTrustState
  operationState: OperationState | null
  report: WorkspaceTrustReport
}>

export type DurableDenial = Readonly<{
  operationID: string
  state: "denied"
  sequence: number
  lastCursor: number
}>

export type DurableExecution = Readonly<{
  operationID: string
  state: "effect_observed" | "failed" | "reconciliation_required"
  sequence: number
  lastCursor: number
  receiptID: string | null
  status: "effect_observed" | "failed_without_effect" | "reconciliation_required"
}>

export type DurableVerification = Readonly<{
  operationID: string
  state: "succeeded" | "failed" | "reconciliation_required"
  sequence: number
  lastCursor: number
  status: "verified" | "failed" | "unknown"
  evidence: Readonly<{
    snapshotDigest: string
    criteria: ReadonlyArray<Readonly<{ result: "passed" | "failed" | "unknown"; observationDigest: string }>>
  }>
}>

export type GitInspection = GitInspectionResult

export type WorkspaceGateDependencies = Readonly<{
  inspectGitWorkspace?: (workspaceRoot: string) => Promise<GitInspection>
  recordDeniedOperation?: (
    input: Readonly<{
      plan: ReturnType<typeof createControlledWritePlan>
      report: WorkspaceTrustReport
      policyAskedAt: string
      approvalRejectedAt: string
      recordingStartedAt: string
    }>,
  ) => Promise<DurableDenial>
  executeApprovedOperation?: (
    input: Readonly<{
      plan: ReturnType<typeof createControlledWritePlan>
      report: WorkspaceTrustReport
      policyAskedAt: string
      approvalGrantedAt: string
      recordingStartedAt: string
    }>,
  ) => Promise<DurableExecution>
  verifyApprovedOperation?: (
    input: Readonly<{
      plan: ReturnType<typeof createControlledWritePlan>
      report: WorkspaceTrustReport
    }>,
  ) => Promise<DurableVerification>
}>

export async function runWorkspaceGate(
  workspace: string,
  io: WorkspaceGateIO,
  dependencies: WorkspaceGateDependencies = {},
): Promise<WorkspaceGateResult> {
  for (const line of renderHeader()) io.write(line)

  let workspaceState = advanceWorkspace(null, "workspace.opened", io)
  const report = await scanWorkspace(workspace)
  workspaceState = advanceWorkspace(
    workspaceState,
    report.completeness === "complete" ? "preflight.completed" : "preflight.blocked",
    io,
  )
  for (const line of renderWorkspaceReport(report)) io.write(line)
  const activationCheck = checkWorkspaceActivation(report)
  const gitInspectionAllowed = supportsGitInspection(report)
  io.write(
    activationCheck.allowed
      ? "CHOICES    [R] read-only   [A] activate once   [Q] exit"
      : gitInspectionAllowed
        ? "CHOICES    [R] read-only   [G] inspect Git   [Q] exit   • activate once unavailable"
        : "CHOICES    [R] read-only   [Q] exit   • activate once unavailable",
  )

  const decision = await io.chooseWorkspaceDecision(activationCheck.allowed, gitInspectionAllowed)
  if (decision === "exit") {
    workspaceState = advanceWorkspace(workspaceState, "decision.exit", io)
    io.write("EXIT       no trust stored • no effect dispatched")
    return { exitCode: 0, workspaceState, operationState: null, report }
  }
  if (decision === "read-only") {
    workspaceState = advanceWorkspace(workspaceState, "decision.read_only", io)
    io.write("READ ONLY  bounded report only • no trust stored • no effect dispatched")
    return { exitCode: 0, workspaceState, operationState: null, report }
  }
  if (decision === "inspect-git") {
    workspaceState = advanceWorkspace(workspaceState, "decision.read_only", io)
    if (!gitInspectionAllowed || !dependencies.inspectGitWorkspace) {
      io.write("GIT INSPECTION BLOCKED  unsupported workspace boundary or adapter unavailable")
      io.write("WORKSPACE STATE  UNTRUSTED • activation unavailable • no trust stored")
      return { exitCode: 2, workspaceState, operationState: null, report }
    }
    let inspection: GitInspection
    try {
      inspection = await dependencies.inspectGitWorkspace(report.root)
    } catch {
      io.write("GIT INSPECTION BLOCKED  bounded adapter failed closed")
      io.write("WORKSPACE STATE  UNTRUSTED • activation unavailable • no trust stored")
      return { exitCode: 2, workspaceState, operationState: null, report }
    }
    if (inspection.workspaceRoot !== report.root) {
      io.write("GIT INSPECTION BLOCKED  adapter result does not match the opened workspace")
      io.write("WORKSPACE STATE  UNTRUSTED • activation unavailable • no trust stored")
      return { exitCode: 2, workspaceState, operationState: null, report }
    }
    if (inspection.status === "complete" && inspection.diff.observationDigest !== inspection.outputDigest) {
      io.write("GIT INSPECTION BLOCKED  diff binding does not match the bounded observation")
      io.write("WORKSPACE STATE  UNTRUSTED • activation unavailable • no trust stored")
      return { exitCode: 2, workspaceState, operationState: null, report }
    }
    for (const line of renderGitInspection(inspection)) io.write(line)
    io.write("WORKSPACE STATE  UNTRUSTED • activation unavailable • no trust stored")
    return { exitCode: inspection.status === "complete" ? 0 : 2, workspaceState, operationState: null, report }
  }
  if (!activationCheck.allowed && activationCheck.reason === "git_baseline_not_inspected") {
    workspaceState = advanceWorkspace(workspaceState, "decision.read_only", io)
    io.write("GIT BASELINE NOT INSPECTED — activation and controlled effects are unavailable")
    io.write("READ ONLY  bounded static report remains available • no trust stored • no effect dispatched")
    return { exitCode: 2, workspaceState, operationState: null, report }
  }
  if (report.completeness !== "complete") {
    io.write("DENIED     activation is unavailable for an incomplete preflight")
    return { exitCode: 2, workspaceState, operationState: null, report }
  }

  const activation = await revalidateWorkspaceSnapshot(report)
  if (!activation.matched) {
    workspaceState = advanceWorkspace(workspaceState, "snapshot.drifted", io)
    io.write(`STALE      ${activation.reason} • run a new bounded static preflight`)
    return { exitCode: 2, workspaceState, operationState: null, report: activation.report }
  }

  workspaceState = advanceWorkspace(workspaceState, "decision.activate_once", io)
  io.write("TRUST      once • bounded static preflight unchanged • current process only • nothing persisted")

  const plan = createControlledWritePlan(report.root)
  let operationState = advanceOperation(null, "operation.admitted", plan.operationId, io)
  const policyAskedAt = new Date().toISOString()
  operationState = advanceOperation(operationState, "policy.ask", plan.operationId, io)
  for (const line of renderControlledWritePreview(plan)) io.write(line)

  const approval = await io.approveControlledWrite()
  if (approval === "deny") {
    const approvalRejectedAt = new Date().toISOString()
    if (dependencies.recordDeniedOperation) {
      try {
        const durable = await dependencies.recordDeniedOperation({
          plan,
          report,
          policyAskedAt,
          approvalRejectedAt,
          recordingStartedAt: new Date().toISOString(),
        })
        requireMatchingDurableDenial(durable, plan.operationId)
        operationState = durable.state
        io.write(renderOperationState(plan.operationId, Operation.operationSemanticKey(durable.state)))
        io.write(`LEDGER     durable • sequence ${durable.sequence} • cursor ${durable.lastCursor}`)
      } catch (error) {
        operationState = advanceOperation(operationState, "approval.rejected", plan.operationId, io)
        io.write(`LEDGER     DENIAL NOT CONFIRMED DURABLE • ${recordingFailureMessage(error)}`)
        io.write("DENIED     no dispatch • no host effect")
        workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
        return { exitCode: 2, workspaceState, operationState, report }
      }
    } else {
      operationState = advanceOperation(operationState, "approval.rejected", plan.operationId, io)
    }
    io.write("DENIED     no dispatch • no host effect")
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 0, workspaceState, operationState, report }
  }

  if (!dependencies.executeApprovedOperation || !dependencies.verifyApprovedOperation) {
    operationState = "reconciliation_required"
    io.write(renderOperationState(plan.operationId, Operation.operationSemanticKey(operationState)))
    io.write("RECONCILIATION REQUIRED  durable executor or independent verifier is unavailable")
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 2, workspaceState, operationState, report }
  }

  io.write("APPROVED   recording durable authority before host execution")
  let executed: DurableExecution
  try {
    const approvalGrantedAt = new Date().toISOString()
    executed = await dependencies.executeApprovedOperation({
      plan,
      report,
      policyAskedAt,
      approvalGrantedAt,
      recordingStartedAt: new Date().toISOString(),
    })
    requireMatchingDurableExecution(executed, plan.operationId)
  } catch (error) {
    operationState = "reconciliation_required"
    io.write(renderOperationState(plan.operationId, Operation.operationSemanticKey(operationState)))
    io.write(`RECONCILIATION REQUIRED  ${recordingFailureMessage(error)} • effect will not be retried`)
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 2, workspaceState, operationState, report }
  }

  operationState = executed.state
  io.write(renderOperationState(plan.operationId, Operation.operationSemanticKey(operationState)))
  io.write(`LEDGER     durable • sequence ${executed.sequence} • cursor ${executed.lastCursor}`)
  if (executed.status === "failed_without_effect") {
    io.write("FAILED     durable proof reports no host effect")
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 1, workspaceState, operationState, report }
  }
  if (executed.status === "reconciliation_required") {
    io.write("RECONCILIATION REQUIRED  effect is uncertain • no automatic retry")
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 2, workspaceState, operationState, report }
  }

  io.write("EFFECT OBSERVED — NOT VERIFIED")
  let verification: DurableVerification
  try {
    verification = await dependencies.verifyApprovedOperation({ plan, report })
    requireMatchingDurableVerification(verification, plan.operationId)
  } catch {
    operationState = "reconciliation_required"
    io.write(renderOperationState(plan.operationId, Operation.operationSemanticKey(operationState)))
    io.write("RECONCILIATION REQUIRED  independent verification evidence is unavailable")
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 2, workspaceState, operationState, report }
  }

  operationState = verification.state
  io.write(renderOperationState(plan.operationId, Operation.operationSemanticKey(operationState)))
  io.write(`LEDGER     durable • sequence ${verification.sequence} • cursor ${verification.lastCursor}`)
  if (verification.status === "verified") {
    io.write("VERIFIED   independent verifier matched the exact expected bytes and SHA-256")
    io.write(`EVIDENCE   ${verification.evidence.snapshotDigest}`)
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 0, workspaceState, operationState, report }
  }
  io.write(
    verification.status === "failed"
      ? "FAILED     independent verification did not match"
      : "RECONCILIATION REQUIRED  independent verification is inconclusive",
  )
  workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
  return { exitCode: verification.status === "failed" ? 1 : 2, workspaceState, operationState, report }
}

function supportsGitInspection(report: WorkspaceTrustReport) {
  const git = report.surfaces.filter((surface) => surface.kind === "git_metadata")
  return (
    report.completeness === "complete" &&
    git.length === 1 &&
    git[0]?.path === ".git" &&
    git[0].entryKind === "directory"
  )
}

function renderGitInspection(inspection: GitInspection) {
  if (inspection.status === "blocked") {
    return [
      `GIT INSPECTION BLOCKED  ${sanitizeTerminalText(inspection.reason)}`,
      "GIT MODE   bounded read-only • baseline not captured • submodules not inspected",
    ]
  }

  const branch = inspection.branch.head ?? `(detached at ${inspection.branch.oid?.slice(0, 12) ?? "unknown"})`
  const upstream = inspection.branch.upstream
    ? `${inspection.branch.upstream} • +${inspection.branch.ahead ?? 0} -${inspection.branch.behind ?? 0} (LOCAL REF ONLY)`
    : "none"
  const lines = [
    "GIT MODE   bounded read-only • baseline not captured • submodules not inspected",
    "GIT DIFF   metadata only • ephemeral • not verified",
    `DIFF BIND  ${sanitizeTerminalText(inspection.diff.observationDigest)}`,
    `GIT BRANCH ${sanitizeTerminalText(branch)}`,
    `UPSTREAM   ${sanitizeTerminalText(upstream)}`,
    `STASH      ${inspection.branch.stashCount}`,
    `CHANGES    ${inspection.staged.length} staged • ${inspection.unstaged.length} unstaged • ${inspection.untracked.length} untracked • ${inspection.conflicts.length} conflicts`,
  ]
  const paths = [
    ...inspection.staged.map((entry) => `STAGED     ${sanitizeTerminalText(entry.path)}`),
    ...inspection.unstaged.map((entry) => `UNSTAGED   ${sanitizeTerminalText(entry.path)}`),
    ...inspection.untracked.map((path) => `UNTRACKED  ${sanitizeTerminalText(path)}`),
    ...inspection.conflicts.map(
      (entry) => `CONFLICT   ${sanitizeTerminalText(entry.code)} • ${sanitizeTerminalText(entry.path)}`,
    ),
  ]
  lines.push(...paths.slice(0, 50))
  if (paths.length > 50) lines.push(`MORE       ${paths.length - 50} bounded entries omitted from terminal output`)
  lines.push(`GIT REPORT ${sanitizeTerminalText(inspection.reportDigest)}`)
  lines.push("AUTHORITY  none • activation remains unavailable")
  return lines
}

function requireMatchingDurableDenial(value: DurableDenial, operationID: string) {
  if (
    value.operationID !== operationID ||
    value.state !== "denied" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.lastCursor) ||
    value.lastCursor < 1
  ) {
    throw new Error("The durable denial projection does not match the current Operation")
  }
}

function requireMatchingDurableExecution(value: DurableExecution, operationID: string) {
  if (
    value.operationID !== operationID ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.lastCursor) ||
    value.lastCursor < 1 ||
    (value.status === "effect_observed" && value.state !== "effect_observed") ||
    (value.status === "failed_without_effect" && value.state !== "failed") ||
    (value.status === "reconciliation_required" && value.state !== "reconciliation_required")
  ) {
    throw new Error("The durable execution projection does not match the current Operation")
  }
}

function requireMatchingDurableVerification(value: DurableVerification, operationID: string) {
  if (
    value.operationID !== operationID ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.lastCursor) ||
    value.lastCursor < 1 ||
    (value.status === "verified" && value.state !== "succeeded") ||
    (value.status === "failed" && value.state !== "failed") ||
    (value.status === "unknown" && value.state !== "reconciliation_required")
  ) {
    throw new Error("The durable verification projection does not match the current Operation")
  }
}

function recordingFailureMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "git_baseline_unavailable") return "Git baseline is unavailable in this increment"
    if (error.code === "incomplete_preflight") return "a complete preflight is required"
    if (error.code === "ledger_inside_workspace") return "the Operation ledger path is unsafe"
    if (error.code === "unsafe_ledger_path") return "the Operation ledger path is unsafe"
  }
  return "durable Operation state is unavailable"
}

function advanceWorkspace(
  state: WorkspaceTrustState | null,
  event: WorkspaceTrustEvent,
  io: WorkspaceGateIO,
): WorkspaceTrustState {
  const result = WorkspaceTrust.projectWorkspaceTrustEvent(state, event)
  if (!result.accepted) throw new Error(`Illegal workspace transition: ${state} + ${event}`)
  io.write(renderWorkspaceState(result.state))
  return result.state
}

function advanceOperation(
  state: OperationState | null,
  event: OperationEvent,
  operationId: string,
  io: WorkspaceGateIO,
): OperationState {
  const result = Operation.projectOperationEvent(state, event)
  if (!result.accepted) throw new Error(`Illegal Operation transition: ${state} + ${event}`)
  io.write(renderOperationState(operationId, Operation.operationSemanticKey(result.state)))
  return result.state
}
