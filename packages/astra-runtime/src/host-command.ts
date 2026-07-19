import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  computeExecutionCapabilityDigest,
  parseExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityManifest,
} from "@astra/domain/execution-capability"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseDispatchRequest,
  parseDispatchRequestID,
  parseExecutorClaimID,
  parseOperationEffectUncertainty,
  parseOperationID,
  parseOperationReceipt,
  parseReceiptID,
  type ActorRef,
  type ContentDigest,
  type OperationEffectUncertainty,
  type OperationID,
  type OperationReceipt,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { AppendOperationEvent, OperationEventDraft, OperationRecord } from "@astra/ledger"
import { captureGitRepositoryBaseline, revalidateGitRepositoryBaseline } from "@astra/git"
import { Effect } from "effect"
import {
  canonicalJson,
  deterministicUUID,
  digest,
  makeControlledWriteBaselineAuthority,
} from "./controlled-write-authority"
import {
  prepareOperationStateFiles,
  runWithCoordinatorLedger,
  runWithCoordinatorReceiptSpool,
  runWithLedger,
  runWithReceiptSpool,
} from "./operation-storage"
import { checkWorkspaceActivation, scanWorkspace } from "./workspace-preflight"

const authorizationLifetimeMilliseconds = 300_000
const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 5_000
const processTerminationGraceMilliseconds = 500
const pwdExecutable = "/bin/pwd"
const commandTimeoutMilliseconds = 3_000
const commandOutputLimitBytes = 4_096

const hostCommandPolicyDigest = digest("astra-policy:host-command-explicit-consent:v1")
const hostCommandAdapterDigest = digest("astra-runtime:host-command:direct-host-process:v1")
const hostCommandObserverDigest = digest("astra-observer:host-command-bounded-output:v1")
const hostCommandExecutor = "astra-executor:allowlisted-host-command"

export const hostExecutionBoundaryLabel = "HOST EXECUTION — NO SANDBOX"

export const hostCommandFaultPoints = [
  "after_batch_before_claim",
  "after_claim_before_effect",
  "after_effect_before_spool",
  "after_spool_before_ledger",
  "after_ledger_before_ack",
] as const

export type HostCommandFaultPoint = (typeof hostCommandFaultPoints)[number]

export type HostCommandCoordinatorDependencies = Readonly<{
  injectFault?: (point: HostCommandFaultPoint) => Promise<void>
  now?: () => number
}>

export type HostCommandPreview = Readonly<{
  command: "pwd"
  boundary: "host_no_sandbox"
  boundaryLabel: typeof hostExecutionBoundaryLabel
  executable: ExecutionCapabilityManifest["process"]["executable"] & Readonly<{ requestedPath: typeof pwdExecutable }>
  argv: ReadonlyArray<string>
  workingDirectory: "/"
  environment: ReadonlyArray<Readonly<{ name: "LANG" | "LC_ALL" | "TZ"; value: string }>>
  stdin: Readonly<{ bytes: 0; digest: ContentDigest }>
  limits: Readonly<{ timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }>
  workspace: Readonly<{ canonicalPath: string; device: string; inode: string; access: "identity_guard" }>
  resources: ReadonlyArray<string>
  network: Readonly<{ mode: "host_unrestricted"; warning: "network is not isolated" }>
  writes: ReadonlyArray<never>
}>

export type HostCommandProposal = Readonly<{
  capability: ExecutionCapability
  preview: HostCommandPreview
  policyAskedAt: string
}>

export type ProposeHostCommandInput = Readonly<{
  operationID: string
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
}>

export type HostCommandConsent =
  | Readonly<{ decision: "approved"; decidedAt: string }>
  | Readonly<{ decision: "rejected"; decidedAt: string; reason?: "user_rejected" }>

export type ExecuteHostCommandInput = ProposeHostCommandInput &
  Readonly<{
    ledgerFilename: string
    spoolFilename: string
    proposal: HostCommandProposal
    consent: HostCommandConsent
    recordingStartedAt: string
  }>

export type HostCommandProcessObservation = Readonly<{
  started: boolean
  termination: Readonly<{ kind: "exited"; exitCode: number }> | Readonly<{ kind: "unconfirmed" }>
  stdout: Uint8Array
  stderr: Uint8Array
  stopReason?: "timeout" | "stdout_limit_exceeded" | "stderr_limit_exceeded" | "process_observation_failed"
}>

export type DurableHostCommandResult = Readonly<{
  operationID: string
  state: "denied" | "completed" | "failed" | "reconciliation_required"
  status: "denied_without_effect" | "completed_observed_not_verified" | "failed_without_effect" | "effect_unknown"
  sequence: number
  lastCursor: number
  receiptID: string | null
  boundaryLabel: typeof hostExecutionBoundaryLabel
  output: Readonly<{ stdout: string; stderr: string; exitCode: number | null }> | null
}>

export class HostCommandCoordinationError extends Error {
  readonly _tag = "HostCommandCoordinationError"

