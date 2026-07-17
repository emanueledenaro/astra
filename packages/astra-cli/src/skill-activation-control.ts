import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { GitRepositoryBaselineRevalidationResult } from "@astra/domain/git-repository-baseline"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import type {
  DurableSkillActivationResult,
  SkillActivationProposal,
} from "../../astra-runtime/src/skill-activation"
import type {
  SkillInventoryCandidate,
  SkillInventoryLimits,
  SkillInventoryResult,
} from "../../astra-runtime/src/skill-inventory"
import { canonicalJson } from "../../astra-runtime/src/controlled-write-authority"
import {
  makeSkillActivationOperationFacts,
  sameSkillActivationCapability,
} from "../../astra-runtime/src/skill-activation-operation-facts"
import type { WorkspaceRevalidation } from "../../astra-runtime/src/workspace-preflight"
import {
  skillActivationBoundaryLabel,
  skillInstructionTrustLabel,
  skillMetadataTrustLabel,
  type SkillActivationDecisionResult,
  type SkillActivationPrepareResult,
  type SkillActivationProgress,
  type SkillInventoryCandidateView,
  type SkillInventoryResult as PublicSkillInventoryResult,
} from "../../astra-domain/src/skill-activation-control"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

export type TrustedPromptSkillBundle = Readonly<{
  operationID: string
  capabilityDigest: `sha256:${string}`
  source: Readonly<{
    provenance: "workspace_opencode"
    relativePath: string
    fileDigest: `sha256:${string}`
    instructionsDigest: `sha256:${string}`
  }>
  skill: Readonly<{
    name: string
    instructions: string
    trust: "untrusted_instruction_data"
    resourceDiscovery: "none"
  }>
  assurance: "observed_not_verified"
}>

export type AstraSkillActivationControl = Readonly<{
  inventory: (requestId: string) => Promise<PublicSkillInventoryResult>
  prepare: (requestId: string, inventoryID: string, candidateID: string) => Promise<SkillActivationPrepareResult>
  decide: (
    requestId: string,
    proposalID: string,
    decision: "approve" | "reject",
    onProgress?: (progress: SkillActivationProgress) => void,
  ) => Promise<SkillActivationDecisionResult>
  takePromptBundle: () => Promise<TrustedPromptSkillBundle | null>
}>

type PreparedActivation = Readonly<{
  proposalID: string
  operationID: string
  candidate: SkillInventoryCandidate
  input: PrepareInput
  proposal: SkillActivationProposal
}>

type PrepareInput = Readonly<{
  plan: Readonly<{
    operationID: string
    sessionID: string
    workspaceMode: "read-only" | "activate-once"
    candidate: SkillInventoryCandidate
    limits: SkillInventoryLimits
    createdAt: string
  }>
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
  recordingStartedAt: string
  ledgerFilename: string
  spoolFilename: string
}>

type CompletedActivation = Readonly<{
  candidate: SkillInventoryCandidate
  operationID: string
  capabilityDigest: `sha256:${string}`
  bundlePath: string
  capabilityGrantID: string
}>

export type AstraSkillActivationControlDependencies = Readonly<{
  now: () => number
  inspect: (workspaceRoot: string) => Promise<SkillInventoryResult>
  revalidateWorkspace: (report: WorkspaceTrustReport) => Promise<WorkspaceRevalidation>
  revalidateGit: (
    workspaceRoot: string,
    baseline: GitRepositoryBaselineSnapshot,
  ) => Promise<GitRepositoryBaselineRevalidationResult>
  prepare: (input: PrepareInput) => Promise<SkillActivationProposal>
  decide: (
    input: PrepareInput &
      Readonly<{
        proposal: SkillActivationProposal
        consent: Readonly<{ decision: "approved" | "rejected"; decidedAt: string }>
        privateRuntimeDirectory: string
      }>,
  ) => Promise<DurableSkillActivationResult>
  cleanup: (input: Readonly<{
    workspaceRoot: string
    privateRuntimeDirectory: string
    sessionID: string
    capabilityGrantID: string
  }>) => Promise<boolean>
}>

/**
 * Owns workspace skill discovery, durable consent, and the private prompt bundle.
 * Socket callers can select only server-issued identifiers; the trusted bundle
 * is available solely through the local takePromptBundle method.
 */
