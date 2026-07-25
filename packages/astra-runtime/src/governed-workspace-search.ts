import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, open, realpath } from "node:fs/promises"
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
import {
  computeGovernedWorkspaceSearchCapabilityDigest,
  governedWorkspaceSearchTaskID,
  parseGovernedWorkspaceSearchCapability,
  parseGovernedWorkspaceSearchRequest,
  type GovernedWorkspaceSearchCapability,
  type GovernedWorkspaceSearchCapabilityManifest,
  type GovernedWorkspaceSearchRequest,
} from "../../astra-domain/src/governed-workspace-search"

const authorizationLifetimeMilliseconds = 300_000
const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 7_000
const processTerminationGraceMilliseconds = 500
const grepExecutable = "/usr/bin/grep"
const searchTimeoutMilliseconds = 5_000
const searchOutputLimitBytes = 65_536
const searchStderrLimitBytes = 4_096

const governedWorkspaceSearchLauncherProgram = String.raw`
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

async function main() {
const chunks = [];
let inputBytes = 0;
for await (const chunk of Bun.stdin.stream()) {
  inputBytes += chunk.byteLength;
  if (inputBytes > 4096) throw new TypeError("Launcher input is too large");
  chunks.push(Buffer.from(chunk));
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  !input || typeof input !== "object" || Array.isArray(input) ||
  Object.keys(input).sort().join(",") !== "searchArguments,searchExecutable,workspaceIdentity"
) throw new TypeError("Invalid launcher input");
const identity = input.workspaceIdentity;
if (
  !identity || typeof identity !== "object" || Array.isArray(identity) ||
  Object.keys(identity).sort().join(",") !== "device,inode" ||
  typeof identity.device !== "string" || typeof identity.inode !== "string"
) throw new TypeError("Invalid workspace identity");
const cwd = await lstat(".");
if (!cwd.isDirectory() || cwd.isSymbolicLink() || String(cwd.dev) !== identity.device || String(cwd.ino) !== identity.inode) {
  throw new TypeError("Workspace identity changed before search");
}
const executable = input.searchExecutable;
if (
  !executable || typeof executable !== "object" || Array.isArray(executable) ||
  Object.keys(executable).sort().join(",") !== "canonicalPath,device,digest,inode" ||
  executable.canonicalPath !== "/usr/bin/grep" || typeof executable.device !== "string" ||
  typeof executable.inode !== "string" || typeof executable.digest !== "string"
) throw new TypeError("Invalid grep identity");
const pathFacts = await lstat(executable.canonicalPath);
const handle = await open(executable.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const before = await handle.stat();
  if (
    !before.isFile() || !pathFacts.isFile() || pathFacts.isSymbolicLink() ||
    before.dev !== pathFacts.dev || before.ino !== pathFacts.ino ||
    String(before.dev) !== executable.device || String(before.ino) !== executable.inode ||
    (before.mode & 0o111) === 0 || (before.mode & 0o022) !== 0
  ) throw new TypeError("Grep identity changed");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, offset);
    if (result.bytesRead === 0) break;
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
    "sha256:" + hash.digest("hex") !== executable.digest
  ) throw new TypeError("Grep content changed");
} finally {
  await handle.close();
}
const args = input.searchArguments;
if (
  !Array.isArray(args) || args.length !== 9 || args[0] !== "-r" || args[1] !== "-I" ||
  args[2] !== "-n" || args[3] !== "-F" || args[4] !== "--exclude-dir=.git" ||
  args[5] !== "--exclude-dir=node_modules" || args[6] !== "--" || typeof args[7] !== "string" || args[8] !== "."
) throw new TypeError("Invalid sealed grep arguments");
const child = Bun.spawn([executable.canonicalPath, ...args], {
  env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
return child.exited;
}

try {
  process.exit(await main());
} catch {
  process.stderr.write("ASTRA_LAUNCHER_REJECTED\n");
  process.exit(125);
}
`

const governedWorkspaceSearchPolicyDigest = digest("astra-policy:workspace-fixed-string-search-explicit-consent:v1")
const governedWorkspaceSearchAdapterDigest = digest("astra-runtime:workspace-fixed-string-search:sealed-grep:v1")
const governedWorkspaceSearchObserverDigest = digest("astra-observer:workspace-fixed-string-search-bounded-output:v1")
const governedWorkspaceSearchExecutor = "astra-executor:workspace-fixed-string-search"

export const hostExecutionBoundaryLabel = "HOST EXECUTION — NO SANDBOX"

