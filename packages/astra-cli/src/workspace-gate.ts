import { Operation, WorkspaceTrust } from "@astra/domain"
import type { OperationEvent, OperationState } from "@astra/domain/operation"
import type { WorkspaceTrustEvent, WorkspaceTrustReport, WorkspaceTrustState } from "@astra/domain/workspace-trust"
import { createControlledWritePlan } from "@astra/runtime/controlled-write-plan"
import { revalidateWorkspaceSnapshot, scanWorkspace } from "@astra/runtime/preflight"
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

export async function runWorkspaceGate(workspace: string, io: WorkspaceGateIO): Promise<WorkspaceGateResult> {
  for (const line of renderHeader()) io.write(line)

  let workspaceState = advanceWorkspace(null, "workspace.opened", io)
  const report = await scanWorkspace(workspace)
  workspaceState = advanceWorkspace(
    workspaceState,
    report.completeness === "complete" ? "preflight.completed" : "preflight.blocked",
    io,
  )
  for (const line of renderWorkspaceReport(report)) io.write(line)
  io.write("CHOICES    [R] read-only   [A] activate once   [Q] exit")

  const decision = await io.chooseWorkspaceDecision(report.completeness === "complete")
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
  if (report.completeness !== "complete") {
    io.write("DENIED     activation is unavailable for an incomplete preflight")
    return { exitCode: 2, workspaceState, operationState: null, report }
  }

  const activation = await revalidateWorkspaceSnapshot(report)
  if (!activation.matched) {
    workspaceState = advanceWorkspace(workspaceState, "snapshot.drifted", io)
    io.write(`STALE      ${activation.reason} • run a new preflight`)
    return { exitCode: 2, workspaceState, operationState: null, report: activation.report }
  }

  workspaceState = advanceWorkspace(workspaceState, "decision.activate_once", io)
  io.write("TRUST      once • exact snapshot • current process only • nothing persisted")

  const plan = createControlledWritePlan(report.root)
  let operationState = advanceOperation(null, "operation.admitted", plan.operationId, io)
  operationState = advanceOperation(operationState, "policy.ask", plan.operationId, io)
  for (const line of renderControlledWritePreview(plan)) io.write(line)

  const approval = await io.approveControlledWrite()
  if (approval === "deny") {
    operationState = advanceOperation(operationState, "approval.rejected", plan.operationId, io)
    io.write("DENIED     no dispatch • no host effect")
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 0, workspaceState, operationState, report }
  }

  operationState = advanceOperation(operationState, "approval.granted", plan.operationId, io)
  operationState = advanceOperation(operationState, "dispatch.requested", plan.operationId, io)
  const { prepareControlledWrite } = await import("@astra/runtime/controlled-write")
  const prepared = await prepareControlledWrite(plan, report)
  if (!prepared.prepared) {
    operationState = advanceOperation(operationState, "dispatch.proved_unclaimed", plan.operationId, io)
    operationState = advanceOperation(operationState, "operation.cancelled", plan.operationId, io)
    const snapshotChanged = ["identity_changed", "security_digest_changed", "preflight_blocked"].includes(
      prepared.reason,
    )
    workspaceState = advanceWorkspace(workspaceState, snapshotChanged ? "snapshot.drifted" : "process.ended", io)
    io.write(`CANCELLED  ${prepared.reason} • no host effect`)
    return { exitCode: 2, workspaceState, operationState, report }
  }

  operationState = advanceOperation(operationState, "executor.accepted", plan.operationId, io)
  const effect = await prepared.execute()
  if (effect.status === "failed_without_effect") {
    operationState = advanceOperation(operationState, "execution.failed_without_effect", plan.operationId, io)
    io.write(`FAILED     ${effect.reason} • no host effect observed`)
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 1, workspaceState, operationState, report }
  }

  operationState = advanceOperation(operationState, "effect.observed", plan.operationId, io)
  io.write("EFFECT OBSERVED — NOT VERIFIED")
  operationState = advanceOperation(operationState, "verification.started", plan.operationId, io)

  if (effect.status === "effect_observed_unverified") {
    operationState = advanceOperation(operationState, "verification.unknown", plan.operationId, io)
    io.write(`RECONCILIATION REQUIRED  ${effect.reason}`)
    workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
    return { exitCode: 2, workspaceState, operationState, report }
  }

  operationState = advanceOperation(operationState, "verification.passed", plan.operationId, io)
  io.write("VERIFIED   demo marker matches the exact expected bytes and SHA-256")
  io.write(`EVIDENCE   ${effect.receipt.observedDigest} • ${effect.receipt.bytes} bytes`)
  workspaceState = advanceWorkspace(workspaceState, "process.ended", io)
  return { exitCode: 0, workspaceState, operationState, report }
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
