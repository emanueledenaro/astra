import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { GitRepositoryBaselineRevalidationResult } from "@astra/domain/git-repository-baseline"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { ControlledWriteCapabilityProposal } from "@astra/runtime/controlled-write-capability"
import type {
  DurableControlledWriteResult,
  ExecuteApprovedControlledWriteInput,
} from "@astra/runtime/controlled-write-coordinator"
import type { DurableVerificationResult } from "@astra/runtime/controlled-write-verifier"
import type { ControlledWritePlan } from "@astra/runtime/controlled-write-plan"
import { createControlledWritePlan, demoMarkerName } from "@astra/runtime/controlled-write-plan"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

const maximumPreparedOperations = 32

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type ControlledWritePreview = Readonly<{
  schemaVersion: 1
  proposalID: string
  operationID: string
  executionBoundary: "HOST EXECUTION — NO SANDBOX"
  target: typeof demoMarkerName
  resource: string
  bytes: number
  contentDigest: string
  capabilityDigest: string
  expiresAt: string
  effect: "create_only"
  network: "host_unrestricted_not_isolated"
}>

export type ControlledWritePrepareResult =
  | Readonly<{ status: "awaiting_approval"; preview: ControlledWritePreview }>
  | Readonly<{
      status: "blocked"
      reason:
        | "read_only"
        | "control_busy"
        | "control_limit_reached"
        | "workspace_stale"
        | "git_baseline_stale"
        | "target_already_exists"
        | "target_state_unavailable"
        | "capability_unavailable"
    }>

export type ControlledWriteProgress =
  | Readonly<{ status: "recording_authority" }>
  | Readonly<{ status: "host_adapter_validating" }>
  | Readonly<{
      status: "effect_observed_not_verified"
      operationID: string
      receiptID: string
      relativeTarget: typeof demoMarkerName
      bytes: number
      contentDigest: string
    }>
  | Readonly<{ status: "verifying" }>

export type ControlledWriteDecisionResult =
  | Readonly<{
      status: "denied_without_workspace_effect"
      operationID: string
      sequence: number
      lastCursor: number
    }>
  | Readonly<{
      status: "failed_without_effect"
      operationID: string
      sequence: number
      lastCursor: number
      receiptID: string | null
      reason: "kernel_proved_no_effect"
    }>
  | Readonly<{
      status: "verified"
      operationID: string
      sequence: number
      lastCursor: number
      receiptID: string
      evidenceID: string
      evidenceDigest: string
      relativeTarget: typeof demoMarkerName
      bytes: number
      contentDigest: string
    }>
  | Readonly<{
      status: "reconciliation_required"
      operationID: string
      sequence: number | null
      lastCursor: number | null
      reason: "effect_unknown" | "verification_unknown" | "durable_state_unavailable"
    }>
  | Readonly<{
      status: "blocked"
      reason: "proposal_unknown" | "proposal_consumed" | "proposal_expired" | "durable_state_unavailable"
    }>

export type AstraControlledWriteControl = Readonly<{
  prepare: () => Promise<ControlledWritePrepareResult>
  decide: (
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: ControlledWriteProgress) => void,
  ) => Promise<ControlledWriteDecisionResult>
}>

type PendingProposal = Readonly<{
  proposalID: string
  plan: ControlledWritePlan
  report: WorkspaceTrustReport
  repositoryBaseline?: NonNullable<OpenedWorkspace["repositoryBaseline"]>
  capabilityProposal: ControlledWriteCapabilityProposal
  policyAskedAt: string
}>