export type GovernedWorkspaceSearchPreview = Readonly<{
  taskID: typeof governedWorkspaceSearchTaskID
  query: string
  queryBytes: number
  boundary: "host_no_sandbox"
  boundaryLabel: typeof hostExecutionBoundaryLabel
  launcher: Readonly<{
    executable: GovernedWorkspaceSearchCapabilityManifest["process"]["launcherExecutable"]
    argv: ReadonlyArray<string>
  }>
  executable: GovernedWorkspaceSearchCapabilityManifest["process"]["searchExecutable"] &
    Readonly<{ requestedPath: typeof grepExecutable }>
  argv: ReadonlyArray<string>
  workingDirectory: string
  environment: ReadonlyArray<Readonly<{ name: "LANG" | "LC_ALL" | "TZ"; value: string }>>
  stdin: Readonly<{ bytes: number; digest: ContentDigest; content: "sealed_launcher_input" }>
  limits: Readonly<{ timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }>
  workspace: Readonly<{ canonicalPath: string; device: string; inode: string; access: "identity_guard" }>
  resources: ReadonlyArray<string>
  network: Readonly<{ mode: "host_unrestricted"; warning: "network is not isolated" }>
  writes: ReadonlyArray<never>
}>

export type GovernedWorkspaceSearchProposal = Readonly<{
  capability: GovernedWorkspaceSearchCapability
  preview: GovernedWorkspaceSearchPreview
  policyAskedAt: string
  launcherProgram: string
  launcherStdin: string
}>

export type ProposeGovernedWorkspaceSearchInput = Readonly<{
  operationID: string
  request: GovernedWorkspaceSearchRequest
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
}>

export type GovernedWorkspaceSearchConsent =
  | Readonly<{ decision: "approved"; decidedAt: string }>
  | Readonly<{ decision: "rejected"; decidedAt: string; reason?: "user_rejected" }>

export type ExecuteGovernedWorkspaceSearchInput = ProposeGovernedWorkspaceSearchInput &
  Readonly<{
    ledgerFilename: string
    spoolFilename: string
    proposal: GovernedWorkspaceSearchProposal
    consent: GovernedWorkspaceSearchConsent
    recordingStartedAt: string
  }>

export type GovernedWorkspaceSearchProcessObservation = Readonly<{
  started: boolean
  termination: Readonly<{ kind: "exited"; exitCode: number }> | Readonly<{ kind: "unconfirmed" }>
  stdout: Uint8Array
  stderr: Uint8Array
  stopReason?: "timeout" | "stdout_limit_exceeded" | "stderr_limit_exceeded" | "process_observation_failed"
}>

export type DurableGovernedWorkspaceSearchResult = Readonly<{
  operationID: string
  state: "denied" | "completed" | "failed" | "reconciliation_required"
  status: "denied_without_effect" | "completed_observed_not_verified" | "failed_without_effect" | "effect_unknown"
  sequence: number
  lastCursor: number
  receiptID: string | null
  boundaryLabel: typeof hostExecutionBoundaryLabel
  output: Readonly<{
    stdout: string
    stderr: string
    exitCode: number | null
    outputLineCount: number | null
    outcome: "matches" | "no_matches" | "unknown"
  }> | null
}>

export const governedWorkspaceSearchFaultPoints = [
  "after_claim_before_effect",
  "after_effect_before_spool",
  "after_spool_before_ledger",
  "after_ledger_before_ack",
] as const

export type GovernedWorkspaceSearchFaultPoint = (typeof governedWorkspaceSearchFaultPoints)[number]

export type GovernedWorkspaceSearchDependencies = Readonly<{
  injectFault?: (point: GovernedWorkspaceSearchFaultPoint) => Promise<void>
  beforeEffectBoundary?: () => Promise<void>
  onProcessEntered?: () => void
  now?: () => number
}>

