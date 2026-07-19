import { randomUUID } from "node:crypto"
import {
  parseGitCommitControlPreview,
  type GitCommitControlPreview,
  type GitCommitDecisionResult,
  type GitCommitPrepareResult,
  type GitCommitProgress,
} from "../../astra-domain/src/git-commit-control"
import {
  parseGitCommitMessage,
  type GitCommitDecision,
  type GitCommitInventory,
} from "../../astra-domain/src/git-commit-mutation"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  executeGitCommitLocal,
  prepareGitCommitLocal,
  verifyGitCommitLocal,
  type GitCommitPreparationResult,
} from "@astra/git"
import {
  executeDurableGitCommit,
  verifyDurableGitCommit,
  type DurableGitCommitInput,
  type DurableGitCommitResult,
  type GitCommitAdapter,
} from "../../astra-runtime/src/git-commit-coordinator"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

const maximumProposals = 32

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type AstraGitCommitControl = Readonly<{
  prepare: (requestId: string, message: string) => Promise<GitCommitPrepareResult>
  decide: (
    requestId: string,
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: GitCommitProgress) => void,
  ) => Promise<GitCommitDecisionResult>
}>

type PendingProposal = Readonly<{
  proposalID: string
  preview: GitCommitControlPreview
  inventory: GitCommitInventory
  baseline: GitRepositoryBaselineSnapshot
}>

export type AstraGitCommitControlDependencies = Readonly<{
  now: () => number
  prepare: (
    workspaceRoot: string,
    baseline: GitRepositoryBaselineSnapshot,
    message: string,
    now: number,
  ) => Promise<GitCommitPreparationResult>
  execute: (input: DurableGitCommitInput, adapter: GitCommitAdapter) => Promise<DurableGitCommitResult>
  verify: (input: DurableGitCommitInput, adapter: Pick<GitCommitAdapter, "verify">) => Promise<DurableGitCommitResult>
  adapter: GitCommitAdapter
}>

/** Owns the exact durable local-commit proposal. The child controls only the
 * validated message text; every repository fact in the preview is parent-owned. */
