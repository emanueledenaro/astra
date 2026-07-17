import { randomUUID } from "node:crypto"
import type {
  GitUnstageControlPreview,
  GitUnstageDecisionResult,
  GitUnstageProgress,
  GitUnstagePrepareResult,
} from "@astra/domain/git-unstage-control"
import { parseGitUnstageAllPreview, type GitUnstageAllDecision } from "@astra/domain/git-control-mutation"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  executeClaimedGitUnstageAll,
  prepareGitUnstageAll,
  verifyGitUnstageAll,
  type GitInspectionResult,
  type GitUnstageAllPreparationResult,
} from "@astra/git"
import {
  executeDurableGitUnstage,
  verifyDurableGitUnstage,
  type DurableGitUnstageInput,
  type DurableGitUnstageResult,
  type GitUnstageAdapter,
} from "@astra/runtime/git-unstage-coordinator"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

const maximumPreparedOperations = 32

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type AstraGitUnstageControl = Readonly<{
  prepare: (requestId: string) => Promise<GitUnstagePrepareResult>
  decide: (
    requestId: string,
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: GitUnstageProgress) => void,
  ) => Promise<GitUnstageDecisionResult>
}>

type PendingProposal = Readonly<{
  proposalID: string
  preview: GitUnstageControlPreview
  baseline: GitRepositoryBaselineSnapshot
}>

export type AstraGitUnstageControlDependencies = Readonly<{
  now: () => number
  prepare: (
    workspaceRoot: string,
    baseline: GitRepositoryBaselineSnapshot,
    inspection: Extract<GitInspectionResult, { status: "complete" }>,
  ) => Promise<GitUnstageAllPreparationResult>
  execute: (input: DurableGitUnstageInput, adapter: GitUnstageAdapter) => Promise<DurableGitUnstageResult>
  verify: (
    input: DurableGitUnstageInput,
    adapter: Pick<GitUnstageAdapter, "verify">,
  ) => Promise<DurableGitUnstageResult>
  adapter: GitUnstageAdapter
}>

/** Owns the exact Unstage-all proposal, baseline, state paths, and host adapter.
 * The child can select only prepare, approve, or reject. */