  constructor(
    readonly code: "invalid_input" | "state_unavailable" | "recovery_unavailable" | "operation_in_progress",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

/** Prepares the exact direct-exec authority that must be displayed before consent. */
export async function proposeHostCommand(input: ProposeHostCommandInput): Promise<HostCommandProposal> {
  requireHostCommandInput(input)
  const executable = await inspectExecutableSource(pwdExecutable)
  const proposal = makeProposal(input, executable)
  const parsed = parseExecutionCapability({
    manifest: proposal.manifest,
    capabilityDigest: computeExecutionCapabilityDigest(proposal.manifest),
  })
  if (!parsed.ok) throw new TypeError("The host command capability is invalid")
  return Object.freeze({ capability: parsed.value, preview: proposal.preview, policyAskedAt: input.policyAskedAt })
}

/**
 * Records consent and executes one exact allowlisted process after a durable
 * claim. Exact retries recover state and never start the process again.
 */
export async function executeHostCommand(
  input: ExecuteHostCommandInput,
  dependencies: HostCommandCoordinatorDependencies = {},
): Promise<DurableHostCommandResult> {
  try {
    const facts = makeHostCommandFacts(input)
    await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    if (input.consent.decision === "rejected") return recordDeniedHostCommand(input, facts)

    if (await exists(input.ledgerFilename)) {
      const existing = await readExistingDispatch(input, facts)
      if (existing?.claim) return recoverHostCommand(input, dependencies)
    }

    const baseline = await revalidateBaseline(facts, facts.repositorySnapshotDigest)
    if (!baseline.matched) throw new HostCommandCoordinationError("invalid_input", baseline.reason)

    const now = dependencies.now ?? Date.now
    await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        yield* ledger.appendBatch(facts.commands)
      }),
    )
    await dependencies.injectFault?.("after_batch_before_claim")

    const claimStartedAt = now()
    const claimed = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        const existing = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        if (existing?.claim) return { kind: "existing_claim" as const }
        return yield* ledger.claimDispatch({
          dispatchRequestID: facts.dispatchRequestID,
          operationID: facts.operationID,
          attemptID: facts.attemptID,
          executor: hostCommandExecutor,
          capabilityDigest: facts.capabilityDigest,
          executorClaimID: facts.executorClaimID,
          claimExpiresAt: new Date(
            Math.min(claimStartedAt + claimLeaseMilliseconds, Date.parse(facts.authorizationExpiresAt) - 1),
          ).toISOString(),
          event: {
            eventID: facts.eventIDs.claim,
            schemaVersion: 1,
            actor: { kind: "system", subject: hostCommandExecutor, componentDigest: hostCommandAdapterDigest },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    )
    if (claimed.kind === "existing_claim" || claimed.kind === "replayed") {
      return recoverHostCommand(input, dependencies)
    }
    await dependencies.injectFault?.("after_claim_before_effect")

    const boundaryBaseline = await revalidateBaseline(facts, facts.repositorySnapshotDigest)
    const executable = boundaryBaseline.matched ? await revalidateExecutable(facts.preview.executable) : null
    const authority =
      boundaryBaseline.matched && executable
        ? await runWithCoordinatorLedger(
            input.ledgerFilename,
            (ledger) =>
              Effect.gen(function* () {
                yield* ledger.initialize()
                return yield* ledger.validateEffectAuthority({
                  operationID: facts.operationID,
                  dispatchRequestID: facts.dispatchRequestID,
                  attemptID: facts.attemptID,
                  capabilityGrantID: facts.capabilityGrantID,
                  capabilityDigest: facts.capabilityDigest,
                  executorClaimID: facts.executorClaimID,
                  fencingToken: claimed.claim.fencingToken,
                  executor: hostCommandExecutor,
                  adapterDigest: hostCommandAdapterDigest,
                  baselineDigest: facts.baselineTrustDigest,
                  minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
                })
              }),
            () => new Date().toISOString(),
          )
        : null

    const startedAt = new Date(now()).toISOString()
    const observation =
      boundaryBaseline.matched && executable && authority?.allowed
        ? await runBoundedHostCommand(facts.preview)
        : notStartedObservation(
            !boundaryBaseline.matched
              ? boundaryBaseline.reason
              : !executable
                ? "executable_identity_changed"
                : `effect_authority_${authority && !authority.allowed ? authority.reason : "unavailable"}`,
          )
    const endedAt = new Date(now()).toISOString()
    await dependencies.injectFault?.("after_effect_before_spool")

    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(input, facts, claimed.claim.fencingToken, endedAt)
    }

    const receipt = await makeHostCommandReceipt(facts, claimed.claim.fencingToken, startedAt, endedAt, observation)
    await runWithReceiptSpool(input.spoolFilename, (spool) =>
      Effect.gen(function* () {
        yield* spool.initialize()
        yield* spool.put(receipt)
      }),
    )
    await dependencies.injectFault?.("after_spool_before_ledger")
    const ingested = await ingestReceipt(input, facts, receipt)
    await dependencies.injectFault?.("after_ledger_before_ack")
    await acknowledgeReceipt(input.spoolFilename, receipt, ingested.event.eventID, ingested.event.digest)
    return durableResult(ingested.operation, receipt, observation)
  } catch (cause) {
    if (cause instanceof HostCommandCoordinationError) throw cause
    throw new HostCommandCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The host command could not complete its durable path",
      cause,
    )
  }
}