export function createAstraSkillActivationControl(
  session: OpenedWorkspace,
  authority: Readonly<{ sessionID: string }>,
  state: Readonly<{ ledgerFilename: string; spoolFilename: string; privateRuntimeDirectory: string }>,
  dependencies: AstraSkillActivationControlDependencies = defaultDependencies(),
): AstraSkillActivationControl {
  let inventory:
    | Readonly<{
        inventoryID: string
        limits: SkillInventoryLimits
        report: WorkspaceTrustReport
        candidates: ReadonlyMap<string, SkillInventoryCandidate>
      }>
    | undefined
  let pending: PreparedActivation | undefined
  let completed: CompletedActivation | undefined
  let activationDecided = false
  let bundleTaken = false
  let bundleTaking = false
  const consumedProposals = new Set<string>()

  return {
    async inventory(requestId) {
      if (session.mode !== "activate-once") return blockedInventory(requestId, "read_only")
      if (activationDecided) return blockedInventory(requestId, "activation_already_decided")
      if (pending) return blockedInventory(requestId, "activation_pending")
      if (completed) return blockedInventory(requestId, "skill_already_activated")
      const current = await currentWorkspace(session, dependencies)
      if (!current) return blockedInventory(requestId, "workspace_stale")
      const inspected = await dependencies.inspect(current.root).catch(() => null)
      if (!inspected || inspected.status !== "complete" || !sameWorkspace(current, inspected.workspace)) {
        return blockedInventory(requestId, inspected?.status === "blocked" ? inspected.reason : "inventory_unavailable")
      }
      const inventoryID = randomUUID()
      const candidates = new Map(inspected.candidates.map((candidate) => [candidate.candidateID, candidate]))
      inventory = Object.freeze({ inventoryID, limits: inspected.limits, report: current, candidates })
      return Object.freeze({
        schemaVersion: 1,
        requestId,
        status: "complete",
        inventoryID,
        candidates: Object.freeze(inspected.candidates.map(publicCandidate)),
        verification: "not_verified",
      })
    },

    async prepare(requestId, inventoryID, candidateID) {
      if (session.mode !== "activate-once") return blockedPrepare(requestId, "read_only")
      if (activationDecided) return blockedPrepare(requestId, "activation_already_decided")
      if (completed) return blockedPrepare(requestId, "skill_already_activated")
      if (pending) return blockedPrepare(requestId, "activation_pending")
      const snapshot = inventory
      if (!snapshot || snapshot.inventoryID !== inventoryID) return blockedPrepare(requestId, "inventory_unknown")
      const candidate = snapshot.candidates.get(candidateID)
      if (!candidate) return blockedPrepare(requestId, "candidate_unknown")
      const current = await currentWorkspace(session, dependencies)
      if (!current || !sameWorkspace(snapshot.report, current)) return blockedPrepare(requestId, "workspace_stale")

      const base = dependencies.now()
      const input: PrepareInput = Object.freeze({
        plan: Object.freeze({
          operationID: randomUUID(),
          sessionID: authority.sessionID,
          workspaceMode: session.mode,
          candidate,
          limits: snapshot.limits,
          createdAt: timestamp(base),
        }),
        report: current,
        ...(session.repositoryBaseline ? { repositoryBaseline: session.repositoryBaseline } : {}),
        policyAskedAt: timestamp(base + 1),
        recordingStartedAt: timestamp(base + 2),
        ledgerFilename: state.ledgerFilename,
        spoolFilename: state.spoolFilename,
      })
      const proposal = await dependencies.prepare(input).catch(() => null)
      if (!proposal) return blockedPrepare(requestId, "proposal_unavailable")
      if (!exactProposal(proposal, input, candidate)) return blockedPrepare(requestId, "proposal_binding_mismatch")
      const proposalID = randomUUID()
      pending = Object.freeze({ proposalID, operationID: input.plan.operationID, candidate, input, proposal })
      inventory = undefined
      return Object.freeze({
        schemaVersion: 1,
        requestId,
        status: "prepared",
        preview: Object.freeze({
          operationID: input.plan.operationID,
          proposalID,
          expiresAt: proposal.capability.manifest.grant.expiresAt,
          boundaryLabel: skillActivationBoundaryLabel,
          capabilityDigest: publicDigest(proposal.capability.capabilityDigest),
          skill: Object.freeze({
            candidateID: candidate.candidateID,
            name: candidate.name,
            relativePath: candidate.relativePath,
            fileDigest: candidate.fileDigest,
            fileBytes: candidate.fileBytes,
            instructionsDigest: candidate.instructionsDigest,
            instructionsBytes: candidate.instructionsBytes,
            provenance: "workspace_opencode",
            trust: skillInstructionTrustLabel,
          }),
          effects: Object.freeze({
            workspaceRead: candidate.relativePath,
            workspaceWrite: "none",
            runtimeWrite: "private_session_skill_bundle",
            process: "none",
            network: "none",
            plugins: "none",
            mcp: "none",
            tools: "none",
          }),
          verification: "not_verified",
        }),
      })
    },

    async decide(requestId, proposalID, decision, onProgress = () => {}) {
      if (consumedProposals.has(proposalID)) return blockedDecision(requestId, proposalID, "proposal_consumed")
      const activation = pending
      if (!activation || activation.proposalID !== proposalID) {
        return blockedDecision(requestId, proposalID, "proposal_unknown")
      }
      pending = undefined
      consumedProposals.add(proposalID)
      activationDecided = true
      if (Date.parse(activation.proposal.capability.manifest.grant.expiresAt) <= dependencies.now()) {
        return blockedDecision(requestId, proposalID, "proposal_expired")
      }

      progress(onProgress, requestId, activation, "recording_authority")
      if (decision === "approve") progress(onProgress, requestId, activation, "submitting_approval")
      const result = await dependencies
        .decide({
          ...activation.input,
          proposal: activation.proposal,
          consent: {
            decision: decision === "approve" ? "approved" : "rejected",
            decidedAt: timestamp(Math.max(dependencies.now(), Date.parse(activation.input.recordingStartedAt))),
          },
          privateRuntimeDirectory: state.privateRuntimeDirectory,
        })
        .catch(() => null)
      if (!result) return reconciliation(requestId, activation, "durable_state_unavailable")
      if (result.operationID !== activation.operationID) {
        return reconciliation(requestId, activation, "durable_state_unavailable")
      }
      if (result.status === "effect_unknown") return reconciliation(requestId, activation, "effect_unknown")
      if (decision === "reject" && result.status !== "denied_without_effect") {
        return reconciliation(requestId, activation, "durable_state_unavailable")
      }
      if (decision === "approve" && result.status === "denied_without_effect") {
        return reconciliation(requestId, activation, "durable_state_unavailable")
      }
      if (result.status === "completed_observed_not_verified") {
        if (!result.receiptID || !result.bundlePath) return reconciliation(requestId, activation, "effect_unknown")
        const expectedBundlePath = join(
          resolve(state.privateRuntimeDirectory),
          `approved-skill-${authority.sessionID}-${activation.proposal.capability.manifest.grant.capabilityGrantID}.json`,
        )
        if (result.bundlePath !== expectedBundlePath) return reconciliation(requestId, activation, "effect_unknown")
        completed = Object.freeze({
          candidate: activation.candidate,
          operationID: activation.operationID,
          capabilityDigest: publicDigest(activation.proposal.capability.capabilityDigest),
          bundlePath: result.bundlePath,
          capabilityGrantID: activation.proposal.capability.manifest.grant.capabilityGrantID,
        })
        progress(onProgress, requestId, activation, "effect_observed_not_verified")
      }
      return Object.freeze({
        schemaVersion: 1,
        requestId,
        proposalID,
        operationID: activation.operationID,
        status: result.status,
        receiptID: result.receiptID,
        verification: "not_verified",
      })
    },

    async takePromptBundle() {
      if (!completed || bundleTaken || bundleTaking) return null
      bundleTaking = true
      const binding = completed
      try {
        const bundle = await readPromptBundle(binding, authority.sessionID).catch(() => null)
        if (!bundle) return null
        const removed = await dependencies.cleanup({
          workspaceRoot: session.report.root,
          privateRuntimeDirectory: state.privateRuntimeDirectory,
          sessionID: authority.sessionID,
          capabilityGrantID: binding.capabilityGrantID,
        }).catch(() => false)
        if (!removed) return null
        bundleTaken = true
        return bundle
      } finally {
        bundleTaking = false
      }
    },
  }
}