export class GovernedWorkspaceSearchCoordinationError extends Error {
  readonly _tag = "GovernedWorkspaceSearchCoordinationError"

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
export async function proposeGovernedWorkspaceSearch(
  unsafeInput: ProposeGovernedWorkspaceSearchInput,
): Promise<GovernedWorkspaceSearchProposal> {
  assertDataOnly(unsafeInput)
  const input = deepFreeze(structuredClone(unsafeInput))
  requireGovernedWorkspaceSearchInput(input)
  const launcherExecutable = await inspectExecutableSource(process.execPath)
  const inspectedSearchExecutable = await inspectExecutableSource(grepExecutable)
  if (inspectedSearchExecutable.canonicalPath !== grepExecutable) {
    throw new TypeError("The governed workspace search executable path is not canonical")
  }
  const searchExecutable = Object.freeze({ ...inspectedSearchExecutable, canonicalPath: grepExecutable })
  const proposal = makeProposal(input, launcherExecutable, searchExecutable)
  const parsed = parseGovernedWorkspaceSearchCapability({
    manifest: proposal.manifest,
    capabilityDigest: computeGovernedWorkspaceSearchCapabilityDigest(proposal.manifest),
  })
  if (!parsed.ok) throw new TypeError("The governed workspace search capability is invalid")
  return Object.freeze({
    capability: parsed.value,
    preview: proposal.preview,
    policyAskedAt: input.policyAskedAt,
    launcherProgram: proposal.launcherProgram,
    launcherStdin: proposal.launcherStdin,
  })
}

/**
 * Records consent and executes one exact allowlisted process after a durable
 * claim. Exact retries recover state and never start the process again.
 */
export async function executeGovernedWorkspaceSearch(
  unsafeInput: ExecuteGovernedWorkspaceSearchInput,
  dependencies: GovernedWorkspaceSearchDependencies = {},
): Promise<DurableGovernedWorkspaceSearchResult> {
  try {
    assertDataOnly(unsafeInput)
    const input = deepFreeze(structuredClone(unsafeInput))
    const facts = makeGovernedWorkspaceSearchFacts(input)
    await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    if (input.consent.decision === "rejected") return recordDeniedGovernedWorkspaceSearch(input, facts)

    if (await exists(input.ledgerFilename)) {
      const existing = await readExistingDispatch(input, facts)
      if (existing?.claim) return recoverGovernedWorkspaceSearch(input, dependencies)
    }

    const baseline = await revalidateBaseline(facts, facts.repositorySnapshotDigest)
    if (!baseline.matched) throw new GovernedWorkspaceSearchCoordinationError("invalid_input", baseline.reason)

    const now = dependencies.now ?? Date.now
    const claimStartedAt = now()
    const claimed = await runWithLedger(input.ledgerFilename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        yield* ledger.appendBatch(facts.commands)
        const existing = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
        if (existing?.claim) return { kind: "existing_claim" as const }
        return yield* ledger.claimDispatch({
          dispatchRequestID: facts.dispatchRequestID,
          operationID: facts.operationID,
          attemptID: facts.attemptID,
          executor: governedWorkspaceSearchExecutor,
          capabilityDigest: facts.capabilityDigest,
          executorClaimID: facts.executorClaimID,
          claimExpiresAt: new Date(
            Math.min(claimStartedAt + claimLeaseMilliseconds, Date.parse(facts.authorizationExpiresAt) - 1),
          ).toISOString(),
          event: {
            eventID: facts.eventIDs.claim,
            schemaVersion: 1,
            actor: {
              kind: "system",
              subject: governedWorkspaceSearchExecutor,
              componentDigest: governedWorkspaceSearchAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    )
    if (claimed.kind === "existing_claim" || claimed.kind === "replayed") {
      return recoverGovernedWorkspaceSearch(input, dependencies)
    }
    await dependencies.injectFault?.("after_claim_before_effect")

    await dependencies.beforeEffectBoundary?.()
    const authority = await runWithCoordinatorLedger(
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
            executor: governedWorkspaceSearchExecutor,
            adapterDigest: governedWorkspaceSearchAdapterDigest,
            baselineDigest: facts.baselineTrustDigest,
            minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
          })
        }),
      () => new Date(now()).toISOString(),
    )
    const boundaryBaseline = authority.allowed
      ? await revalidateBaseline(facts, facts.repositorySnapshotDigest)
      : { matched: false as const, reason: `effect_authority_${authority.reason}` }
    const launcherExecutable = boundaryBaseline.matched
      ? await revalidateExecutable(facts.preview.launcher.executable)
      : null
    const searchExecutable = launcherExecutable ? await revalidateExecutable(facts.preview.executable) : null

    const startedAt = new Date(now()).toISOString()
    const observation =
      boundaryBaseline.matched && launcherExecutable && searchExecutable && authority?.allowed
        ? await runBoundedGovernedWorkspaceSearch(
            facts.preview,
            facts.launcherProgram,
            facts.launcherStdin,
            dependencies.onProcessEntered,
          )
        : notStartedObservation(
            !boundaryBaseline.matched
              ? boundaryBaseline.reason
              : !launcherExecutable || !searchExecutable
                ? "executable_identity_changed"
                : "effect_authority_unavailable",
          )
    const endedAt = new Date(now()).toISOString()
    await dependencies.injectFault?.("after_effect_before_spool")
    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(input, facts, claimed.claim.fencingToken, endedAt)
    }
    const receipt = await makeGovernedWorkspaceSearchReceipt(
      facts,
      claimed.claim.fencingToken,
      startedAt,
      endedAt,
      observation,
    )
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
    if (cause instanceof GovernedWorkspaceSearchCoordinationError) throw cause
    throw new GovernedWorkspaceSearchCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The governed workspace search could not complete its durable path",
      cause,
    )
  }
}