/** Recovers receipts or marks an expired claim uncertain without rerunning the command. */
export async function recoverHostCommand(
  input: ExecuteHostCommandInput,
  dependencies: Pick<HostCommandCoordinatorDependencies, "now"> = {},
): Promise<DurableHostCommandResult> {
  try {
    if (input.consent.decision !== "approved") {
      throw new HostCommandCoordinationError("recovery_unavailable", "A denied command has no executor claim")
    }
    const facts = makeHostCommandFacts(input)
    await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    if (await exists(input.spoolFilename)) await ingestPendingReceipt(input, facts, dependencies)
    const snapshot = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return {
          dispatch: yield* ledger.getDispatchSnapshot(facts.dispatchRequestID),
          operation: yield* ledger.getOperation(facts.operationID),
        }
      }),
    )
    if (!snapshot.operation || !snapshot.dispatch) {
      throw new HostCommandCoordinationError("recovery_unavailable", "No durable host command is available")
    }
    if (snapshot.dispatch.recoveryStatus === "claimed_no_receipt") {
      const now = dependencies.now?.() ?? Date.now()
      if (now < Date.parse(snapshot.dispatch.claim!.claimExpiresAt)) {
        throw new HostCommandCoordinationError(
          "operation_in_progress",
          "The one-shot claim is active; recovery will not retry the process",
        )
      }
      return recordUncertainty(input, facts, snapshot.dispatch.claim!.fencingToken, new Date(now).toISOString())
    }
    if (snapshot.dispatch.recoveryStatus === "pending_outbox") {
      throw new HostCommandCoordinationError(
        "recovery_unavailable",
        "The dispatch was not claimed and is not retried automatically",
      )
    }
    return durableResult(snapshot.operation, snapshot.dispatch.receipt, null)
  } catch (cause) {
    if (cause instanceof HostCommandCoordinationError) throw cause
    throw new HostCommandCoordinationError(
      "recovery_unavailable",
      "The host command could not be recovered without retrying the process",
      cause,
    )
  }
}

function makeProposal(
  input: ProposeHostCommandInput,
  executable: ExecutionCapabilityManifest["process"]["executable"],
) {
  requireHostCommandInput(input)
  const operationID = requireOperationID(input.operationID)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const baseline = makeControlledWriteBaselineAuthority(input.report, input.repositoryBaseline)
  const environment = [
    { name: "LANG", value: "C" },
    { name: "LC_ALL", value: "C" },
    { name: "TZ", value: "UTC" },
  ] as const
  const resources = [`process:${executable.canonicalPath}`, `workspace:${input.report.root}`]
  const stdinDigest = sha256(new Uint8Array())
  const limits = {
    timeoutMs: commandTimeoutMilliseconds,
    maxStdoutBytes: commandOutputLimitBytes,
    maxStderrBytes: commandOutputLimitBytes,
  } as const
  const preview = freezePreview({
    command: "pwd",
    boundary: "host_no_sandbox",
    boundaryLabel: hostExecutionBoundaryLabel,
    executable: { requestedPath: pwdExecutable, ...executable },
    argv: [executable.canonicalPath],
    workingDirectory: "/",
    environment,
    stdin: { bytes: 0, digest: stdinDigest },
    limits,
    workspace: {
      canonicalPath: input.report.root,
      device: input.report.identity!.device,
      inode: input.report.identity!.inode,
      access: "identity_guard",
    },
    resources,
    network: { mode: "host_unrestricted", warning: "network is not isolated" },
    writes: [],
  } as const satisfies HostCommandPreview)
  const manifest = {
    schemaVersion: 1,
    grant: {
      capabilityGrantID,
      operationID,
      attemptID,
      baselineDigest: requireContentDigest(baseline.baselineDigest),
      expiresAt: new Date(Date.parse(input.policyAskedAt) + authorizationLifetimeMilliseconds).toISOString(),
    },
    isolation: { platform: "darwin", backend: "host", fallback: "deny" },
    process: {
      executable,
      programDigest: digest("astra-host-command:direct-exec:pwd:v1"),
      arguments: [],
      workingDirectory: "/",
      stdinDigest,
    },
    filesystem: {
      workspace: { canonicalPath: input.report.root, ...input.report.identity! },
      runtimeScratch: {
        canonicalPath: join(homedir(), "Library", "Application Support", "Astra", "Runtime", capabilityGrantID),
        lifecycle: "private_ephemeral",
      },
      readOnlyRoots: [input.report.root],
      createOnlyFiles: [],
      writableFiles: [],
    },
    network: { mode: "host_unrestricted" },
    environment: { variables: environment },
    limits,
  } as const satisfies ExecutionCapabilityManifest
  return { manifest, preview }
}

