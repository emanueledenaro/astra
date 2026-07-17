import { join } from "node:path"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseOperationEvidence,
  parseOperationID,
  type OperationEvidence,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import { captureGitRepositoryBaseline } from "@astra/git"
import { Effect } from "effect"
import { verifyControlledWrite } from "./controlled-write"
import type { ControlledWritePlan } from "./controlled-write-plan"
import {
  canonicalJson,
  controlledWriteVerifier,
  controlledWriteVerifierDigest,
  deterministicUUID,
  digest,
  makeControlledWriteBaselineAuthority,
} from "./controlled-write-operation-facts"
import { assertSafeStateFile, runWithLedger, runWithVerificationLedger } from "./operation-storage"
import { checkWorkspaceActivation, scanWorkspace } from "./workspace-preflight"

export type VerifyControlledWriteInput = Readonly<{
  ledgerFilename: string
  plan: ControlledWritePlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
}>

export type DurableVerificationResult = Readonly<{
  operationID: string
  state: "succeeded" | "failed" | "reconciliation_required"
  sequence: number
  lastCursor: number
  status: "verified" | "failed" | "unknown"
  evidence: OperationEvidence
}>

export class ControlledWriteVerificationError extends Error {
  readonly _tag = "ControlledWriteVerificationError"

  constructor(
    readonly code: "invalid_input" | "receipt_unavailable" | "verification_unavailable",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

/**
 * Reopens durable state and the target through a fresh file handle. This is the
 * only runtime boundary allowed to submit verification evidence.
 */
export async function verifyRecordedControlledWrite(
  input: VerifyControlledWriteInput,
): Promise<DurableVerificationResult> {
  try {
    if (!input.report.identity || input.report.root !== input.plan.workspaceRoot) {
      throw new ControlledWriteVerificationError(
        "invalid_input",
        "Verification requires the admitted workspace identity",
      )
    }
    await assertSafeStateFile(input.report.root, input.ledgerFilename)
    const operationID = requireOperationID(input.plan.operationId)
    const durable = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        const operation = yield* ledger.getOperation(operationID)
        const existing = yield* ledger.getVerification(operationID)
        const dispatch = operation?.dispatchRequestID
          ? yield* ledger.getDispatchSnapshot(operation.dispatchRequestID)
          : null
        return { operation, existing, dispatch }
      }),
    )
    if (!durable.operation) {
      throw new ControlledWriteVerificationError("receipt_unavailable", "The durable Operation is missing")
    }
    if (!durable.dispatch?.receipt || durable.dispatch.receipt.observation.kind !== "effect_observed") {
      throw new ControlledWriteVerificationError(
        "receipt_unavailable",
        "An independently verifiable observed-effect receipt is required",
      )
    }