/** Returns a transport-independent handler for later parent socket integration. */
export function createAstraSkillActivationRegistration(control: AstraSkillActivationControl) {
  return Object.freeze({
    methods: Object.freeze(["skill.inventory", "skill.prepare", "skill.decide"] as const),
    async handle(
      request:
        | Readonly<{ method: "skill.inventory"; requestId: string }>
        | Readonly<{ method: "skill.prepare"; requestId: string; inventoryID: string; candidateID: string }>
        | Readonly<{
            method: "skill.decide"
            requestId: string
            proposalID: string
            decision: "approve" | "reject"
          }>,
      onProgress: (progress: SkillActivationProgress) => void = () => {},
    ) {
      if (request.method === "skill.inventory") return control.inventory(request.requestId)
      if (request.method === "skill.prepare") {
        return control.prepare(request.requestId, request.inventoryID, request.candidateID)
      }
      return control.decide(request.requestId, request.proposalID, request.decision, onProgress)
    },
  })
}

function defaultDependencies(): AstraSkillActivationControlDependencies {
  return {
    now: Date.now,
    async inspect(workspaceRoot) {
      const runtime = await import("../../astra-runtime/src/skill-inventory")
      return runtime.inspectWorkspaceSkills(workspaceRoot)
    },
    async revalidateWorkspace(report) {
      const runtime = await import("../../astra-runtime/src/workspace-preflight")
      return runtime.revalidateWorkspacePreflight(report)
    },
    async revalidateGit(workspaceRoot, baseline) {
      const git = await import("@astra/git")
      return git.revalidateGitRepositoryBaseline(workspaceRoot, baseline)
    },
    async prepare(input) {
      const runtime = await import("../../astra-runtime/src/skill-activation")
      return runtime.prepareSkillActivation(input)
    },
    async decide(input) {
      const runtime = await import("../../astra-runtime/src/skill-activation")
      return runtime.decideSkillActivation(input)
    },
    async cleanup(input) {
      const runtime = await import("../../astra-runtime/src/skill-activation")
      return runtime.cleanupSkillActivationBundle(input)
    },
  }
}