function makeHostCommandFacts(input: ExecuteHostCommandInput) {
  requireHostCommandInput(input)
  requireTimeline(input)
  const report = deepFreeze(structuredClone(input.report))
  const repositoryBaseline = input.repositoryBaseline
    ? deepFreeze(structuredClone(input.repositoryBaseline))
    : undefined
  const authorityInput = repositoryBaseline
    ? { operationID: input.operationID, report, repositoryBaseline, policyAskedAt: input.policyAskedAt }
    : { operationID: input.operationID, report, policyAskedAt: input.policyAskedAt }
  const parsed = parseExecutionCapability(input.proposal.capability)
  if (!parsed.ok) throw new TypeError("The host command capability is invalid")
  const expected = makeProposal(authorityInput, parsed.value.manifest.process.executable)
  if (
    input.proposal.policyAskedAt !== input.policyAskedAt ||
    canonicalJson(parsed.value.manifest) !== canonicalJson(expected.manifest) ||
    canonicalJson(input.proposal.preview) !== canonicalJson(expected.preview)
  ) {
    throw new TypeError("The host command authority does not match the displayed preview")
  }

  const operationID = requireOperationID(input.operationID)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const correlationID = deterministicUUID(operationID, "correlation")
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const baselineAuthority = makeControlledWriteBaselineAuthority(report, repositoryBaseline)
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const resources = expected.preview.resources
  const intent = {
    kind: "host_command",
    schemaVersion: 1,
    parameters: {
      command: expected.preview.command,
      capabilityDigest: parsed.value.capabilityDigest,
      boundary: expected.preview.boundary,
    },
  } as const
  const baseline = {
    kind: "workspace",
    locationID: `local:${report.root}`,
    workspaceIdentity: report.identity!,
    trustDigest: baselineAuthority.baselineDigest,
    repository: baselineAuthority.repository,
    policyDigest: hostCommandPolicyDigest,
    adapterDigest: hostCommandAdapterDigest,
  } as const
  const admissionKey = digest(canonicalJson({ actor, baseline, intent, resources }))
  const completionCriterion = "host_process_exit_observed"
  const admittedPayload = {
    admissionKey,
    intent,
    baseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed", "authority_expired", "capability_consumed"],
    },
    effectSpecification: {
      effectClass: "host_command",
      targetDescriptors: [
        { resource: resources[0]!, mode: "execute_once" },
        { resource: resources[1]!, mode: "identity_guard" },
      ],
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "low",
      classification: "allowlisted_read_only_host_command",
      rationaleDigest: digest("direct execution of trusted pwd with no arguments and bounded output"),
    },
    reversibility: { kind: "irreversible" },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: "bounded-host-observer", version: "1", digest: hostCommandObserverDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: parsed.value.capabilityDigest }],
    },
  } as const
  const dispatchRequest = requireDispatchRequest({
    dispatchRequestID,
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest: parsed.value.capabilityDigest,
    baselineDigest: baselineAuthority.baselineDigest,
    executor: hostCommandExecutor,
    adapterDigest: hostCommandAdapterDigest,
    idempotencyKey: digest(canonicalJson({ operationID, attemptID, capabilityDigest: parsed.value.capabilityDigest })),
    requestedAt: input.recordingStartedAt,
    authorizationExpiresAt: parsed.value.manifest.grant.expiresAt,
  })
  const eventIDs = {
    admitted: deterministicUUID(operationID, "event:admitted"),
    policy: deterministicUUID(operationID, "event:policy-ask"),
    decision: deterministicUUID(operationID, `event:approval-${input.consent.decision}`),
    dispatch: deterministicUUID(operationID, "event:dispatch-requested"),
    claim: deterministicUUID(operationID, "event:executor-accepted"),
    receipt: deterministicUUID(operationID, "event:receipt"),
    uncertainty: deterministicUUID(operationID, "event:uncertainty"),
  }
  const common = [
    {
      expectedState: null,
      expectedSequence: 0,
      event: eventDraft({
        operationID,
        eventID: eventIDs.admitted,
        name: "operation.admitted",
        payload: admittedPayload,
        recordedAt: input.recordingStartedAt,
        observedAt: input.policyAskedAt,
        actor,
        causationID: null,
        correlationID,
        attemptID: null,
      }),
    },
    {
      expectedState: "proposed",
      expectedSequence: 1,
      event: eventDraft({
        operationID,
        eventID: eventIDs.policy,
        name: "policy.ask",
        payload: {
          decisionID,
          ruleID: "host-command-explicit-consent",
          policyDigest: hostCommandPolicyDigest,
          previewDigest: digest(canonicalJson(expected.preview)),
          capabilityDigest: parsed.value.capabilityDigest,
          approverClass: "workspace-user",
          expiresAt: parsed.value.manifest.grant.expiresAt,
        },
        recordedAt: input.recordingStartedAt,
        observedAt: input.policyAskedAt,
        actor,
        causationID: null,
        correlationID,
        attemptID: null,
      }),
    },
  ] as const satisfies ReadonlyArray<AppendOperationEvent>
  const decision = {
    expectedState: "awaiting_approval",
    expectedSequence: 2,
    event: eventDraft({
      operationID,
      eventID: eventIDs.decision,
      name: input.consent.decision === "approved" ? "approval.granted" : "approval.rejected",
      payload:
        input.consent.decision === "approved"
          ? {
              decisionID,
              capabilityGrantID,
              capabilityDigest: parsed.value.capabilityDigest,
              attemptID,
              baselineDigest: baselineAuthority.baselineDigest,
              expiresAt: parsed.value.manifest.grant.expiresAt,
            }
          : { decisionID, reasonCode: input.consent.reason ?? "user_rejected" },
      recordedAt: input.recordingStartedAt,
      observedAt: input.consent.decidedAt,
      actor,
      causationID: eventIDs.policy,
      correlationID,
      attemptID: input.consent.decision === "approved" ? attemptID : null,
    }),
  } as const satisfies AppendOperationEvent
  const dispatch = {
    expectedState: "authorized",
    expectedSequence: 3,
    event: eventDraft({
      operationID,
      eventID: eventIDs.dispatch,
      name: "dispatch.requested",
      payload: dispatchRequest,
      recordedAt: input.recordingStartedAt,
      observedAt: input.recordingStartedAt,
      actor,
      causationID: eventIDs.decision,
      correlationID,
      attemptID,
    }),
  } as const satisfies AppendOperationEvent
  return {
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest: parsed.value.capabilityDigest,
    dispatchRequestID,
    executorClaimID,
    receiptID,
    correlationID,
    baselineTrustDigest: requireContentDigest(baselineAuthority.baselineDigest),
    repositorySnapshotDigest: baselineAuthority.repositorySnapshotDigest
      ? requireContentDigest(baselineAuthority.repositorySnapshotDigest)
      : null,
    authorizationExpiresAt: parsed.value.manifest.grant.expiresAt,
    preview: expected.preview,
    report,
    repositoryBaseline,
    resources,
    eventIDs,
    commands: input.consent.decision === "approved" ? [...common, decision, dispatch] : [...common, decision],
  }
}

