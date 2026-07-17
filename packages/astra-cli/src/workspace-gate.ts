import { Operation, WorkspaceTrust } from "@astra/domain"
import type { OperationEvent, OperationState } from "@astra/domain/operation"
import type { WorkspaceTrustEvent, WorkspaceTrustReport, WorkspaceTrustState } from "@astra/domain/workspace-trust"
import { createControlledWritePlan } from "@astra/runtime/controlled-write-plan"
import { checkWorkspaceActivation, revalidateWorkspaceSnapshot, scanWorkspace } from "@astra/runtime/preflight"
import {
  renderControlledWritePreview,
  renderHeader,
  renderOperationState,
  renderWorkspaceReport,
  renderWorkspaceState,
} from "./terminal"

export type WorkspaceDecision = "read-only" | "activate-once" | "exit"
export type EffectApproval = "approve" | "deny"

export type WorkspaceGateIO = Readonly<{
  write: (line: string) => void
  chooseWorkspaceDecision: (activationAllowed: boolean) => Promise<WorkspaceDecision>
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

export type WorkspaceGateDependencies = Readonly<{
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
  io.write(
    activationCheck.allowed
      ? "CHOICES    [R] read-only   [A] activate once   [Q] exit"
      : "CHOICES    [R] read-only   [Q] exit   • activate once unavailable",
  )

  const decision = await io.chooseWorkspaceDecision(activationCheck.allowed)
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