/** Recovers receipts or marks an expired claim uncertain without rerunning the command. */
export async function recoverGovernedWorkspaceSearch(
  unsafeInput: ExecuteGovernedWorkspaceSearchInput,
  dependencies: Pick<GovernedWorkspaceSearchDependencies, "now"> = {},
): Promise<DurableGovernedWorkspaceSearchResult> {
  try {
    assertDataOnly(unsafeInput)
    const input = deepFreeze(structuredClone(unsafeInput))
    if (input.consent.decision !== "approved") {
      throw new GovernedWorkspaceSearchCoordinationError(
        "recovery_unavailable",
        "A denied command has no executor claim",
      )
    }
    const facts = makeGovernedWorkspaceSearchFacts(input)
    await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    if (await exists(input.spoolFilename)) await ingestPendingReceipt(input, facts)
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
      throw new GovernedWorkspaceSearchCoordinationError(
        "recovery_unavailable",
        "No durable governed workspace search is available",
      )
    }
    requireExactRecoveryBinding(snapshot.dispatch, facts)
    if (snapshot.dispatch.recoveryStatus === "claimed_no_receipt") {
      const now = dependencies.now?.() ?? Date.now()
      if (now < Date.parse(snapshot.dispatch.claim!.claimExpiresAt)) {
        throw new GovernedWorkspaceSearchCoordinationError(
          "operation_in_progress",
          "The one-shot claim is active; recovery will not retry the process",
        )
      }
      return recordUncertainty(input, facts, snapshot.dispatch.claim!.fencingToken, new Date(now).toISOString())
    }
    if (snapshot.dispatch.recoveryStatus === "pending_outbox") {
      throw new GovernedWorkspaceSearchCoordinationError(
        "recovery_unavailable",
        "The dispatch was not claimed and is not retried automatically",
      )
    }
    return durableResult(snapshot.operation, snapshot.dispatch.receipt, null)
  } catch (cause) {
    if (cause instanceof GovernedWorkspaceSearchCoordinationError) throw cause
    throw new GovernedWorkspaceSearchCoordinationError(
      "recovery_unavailable",
      "The governed workspace search could not be recovered without retrying the process",
      cause,
    )
  }
}

function requireExactRecoveryBinding(
  dispatch: NonNullable<Awaited<ReturnType<typeof readExistingDispatch>>>,
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
) {
  const request = dispatch.request
  if (
    request.operationID !== facts.operationID ||
    request.attemptID !== facts.attemptID ||
    request.capabilityGrantID !== facts.capabilityGrantID ||
    request.capabilityDigest !== facts.capabilityDigest ||
    request.baselineDigest !== facts.baselineTrustDigest ||
    request.executor !== governedWorkspaceSearchExecutor ||
    request.adapterDigest !== governedWorkspaceSearchAdapterDigest
  ) {
    throw new GovernedWorkspaceSearchCoordinationError(
      "invalid_input",
      "The durable dispatch belongs to different search authority",
    )
  }
  if (
    dispatch.claim &&
    (dispatch.claim.operationID !== facts.operationID ||
      dispatch.claim.attemptID !== facts.attemptID ||
      dispatch.claim.dispatchRequestID !== facts.dispatchRequestID ||
      dispatch.claim.executorClaimID !== facts.executorClaimID ||
      dispatch.claim.capabilityDigest !== facts.capabilityDigest ||
      dispatch.claim.executor !== governedWorkspaceSearchExecutor)
  ) {
    throw new GovernedWorkspaceSearchCoordinationError(
      "invalid_input",
      "The durable claim belongs to different search authority",
    )
  }
  if (
    dispatch.receipt &&
    (dispatch.receipt.operationID !== facts.operationID ||
      dispatch.receipt.attemptID !== facts.attemptID ||
      dispatch.receipt.dispatchRequestID !== facts.dispatchRequestID ||
      dispatch.receipt.executorClaimID !== facts.executorClaimID ||
      dispatch.receipt.capabilityGrantID !== facts.capabilityGrantID ||
      dispatch.receipt.capabilityDigest !== facts.capabilityDigest)
  ) {
    throw new GovernedWorkspaceSearchCoordinationError(
      "invalid_input",
      "The durable receipt belongs to different search authority",
    )
  }
}