export type AstraControlledWriteControlDependencies = Readonly<{
  now: () => number
  revalidateWorkspace: (
    report: WorkspaceTrustReport,
  ) => Promise<Readonly<{ matched: boolean; report: WorkspaceTrustReport }>>
  revalidateGit: (
    root: string,
    baseline: NonNullable<OpenedWorkspace["repositoryBaseline"]>,
  ) => Promise<GitRepositoryBaselineRevalidationResult>
  propose: (
    input: Readonly<{
      plan: ControlledWritePlan
      report: WorkspaceTrustReport
      repositoryBaseline?: NonNullable<OpenedWorkspace["repositoryBaseline"]>
      policyAskedAt: string
    }>,
  ) => Promise<ControlledWriteCapabilityProposal>
  recordDenied: (
    input: Readonly<{
      filename: string
      plan: ControlledWritePlan
      report: WorkspaceTrustReport
      repositoryBaseline?: NonNullable<OpenedWorkspace["repositoryBaseline"]>
      capabilityProposal: ControlledWriteCapabilityProposal
      policyAskedAt: string
      approvalRejectedAt: string
      recordingStartedAt: string
    }>,
  ) => Promise<Readonly<{ operationID: string; state: string; sequence: number; lastCursor: number }>>
  execute: (
    input: ExecuteApprovedControlledWriteInput,
    lifecycle: Readonly<{ onHostAdapterEntered: () => void }>,
  ) => Promise<DurableControlledWriteResult>
  verify: (
    input: Readonly<{
      ledgerFilename: string
      plan: ControlledWritePlan
      report: WorkspaceTrustReport
      repositoryBaseline?: NonNullable<OpenedWorkspace["repositoryBaseline"]>
    }>,
  ) => Promise<DurableVerificationResult>
  targetState: (root: string) => Promise<"absent" | "exists" | "unavailable">
}>

/**
 * Owns the trusted, parent-process half of one bounded create-only operation.
 * The child can choose only prepare, approve, or reject; it never supplies the
 * workspace, path, content, executable, or capability.
 */