async function currentWorkspace(session: OpenedWorkspace, dependencies: AstraSkillActivationControlDependencies) {
  const current = await dependencies.revalidateWorkspace(session.report).catch(() => null)
  if (!current?.matched || !sameWorkspace(session.report, current.report)) return null
  if (!session.repositoryBaseline) return current.report
  const repository = await dependencies.revalidateGit(current.report.root, session.repositoryBaseline).catch(() => null)
  if (
    !repository ||
    repository.status !== "current" ||
    repository.expectedSnapshotDigest !== session.repositoryBaseline.snapshotDigest ||
    repository.currentSnapshotDigest !== session.repositoryBaseline.snapshotDigest
  ) return null
  return current.report
}

function publicCandidate(candidate: SkillInventoryCandidate): SkillInventoryCandidateView {
  return Object.freeze({
    candidateID: candidate.candidateID,
    name: candidate.name,
    description: candidate.description,
    metadataTrust: skillMetadataTrustLabel,
    provenance: "workspace_opencode",
    relativePath: candidate.relativePath,
    fileDigest: candidate.fileDigest,
    fileBytes: candidate.fileBytes,
    instructionsDigest: candidate.instructionsDigest,
    instructionsBytes: candidate.instructionsBytes,
  })
}

async function readPromptBundle(binding: CompletedActivation, sessionID: string): Promise<TrustedPromptSkillBundle> {
  const handle = await open(binding.bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const facts = await handle.stat()
    const owner = process.getuid?.()
    if (
      owner === undefined ||
      !facts.isFile() ||
      facts.isSymbolicLink() ||
      facts.nlink !== 1 ||
      facts.uid !== owner ||
      (facts.mode & 0o077) !== 0 ||
      facts.size <= 0 ||
      facts.size > 70_000
    ) {
      throw new Error("Unsafe private skill bundle")
    }
    const bytes = Buffer.alloc(facts.size + 1)
    const read = await handle.read(bytes, 0, bytes.byteLength, 0)
    const after = await handle.stat()
    if (read.bytesRead !== facts.size || !sameFile(facts, after)) throw new Error("Private skill bundle drifted")
    const input: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"))
    if (!record(input) || input.schemaVersion !== 1 || input.sessionID !== sessionID || input.operationID !== binding.operationID) {
      throw new Error("Private skill bundle binding mismatch")
    }
    if (input.capabilityDigest !== binding.capabilityDigest || input.assurance !== "observed_not_verified") {
      throw new Error("Private skill bundle capability mismatch")
    }
    if (!record(input.source) || !record(input.skill)) throw new Error("Invalid private skill bundle")
    if (
      input.source.relativePath !== binding.candidate.relativePath ||
      input.source.fileDigest !== binding.candidate.fileDigest ||
      input.source.instructionsDigest !== binding.candidate.instructionsDigest ||
      input.skill.name !== binding.candidate.name ||
      typeof input.skill.instructions !== "string" ||
      digest(input.skill.instructions) !== binding.candidate.instructionsDigest ||
      input.skill.trust !== "untrusted_instruction_data" ||
      input.skill.resourceDiscovery !== "none"
    ) throw new Error("Private skill bundle content mismatch")
    return Object.freeze({
      operationID: binding.operationID,
      capabilityDigest: binding.capabilityDigest,
      source: Object.freeze({
        provenance: "workspace_opencode",
        relativePath: binding.candidate.relativePath,
        fileDigest: binding.candidate.fileDigest,
        instructionsDigest: binding.candidate.instructionsDigest,
      }),
      skill: Object.freeze({
        name: binding.candidate.name,
        instructions: input.skill.instructions,
        trust: "untrusted_instruction_data",
        resourceDiscovery: "none",
      }),
      assurance: "observed_not_verified",
    })
  } finally {
    await handle.close()
  }
}