function makeProposal(
  input: ProposeGovernedWorkspaceSearchInput,
  launcherExecutable: GovernedWorkspaceSearchCapabilityManifest["process"]["launcherExecutable"],
  searchExecutable: GovernedWorkspaceSearchCapabilityManifest["process"]["searchExecutable"],
) {
  requireGovernedWorkspaceSearchInput(input)
  const operationID = requireOperationID(input.operationID)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const baseline = makeControlledWriteBaselineAuthority(input.report, input.repositoryBaseline)
  const request = requireSearchRequest(input.request)
  const environment = [
    { name: "LANG", value: "C" },
    { name: "LC_ALL", value: "C" },
    { name: "TZ", value: "UTC" },
  ] as const
  const searchArguments = [
    "-r",
    "-I",
    "-n",
    "-F",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--",
    request.query,
    ".",
  ] as const
  const launcherArguments = [
    "--no-install",
    "--no-env-file",
    "--config=/dev/null",
    "--eval",
    governedWorkspaceSearchLauncherProgram,
  ] as const
  const launcherStdin = JSON.stringify({
    workspaceIdentity: input.report.identity!,
    searchExecutable,
    searchArguments,
  })
  const stdinDigest = sha256(Buffer.from(launcherStdin))
  const resources = [
    `process:${launcherExecutable.canonicalPath}`,
    `process:${searchExecutable.canonicalPath}`,
    `workspace:${input.report.root}`,
  ]
  const limits = {
    timeoutMs: searchTimeoutMilliseconds,
    maxStdoutBytes: searchOutputLimitBytes,
    maxStderrBytes: searchStderrLimitBytes,
  } as const
  const preview = freezePreview({
    taskID: governedWorkspaceSearchTaskID,
    query: request.query,
    queryBytes: request.queryBytes,
    boundary: "host_no_sandbox",
    boundaryLabel: hostExecutionBoundaryLabel,
    launcher: { executable: launcherExecutable, argv: [launcherExecutable.canonicalPath, ...launcherArguments] },
    executable: { requestedPath: grepExecutable, ...searchExecutable },
    argv: [searchExecutable.canonicalPath, ...searchArguments],
    workingDirectory: input.report.root,
    environment,
    stdin: { bytes: Buffer.byteLength(launcherStdin), digest: stdinDigest, content: "sealed_launcher_input" },
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
  } as const satisfies GovernedWorkspaceSearchPreview)
  const manifest = {
    schemaVersion: 1,
    grant: {
      capabilityGrantID,
      operationID,
      attemptID,
      baselineDigest: requireContentDigest(baseline.baselineDigest),
      expiresAt: new Date(Date.parse(input.policyAskedAt) + authorizationLifetimeMilliseconds).toISOString(),
    },
    boundary: "host_no_sandbox",
    task: {
      taskID: governedWorkspaceSearchTaskID,
      queryDigest: sha256(Buffer.from(request.query)),
      queryBytes: request.queryBytes,
    },
    process: {
      launcherExecutable,
      programDigest: sha256(Buffer.from(governedWorkspaceSearchLauncherProgram)),
      arguments: launcherArguments,
      workingDirectory: input.report.root,
      stdinDigest,
      searchExecutable,
      searchArguments,
    },
    filesystem: {
      workspace: { canonicalPath: input.report.root, ...input.report.identity! },
      readOnlyRoots: [input.report.root],
      writableFiles: [],
    },
    network: { mode: "host_unrestricted" },
    environment: { variables: environment },
    limits,
  } as const satisfies GovernedWorkspaceSearchCapabilityManifest
  return { manifest, preview, launcherProgram: governedWorkspaceSearchLauncherProgram, launcherStdin }
}

function makeGovernedWorkspaceSearchFacts(input: ExecuteGovernedWorkspaceSearchInput) {
  requireGovernedWorkspaceSearchInput(input)
  const proposal = requireProposalData(input.proposal)
  const parsed = parseGovernedWorkspaceSearchCapability(proposal.capability)
  if (!parsed.ok) throw new TypeError("The governed workspace search capability is invalid")
  requireTimeline(input, parsed.value.manifest.grant.expiresAt)
  const report = deepFreeze(structuredClone(input.report))
  const repositoryBaseline = input.repositoryBaseline
    ? deepFreeze(structuredClone(input.repositoryBaseline))
    : undefined
  const authorityInput = repositoryBaseline
    ? {
        operationID: input.operationID,
        request: input.request,
        report,
        repositoryBaseline,
        policyAskedAt: input.policyAskedAt,
      }
    : { operationID: input.operationID, request: input.request, report, policyAskedAt: input.policyAskedAt }
  const expected = makeProposal(
    authorityInput,
    parsed.value.manifest.process.launcherExecutable,
    parsed.value.manifest.process.searchExecutable,
  )
  if (
    proposal.policyAskedAt !== input.policyAskedAt ||
    proposal.launcherProgram !== expected.launcherProgram ||
    proposal.launcherStdin !== expected.launcherStdin ||
    canonicalJson(parsed.value.manifest) !== canonicalJson(expected.manifest) ||
    canonicalJson(proposal.preview) !== canonicalJson(expected.preview)
  ) {
    throw new TypeError("The governed workspace search authority does not match the displayed preview")
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
  const request = requireSearchRequest(input.request)
  const intent = {
    kind: "workspace_fixed_string_search",
    schemaVersion: 1,
    parameters: {
      taskID: request.taskID,
      queryDigest: sha256(Buffer.from(request.query)),
      queryBytes: request.queryBytes,
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
    policyDigest: governedWorkspaceSearchPolicyDigest,
    adapterDigest: governedWorkspaceSearchAdapterDigest,
  } as const
  const admissionKey = digest(canonicalJson({ actor, baseline, intent, resources }))
  const completionCriterion = "bounded_grep_exit_observed"
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
      classification: "closed_read_only_workspace_search",
      rationaleDigest: digest("sealed direct grep with fixed flags, exact workspace, and bounded output"),
    },
    reversibility: { kind: "irreversible" },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: "bounded-search-observer", version: "1", digest: governedWorkspaceSearchObserverDigest },
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
    executor: governedWorkspaceSearchExecutor,
    adapterDigest: governedWorkspaceSearchAdapterDigest,
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
          ruleID: "workspace-fixed-string-search-explicit-consent",
          policyDigest: governedWorkspaceSearchPolicyDigest,
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
    launcherProgram: expected.launcherProgram,
    launcherStdin: expected.launcherStdin,
    report,
    repositoryBaseline,
    resources,
    eventIDs,
    commands: input.consent.decision === "approved" ? [...common, decision, dispatch] : [...common, decision],
  }
}