async function recordDeniedHostCommand(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
): Promise<DurableHostCommandResult> {
  const operation = await runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const results = yield* ledger.appendBatch(facts.commands)
      return results.at(-1)?.operation ?? null
    }),
  )
  if (!operation || operation.state !== "denied") {
    throw new HostCommandCoordinationError("state_unavailable", "The durable denial was not recorded")
  }
  return durableResult(operation, null, null)
}

async function readExistingDispatch(input: ExecuteHostCommandInput, facts: ReturnType<typeof makeHostCommandFacts>) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
    }),
  )
}

async function ingestReceipt(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
  receipt: OperationReceipt,
) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.ingestReceipt({
        receipt,
        event: {
          eventID: facts.eventIDs.receipt,
          schemaVersion: 1,
          correlationID: facts.correlationID,
          redaction: "internal",
          externalBlobDigest: null,
        },
      })
    }),
  )
}

async function ingestPendingReceipt(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
  dependencies: Pick<HostCommandCoordinatorDependencies, "now"> = {},
) {
  const pending = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.listPending({ limit: 2 })
    }),
  )
  if (pending.length > 1) {
    throw new HostCommandCoordinationError("recovery_unavailable", "Multiple receipts require reconciliation")
  }
  const entry = pending[0]
  if (!entry) return
  if (
    entry.receipt.operationID !== facts.operationID ||
    entry.receipt.receiptID !== facts.receiptID ||
    entry.receipt.capabilityDigest !== facts.capabilityDigest
  ) {
    throw new HostCommandCoordinationError("recovery_unavailable", "The pending receipt is not bound to this command")
  }
  const dispatch = await readExistingDispatch(input, facts)
  if (dispatch?.claim && dispatch.recoveryStatus === "claim_uncertain") {
    return quarantineReceiptAgainstRecordedUncertainty(input, facts, entry.receipt)
  }
  if (dispatch?.claim && Date.parse(entry.receipt.endedAt) > Date.parse(dispatch.claim.claimExpiresAt)) {
    return quarantineStaleClaimReceipt(input, facts, dispatch.claim, entry.receipt, dependencies)
  }
  const ingested = await ingestReceipt(input, facts, entry.receipt)
  await acknowledgeReceipt(input.spoolFilename, entry.receipt, ingested.event.eventID, ingested.event.digest)
}

/**
 * A spooled receipt whose effect outlived its claim lease can never be
 * ingested (the ledger proves it stale forever). Recovery must not wedge on
 * it: record durable uncertainty for the claim, then acknowledge the receipt
 * against that uncertainty event so it is retired explicitly, never as
 * success and never silently.
 */
async function quarantineStaleClaimReceipt(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
  claim: Readonly<{ claimExpiresAt: string; fencingToken: number }>,
  receipt: OperationReceipt,
  dependencies: Pick<HostCommandCoordinatorDependencies, "now">,
) {
  const now = dependencies.now?.() ?? Date.now()
  if (now < Date.parse(claim.claimExpiresAt)) {
    throw new HostCommandCoordinationError(
      "operation_in_progress",
      "The one-shot claim is active; recovery will not retire its receipt yet",
    )
  }
  const recorded = await appendClaimUncertainty(input, facts, claim.fencingToken, new Date(now).toISOString())
  await acknowledgeReceipt(input.spoolFilename, receipt, recorded.event.eventID, recorded.event.digest)
}

/** Retires a pending receipt whose claim is already durably uncertain by binding it to the recorded uncertainty event. */
async function quarantineReceiptAgainstRecordedUncertainty(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
  receipt: OperationReceipt,
) {
  const events = await runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.readEvents(facts.operationID, { limit: 16 })
    }),
  )
  const uncertaintyEvent = events.find((event) => event.eventID === facts.eventIDs.uncertainty)
  if (!uncertaintyEvent) {
    throw new HostCommandCoordinationError("recovery_unavailable", "The recorded uncertainty event is unavailable")
  }
  await acknowledgeReceipt(input.spoolFilename, receipt, uncertaintyEvent.eventID, uncertaintyEvent.digest)
}

async function acknowledgeReceipt(
  spoolFilename: string,
  receipt: OperationReceipt,
  ledgerEventID: string,
  ledgerEventDigest: string,
) {
  await runWithCoordinatorReceiptSpool(spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      yield* spool.acknowledgeIngestedReceipt({ receiptID: receipt.receiptID, ledgerEventID, ledgerEventDigest })
    }),
  )
}