export function createAstraControlledWriteControl(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraControlledWriteControlDependencies = defaultDependencies(),
): AstraControlledWriteControl {
  let pending: PendingProposal | undefined
  const consumed = new Set<string>()
  let prepared = 0

  return {
    async prepare() {
      if (session.mode !== "activate-once") return { status: "blocked", reason: "read_only" }
      if (pending) {
        if (Date.parse(pending.capabilityProposal.capability.manifest.grant.expiresAt) > dependencies.now()) {
          return { status: "blocked", reason: "control_busy" }
        }
        consumed.add(pending.proposalID)
        pending = undefined
      }
      if (prepared >= maximumPreparedOperations) return { status: "blocked", reason: "control_limit_reached" }

      const current = await dependencies.revalidateWorkspace(session.report).catch(() => null)
      if (!current?.matched || !sameWorkspaceReport(session.report, current.report)) {
        return { status: "blocked", reason: "workspace_stale" }
      }
      if (session.repositoryBaseline) {
        const repository = await dependencies
          .revalidateGit(current.report.root, session.repositoryBaseline)
          .catch(() => null)
        if (
          !repository ||
          repository.status !== "current" ||
          repository.expectedSnapshotDigest !== session.repositoryBaseline.snapshotDigest ||
          repository.currentSnapshotDigest !== session.repositoryBaseline.snapshotDigest
        ) {
          return { status: "blocked", reason: "git_baseline_stale" }
        }
      }

      const targetState = await dependencies.targetState(current.report.root)
      if (targetState === "exists") return { status: "blocked", reason: "target_already_exists" }
      if (targetState !== "absent") return { status: "blocked", reason: "target_state_unavailable" }

      const createdAt = canonicalTimestamp(dependencies.now())
      const plan = createControlledWritePlan(current.report.root, randomUUID(), createdAt)
      const policyAskedAt = canonicalTimestamp(Math.max(dependencies.now(), Date.parse(createdAt)))
      const capabilityProposal = await dependencies
        .propose({
          plan,
          report: current.report,
          ...(session.repositoryBaseline ? { repositoryBaseline: session.repositoryBaseline } : {}),
          policyAskedAt,
        })
        .catch(() => null)
      if (!capabilityProposal) return { status: "blocked", reason: "capability_unavailable" }

      const proposalID = randomUUID()
      pending = Object.freeze({
        proposalID,
        plan,
        report: current.report,
        ...(session.repositoryBaseline ? { repositoryBaseline: session.repositoryBaseline } : {}),
        capabilityProposal,
        policyAskedAt,
      })
      prepared++
      return {
        status: "awaiting_approval",
        preview: Object.freeze({
          schemaVersion: 1,
          proposalID,
          operationID: plan.operationId,
          executionBoundary: "HOST EXECUTION — NO SANDBOX",
          target: demoMarkerName,
          resource: `workspace:${demoMarkerName}`,
          bytes: Buffer.byteLength(plan.content),
          contentDigest: plan.contentDigest,
          capabilityDigest: capabilityProposal.capability.capabilityDigest,
          expiresAt: capabilityProposal.capability.manifest.grant.expiresAt,
          effect: "create_only",
          network: "host_unrestricted_not_isolated",
        }),
      }
    },

    async decide(proposalID, decision, onProgress = () => {}) {
      if (consumed.has(proposalID)) return { status: "blocked", reason: "proposal_consumed" }
      const proposal = pending
      if (!proposal || proposal.proposalID !== proposalID) return { status: "blocked", reason: "proposal_unknown" }

      pending = undefined
      consumed.add(proposalID)
      if (Date.parse(proposal.capabilityProposal.capability.manifest.grant.expiresAt) <= dependencies.now()) {
        return { status: "blocked", reason: "proposal_expired" }
      }

      if (decision === "reject") {
        const rejectedAt = canonicalTimestamp(dependencies.now())
        const recordedAt = canonicalTimestamp(Math.max(dependencies.now(), Date.parse(rejectedAt)))
        const denied = await dependencies
          .recordDenied({
            filename: state.ledgerFilename,
            plan: proposal.plan,
            report: proposal.report,
            ...(proposal.repositoryBaseline ? { repositoryBaseline: proposal.repositoryBaseline } : {}),
            capabilityProposal: proposal.capabilityProposal,
            policyAskedAt: proposal.policyAskedAt,
            approvalRejectedAt: rejectedAt,
            recordingStartedAt: recordedAt,
          })
          .catch(() => null)
        if (!denied || !validDenied(denied, proposal.plan.operationId)) {
          return { status: "blocked", reason: "durable_state_unavailable" }
        }
        return {
          status: "denied_without_workspace_effect",
          operationID: denied.operationID,
          sequence: denied.sequence,
          lastCursor: denied.lastCursor,
        }
      }

      notify(onProgress, { status: "recording_authority" })
      const grantedAt = canonicalTimestamp(dependencies.now())
      const recordedAt = canonicalTimestamp(Math.max(dependencies.now(), Date.parse(grantedAt)))
      const executed = await dependencies
        .execute(
          {
            ledgerFilename: state.ledgerFilename,
            spoolFilename: state.spoolFilename,
            plan: proposal.plan,
            report: proposal.report,
            ...(proposal.repositoryBaseline ? { repositoryBaseline: proposal.repositoryBaseline } : {}),
            capabilityProposal: proposal.capabilityProposal,
            policyAskedAt: proposal.policyAskedAt,
            approvalGrantedAt: grantedAt,
            recordingStartedAt: recordedAt,
          },
          {
            onHostAdapterEntered() {
              notify(onProgress, { status: "host_adapter_validating" })
            },
          },
        )
        .catch(() => null)
      if (!executed || !validExecution(executed, proposal.plan.operationId)) {
        return reconciliation(proposal.plan.operationId, null, "durable_state_unavailable")
      }
      if (executed.status === "failed_without_effect") {
        return {
          status: "failed_without_effect",
          operationID: executed.operationID,
          sequence: executed.sequence,
          lastCursor: executed.lastCursor,
          receiptID: executed.receiptID,
          reason: "kernel_proved_no_effect",
        }
      }
      if (executed.status === "reconciliation_required") {
        return reconciliation(executed.operationID, executed, "effect_unknown")
      }

      if (!executed.receiptID) return reconciliation(executed.operationID, executed, "effect_unknown")
      notify(onProgress, {
        status: "effect_observed_not_verified",
        operationID: executed.operationID,
        receiptID: executed.receiptID,
        relativeTarget: demoMarkerName,
        bytes: Buffer.byteLength(proposal.plan.content),
        contentDigest: proposal.plan.contentDigest,
      })
      notify(onProgress, { status: "verifying" })
      const verified = await dependencies
        .verify({
          ledgerFilename: state.ledgerFilename,
          plan: proposal.plan,
          report: proposal.report,
          ...(proposal.repositoryBaseline ? { repositoryBaseline: proposal.repositoryBaseline } : {}),
        })
        .catch(() => null)
      if (!verified || !validVerification(verified, proposal.plan, executed.receiptID)) {
        return reconciliation(executed.operationID, executed, "verification_unknown")
      }
      if (verified.status !== "verified") {
        return reconciliation(verified.operationID, verified, "verification_unknown")
      }
      return {
        status: "verified",
        operationID: verified.operationID,
        sequence: verified.sequence,
        lastCursor: verified.lastCursor,
        receiptID: executed.receiptID,
        evidenceID: verified.evidence.evidenceID,
        evidenceDigest: verified.evidence.snapshotDigest,
        relativeTarget: demoMarkerName,
        bytes: Buffer.byteLength(proposal.plan.content),
        contentDigest: proposal.plan.contentDigest,
      }
    },
  }
}