function progress(
  notify: (progress: SkillActivationProgress) => void,
  requestId: string,
  activation: PreparedActivation,
  status: SkillActivationProgress["status"],
) {
  try {
    notify(Object.freeze({
      schemaVersion: 1,
      requestId,
      proposalID: activation.proposalID,
      operationID: activation.operationID,
      status,
      verification: "not_verified",
    }))
  } catch {}
}

function exactProposal(proposal: SkillActivationProposal, input: PrepareInput, candidate: SkillInventoryCandidate) {
  if (candidate.candidateID !== input.plan.candidate.candidateID) return false
  const facts = makeSkillActivationOperationFacts(input)
  return proposal.policyAskedAt === input.policyAskedAt &&
    sameSkillActivationCapability(proposal.capability, facts.capability) &&
    canonicalJson(proposal.preview) === canonicalJson(facts.preview)
}

function blockedInventory(requestId: string, reason: string): PublicSkillInventoryResult {
  return { schemaVersion: 1, requestId, status: "blocked", reason: safeReason(reason) }
}
function blockedPrepare(requestId: string, reason: string): SkillActivationPrepareResult {
  return { schemaVersion: 1, requestId, status: "blocked", reason: safeReason(reason) }
}
function blockedDecision(requestId: string, proposalID: string, reason: string): SkillActivationDecisionResult {
  return { schemaVersion: 1, requestId, proposalID, status: "blocked", reason: safeReason(reason) }
}
function reconciliation(
  requestId: string,
  activation: PreparedActivation,
  reason: "effect_unknown" | "durable_state_unavailable",
): SkillActivationDecisionResult {
  return {
    schemaVersion: 1,
    requestId,
    proposalID: activation.proposalID,
    operationID: activation.operationID,
    status: "reconciliation_required",
    reason,
    verification: "not_verified",
  }
}

function sameWorkspace(
  left: WorkspaceTrustReport,
  right: WorkspaceTrustReport | Readonly<{ root: string; device: string; inode: string }>,
) {
  if ("identity" in right) {
    return left.root === right.root && left.identity?.device === right.identity?.device && left.identity?.inode === right.identity?.inode && left.securityDigest === right.securityDigest
  }
  return left.root === right.root && left.identity?.device === right.device && left.identity?.inode === right.inode
}
function sameFile(left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}
function timestamp(input: number) { return new Date(input).toISOString() }
function digest(input: string): `sha256:${string}` { return `sha256:${createHash("sha256").update(input).digest("hex")}` }
function publicDigest(input: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(input)) throw new TypeError("Invalid content digest")
  return `sha256:${input.slice(7)}`
}
function safeReason(input: string) { return /^[a-z][a-z0-9_]{0,63}$/.test(input) ? input : "control_failed" }
function record(input: unknown): input is Record<string, unknown> { return typeof input === "object" && input !== null && !Array.isArray(input) }