async function recordDeniedGovernedWorkspaceSearch(
  input: ExecuteGovernedWorkspaceSearchInput,
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
): Promise<DurableGovernedWorkspaceSearchResult> {
  const operation = await runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const results = yield* ledger.appendBatch(facts.commands)
      return results.at(-1)?.operation ?? null
    }),
  )
  if (!operation || operation.state !== "denied") {
    throw new GovernedWorkspaceSearchCoordinationError("state_unavailable", "The durable denial was not recorded")
  }
  return durableResult(operation, null, null)
}

async function readExistingDispatch(
  input: ExecuteGovernedWorkspaceSearchInput,
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
    }),
  )
}

async function ingestReceipt(
  input: ExecuteGovernedWorkspaceSearchInput,
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
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
  input: ExecuteGovernedWorkspaceSearchInput,
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
) {
  const entry = await runWithReceiptSpool(input.spoolFilename, (spool) =>
    Effect.gen(function* () {
      yield* spool.initialize()
      return yield* spool.get(facts.receiptID)
    }),
  )
  if (!entry || entry.acknowledgement) return
  if (
    entry.receipt.operationID !== facts.operationID ||
    entry.receipt.receiptID !== facts.receiptID ||
    entry.receipt.capabilityDigest !== facts.capabilityDigest
  ) {
    throw new GovernedWorkspaceSearchCoordinationError(
      "recovery_unavailable",
      "The pending receipt is not bound to this command",
    )
  }
  const ingested = await ingestReceipt(input, facts, entry.receipt)
  await acknowledgeReceipt(input.spoolFilename, entry.receipt, ingested.event.eventID, ingested.event.digest)
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
  input: ExecuteGovernedWorkspaceSearchInput,
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
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
      digest: digest(canonicalJson({ taskID: governedWorkspaceSearchTaskID, observation: "receipt_missing" })),
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
              componentDigest: governedWorkspaceSearchAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "internal",
            externalBlobDigest: null,
          },
        })
      }),
    () => observedAt,
  )
  return durableResult(recorded.operation, null, null)
}

async function makeGovernedWorkspaceSearchReceipt(
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  process: GovernedWorkspaceSearchProcessObservation,
) {
  const stdoutDigest = sha256(process.stdout)
  const stderrDigest = sha256(process.stderr)
  const exitCode = process.termination.kind === "exited" ? process.termination.exitCode : null
  const outputLineCount = completedSearchExit(process) ? countOutputLines(process.stdout) : null
  const observationDigest = digest(
    canonicalJson({
      capabilityDigest: facts.capabilityDigest,
      exitCode,
      started: process.started,
      stderrDigest,
      stdoutDigest,
      outputLineCount,
      stopReason: process.stopReason ?? null,
    }),
  )
  const outcome = classifyGovernedWorkspaceSearchObservation(process)
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
  const outputPreview = completed
    ? `COMPLETED — SEARCH OUTPUT OBSERVED — NOT VERIFIED • ${outputLineCount ?? 0} OUTPUT LINES`
    : noEffect
      ? "NO EFFECT — SEARCH PROCESS NOT STARTED"
      : `EFFECT UNKNOWN — SEARCH ${redactedStopStatus(process, exitCode)}`
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: governedWorkspaceSearchExecutor, version: "1", digest: governedWorkspaceSearchAdapterDigest },
    effectClass: "host_command",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation,
    verificationContext,
    output: {
      digest: observationDigest,
      bytes: process.stdout.byteLength + process.stderr.byteLength,
      preview: outputPreview,
    },
  })
}