async function recordUncertainty(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
  fencingToken: number,
  observedAt: string,
) {
  const recorded = await appendClaimUncertainty(input, facts, fencingToken, observedAt)
  return durableResult(recorded.operation, null, null)
}

async function appendClaimUncertainty(
  input: ExecuteHostCommandInput,
  facts: ReturnType<typeof makeHostCommandFacts>,
  fencingToken: number,
  observedAt: string,
) {
  const uncertainty = requireUncertainty({
    uncertaintyID: deterministicUUID(facts.operationID, "uncertainty:1"),
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    reason: "claimed_without_receipt",
    observedAt,
    targetObservation: {
      state: "unavailable",
      digest: digest(canonicalJson({ command: "pwd", observation: "receipt_missing" })),
    },
  })
  const recorded = await runWithCoordinatorLedger(
    input.ledgerFilename,
    (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        return yield* ledger.recordClaimUncertainty({
          uncertainty,
          event: {
            eventID: facts.eventIDs.uncertainty,
            schemaVersion: 1,
            actor: {
              kind: "system",
              subject: "astra-coordinator:recovery",
              componentDigest: hostCommandAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    () => observedAt,
  )
  return recorded
}

async function makeHostCommandReceipt(
  facts: ReturnType<typeof makeHostCommandFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  process: HostCommandProcessObservation,
) {
  const stdoutDigest = sha256(process.stdout)
  const stderrDigest = sha256(process.stderr)
  const exitCode = process.termination.kind === "exited" ? process.termination.exitCode : null
  const observationDigest = digest(
    canonicalJson({
      capabilityDigest: facts.capabilityDigest,
      exitCode,
      started: process.started,
      stderrDigest,
      stdoutDigest,
      stopReason: process.stopReason ?? null,
    }),
  )
  const outcome = classifyHostCommandObservation(process)
  const completed = outcome === "completed_observed_not_verified"
  const noEffect = outcome === "failed_without_effect"
  const observation: OperationReceipt["observation"] = completed
    ? { kind: "effect_completed", completionDigest: observationDigest, assurance: "observed_not_verified" }
    : noEffect
      ? { kind: "no_effect_proved", proofDigest: observationDigest }
      : { kind: "effect_unknown", observationDigest }
  const verificationContext = completed
    ? ({
        schemaVersion: 3,
        admittedBaselineDigest: facts.baselineTrustDigest,
        workspaceIdentity: facts.report.identity!,
        executionBoundary: "host_no_sandbox",
        observationDigest,
        limitations: [
          "bounded process exit and output were observed",
          "command semantics and external side effects were not independently verified",
          "host execution was not sandboxed",
        ],
      } as const)
    : await legacyReceiptContext(facts)
  const stdout = decodeOutput(process.stdout)
  const stderr = decodeOutput(process.stderr)
  const outputPreview = completed
    ? `COMPLETED — OUTPUT OBSERVED — NOT VERIFIED: ${stdout.trim() || "(empty output)"}`
    : noEffect
      ? `NO EFFECT: ${process.stopReason ?? "process not started"}`
      : `EFFECT UNKNOWN: ${process.stopReason ?? `exit ${exitCode ?? "unconfirmed"}`} ${stderr.trim()}`.trim()
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: hostCommandExecutor, version: "1", digest: hostCommandAdapterDigest },
    effectClass: "host_command",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation,
    verificationContext,
    output: {
      digest: observationDigest,
      bytes: process.stdout.byteLength + process.stderr.byteLength,
      preview: outputPreview.slice(0, 4_096),
    },
  })
}

async function legacyReceiptContext(
  facts: ReturnType<typeof makeHostCommandFacts>,
): Promise<OperationReceipt["verificationContext"]> {
  const report = await scanWorkspace(facts.report.root, facts.report.limits)
  const activation = checkWorkspaceActivation(report)
  if (isGitWorkspace(facts.report)) {
    const baseline = await captureGitRepositoryBaseline(facts.report.root, facts.repositoryBaseline?.limits)
    return {
      schemaVersion: 2,
      admittedBaselineDigest: facts.baselineTrustDigest,
      admittedRepositorySnapshotDigest: facts.repositorySnapshotDigest!,
      postEffectWorkspaceDigest: report.securityDigest ? requireContentDigest(report.securityDigest) : null,
      postEffectRepositorySnapshotDigest:
        baseline.status === "complete" ? requireContentDigest(baseline.snapshot.snapshotDigest) : null,
      workspaceIdentity: facts.report.identity!,
      targetIdentity: null,
      preflightLimits: facts.report.limits,
      activationGuard: activation.allowed ? "allowed" : "blocked",
    }
  }
  return {
    admittedBaselineDigest: facts.baselineTrustDigest,
    postEffectWorkspaceDigest: report.securityDigest ? requireContentDigest(report.securityDigest) : null,
    workspaceIdentity: facts.report.identity!,
    targetIdentity: null,
    preflightLimits: facts.report.limits,
    activationGuard: activation.allowed ? "allowed" : "blocked",
  }
}

async function revalidateBaseline(
  input: Readonly<{
    report: WorkspaceTrustReport
    repositoryBaseline: GitRepositoryBaselineSnapshot | undefined
  }>,
  repositorySnapshotDigest: string | null,
): Promise<Readonly<{ matched: true }> | Readonly<{ matched: false; reason: string }>> {
  const root = await lstat(input.report.root).catch(() => null)
  if (
    !root?.isDirectory() ||
    root.isSymbolicLink() ||
    String(root.dev) !== input.report.identity?.device ||
    String(root.ino) !== input.report.identity.inode
  ) {
    return { matched: false, reason: "workspace_identity_changed" }
  }
  if (!isGitWorkspace(input.report)) return { matched: true }
  if (!input.repositoryBaseline || input.repositoryBaseline.snapshotDigest !== repositorySnapshotDigest) {
    return { matched: false, reason: "git_baseline_binding_mismatch" }
  }
  const result = await revalidateGitRepositoryBaseline(input.report.root, input.repositoryBaseline)
  if (result.status === "current" && result.currentSnapshotDigest === repositorySnapshotDigest) {
    return { matched: true }
  }
  return { matched: false, reason: result.status === "stale" ? "git_baseline_stale" : "git_baseline_blocked" }
}

async function inspectExecutableSource(path: string): Promise<ExecutionCapabilityManifest["process"]["executable"]> {
  const canonicalPath = await realpath(path)
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    const currentUser = process.getuid?.()
    if (
      !before.isFile() ||
      (before.mode & 0o111) === 0 ||
      (before.mode & 0o022) !== 0 ||
      (currentUser !== undefined && before.uid !== 0 && before.uid !== currentUser)
    ) {
      throw new TypeError("The host command executable is not trusted")
    }
    const executableDigest = await digestHandle(handle)
    const after = await handle.stat()
    if (!sameExecutable(before, after)) throw new TypeError("The host command executable changed during inspection")
    return Object.freeze({
      canonicalPath,
      device: String(after.dev),
      inode: String(after.ino),
      digest: executableDigest,
    })
  } finally {
    await handle.close().catch(() => {})
  }
}

async function revalidateExecutable(expected: ExecutionCapabilityManifest["process"]["executable"]) {
  if ((await realpath(expected.canonicalPath).catch(() => null)) !== expected.canonicalPath) return false
  const handle = await open(expected.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return false
  try {
    const before = await handle.stat()
    const path = await lstat(expected.canonicalPath).catch(() => null)
    if (
      !before.isFile() ||
      !path?.isFile() ||
      path.isSymbolicLink() ||
      before.dev !== path.dev ||
      before.ino !== path.ino ||
      String(before.dev) !== expected.device ||
      String(before.ino) !== expected.inode ||
      (before.mode & 0o111) === 0 ||
      (before.mode & 0o022) !== 0
    ) {
      return false
    }
    const executableDigest = await digestHandle(handle)
    const after = await handle.stat()
    return sameExecutable(before, after) && executableDigest === expected.digest
  } finally {
    await handle.close().catch(() => {})
  }
}

async function runBoundedHostCommand(preview: HostCommandPreview): Promise<HostCommandProcessObservation> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null
  let exited = false
  let stopReason: HostCommandProcessObservation["stopReason"]
  let forceKill: ReturnType<typeof setTimeout> | null = null
  let hardStop: ReturnType<typeof setTimeout> | null = null
  try {
    child = Bun.spawn([...preview.argv], {
      cwd: preview.workingDirectory,
      env: Object.fromEntries(preview.environment.map(({ name, value }) => [name, value])),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const current = child
    const requestStop = (reason: NonNullable<HostCommandProcessObservation["stopReason"]>) => {
      if (stopReason) return
      stopReason = reason
      killProcessGroup(current, "SIGTERM")
      forceKill = setTimeout(() => {
        if (!exited) killProcessGroup(current, "SIGKILL")
      }, 100)
    }
    const timeout = setTimeout(() => requestStop("timeout"), preview.limits.timeoutMs)
    const observed = Promise.all([
      current.exited.then((exitCode) => {
        exited = true
        return exitCode
      }),
      readBounded(current.stdout, preview.limits.maxStdoutBytes, () => requestStop("stdout_limit_exceeded")),
      readBounded(current.stderr, preview.limits.maxStderrBytes, () => requestStop("stderr_limit_exceeded")),
    ]).catch(() => null)
    const hardStopped = new Promise<null>((resolve) => {
      hardStop = setTimeout(() => {
        requestStop(stopReason ?? "process_observation_failed")
        resolve(null)
      }, preview.limits.timeoutMs + processTerminationGraceMilliseconds)
    })
    const result = await Promise.race([observed, hardStopped])
    clearTimeout(timeout)
    if (!result) {
      return {
        started: true,
        termination: { kind: "unconfirmed" },
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stopReason: stopReason ?? "process_observation_failed",
      }
    }
    return {
      started: true,
      termination: { kind: "exited", exitCode: result[0] },
      stdout: result[1],
      stderr: result[2],
      ...(stopReason ? { stopReason } : {}),
    }
  } catch {
    if (!child) return notStartedObservation("process_not_started")
    return {
      started: true,
      termination: { kind: "unconfirmed" },
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      stopReason: "process_observation_failed",
    }
  } finally {
    if (forceKill) clearTimeout(forceKill)
    if (hardStop) clearTimeout(hardStop)
    if (child && !exited) killProcessGroup(child, "SIGKILL")
  }
}

/** Classifies process evidence without upgrading an observed exit to verification. */
export function classifyHostCommandObservation(
  observation: HostCommandProcessObservation,
): "completed_observed_not_verified" | "failed_without_effect" | "effect_unknown" {
  if (!observation.started) return "failed_without_effect"
  if (observation.termination.kind === "exited" && observation.termination.exitCode === 0 && !observation.stopReason) {
    return "completed_observed_not_verified"
  }
  return "effect_unknown"
}

function notStartedObservation(reason: string): HostCommandProcessObservation {
  return {
    started: false,
    termination: { kind: "exited", exitCode: 127 },
    stdout: new Uint8Array(),
    stderr: Buffer.from(reason),
    stopReason: "process_observation_failed",
  }
}

function freezePreview(preview: HostCommandPreview): HostCommandPreview {
  return Object.freeze({
    ...preview,
    executable: Object.freeze({ ...preview.executable }),
    argv: Object.freeze([...preview.argv]),
    environment: Object.freeze(preview.environment.map((variable) => Object.freeze({ ...variable }))),
    stdin: Object.freeze({ ...preview.stdin }),
    limits: Object.freeze({ ...preview.limits }),
    workspace: Object.freeze({ ...preview.workspace }),
    resources: Object.freeze([...preview.resources]),
    network: Object.freeze({ ...preview.network }),
    writes: Object.freeze([]),
  })
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onExceeded: () => void) {
  const chunks: Array<Uint8Array> = []
  let retained = 0
  let exceeded = false
  for await (const chunk of stream) {
    const remaining = Math.max(0, limit - retained)
    if (remaining > 0) {
      const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
      chunks.push(kept)
      retained += kept.byteLength
    }
    if (!exceeded && chunk.byteLength > remaining) {
      exceeded = true
      onExceeded()
    }
  }
  const output = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function durableResult(
  operation: OperationRecord,
  receipt: OperationReceipt | null,
  process: HostCommandProcessObservation | null,
): DurableHostCommandResult {
  if (
    operation.state !== "denied" &&
    operation.state !== "completed" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required"
  ) {
    throw new HostCommandCoordinationError(
      "recovery_unavailable",
      `Operation state ${operation.state} is outside the host command boundary`,
    )
  }
  const status =
    operation.state === "denied"
      ? "denied_without_effect"
      : operation.state === "completed"
        ? "completed_observed_not_verified"
        : operation.state === "failed"
          ? "failed_without_effect"
          : "effect_unknown"
  return {
    operationID: operation.operationID,
    state: operation.state,
    status,
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    boundaryLabel: hostExecutionBoundaryLabel,
    output: process
      ? {
          stdout: decodeOutput(process.stdout),
          stderr: decodeOutput(process.stderr),
          exitCode: process.termination.kind === "exited" ? process.termination.exitCode : null,
        }
      : null,
  }
}

function requireHostCommandInput(input: ProposeHostCommandInput) {
  if (process.platform !== "darwin") throw new TypeError("Host command execution is unavailable on this platform")
  if (input.report.completeness !== "complete" || !input.report.identity || !input.report.securityDigest) {
    throw new TypeError("A complete preflight is required for a host command")
  }
  requireOperationID(input.operationID)
  requireCanonicalTimestamp(input.policyAskedAt)
}

function requireTimeline(input: ExecuteHostCommandInput) {
  const values = [input.policyAskedAt, input.consent.decidedAt, input.recordingStartedAt]
  const times = values.map((value) => Date.parse(requireCanonicalTimestamp(value)))
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) {
    throw new TypeError("Host command observations must use a monotonic timeline")
  }
  if (times[2]! >= Date.parse(input.proposal.capability.manifest.grant.expiresAt)) {
    throw new TypeError("Host command consent has expired")
  }
}

function eventDraft(input: {
  operationID: OperationID
  eventID: string
  name: OperationEventDraft["name"]
  payload: Readonly<Record<string, unknown>>
  recordedAt: string
  observedAt: string
  actor: ActorRef
  causationID: string | null
  correlationID: string
  attemptID: string | null
}): OperationEventDraft {
  return { ...input, schemaVersion: 1, redaction: "internal", externalBlobDigest: null }
}

function requireCanonicalTimestamp(input: string) {
  const milliseconds = Date.parse(input)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw new TypeError("Host command times must be canonical UTC timestamps")
  }
  return input
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The host command Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The host command attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The host command capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The host command dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The host command claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The host command receipt ID is invalid")
  return parsed.value
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The host command digest is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError(`The host command dispatch request is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`The host command receipt is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError(`The host command uncertainty is invalid at ${parsed.issue.path}`)
  return parsed.value
}

async function digestHandle(handle: Awaited<ReturnType<typeof open>>) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, offset)
    if (result.bytesRead === 0) return requireContentDigest(`sha256:${hash.digest("hex")}`)
    hash.update(buffer.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
}

function sameExecutable(left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, right: typeof left) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function killProcessGroup(child: Bun.Subprocess, signal: NodeJS.Signals) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The child may have exited between the observation and cleanup request.
    }
  }
}

function sha256(input: Uint8Array) {
  return requireContentDigest(`sha256:${createHash("sha256").update(input).digest("hex")}`)
}

function decodeOutput(input: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(input)
}

function isGitWorkspace(report: WorkspaceTrustReport) {
  return report.surfaces.some((surface) => surface.kind === "git_metadata")
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
