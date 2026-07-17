import { randomUUID } from "node:crypto"
import {
  parseGitStageControlInventory,
  type GitStageControlInventory,
  type GitStageControlPreview,
  type GitStageDecisionResult,
  type GitStageInventoryResult,
  type GitStagePrepareResult,
  type GitStageProgress,
} from "../../astra-domain/src/git-stage-control"
import {
  gitStageLimitations,
  parseGitStageInventory,
  parseGitStagePreview,
  type GitStageDecision,
  type GitStageInventory,
} from "../../astra-domain/src/git-stage-mutation"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  captureGitStageInventory,
  executeClaimedGitStageSelected,
  prepareGitStageSelected,
  verifyGitStageSelected,
  type GitInspectionResult,
  type GitStageInventoryResult as GitStageCoreInventoryResult,
  type GitStagePreparationResult,
} from "@astra/git"
import {
  executeDurableGitStage,
  verifyDurableGitStage,
  type DurableGitStageInput,
  type DurableGitStageResult,
  type GitStageAdapter,
} from "../../astra-runtime/src/git-stage-coordinator"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

const maximumInventories = 32
const inventoryLifetimeMilliseconds = 5 * 60 * 1_000

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type AstraGitStageControl = Readonly<{
  inventory: (requestId: string) => Promise<GitStageInventoryResult>
  prepare: (
    requestId: string,
    inventoryID: string,
    candidateIDs: ReadonlyArray<string>,
  ) => Promise<GitStagePrepareResult>
  decide: (
    requestId: string,
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: GitStageProgress) => void,
  ) => Promise<GitStageDecisionResult>
}>

type PendingInventory = Readonly<{
  inventoryID: string
  expiresAt: string
  authority: GitStageInventory
  publicInventory: GitStageControlInventory
  baseline: GitRepositoryBaselineSnapshot
}>

type PendingProposal = Readonly<{
  proposalID: string
  preview: GitStageControlPreview
  inventory: GitStageInventory
  baseline: GitRepositoryBaselineSnapshot
}>

export type AstraGitStageControlDependencies = Readonly<{
  now: () => number
  captureInventory: (
    workspaceRoot: string,
    baseline: GitRepositoryBaselineSnapshot,
    inspection: Extract<GitInspectionResult, { status: "complete" }>,
  ) => Promise<GitStageCoreInventoryResult>
  prepare: (inventory: GitStageInventory, candidateIDs: ReadonlyArray<string>, now: number) => GitStagePreparationResult
  execute: (input: DurableGitStageInput, adapter: GitStageAdapter) => Promise<DurableGitStageResult>
  verify: (input: DurableGitStageInput, adapter: Pick<GitStageAdapter, "verify">) => Promise<DurableGitStageResult>
  adapter: GitStageAdapter
}>

/** Owns inventory authority, opaque selection IDs, and the exact durable Stage
 * proposal. The child can request inventory, select IDs, then approve/reject. */