function defaultDependencies(): AstraControlledWriteControlDependencies {
  return {
    now: Date.now,
    async revalidateWorkspace(report) {
      const runtime = await import("@astra/runtime/preflight")
      return runtime.revalidateWorkspacePreflight(report)
    },
    async revalidateGit(root, baseline) {
      const git = await import("@astra/git")
      return git.revalidateGitRepositoryBaseline(root, baseline)
    },
    async propose(input) {
      const runtime = await import("@astra/runtime/controlled-write-capability")
      return runtime.proposeControlledWriteCapability(input)
    },
    async recordDenied(input) {
      const runtime = await import("@astra/runtime/operation-ledger")
      return runtime.recordDeniedControlledWrite(input)
    },
    async execute(input, lifecycle) {
      const runtime = await import("@astra/runtime/controlled-write-coordinator")
      return runtime.executeApprovedControlledWrite(input, lifecycle)
    },
    async verify(input) {
      const runtime = await import("@astra/runtime/controlled-write-verifier")
      return runtime.verifyRecordedControlledWrite(input)
    },
    targetState,
  }
}

async function targetState(root: string) {
  try {
    await lstat(join(root, demoMarkerName))
    return "exists" as const
  } catch (error) {
    return isNodeError(error, "ENOENT") ? ("absent" as const) : ("unavailable" as const)
  }
}

function validDenied(
  value: Readonly<{ operationID: string; state: string; sequence: number; lastCursor: number }>,
  id: string,
) {
  return value.operationID === id && value.state === "denied" && positive(value.sequence) && positive(value.lastCursor)
}

function validExecution(value: DurableControlledWriteResult, id: string) {
  return (
    value.operationID === id &&
    positive(value.sequence) &&
    positive(value.lastCursor) &&
    ((value.status === "effect_observed" && value.state === "effect_observed" && value.receiptID !== null) ||
      (value.status === "failed_without_effect" && value.state === "failed") ||
      (value.status === "reconciliation_required" && value.state === "reconciliation_required"))
  )
}

function validVerification(value: DurableVerificationResult, plan: ControlledWritePlan, receiptID: string | null) {
  const criterion = value.evidence.criteria.length === 1 ? value.evidence.criteria[0] : undefined
  return (
    value.operationID === plan.operationId &&
    positive(value.sequence) &&
    positive(value.lastCursor) &&
    value.evidence.operationID === plan.operationId &&
    receiptID !== null &&
    value.evidence.receiptID === receiptID &&
    criterion?.criterionID === "marker_exact_bytes" &&
    ((value.status === "verified" &&
      value.state === "succeeded" &&
      criterion.result === "passed" &&
      criterion.observationDigest === plan.contentDigest) ||
      (value.status === "failed" && value.state === "failed" && criterion.result === "failed") ||
      (value.status === "unknown" && value.state === "reconciliation_required" && criterion.result === "unknown"))
  )
}

function reconciliation(
  operationID: string,
  durable: Readonly<{ sequence: number; lastCursor: number }> | null,
  reason: Extract<ControlledWriteDecisionResult, { status: "reconciliation_required" }>["reason"],
): ControlledWriteDecisionResult {
  return {
    status: "reconciliation_required",
    operationID,
    sequence: durable?.sequence ?? null,
    lastCursor: durable?.lastCursor ?? null,
    reason,
  }
}

function sameWorkspaceReport(expected: WorkspaceTrustReport, current: WorkspaceTrustReport) {
  return (
    current.completeness === "complete" &&
    current.root === expected.root &&
    current.securityDigest === expected.securityDigest &&
    current.identity?.device === expected.identity?.device &&
    current.identity?.inode === expected.identity?.inode
  )
}

function canonicalTimestamp(milliseconds: number) {
  return new Date(milliseconds).toISOString()
}

function notify(callback: (progress: ControlledWriteProgress) => void, progress: ControlledWriteProgress) {
  try {
    callback(progress)
  } catch {
    // Observation delivery must never change or retry an Operation.
  }
}

function positive(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