async function legacyReceiptContext(
  facts: ReturnType<typeof makeGovernedWorkspaceSearchFacts>,
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
  const current = await scanWorkspace(input.report.root, input.report.limits)
  if (
    current.completeness !== "complete" ||
    !current.identity ||
    current.identity.device !== input.report.identity.device ||
    current.identity.inode !== input.report.identity.inode ||
    current.securityDigest !== input.report.securityDigest
  ) {
    return { matched: false, reason: "workspace_preflight_changed" }
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

async function inspectExecutableSource(
  path: string,
): Promise<GovernedWorkspaceSearchCapabilityManifest["process"]["launcherExecutable"]> {
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
      throw new TypeError("The governed workspace search executable is not trusted")
    }
    const executableDigest = await digestHandle(handle)
    const after = await handle.stat()
    if (!sameExecutable(before, after))
      throw new TypeError("The governed workspace search executable changed during inspection")
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

async function revalidateExecutable(
  expected:
    | GovernedWorkspaceSearchCapabilityManifest["process"]["launcherExecutable"]
    | GovernedWorkspaceSearchCapabilityManifest["process"]["searchExecutable"],
) {
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

async function runBoundedGovernedWorkspaceSearch(
  preview: GovernedWorkspaceSearchPreview,
  launcherProgram: string,
  launcherStdin: string,
  onProcessEntered?: () => void,
): Promise<GovernedWorkspaceSearchProcessObservation> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
  let exited = false
  let stopReason: GovernedWorkspaceSearchProcessObservation["stopReason"]
  let forceKill: ReturnType<typeof setTimeout> | null = null
  let hardStop: ReturnType<typeof setTimeout> | null = null
  try {
    notifyProcessEntered(onProcessEntered)
    if (
      launcherProgram !== governedWorkspaceSearchLauncherProgram ||
      preview.launcher.argv.length !== 6 ||
      preview.launcher.argv[5] !== launcherProgram ||
      sha256(Buffer.from(launcherStdin)) !== preview.stdin.digest ||
      Buffer.byteLength(launcherStdin) !== preview.stdin.bytes
    ) {
      return notStartedObservation("launcher_authority_mismatch")
    }
    child = Bun.spawn([...preview.launcher.argv], {
      cwd: preview.workingDirectory,
      env: Object.fromEntries(preview.environment.map(({ name, value }) => [name, value])),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const current = child
    await current.stdin.write(Buffer.from(launcherStdin))
    await current.stdin.end()
    const requestStop = (reason: NonNullable<GovernedWorkspaceSearchProcessObservation["stopReason"]>) => {
      if (stopReason) return
      stopReason = reason
      killProcessGroup(current, "SIGTERM")
      forceKill = setTimeout(() => {
        killProcessGroup(current, "SIGKILL")
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
        if (!stopReason) stopReason = "process_observation_failed"
        killProcessGroup(current, "SIGKILL")
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
    if (child && (!exited || stopReason)) killProcessGroup(child, "SIGKILL")
  }
}

/** Classifies process evidence without upgrading an observed exit to verification. */
export function classifyGovernedWorkspaceSearchObservation(
  observation: GovernedWorkspaceSearchProcessObservation,
): "completed_observed_not_verified" | "failed_without_effect" | "effect_unknown" {
  if (!observation.started) return "failed_without_effect"
  if (completedSearchExit(observation)) {
    return "completed_observed_not_verified"
  }
  return "effect_unknown"
}

function notStartedObservation(reason: string): GovernedWorkspaceSearchProcessObservation {
  return {
    started: false,
    termination: { kind: "exited", exitCode: 127 },
    stdout: new Uint8Array(),
    stderr: Buffer.from(reason),
    stopReason: "process_observation_failed",
  }
}

function completedSearchExit(observation: GovernedWorkspaceSearchProcessObservation) {
  return (
    observation.started &&
    observation.termination.kind === "exited" &&
    (observation.termination.exitCode === 0 || observation.termination.exitCode === 1) &&
    !observation.stopReason
  )
}

function countOutputLines(output: Uint8Array) {
  if (output.byteLength === 0) return 0
  const text = decodeOutput(output)
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

function redactedStopStatus(observation: GovernedWorkspaceSearchProcessObservation, exitCode: number | null) {
  if (observation.stopReason === "timeout") return "TIMED OUT"
  if (observation.stopReason === "stdout_limit_exceeded") return "OUTPUT LIMIT EXCEEDED"
  if (observation.stopReason === "stderr_limit_exceeded") return "ERROR OUTPUT LIMIT EXCEEDED"
  if (observation.stopReason) return "OBSERVATION FAILED"
  return `EXIT ${exitCode ?? "UNCONFIRMED"}`
}

function notifyProcessEntered(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {
    // Observability callbacks cannot change process authority or retry behavior.
  }
}

function freezePreview(preview: GovernedWorkspaceSearchPreview): GovernedWorkspaceSearchPreview {
  return Object.freeze({
    ...preview,
    launcher: Object.freeze({
      ...preview.launcher,
      executable: Object.freeze({ ...preview.launcher.executable }),
      argv: Object.freeze([...preview.launcher.argv]),
    }),
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

function assertDataOnly(input: unknown, depth = 0, budget = { fields: 0 }): void {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return
  }
  if (typeof input !== "object" || depth > 16) {
    throw new TypeError("Governed workspace search inputs must contain plain bounded data")
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new TypeError("Governed workspace search inputs must contain plain bounded data")
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw new TypeError("Governed workspace search symbol fields are not allowed")
    if (Array.isArray(input) && key === "length") continue
    budget.fields++
    if (budget.fields > 2_048) throw new TypeError("Governed workspace search input field limit exceeded")
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Governed workspace search input accessors are not allowed")
    }
    assertDataOnly(descriptor.value, depth + 1, budget)
  }
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
  process: GovernedWorkspaceSearchProcessObservation | null,
): DurableGovernedWorkspaceSearchResult {
  if (
    operation.state !== "denied" &&
    operation.state !== "completed" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required"
  ) {
    throw new GovernedWorkspaceSearchCoordinationError(
      "recovery_unavailable",
      `Operation state ${operation.state} is outside the governed workspace search boundary`,
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
          outputLineCount: completedSearchExit(process) ? countOutputLines(process.stdout) : null,
          outcome:
            completedSearchExit(process) && process.termination.kind === "exited"
              ? process.termination.exitCode === 0
                ? "matches"
                : "no_matches"
              : "unknown",
        }
      : null,
  }
}

function requireGovernedWorkspaceSearchInput(input: ProposeGovernedWorkspaceSearchInput) {
  if (process.platform !== "darwin")
    throw new TypeError("Governed workspace search execution is unavailable on this platform")
  if (input.report.completeness !== "complete" || !input.report.identity || !input.report.securityDigest) {
    throw new TypeError("A complete preflight is required for a governed workspace search")
  }
  requireSearchRequest(input.request)
  const activation = checkWorkspaceActivation(input.report)
  if (!activation.allowed && (!isGitWorkspace(input.report) || !input.repositoryBaseline)) {
    throw new TypeError(`Workspace activation is required: ${activation.reason}`)
  }
  requireOperationID(input.operationID)
  requireCanonicalTimestamp(input.policyAskedAt)
}

function requireSearchRequest(input: unknown): GovernedWorkspaceSearchRequest {
  const parsed = parseGovernedWorkspaceSearchRequest(input)
  if (!parsed.ok) throw new TypeError(`The governed workspace search request is invalid: ${parsed.issue}`)
  return parsed.value
}

function requireProposalData(input: GovernedWorkspaceSearchProposal) {
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("The governed workspace search proposal must be plain data")
  }
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== 5 ||
    !keys.every(
      (key) =>
        key === "capability" ||
        key === "preview" ||
        key === "policyAskedAt" ||
        key === "launcherProgram" ||
        key === "launcherStdin",
    )
  ) {
    throw new TypeError("The governed workspace search proposal shape is invalid")
  }
  const values = Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("The governed workspace search proposal cannot contain accessors")
      }
      return [key, descriptor.value]
    }),
  ) as Record<string, unknown>
  return {
    capability: values.capability,
    preview: values.preview,
    policyAskedAt: values.policyAskedAt,
    launcherProgram: values.launcherProgram,
    launcherStdin: values.launcherStdin,
  }
}

function requireTimeline(input: ExecuteGovernedWorkspaceSearchInput, authorizationExpiresAt: string) {
  const values = [input.policyAskedAt, input.consent.decidedAt, input.recordingStartedAt]
  const times = values.map((value) => Date.parse(requireCanonicalTimestamp(value)))
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) {
    throw new TypeError("Governed workspace search observations must use a monotonic timeline")
  }
  if (times[2]! >= Date.parse(authorizationExpiresAt)) {
    throw new TypeError("Governed workspace search consent has expired")
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
    throw new TypeError("Governed workspace search times must be canonical UTC timestamps")
  }
  return input
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search receipt ID is invalid")
  return parsed.value
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The governed workspace search digest is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok)
    throw new TypeError(`The governed workspace search dispatch request is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError(`The governed workspace search receipt is invalid at ${parsed.issue.path}`)
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError(`The governed workspace search uncertainty is invalid at ${parsed.issue.path}`)
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