export function createAstraGitUnstageControl(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraGitUnstageControlDependencies = defaultDependencies(),
): AstraGitUnstageControl {
  let pending: PendingProposal | undefined
  const consumed = new Set<string>()
  let prepared = 0

  return {
    async prepare(requestId) {
      if (session.mode !== "activate-once") return blockedPrepare(requestId, "read_only")
      if (!session.repositoryBaseline) return blockedPrepare(requestId, "git_baseline_required")
      if (!session.repositoryInspection) return blockedPrepare(requestId, "git_inspection_required")
      if (pending) {
        if (Date.parse(pending.preview.authority.expiresAt) > dependencies.now()) {
          return blockedPrepare(requestId, "control_busy")
        }
        consumed.add(pending.proposalID)
        pending = undefined
      }
      if (prepared >= maximumPreparedOperations) return blockedPrepare(requestId, "control_limit_reached")

      const result = await dependencies
        .prepare(session.report.root, session.repositoryBaseline, session.repositoryInspection)
        .catch(() => null)
      if (!result || result.status !== "ready") {
        return blockedPrepare(requestId, result?.status === "blocked" ? result.reason : "preparation_unavailable")
      }
      const authority = parseGitUnstageAllPreview(result.preview)
      if (
        !authority.ok ||
        authority.value.workspaceRoot !== session.report.root ||
        authority.value.baseline.snapshotDigest !== session.repositoryBaseline.snapshotDigest ||
        authority.value.inspection.observationDigest !== session.repositoryInspection.outputDigest ||
        authority.value.inspection.reportDigest !== session.repositoryInspection.reportDigest ||
        Date.parse(authority.value.expiresAt) <= dependencies.now()
      ) {
        return blockedPrepare(requestId, "preparation_unavailable")
      }

      const proposalID = randomUUID()
      const preview = deepFreeze({
        schemaVersion: 1,
        action: "Unstage all",
        proposalID,
        authority: authority.value,
      } as const satisfies GitUnstageControlPreview)
      pending = Object.freeze({ proposalID, preview, baseline: session.repositoryBaseline })
      prepared++
      return { schemaVersion: 1, requestId, status: "prepared", preview }
    },

    async decide(requestId, proposalID, decision, onProgress = () => {}) {
      const proposal = pending
      if (consumed.has(proposalID)) return blockedDecision(requestId, proposalID, "proposal_consumed")
      if (!proposal || proposal.proposalID !== proposalID) {
        return blockedDecision(requestId, proposalID, "proposal_unknown")
      }
      pending = undefined
      consumed.add(proposalID)
      const decisionTime = dependencies.now()
      if (Date.parse(proposal.preview.authority.expiresAt) <= decisionTime) {
        return blockedDecision(requestId, proposalID, "proposal_expired")
      }

      const decidedAt = canonicalTimestamp(decisionTime)
      const durableInput = {
        preview: proposal.preview.authority,
        expectedBaseline: proposal.baseline,
        decision: {
          schemaVersion: 1,
          operation: "git_unstage_all",
          proposalDigest: proposal.preview.authority.proposalDigest,
          nonce: proposal.preview.authority.nonce,
          decision: decision === "approve" ? "approved" : "rejected",
          decidedAt,
        } satisfies GitUnstageAllDecision,
        recordingStartedAt: decidedAt,
        ledgerFilename: state.ledgerFilename,
        spoolFilename: state.spoolFilename,
      } as const satisfies DurableGitUnstageInput
      const binding = {
        schemaVersion: 1,
        requestId,
        proposalID,
        proposalDigest: proposal.preview.authority.proposalDigest,
      } as const

      if (decision === "reject") {
        const denied = await dependencies.execute(durableInput, dependencies.adapter).catch(() => null)
        if (!denied || denied.status !== "denied_without_effect") {
          return blockedDecision(requestId, proposalID, "durable_rejection_unavailable")
        }
        return { ...binding, status: "denied_without_git_effect", operationID: denied.operationID }
      }

      notify(onProgress, { ...binding, status: "recording_authority", verification: "not_verified" })
      const adapter = progressAdapter(dependencies.adapter, () =>
        notify(onProgress, { ...binding, status: "host_adapter_validating", verification: "not_verified" }),
      )
      const executed = await dependencies.execute(durableInput, adapter).catch(() => null)
      if (!executed) return reconciliation(binding, null, "durable_state_unavailable")
      if (executed.status === "failed_without_effect") {
        return {
          ...binding,
          status: "failed_without_effect",
          operationID: executed.operationID,
          reason: "kernel_proved_no_effect",
        }
      }
      if (executed.status === "reconciliation_required") {
        return reconciliation(binding, executed.operationID, "effect_unknown")
      }
      if (
        executed.status !== "effect_observed" ||
        !executed.receiptID ||
        !executed.observation ||
        executed.observation.proposalDigest !== binding.proposalDigest
      ) {
        return reconciliation(binding, executed.operationID, "effect_observation_unavailable")
      }
      notify(onProgress, {
        ...binding,
        status: "effect_observed_not_verified",
        verification: "not_verified",
        operationID: executed.operationID,
        receiptID: executed.receiptID,
        snapshotDigest: executed.observation.afterSnapshotDigest,
      })
      notify(onProgress, { ...binding, status: "verifying", verification: "not_verified" })
      const verified = await dependencies.verify(durableInput, adapter).catch(() => null)
      if (
        !verified ||
        verified.status !== "verified" ||
        verified.operationID !== executed.operationID ||
        verified.receiptID !== executed.receiptID ||
        verified.observation?.afterSnapshotDigest !== executed.observation.afterSnapshotDigest
      ) {
        return reconciliation(binding, executed.operationID, "verification_unknown")
      }
      return {
        ...binding,
        status: "verified",
        verification: "independent_post_state",
        operationID: verified.operationID,
        receiptID: verified.receiptID,
        snapshotDigest: verified.observation.afterSnapshotDigest,
      }
    },
  }
}

function defaultDependencies(): AstraGitUnstageControlDependencies {
  const adapter = {
    execute: (input, claimProposal) => executeClaimedGitUnstageAll(input, claimProposal),
    verify: (input) => verifyGitUnstageAll(input),
  } satisfies GitUnstageAdapter
  return {
    now: Date.now,
    prepare: prepareGitUnstageAll,
    execute: (input, selectedAdapter) => executeDurableGitUnstage(input, { adapter: selectedAdapter }),
    verify: verifyDurableGitUnstage,
    adapter,
  }
}

function progressAdapter(adapter: GitUnstageAdapter, onHostEffect: () => void): GitUnstageAdapter {
  return {
    execute(input, claimProposal) {
      onHostEffect()
      return adapter.execute(input, claimProposal)
    },
    verify: adapter.verify,
  }
}

function blockedPrepare(requestId: string, reason: string): GitUnstagePrepareResult {
  return { schemaVersion: 1, requestId, status: "blocked", reason }
}

function blockedDecision(requestId: string, proposalID: string, reason: string): GitUnstageDecisionResult {
  return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason }
}

function reconciliation(
  binding: Readonly<{
    schemaVersion: 1
    requestId: string
    proposalID: string
    proposalDigest: `sha256:${string}`
  }>,
  operationID: string | null,
  reason: string,
): GitUnstageDecisionResult {
  return { ...binding, status: "reconciliation_required", operationID, reason }
}

function canonicalTimestamp(milliseconds: number) {
  if (!Number.isFinite(milliseconds)) throw new TypeError("The Git control clock is invalid")
  return new Date(milliseconds).toISOString()
}

function notify(onProgress: (progress: GitUnstageProgress) => void, progress: GitUnstageProgress) {
  try {
    onProgress(Object.freeze(progress))
  } catch {
    // Progress is advisory. Durable execution and reconciliation continue.
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