    const receipt = durable.dispatch.receipt
    const context = receipt.verificationContext
    const baselineAuthority = makeControlledWriteBaselineAuthority(input.report, input.repositoryBaseline)
    const gitContext = "schemaVersion" in context && context.schemaVersion === 2 ? context : null
    const observedAt = new Date().toISOString()
    const callerBindingMatched =
      input.report.completeness === "complete" &&
      baselineAuthority.baselineDigest === durable.operation.baselineTrustDigest &&
      baselineAuthority.baselineDigest === durable.dispatch.request.baselineDigest &&
      baselineAuthority.baselineDigest === context.admittedBaselineDigest &&
      sameIdentity(input.report.identity, context.workspaceIdentity) &&
      input.report.root === input.plan.workspaceRoot &&
      (gitContext === null ||
        (input.repositoryBaseline !== undefined &&
          gitContext.admittedRepositorySnapshotDigest === input.repositoryBaseline.snapshotDigest)) &&
      receipt.observation.kind === "effect_observed" &&
      receipt.observation.afterDigest === input.plan.contentDigest
    if (!callerBindingMatched) {
      throw new ControlledWriteVerificationError(
        "invalid_input",
        "The current verification input does not match the admitted Operation",
      )
    }
    if (durable.existing) return verificationResult(durable.operation, durable.existing.evidence)
    if (durable.operation.state !== "effect_observed") {
      throw new ControlledWriteVerificationError(
        "receipt_unavailable",
        "An observed-effect Operation is required before verification",
      )
    }
    const contextReady =
      context.postEffectWorkspaceDigest !== null &&
      context.targetIdentity !== null &&
      context.activationGuard === "allowed" &&
      (gitContext === null || gitContext.postEffectRepositorySnapshotDigest !== null)
    const beforeRead =
      callerBindingMatched && contextReady
        ? await inspectWorkspace(input.plan.workspaceRoot, context, input.repositoryBaseline)
        : unmatchedWorkspaceCheck("caller_or_receipt_binding_mismatch")
    const firstRead =
      beforeRead.matched && context.targetIdentity
        ? await verifyControlledWrite(
            input.plan,
            join(input.plan.workspaceRoot, input.plan.relativePath),
            context.workspaceIdentity,
            context.targetIdentity,
          )
        : null
    const afterRead = beforeRead.matched
      ? await inspectWorkspace(input.plan.workspaceRoot, context, input.repositoryBaseline)
      : unmatchedWorkspaceCheck("pre_read_workspace_mismatch")
    const secondRead =
      afterRead.matched && context.targetIdentity
        ? await verifyControlledWrite(
            input.plan,
            join(input.plan.workspaceRoot, input.plan.relativePath),
            context.workspaceIdentity,
            context.targetIdentity,
          )
        : null
    const beforeIngestion = afterRead.matched
      ? await inspectWorkspace(input.plan.workspaceRoot, context, input.repositoryBaseline)
      : unmatchedWorkspaceCheck("post_read_workspace_mismatch")
    const snapshot = {
      callerBindingMatched,
      contextReady,
      beforeRead,
      firstRead,
      afterRead,
      secondRead,
      beforeIngestion,
    }
    const workspaceStable = beforeRead.matched && afterRead.matched && beforeIngestion.matched
    const readsStable =
      firstRead !== null && secondRead !== null && canonicalJson(firstRead) === canonicalJson(secondRead)
    const firstExact = firstRead !== null && exactReadback(firstRead, input.plan)
    const secondExact = secondRead !== null && exactReadback(secondRead, input.plan)
    const exact = callerBindingMatched && contextReady && workspaceStable && readsStable && firstExact && secondExact
    const conclusiveContentMismatch =
      callerBindingMatched &&
      contextReady &&
      workspaceStable &&
      readsStable &&
      firstRead !== null &&
      secondRead !== null &&
      firstRead.workspaceIdentityMatched &&
      firstRead.targetIdentityMatched &&
      secondRead.workspaceIdentityMatched &&
      secondRead.targetIdentityMatched
    const result = exact ? "passed" : conclusiveContentMismatch ? "failed" : "unknown"
    const observationDigest = exact ? input.plan.contentDigest : digest(canonicalJson(snapshot))
    const evidence = requireEvidence({
      evidenceID: deterministicUUID(operationID, "evidence:1"),
      operationID,
      receiptID: durable.dispatch.receipt.receiptID,
      verificationPlanID: deterministicUUID(operationID, "verification-plan"),
      verifier: { identity: controlledWriteVerifier, version: "1", digest: controlledWriteVerifierDigest },
      snapshotDigest: digest(canonicalJson(snapshot)),
      observedAt,
      criteria: [{ criterionID: "marker_exact_bytes", result, observationDigest }],
      limitations: exact
        ? []
        : [result === "failed" ? "exact_target_bytes_did_not_match" : "binding_or_snapshot_unstable"],
    })
    const ingested = await runWithVerificationLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.ingestEvidence({
          evidence,
          startedEvent: {
            eventID: deterministicUUID(operationID, "event:verification-started"),
            schemaVersion: 1,
            correlationID: deterministicUUID(operationID, "correlation"),
            redaction: "internal",
            externalBlobDigest: null,
          },
          terminalEvent: {
            eventID: deterministicUUID(operationID, "event:verification-terminal"),
            schemaVersion: 1,
            correlationID: deterministicUUID(operationID, "correlation"),
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    )
    return verificationResult(ingested.operation, ingested.evidence)
  } catch (cause) {
    if (cause instanceof ControlledWriteVerificationError) throw cause
    throw new ControlledWriteVerificationError(
      "verification_unavailable",
      "Independent verification could not produce durable evidence",
      cause,
    )
  }
}

type ReceiptVerificationContext = OperationReceipt["verificationContext"]

async function inspectWorkspace(
  root: string,
  context: ReceiptVerificationContext,
  admittedRepositoryBaseline: GitRepositoryBaselineSnapshot | undefined,
) {
  const report = await scanWorkspace(root, context.preflightLimits)
  const gitContext = "schemaVersion" in context && context.schemaVersion === 2 ? context : null
  const repository = gitContext ? await captureGitRepositoryBaseline(root, admittedRepositoryBaseline?.limits) : null
  const repositoryMatched =
    gitContext === null ||
    (repository?.status === "complete" &&
      repository.snapshot.snapshotDigest === gitContext.postEffectRepositorySnapshotDigest)
  const activation = gitContext ? { allowed: repositoryMatched } : checkWorkspaceActivation(report)
  const matched =
    report.completeness === "complete" &&
    report.securityDigest === context.postEffectWorkspaceDigest &&
    report.identity !== null &&
    sameIdentity(report.identity, context.workspaceIdentity) &&
    activation.allowed &&
    repositoryMatched
  return {
    matched,
    securityDigest: report.securityDigest,
    identity: report.identity,
    activationGuard: activation.allowed ? ("allowed" as const) : ("blocked" as const),
    repositorySnapshotDigest: repository?.status === "complete" ? repository.snapshot.snapshotDigest : null,
    blockers: report.blockers,
  }
}

function unmatchedWorkspaceCheck(reason: string) {
  return {
    matched: false as const,
    securityDigest: null,
    identity: null,
    activationGuard: "blocked" as const,
    repositorySnapshotDigest: null,
    blockers: [reason],
  }
}

function exactReadback(snapshot: Awaited<ReturnType<typeof verifyControlledWrite>>, plan: ControlledWritePlan) {
  return (
    snapshot.workspaceIdentityMatched &&
    snapshot.targetIdentityMatched &&
    snapshot.observedDigest === plan.contentDigest &&
    snapshot.bytes === Buffer.byteLength(plan.content)
  )
}

function sameIdentity(
  left: Readonly<{ device: string; inode: string }>,
  right: Readonly<{ device: string; inode: string }>,
) {
  return left.device === right.device && left.inode === right.inode
}

function verificationResult(
  operation: Readonly<{ operationID: string; state: string; sequence: number; lastCursor: number }>,
  evidence: OperationEvidence,
): DurableVerificationResult {
  const status = evidence.criteria.every((criterion) => criterion.result === "passed")
    ? "verified"
    : evidence.criteria.some((criterion) => criterion.result === "failed")
      ? "failed"
      : "unknown"
  const state = status === "verified" ? "succeeded" : status === "failed" ? "failed" : "reconciliation_required"
  if (operation.state !== state) {
    throw new ControlledWriteVerificationError(
      "verification_unavailable",
      "Verification evidence and durable Operation state diverge",
    )
  }
  return {
    operationID: operation.operationID,
    state,
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    status,
    evidence,
  }
}

function requireOperationID(value: string) {
  const parsed = parseOperationID(value)
  if (!parsed.ok) throw new ControlledWriteVerificationError("invalid_input", "The Operation ID is invalid")
  return parsed.value
}

function requireEvidence(input: unknown) {
  const parsed = parseOperationEvidence(input)
  if (!parsed.ok) throw new TypeError(`Verification evidence is invalid at ${parsed.issue.path}`)
  return parsed.value
}