export function createAstraGitCommitControl(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraGitCommitControlDependencies = defaultDependencies(),
): AstraGitCommitControl {
  let pendingProposal: PendingProposal | undefined
  let proposalCount = 0
  const consumedProposals = new Set<string>()

  return {
    async prepare(requestId, message) {
      if (session.mode !== "activate-once") return blockedPrepare(requestId, "read_only")
      const parsedMessage = parseGitCommitMessage(message)
      if (!parsedMessage.ok) return blockedPrepare(requestId, "invalid_commit_message")
      if (!session.repositoryBaseline) return blockedPrepare(requestId, "git_baseline_required")
      if (pendingProposal && Date.parse(pendingProposal.preview.authority.expiresAt) > dependencies.now()) {
        return blockedPrepare(requestId, "control_busy")
      }
      if (pendingProposal) consumedProposals.add(pendingProposal.proposalID)
      pendingProposal = undefined
      if (proposalCount >= maximumProposals) return blockedPrepare(requestId, "control_limit_reached")

      const prepared = await dependencies
        .prepare(session.report.root, session.repositoryBaseline, parsedMessage.value, dependencies.now())
        .catch(() => null)
      if (!prepared) return blockedPrepare(requestId, "preparation_unavailable")
      if (prepared.status !== "ready") return blockedPrepare(requestId, prepared.reason)
      if (
        prepared.preview.workspaceRoot !== session.report.root ||
        prepared.preview.baselineSnapshotDigest !== session.repositoryBaseline.snapshotDigest ||
        prepared.preview.message !== parsedMessage.value ||
        prepared.inventory.inventoryDigest !== prepared.preview.inventoryDigest ||
        prepared.baseline.snapshotDigest !== session.repositoryBaseline.snapshotDigest ||
        Date.parse(prepared.preview.expiresAt) <= dependencies.now()
      ) {
        return blockedPrepare(requestId, "preparation_unavailable")
      }
      const proposalID = randomUUID()
      const parsedPreview = parseGitCommitControlPreview({
        schemaVersion: 1,
        action: "Commit staged",
        proposalID,
        authority: prepared.preview,
      })
      if (!parsedPreview.ok) return blockedPrepare(requestId, "preparation_unavailable")
      const preview = parsedPreview.value
      pendingProposal = Object.freeze({
        proposalID,
        preview,
        inventory: prepared.inventory,
        baseline: prepared.baseline,
      })
      proposalCount++
      return { schemaVersion: 1, requestId, status: "prepared", preview }
    },

    async decide(requestId, proposalID, decision, onProgress = () => {}) {
      if (consumedProposals.has(proposalID)) return blockedDecision(requestId, proposalID, "proposal_consumed")
      const proposal = pendingProposal
      if (!proposal || proposal.proposalID !== proposalID)
        return blockedDecision(requestId, proposalID, "proposal_unknown")
      pendingProposal = undefined
      consumedProposals.add(proposalID)
      const decisionTime = dependencies.now()
      if (Date.parse(proposal.preview.authority.expiresAt) <= decisionTime) {
        return blockedDecision(requestId, proposalID, "proposal_expired")
      }
      const decidedAt = canonicalTimestamp(decisionTime)
      const durableInput = {
        preview: proposal.preview.authority,
        inventory: proposal.inventory,
        expectedBaseline: proposal.baseline,
        decision: {
          schemaVersion: 1,
          operation: "git_commit_local",
          proposalDigest: proposal.preview.authority.proposalDigest,
          nonce: proposal.preview.authority.nonce,
          decision: decision === "approve" ? "approved" : "rejected",
          decidedAt,
        } satisfies GitCommitDecision,
        recordingStartedAt: decidedAt,
        ledgerFilename: state.ledgerFilename,
        spoolFilename: state.spoolFilename,
      } as const satisfies DurableGitCommitInput
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
      if (executed.status === "reconciliation_required")
        return reconciliation(binding, executed.operationID, "effect_unknown")
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
        commitOID: executed.observation.afterOID,
      })
      notify(onProgress, { ...binding, status: "verifying", verification: "not_verified" })
      const verified = await dependencies.verify(durableInput, adapter).catch(() => null)
      if (
        !verified ||
        verified.status !== "verified" ||
        verified.operationID !== executed.operationID ||
        verified.receiptID !== executed.receiptID ||
        verified.observation?.afterOID !== executed.observation.afterOID
      ) {
        return reconciliation(binding, executed.operationID, "verification_unknown")
      }
      return {
        ...binding,
        status: "verified",
        verification: "independent_commit_bytes_and_repository_state",
        operationID: verified.operationID,
        receiptID: verified.receiptID,
        commitOID: verified.observation.afterOID,
      }
    },
  }
}

function defaultDependencies(): AstraGitCommitControlDependencies {
  const adapter = {
    execute: (input, claimProposal) => executeGitCommitLocal(input, { claimProposal }),
    verify: (input) => verifyGitCommitLocal(input),
  } satisfies GitCommitAdapter
  return {
    now: Date.now,
    prepare: (workspaceRoot, baseline, message, now) =>
      prepareGitCommitLocal(workspaceRoot, baseline, message, process.env, now),
    execute: (input, selectedAdapter) => executeDurableGitCommit(input, { adapter: selectedAdapter }),
    verify: verifyDurableGitCommit,
    adapter,
  }
}

function progressAdapter(adapter: GitCommitAdapter, onHostEffect: () => void): GitCommitAdapter {
  return {
    execute(input, claimProposal) {
      onHostEffect()
      return adapter.execute(input, claimProposal)
    },
    verify: adapter.verify,
  }
}

function blockedPrepare(requestId: string, reason: string): GitCommitPrepareResult {
  return { schemaVersion: 1, requestId, status: "blocked", reason }
}
function blockedDecision(requestId: string, proposalID: string, reason: string): GitCommitDecisionResult {
  return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason }
}
function reconciliation(
  binding: Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; proposalDigest: `sha256:${string}` }>,
  operationID: string | null,
  reason: string,
): GitCommitDecisionResult {
  return { ...binding, status: "reconciliation_required", operationID, reason }
}
function canonicalTimestamp(milliseconds: number) {
  if (!Number.isFinite(milliseconds)) throw new TypeError("The Git commit control clock is invalid")
  return new Date(milliseconds).toISOString()
}
function notify(onProgress: (progress: GitCommitProgress) => void, progress: GitCommitProgress) {
  try {
    onProgress(Object.freeze(progress))
  } catch {
    /* Progress is advisory. */
  }
}