export function createAstraGitStageControl(
  session: OpenedWorkspace,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string }>,
  dependencies: AstraGitStageControlDependencies = defaultDependencies(),
): AstraGitStageControl {
  let pendingInventory: PendingInventory | undefined
  let pendingProposal: PendingProposal | undefined
  let inventoryCount = 0
  const consumedInventories = new Set<string>()
  const consumedProposals = new Set<string>()

  return {
    async inventory(requestId) {
      if (session.mode !== "activate-once") return blockedInventory(requestId, "read_only")
      if (!session.repositoryBaseline) return blockedInventory(requestId, "git_baseline_required")
      if (!session.repositoryInspection) return blockedInventory(requestId, "git_inspection_required")
      if (pendingProposal && Date.parse(pendingProposal.preview.authority.expiresAt) > dependencies.now()) {
        return blockedInventory(requestId, "control_busy")
      }
      if (pendingProposal) consumedProposals.add(pendingProposal.proposalID)
      pendingProposal = undefined
      if (pendingInventory && Date.parse(pendingInventory.expiresAt) > dependencies.now()) {
        return blockedInventory(requestId, "control_busy")
      }
      if (pendingInventory) consumedInventories.add(pendingInventory.inventoryID)
      pendingInventory = undefined
      if (inventoryCount >= maximumInventories) return blockedInventory(requestId, "control_limit_reached")

      const captured = await dependencies
        .captureInventory(session.report.root, session.repositoryBaseline, session.repositoryInspection)
        .catch(() => null)
      if (!captured || captured.status !== "ready") {
        return blockedInventory(requestId, captured?.status === "blocked" ? captured.reason : "inventory_unavailable")
      }
      const authority = parseGitStageInventory(captured.inventory)
      if (
        !authority.ok ||
        authority.value.workspaceRoot !== session.report.root ||
        authority.value.baselineSnapshotDigest !== session.repositoryBaseline.snapshotDigest ||
        authority.value.inspectionObservationDigest !== session.repositoryInspection.outputDigest ||
        authority.value.inspectionReportDigest !== session.repositoryInspection.reportDigest
      ) {
        return blockedInventory(requestId, "inventory_unavailable")
      }
      const inventoryID = randomUUID()
      const expiresAt = canonicalTimestamp(dependencies.now() + inventoryLifetimeMilliseconds)
      const publicInventoryCandidate = {
        schemaVersion: 1,
        action: "Stage selected",
        inventoryID,
        inventoryDigest: authority.value.inventoryDigest,
        baselineSnapshotDigest: authority.value.baselineSnapshotDigest,
        expiresAt,
        boundaryLabel: "HOST EXECUTION — NO SANDBOX",
        verification: "not_verified",
        candidates: authority.value.candidates.map((candidate) => ({
          candidateID: candidate.candidateID,
          path: candidate.path,
          change:
            candidate.after.state === "absent"
              ? ("delete" as const)
              : candidate.before.state === "absent"
                ? ("add" as const)
                : ("modify" as const),
        })),
        limitations: gitStageLimitations,
      } as const satisfies GitStageControlInventory
      const parsedPublicInventory = parseGitStageControlInventory(publicInventoryCandidate)
      if (!parsedPublicInventory.ok) return blockedInventory(requestId, "inventory_unavailable")
      const publicInventory = deepFreeze(parsedPublicInventory.value)
      pendingInventory = Object.freeze({
        inventoryID,
        expiresAt,
        authority: authority.value,
        publicInventory,
        baseline: session.repositoryBaseline,
      })
      inventoryCount++
      return { schemaVersion: 1, requestId, status: "inventory", inventory: publicInventory }
    },

    async prepare(requestId, inventoryID, candidateIDs) {
      if (consumedInventories.has(inventoryID)) return blockedPrepare(requestId, "inventory_consumed")
      const inventory = pendingInventory
      if (!inventory || inventory.inventoryID !== inventoryID) return blockedPrepare(requestId, "inventory_unknown")
      if (Date.parse(inventory.expiresAt) <= dependencies.now()) {
        pendingInventory = undefined
        consumedInventories.add(inventoryID)
        return blockedPrepare(requestId, "inventory_expired")
      }
      if (pendingProposal) return blockedPrepare(requestId, "control_busy")
      const selected = new Set(candidateIDs)
      if (
        selected.size !== candidateIDs.length ||
        candidateIDs.length < 1 ||
        candidateIDs.some(
          (candidateID) => !inventory.authority.candidates.some((candidate) => candidate.candidateID === candidateID),
        )
      ) {
        return blockedPrepare(requestId, "invalid_selection")
      }
      const result = dependencies.prepare(inventory.authority, candidateIDs, dependencies.now())
      if (result.status !== "ready") return blockedPrepare(requestId, result.reason)
      const authority = parseGitStagePreview(result.preview)
      if (
        !authority.ok ||
        authority.value.inventoryDigest !== inventory.authority.inventoryDigest ||
        authority.value.baselineSnapshotDigest !== inventory.baseline.snapshotDigest ||
        authority.value.workspaceRoot !== session.report.root ||
        authority.value.selection.candidateIDs.length !== candidateIDs.length ||
        authority.value.selection.candidateIDs.some((candidateID) => !selected.has(candidateID)) ||
        !exactSelectedCandidates(authority.value, inventory.authority) ||
        Date.parse(authority.value.expiresAt) <= dependencies.now()
      ) {
        return blockedPrepare(requestId, "preparation_unavailable")
      }
      const proposalID = randomUUID()
      const preview = deepFreeze({
        schemaVersion: 1,
        action: "Stage selected",
        proposalID,
        authority: authority.value,
      } as const satisfies GitStageControlPreview)
      pendingInventory = undefined
      consumedInventories.add(inventoryID)
      pendingProposal = Object.freeze({
        proposalID,
        preview,
        inventory: inventory.authority,
        baseline: inventory.baseline,
      })
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
          operation: "git_stage_paths",
          proposalDigest: proposal.preview.authority.proposalDigest,
          nonce: proposal.preview.authority.nonce,
          decision: decision === "approve" ? "approved" : "rejected",
          decidedAt,
        } satisfies GitStageDecision,
        recordingStartedAt: decidedAt,
        ledgerFilename: state.ledgerFilename,
        spoolFilename: state.spoolFilename,
      } as const satisfies DurableGitStageInput
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
        verification: "independent_selected_index_and_preservation",
        operationID: verified.operationID,
        receiptID: verified.receiptID,
        snapshotDigest: verified.observation.afterSnapshotDigest,
      }
    },
  }
}

