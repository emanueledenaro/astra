import type { WorkspaceIdentity, WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { demoMarkerName, type ControlledWritePlan } from "./controlled-write-plan"
import { revalidateWorkspaceSnapshot } from "./workspace-preflight"

export type ControlledWriteReceipt = Readonly<{
  path: string
  bytes: number
  expectedDigest: string
  observedDigest: string | null
  targetIdentityMatched: boolean
  workspaceIdentityMatched: boolean
}>

export type ControlledWriteResult =
  | Readonly<{ status: "verified"; receipt: ControlledWriteReceipt }>
  | Readonly<{ status: "failed_without_effect"; reason: string }>
  | Readonly<{
      status: "effect_observed_unverified"
      reason: string
      receipt: ControlledWriteReceipt
    }>

export type PreparedControlledWrite =
  | Readonly<{ prepared: false; reason: string }>
  | Readonly<{ prepared: true; execute: () => Promise<ControlledWriteResult> }>

/**
 * Revalidates the exact preflight snapshot before exposing the host effect.
 * The returned attempt is single-purpose and create-only.
 */
export async function prepareControlledWrite(
  plan: ControlledWritePlan,
  trustedReport: WorkspaceTrustReport,
): Promise<PreparedControlledWrite> {
  if (plan.relativePath !== demoMarkerName || plan.workspaceRoot !== trustedReport.root) {
    return { prepared: false, reason: "plan_scope_mismatch" }
  }

  const current = await revalidateWorkspaceSnapshot(trustedReport)
  if (!current.matched) return { prepared: false, reason: current.reason }
  const expectedIdentity = trustedReport.identity
  if (!expectedIdentity) return { prepared: false, reason: "workspace_identity_unavailable" }

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
      return executeCreateOnlyWrite(plan, target, expectedIdentity)
    },
  }
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

async function executeCreateOnlyWrite(
  plan: ControlledWritePlan,
  target: string,
  expectedWorkspaceIdentity: WorkspaceIdentity,
): Promise<ControlledWriteResult> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let created = false
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    created = true
    const createdFacts = await handle.stat()
    const createdIdentity = fileIdentity(createdFacts)
    await handle.writeFile(plan.content, "utf8")
    await handle.sync()

    const receipt = await readReceiptFromHandle(plan, target, handle, expectedWorkspaceIdentity, createdIdentity)
    await handle.close()
    handle = null
    const verified =
      receipt.workspaceIdentityMatched &&
      receipt.targetIdentityMatched &&
      receipt.observedDigest === receipt.expectedDigest &&
      receipt.bytes === Buffer.byteLength(plan.content)
    if (!verified) return { status: "effect_observed_unverified", reason: "readback_mismatch", receipt }
    return { status: "verified", receipt }
  } catch {
    if (handle) await handle.close().catch(() => {})
    if (!created) return { status: "failed_without_effect", reason: "create_rejected" }
    return {
      status: "effect_observed_unverified",
      reason: "write_or_readback_failed",
      receipt: {
        path: target,
        bytes: 0,
        expectedDigest: plan.contentDigest,
        observedDigest: null,
        targetIdentityMatched: false,
        workspaceIdentityMatched: false,
      },
    }
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
