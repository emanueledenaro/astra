import type { WorkspaceIdentity, WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { demoMarkerName, type ControlledWritePlan } from "./controlled-write-plan"
import { revalidateWorkspacePreflight } from "./workspace-preflight"

export type ControlledWriteReceipt = Readonly<{
  path: string
  bytes: number
  expectedDigest: string
  observedDigest: string | null
  targetIdentityMatched: boolean
  workspaceIdentityMatched: boolean
  targetIdentity: WorkspaceIdentity | null
}>

export type ControlledWriteExecutionEvidence = Readonly<{
  backend: "host" | "darwin-seatbelt"
  capabilityDigest: string
  executionImage: Readonly<{ canonicalPath: string; device: string; inode: string; digest: string }> | null
  termination:
    | Readonly<{ kind: "not_started" }>
    | Readonly<{ kind: "exited"; exitCode: number }>
    | Readonly<{ kind: "unconfirmed" }>
  cleanupSucceeded: boolean | null
  stdoutDigest: string | null
  stderrDigest: string | null
}>

export type ControlledWriteResult =
  | Readonly<{
      status: "effect_observed"
      receipt: ControlledWriteReceipt
      execution?: ControlledWriteExecutionEvidence
    }>
  | Readonly<{ status: "failed_without_effect"; reason: string; execution?: ControlledWriteExecutionEvidence }>
  | Readonly<{
      status: "effect_observed_unverified"
      reason: string
      receipt: ControlledWriteReceipt
      execution?: ControlledWriteExecutionEvidence
    }>
  | Readonly<{
      status: "effect_unknown"
      reason: string
      receipt: ControlledWriteReceipt
      execution: ControlledWriteExecutionEvidence
    }>

export type PreparedControlledWrite =
  | Readonly<{ prepared: false; reason: string }>
  | Readonly<{ prepared: true; execute: () => Promise<ControlledWriteResult> }>

export type EffectAuthorityCheck = () => Promise<
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: string }>
>

export type RepositoryBaselineCheck = () => Promise<
  Readonly<{ matched: true }> | Readonly<{ matched: false; reason: string }>
>

export type ControlledWriteEffectExecutor = (
  plan: ControlledWritePlan,
  target: string,
  expectedWorkspaceIdentity: WorkspaceIdentity,
) => Promise<ControlledWriteResult>

/**
 * Revalidates the exact preflight snapshot before invoking the supplied effect boundary.
 * The returned attempt is single-purpose and create-only.
 */
export async function prepareControlledWrite(
  plan: ControlledWritePlan,
  trustedReport: WorkspaceTrustReport,
  authorizeEffect: EffectAuthorityCheck,
  revalidateRepository?: RepositoryBaselineCheck,
  executeEffect?: ControlledWriteEffectExecutor,
): Promise<PreparedControlledWrite> {
  if (plan.relativePath !== demoMarkerName || plan.workspaceRoot !== trustedReport.root) {
    return { prepared: false, reason: "plan_scope_mismatch" }
  }

  const current = await revalidateWorkspacePreflight(trustedReport)
  if (!current.matched) return { prepared: false, reason: current.reason }
  const repository = await checkRepositoryBoundary(trustedReport, revalidateRepository)
  if (!repository.matched) return { prepared: false, reason: repository.reason }
  const expectedIdentity = trustedReport.identity
  if (!expectedIdentity) return { prepared: false, reason: "workspace_identity_unavailable" }
  if (!executeEffect) return { prepared: false, reason: "effect_executor_unavailable" }

  const target = join(plan.workspaceRoot, plan.relativePath)
  const targetState = await inspectTarget(target)
  if (targetState === "exists") return { prepared: false, reason: "target_already_exists" }
  if (targetState === "unknown") return { prepared: false, reason: "target_state_unavailable" }

  let consumed = false
  return {
    prepared: true,
    async execute() {
      if (consumed) return { status: "failed_without_effect", reason: "attempt_already_consumed" }
      consumed = true
      const revalidation = await revalidateWorkspacePreflight(trustedReport)
      if (!revalidation.matched) {
        const gitMetadataAppeared =
          !trustedReport.surfaces.some((surface) => surface.kind === "git_metadata") &&
          revalidation.report.surfaces.some((surface) => surface.kind === "git_metadata")
        return {
          status: "failed_without_effect",
          reason: gitMetadataAppeared ? "git_baseline_not_inspected" : revalidation.reason,
        }
      }
      const repository = await checkRepositoryBoundary(trustedReport, revalidateRepository)
      if (!repository.matched) return { status: "failed_without_effect", reason: repository.reason }
      const authority = await authorizeEffect()
      if (!authority.allowed) return { status: "failed_without_effect", reason: authority.reason }
      return executeEffect(plan, target, expectedIdentity)
    },
  }
}