function exactSelectedCandidates(preview: GitStageControlPreview["authority"], inventory: GitStageInventory) {
  const candidates = new Map(inventory.candidates.map((candidate) => [candidate.candidateID, candidate]))
  return preview.candidates.every((candidate, index) => {
    const expected = candidates.get(preview.selection.candidateIDs[index] ?? "")
    return expected !== undefined && JSON.stringify(candidate) === JSON.stringify(expected)
  })
}

function defaultDependencies(): AstraGitStageControlDependencies {
  const adapter = {
    execute: (input, claimProposal) => executeClaimedGitStageSelected(input, claimProposal),
    verify: verifyGitStageSelected,
  } satisfies GitStageAdapter
  return {
    now: Date.now,
    captureInventory: captureGitStageInventory,
    prepare: prepareGitStageSelected,
    execute: (input, selectedAdapter) => executeDurableGitStage(input, { adapter: selectedAdapter }),
    verify: verifyDurableGitStage,
    adapter,
  }
}

function progressAdapter(adapter: GitStageAdapter, onHostEffect: () => void): GitStageAdapter {
  return {
    execute(input, claimProposal) {
      onHostEffect()
      return adapter.execute(input, claimProposal)
    },
    verify: adapter.verify,
  }
}

function blockedInventory(requestId: string, reason: string): GitStageInventoryResult {
  return { schemaVersion: 1, requestId, status: "blocked", reason }
}
function blockedPrepare(requestId: string, reason: string): GitStagePrepareResult {
  return { schemaVersion: 1, requestId, status: "blocked", reason }
}
function blockedDecision(requestId: string, proposalID: string, reason: string): GitStageDecisionResult {
  return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason }
}
function reconciliation(
  binding: Readonly<{ schemaVersion: 1; requestId: string; proposalID: string; proposalDigest: `sha256:${string}` }>,
  operationID: string | null,
  reason: string,
): GitStageDecisionResult {
  return { ...binding, status: "reconciliation_required", operationID, reason }
}
function canonicalTimestamp(milliseconds: number) {
  if (!Number.isFinite(milliseconds)) throw new TypeError("The Git stage control clock is invalid")
  return new Date(milliseconds).toISOString()
}
function notify(onProgress: (progress: GitStageProgress) => void, progress: GitStageProgress) {
  try {
    onProgress(Object.freeze(progress))
  } catch {
    /* Progress is advisory. */
  }
}
function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