async function checkRepositoryBoundary(
  report: WorkspaceTrustReport,
  revalidateRepository: RepositoryBaselineCheck | undefined,
) {
  const gitWorkspace = report.surfaces.some((surface) => surface.kind === "git_metadata")
  if (!gitWorkspace) return { matched: true as const }
  if (!revalidateRepository) return { matched: false as const, reason: "git_baseline_not_inspected" }
  return revalidateRepository()
}

export async function verifyControlledWrite(
  plan: ControlledWritePlan,
  target = join(plan.workspaceRoot, plan.relativePath),
  expectedWorkspaceIdentity?: WorkspaceIdentity,
  expectedTargetIdentity?: WorkspaceIdentity,
): Promise<ControlledWriteReceipt> {
  let handle: FileHandle | null = null
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const facts = await handle.stat()
    const identity = expectedTargetIdentity ?? fileIdentity(facts)
    return await readReceiptFromHandle(plan, target, handle, expectedWorkspaceIdentity, identity)
  } catch {
    return emptyReceipt(plan, target, false, expectedWorkspaceIdentity)
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readReceiptFromHandle(
  plan: ControlledWritePlan,
  target: string,
  handle: FileHandle,
  expectedWorkspaceIdentity: WorkspaceIdentity | undefined,
  expectedTargetIdentity: WorkspaceIdentity,
): Promise<ControlledWriteReceipt> {
  const expectedBytes = Buffer.byteLength(plan.content)
  const before = await handle.stat()
  const content = Buffer.alloc(expectedBytes)
  let offset = 0
  while (offset < content.byteLength) {
    const read = await handle.read(content, offset, content.byteLength - offset, offset)
    if (read.bytesRead === 0) break
    offset += read.bytesRead
  }
  const after = await handle.stat()
  const pathFacts = await lstat(target).catch(() => null)
  const stableHandle = sameFileFacts(before, after) && sameIdentity(fileIdentity(after), expectedTargetIdentity)
  const targetIdentityMatched =
    stableHandle &&
    pathFacts !== null &&
    pathFacts.isFile() &&
    !pathFacts.isSymbolicLink() &&
    sameIdentity(fileIdentity(pathFacts), expectedTargetIdentity)
  const completeRead = offset === expectedBytes && after.size === expectedBytes
  const workspaceIdentityMatched = expectedWorkspaceIdentity
    ? await rootIdentityMatches(plan.workspaceRoot, expectedWorkspaceIdentity)
    : true

  return {
    path: target,
    bytes: after.size,
    expectedDigest: plan.contentDigest,
    observedDigest:
      completeRead && stableHandle ? `sha256:${createHash("sha256").update(content).digest("hex")}` : null,
    targetIdentityMatched,
    workspaceIdentityMatched,
    targetIdentity: expectedTargetIdentity,
  }
}

async function emptyReceipt(
  plan: ControlledWritePlan,
  target: string,
  targetIdentityMatched: boolean,
  expectedWorkspaceIdentity?: WorkspaceIdentity,
): Promise<ControlledWriteReceipt> {
  return {
    path: target,
    bytes: 0,
    expectedDigest: plan.contentDigest,
    observedDigest: null,
    targetIdentityMatched,
    workspaceIdentityMatched: expectedWorkspaceIdentity
      ? await rootIdentityMatches(plan.workspaceRoot, expectedWorkspaceIdentity)
      : true,
    targetIdentity: null,
  }
}

async function inspectTarget(path: string): Promise<"absent" | "exists" | "unknown"> {
  try {
    await lstat(path)
    return "exists"
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "absent" : "unknown"
  }
}

async function rootIdentityMatches(root: string, expected: WorkspaceIdentity) {
  try {
    const facts = await lstat(root)
    return (
      facts.isDirectory() &&
      !facts.isSymbolicLink() &&
      String(facts.dev) === expected.device &&
      String(facts.ino) === expected.inode
    )
  } catch {
    return false
  }
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

function fileIdentity(facts: Awaited<ReturnType<FileHandle["stat"]>>): WorkspaceIdentity {
  return { device: String(facts.dev), inode: String(facts.ino) }
}

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity) {
  return left.device === right.device && left.inode === right.inode
}

function sameFileFacts(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<FileHandle["stat"]>>) {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
