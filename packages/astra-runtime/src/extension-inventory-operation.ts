import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, unlinkSync } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
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
import { Effect } from "effect"
import {
  computeExtensionInventoryCapabilityDigest,
  extensionInventoryAllowlist,
  extensionInventoryBoundaryLabel,
  extensionInventoryLimits,
  extensionInventoryResourceClasses,
  parseExtensionInventoryProposal,
  parseExtensionInventoryReport,
  type ExtensionInventoryCandidate,
  type ExtensionInventoryHelperIdentity,
  type ExtensionInventoryProposal,
  type ExtensionInventoryReport,
} from "@astra/domain/extension-inventory-operation"
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

const authorizationLifetimeMilliseconds = 5 * 60_000
const claimLeaseMilliseconds = 60_000
const minimumEffectLeaseMilliseconds = 5_000
const helperMaximumBytes = 32 * 1024 * 1024
const processTerminationGraceMilliseconds = 250
const extensionInventoryPolicyDigest = digest("astra-policy:extension-inventory-explicit-consent:v1")
const extensionInventoryAdapterDigest = digest("astra-runtime:extension-inventory-native-parent:v1")
const extensionInventoryObserverDigest = digest("astra-observer:redacted-extension-inventory:v1")
const extensionInventoryExecutor = "astra-executor:extension-inventory-native-parent"

export type ExtensionInventoryTrustedSession = Readonly<{
  mode: "activate-once"
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
}>

export type ProposeExtensionInventoryInput = Readonly<{
  operationID: string
  policyAskedAt: string
  session: ExtensionInventoryTrustedSession
  helper: ExtensionInventoryHelperIdentity
}>

export type ExtensionInventoryConsent =
  | Readonly<{ decision: "approved"; decidedAt: string }>
  | Readonly<{ decision: "rejected"; decidedAt: string; reason?: "user_rejected" }>

export type ExecuteExtensionInventoryInput = ProposeExtensionInventoryInput &
  Readonly<{
    proposal: ExtensionInventoryProposal
    consent: ExtensionInventoryConsent
    recordingStartedAt: string
    ledgerFilename: string
    spoolFilename: string
  }>

export type DurableExtensionInventoryResult = Readonly<{
  operationID: string
  state: "denied" | "completed" | "failed" | "reconciliation_required"
  status: "denied_without_effect" | "completed_observed_not_verified" | "failed_without_effect" | "effect_unknown"
  sequence: number
  lastCursor: number
  receiptID: string | null
  boundaryLabel: typeof extensionInventoryBoundaryLabel
  inventory: ExtensionInventoryReport | null
}>

export const extensionInventoryFaultPoints = [
  "after_claim_before_effect",
  "after_effect_before_spool",
  "after_spool_before_ledger",
  "after_ledger_before_ack",
] as const

export type ExtensionInventoryDependencies = Readonly<{
  now?: () => number
  injectFault?: (point: (typeof extensionInventoryFaultPoints)[number]) => Promise<void>
  beforeEffectBoundary?: () => Promise<void>
  onPostClaimWorkspaceValidation?: () => void | Promise<void>
  beforePinnedHelperSpawn?: () => Promise<void>
  onWorkspaceRootOpened?: () => void
  onProcessEntered?: () => void
}>

export class ExtensionInventoryCoordinationError extends Error {
  readonly _tag = "ExtensionInventoryCoordinationError"

  constructor(
    readonly code: "invalid_input" | "state_unavailable" | "recovery_unavailable" | "operation_in_progress",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

/** Inspects the trusted helper itself; this never reads the workspace. */
export async function inspectTrustedExtensionInventoryHelper(path: string): Promise<ExtensionInventoryHelperIdentity> {
  const canonicalPath = await realpath(resolve(path))
  const pathFacts = await lstat(canonicalPath)
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    requireTrustedHelperFacts(pathFacts, before)
    const helperDigest = await digestFileHandle(handle, helperMaximumBytes)
    const after = await handle.stat()
    if (!sameFileIdentity(before, after)) throw new TypeError("The extension inventory helper changed")
    return Object.freeze({
      canonicalPath,
      device: String(after.dev),
      inode: String(after.ino),
      size: after.size,
      digest: helperDigest,
    })
  } finally {
    await handle.close()
  }
}

/** Prepares only private Operation state and never canonicalizes or opens the workspace. */
async function preparePrivateOperationStateFiles(workspace: string, ledgerFilename: string, spoolFilename: string) {
  const ledgerFamily = sqliteFamily(ledgerFilename)
  const spoolFamily = sqliteFamily(spoolFilename)
  if (ledgerFamily.some((candidate) => spoolFamily.includes(candidate))) {
    throw new TypeError("The inventory Operation state files overlap")
  }
  for (const filename of [ledgerFilename, spoolFilename]) {
    const parent = dirname(resolve(filename))
    if (inside(workspace, parent)) throw new TypeError("Inventory Operation state must remain outside the workspace")
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const canonicalParent = await realpath(parent)
    if (!canonicalAliases(parent).includes(canonicalParent) || inside(workspace, canonicalParent)) {
      throw new TypeError("The inventory Operation state parent is not private")
    }
    const parentFacts = await lstat(canonicalParent)
    const uid = process.getuid?.()
    if (
      !parentFacts.isDirectory() ||
      parentFacts.isSymbolicLink() ||
      (uid !== undefined && parentFacts.uid !== uid) ||
      (parentFacts.mode & 0o077) !== 0
    ) {
      throw new TypeError("The inventory Operation state parent is not private")
    }
    for (const candidate of sqliteFamily(filename)) {
      const facts = await lstat(candidate).catch((cause: unknown) => {
        if (isNodeError(cause, "ENOENT")) return null
        throw cause
      })
      if (facts && (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1)) {
        throw new TypeError("The inventory Operation state file is unsafe")
      }
    }
  }
}

function sqliteFamily(filename: string) {
  const base = resolve(filename)
  return [base, `${base}-journal`, `${base}-shm`, `${base}-wal`]
}

/** Creates the complete data-only authority shown before consent. */
export function proposeExtensionInventory(input: ProposeExtensionInventoryInput): ExtensionInventoryProposal {
  requireProposalInput(input)
  const report = input.session.report
  const withoutDigest = {
    schemaVersion: 1,
    operationID: input.operationID,
    policyAskedAt: input.policyAskedAt,
    authorizationExpiresAt: new Date(
      Date.parse(input.policyAskedAt) + authorizationLifetimeMilliseconds,
    ).toISOString(),
    session: { mode: "activate-once", trust: "trusted_once" },
    boundary: "host_no_sandbox",
    boundaryLabel: extensionInventoryBoundaryLabel,
    workspace: {
      canonicalPath: report.root,
      identity: report.identity!,
      securityDigest: requireContentDigest(report.securityDigest!),
      descriptor: {
        childFD: 3,
        flags: ["O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW"],
        validation: "device_and_inode_after_durable_claim",
      },
    },
    helper: input.helper,
    allowlist: extensionInventoryAllowlist,
    resourceClasses: extensionInventoryResourceClasses,
    limits: extensionInventoryLimits,
    guarantees: {
      automaticInitialization: "none",
      parsing: "static_json_jsonc_only",
      substitutions: "forbidden",
      imports: "forbidden",
      activation: "none",
      rawBytes: "private_parent_pipe_only",
      helperExecution: "private_verified_snapshot_after_claim",
      rejection: "no_workspace_open_no_child",
    },
  } as const
  const proposal = Object.freeze({
    ...withoutDigest,
    capabilityDigest: computeExtensionInventoryCapabilityDigest(withoutDigest),
  })
  const parsed = parseExtensionInventoryProposal(proposal)
  if (!parsed.ok) throw new TypeError("The extension inventory proposal is invalid")
  return parsed.value
}

/**
 * Executes one inventory after consent and one durable claim. Exact retries
 * recover state and never open the workspace or start the helper again.
 */
export async function executeExtensionInventory(
  unsafeInput: ExecuteExtensionInventoryInput,
  dependencies: ExtensionInventoryDependencies = {},
): Promise<DurableExtensionInventoryResult> {
  try {
    assertDataOnly(unsafeInput)
    const input = deepFreeze(structuredClone(unsafeInput))
    const facts = makeFacts(input)
    await preparePrivateOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    if (input.consent.decision === "rejected") return recordDenied(input, facts)

    if (await exists(input.ledgerFilename)) {
      const existing = await readDispatch(input, facts)
      if (existing) return recoverExtensionInventory(input, dependencies)
    }

    const now = dependencies.now ?? Date.now
    const claimStartedAt = now()
    const claimed = await runWithCoordinatorLedger(
      input.ledgerFilename,
      (ledger) =>
        Effect.gen(function* () {
          yield* ledger.initialize()
          yield* ledger.appendBatch(facts.commands)
          const existing = yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
          if (existing?.claim) return { kind: "existing_claim" as const }
          return yield* ledger.claimDispatch({
            dispatchRequestID: facts.dispatchRequestID,
            operationID: facts.operationID,
            attemptID: facts.attemptID,
            executor: extensionInventoryExecutor,
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
                subject: extensionInventoryExecutor,
                componentDigest: extensionInventoryAdapterDigest,
              },
              correlationID: facts.correlationID,
              redaction: "sensitive_redacted",
              externalBlobDigest: null,
            },
          })
        }),
      () => new Date(claimStartedAt).toISOString(),
    )
    if (claimed.kind === "existing_claim" || claimed.kind === "replayed") {
      return recoverExtensionInventory(input, dependencies)
    }
    await dependencies.injectFault?.("after_claim_before_effect")
    await prepareOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
    await dependencies.onPostClaimWorkspaceValidation?.()
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
            executor: extensionInventoryExecutor,
            adapterDigest: extensionInventoryAdapterDigest,
            baselineDigest: facts.baselineTrustDigest,
            minimumRemainingLeaseMilliseconds: minimumEffectLeaseMilliseconds,
          })
        }),
      () => new Date(now()).toISOString(),
    )

    const startedAt = new Date(now()).toISOString()
    const observation = authority.allowed
      ? await runBoundedExtensionInventory(facts, dirname(resolve(input.ledgerFilename)), dependencies)
      : notStartedObservation("effect_authority_unavailable")
    const endedAt = new Date(now()).toISOString()
    await dependencies.injectFault?.("after_effect_before_spool")
    if (Date.parse(endedAt) > Date.parse(claimed.claim.claimExpiresAt)) {
      return recordUncertainty(input, facts, claimed.claim.fencingToken, endedAt)
    }

    const receipt = makeReceipt(facts, claimed.claim.fencingToken, startedAt, endedAt, observation)
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
    return durableResult(ingested.operation, receipt, observation.report)
  } catch (cause) {
    if (cause instanceof ExtensionInventoryCoordinationError) throw cause
    throw new ExtensionInventoryCoordinationError(
      cause instanceof TypeError ? "invalid_input" : "state_unavailable",
      "The extension inventory could not complete its durable path",
      cause,
    )
  }
}

/** Recovers durable state without opening the workspace or starting a process. */
export async function recoverExtensionInventory(
  unsafeInput: ExecuteExtensionInventoryInput,
  dependencies: Pick<ExtensionInventoryDependencies, "now"> = {},
): Promise<DurableExtensionInventoryResult> {
  try {
    assertDataOnly(unsafeInput)
    const input = deepFreeze(structuredClone(unsafeInput))
    if (input.consent.decision !== "approved") {
      throw new ExtensionInventoryCoordinationError("recovery_unavailable", "A denied inventory has no claim")
    }
    const facts = makeFacts(input)
    await preparePrivateOperationStateFiles(facts.report.root, input.ledgerFilename, input.spoolFilename)
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
      throw new ExtensionInventoryCoordinationError("recovery_unavailable", "No durable inventory is available")
    }
    requireRecoveryBinding(snapshot.dispatch, facts)
    if (snapshot.dispatch.recoveryStatus === "claimed_no_receipt") {
      const now = dependencies.now?.() ?? Date.now()
      if (now < Date.parse(snapshot.dispatch.claim!.claimExpiresAt)) {
        throw new ExtensionInventoryCoordinationError(
          "operation_in_progress",
          "The one-shot claim is active and will not be retried",
        )
      }
      await cleanupPrivateHelperSnapshot(dirname(resolve(input.ledgerFilename)), facts.operationID)
      return recordUncertainty(input, facts, snapshot.dispatch.claim!.fencingToken, new Date(now).toISOString())
    }
    if (snapshot.dispatch.recoveryStatus === "pending_outbox") {
      throw new ExtensionInventoryCoordinationError(
        "recovery_unavailable",
        "The dispatch is unclaimed and is not retried automatically",
      )
    }
    await cleanupPrivateHelperSnapshot(dirname(resolve(input.ledgerFilename)), facts.operationID)
    return durableResult(snapshot.operation, snapshot.dispatch.receipt, null)
  } catch (cause) {
    if (cause instanceof ExtensionInventoryCoordinationError) throw cause
    throw new ExtensionInventoryCoordinationError(
      "recovery_unavailable",
      "The extension inventory could not be recovered without retrying",
    )
  }
}

/** Parses the private wire and returns only a redacted public report. */
export function parseAndRedactExtensionInventoryWire(input: Uint8Array): ExtensionInventoryReport {
  const records = decodeWire(input)
  const candidates = records
    .flatMap((record) => candidatesFromRecord(record))
    .toSorted((left, right) => {
      const leftKey = `${left.kind}\0${left.sourcePath}\0${left.candidateID}`
      const rightKey = `${right.kind}\0${right.sourcePath}\0${right.candidateID}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  const report = {
    schemaVersion: 1,
    status: "complete",
    candidates,
    sourceFileCount: records.length,
    sourceByteCount: records.reduce((total, record) => total + record.content.byteLength, 0),
    candidateCounts: {
      plugins: candidates.filter((candidate) => candidate.kind === "plugin").length,
      mcp: candidates.filter((candidate) => candidate.kind === "mcp").length,
    },
    state: "inactive",
    verification: "not_verified",
    redaction: "secrets_removed",
  } as const
  const parsed = parseExtensionInventoryReport(report)
  if (!parsed.ok) throw new TypeError("The redacted extension inventory is invalid")
  return parsed.value
}

type WireRecord = Readonly<{
  path: string
  content: Uint8Array
}>

type ExtensionInventoryObservation = Readonly<{
  started: boolean
  termination: Readonly<{ kind: "exited"; exitCode: number }> | Readonly<{ kind: "unconfirmed" }>
  stdoutDigest: ContentDigest
  stdoutBytes: number
  stderrDigest: ContentDigest
  stderrBytes: number
  report: ExtensionInventoryReport | null
  stopReason?:
    | "workspace_identity_changed"
    | "helper_identity_changed"
    | "spawn_failed"
    | "effect_authority_unavailable"
    | "timeout"
    | "output_limit_exceeded"
    | "protocol_rejected"
}>

async function runBoundedExtensionInventory(
  facts: ReturnType<typeof makeFacts>,
  privateStateDirectory: string,
  dependencies: ExtensionInventoryDependencies,
): Promise<ExtensionInventoryObservation> {
  let helperHandle: Awaited<ReturnType<typeof open>> | undefined
  let pinnedHelperHandle: Awaited<ReturnType<typeof open>> | undefined
  let pinnedHelperPath: string | undefined
  let rootDescriptor: number | undefined
  let child: Bun.Subprocess | undefined
  try {
    const trustedHelperHandle = await openTrustedHelper(facts.proposal.helper)
    if (!trustedHelperHandle) return notStartedObservation("helper_identity_changed")
    helperHandle = trustedHelperHandle
    pinnedHelperPath = resolve(privateStateDirectory, `.astra-extension-helper-${facts.operationID}`)
    pinnedHelperHandle = await createPrivateHelperSnapshot(helperHandle, pinnedHelperPath, facts.proposal.helper)
    await helperHandle.close()
    helperHandle = undefined

    rootDescriptor = openSync(
      facts.proposal.workspace.canonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    notify(dependencies.onWorkspaceRootOpened)
    const root = fstatSync(rootDescriptor)
    if (
      !root.isDirectory() ||
      String(root.dev) !== facts.proposal.workspace.identity.device ||
      String(root.ino) !== facts.proposal.workspace.identity.inode
    ) {
      return notStartedObservation("workspace_identity_changed")
    }

    try {
      await dependencies.beforePinnedHelperSpawn?.()
      child = Bun.spawn([pinnedHelperPath], {
        detached: true,
        env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "pipe", rootDescriptor],
      })
      notify(dependencies.onProcessEntered)
    } catch {
      return notStartedObservation("spawn_failed")
    }

    let stopReason: ExtensionInventoryObservation["stopReason"]
    let timer: ReturnType<typeof setTimeout> | undefined
    let escalationTimer: ReturnType<typeof setTimeout> | undefined
    const runningChild = child
    const stop = (reason: NonNullable<ExtensionInventoryObservation["stopReason"]>) => {
      if (stopReason) return
      stopReason = reason
      killProcessGroup(runningChild, "SIGTERM")
      escalationTimer = setTimeout(
        () => killProcessGroup(runningChild, "SIGKILL"),
        processTerminationGraceMilliseconds,
      )
      escalationTimer.unref?.()
    }
    timer = setTimeout(() => stop("timeout"), extensionInventoryLimits.timeoutMilliseconds)
    timer.unref?.()

    const stdoutPromise = readBounded(requireReadableChildStream(runningChild.stdout), extensionInventoryLimits.maxProtocolBytes, () =>
      stop("output_limit_exceeded"),
    )
    const stderrPromise = readBounded(requireReadableChildStream(runningChild.stderr), extensionInventoryLimits.maxStderrBytes, () =>
      stop("output_limit_exceeded"),
    )
    const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, runningChild.exited])
    if (timer) clearTimeout(timer)
    if (escalationTimer) clearTimeout(escalationTimer)

    const termination = Number.isInteger(exitCode)
      ? ({ kind: "exited", exitCode } as const)
      : ({ kind: "unconfirmed" } as const)
    let report: ExtensionInventoryReport | null = null
    if (!stopReason && exitCode === 0) {
      try {
        report = parseAndRedactExtensionInventoryWire(stdout)
      } catch {
        stopReason = "protocol_rejected"
      }
    }
    return Object.freeze({
      started: true,
      termination,
      stdoutDigest: sha256(stdout),
      stdoutBytes: stdout.byteLength,
      stderrDigest: sha256(stderr),
      stderrBytes: stderr.byteLength,
      report,
      ...(stopReason ? { stopReason } : {}),
    })
  } catch {
    if (child) {
      killProcessGroup(child, "SIGKILL")
      await child.exited.catch(() => undefined)
      return startedUnknownObservation("spawn_failed")
    }
    return notStartedObservation("workspace_identity_changed")
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor)
    await pinnedHelperHandle?.close().catch(() => undefined)
    await helperHandle?.close().catch(() => undefined)
    if (pinnedHelperPath) {
      try {
        unlinkSync(pinnedHelperPath)
      } catch {}
    }
  }
}

function decodeWire(input: Uint8Array): ReadonlyArray<WireRecord> {
  if (input.byteLength < 12 || input.byteLength > extensionInventoryLimits.maxProtocolBytes) throw protocolError()
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (!bytes.subarray(0, 8).equals(Buffer.from("ASTRXI01"))) throw protocolError()
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const count = view.getUint32(8)
  if (count > extensionInventoryLimits.maxRecords) throw protocolError()
  const records: Array<WireRecord> = []
  const identities = new Set<string>()
  let totalBytes = 0
  let offset = 12
  let previousPathBytes: Buffer | null = null

  for (let index = 0; index < count; index++) {
    const pathLength = readU16(view, offset, input.byteLength)
    offset += 2
    if (pathLength === 0 || pathLength > 1024 || offset + pathLength > input.byteLength) throw protocolError()
    const pathBytes = bytes.subarray(offset, offset + pathLength)
    offset += pathLength
    if (previousPathBytes && Buffer.compare(previousPathBytes, pathBytes) >= 0) throw protocolError()
    previousPathBytes = Buffer.from(pathBytes)
    const path = decodeUtf8(pathBytes)
    if (!allowedWirePath(path)) throw protocolError()

    const device = readU64(view, offset, input.byteLength)
    offset += 8
    const inode = readU64(view, offset, input.byteLength)
    offset += 8
    const mode = readU64(view, offset, input.byteLength)
    offset += 8
    const linkCount = readU64(view, offset, input.byteLength)
    offset += 8
    const size = readU64(view, offset, input.byteLength)
    offset += 8
    if ((mode & 0o170000n) !== 0o100000n || linkCount !== 1n || size > BigInt(extensionInventoryLimits.maxFileBytes)) {
      throw protocolError()
    }
    const identity = `${device}:${inode}`
    if (identities.has(identity)) throw protocolError()
    identities.add(identity)

    if (offset + 32 > input.byteLength) throw protocolError()
    const expectedDigest = bytes.subarray(offset, offset + 32)
    offset += 32
    const contentLength = readU32(view, offset, input.byteLength)
    offset += 4
    if (
      contentLength > extensionInventoryLimits.maxFileBytes ||
      BigInt(contentLength) !== size ||
      offset + contentLength > input.byteLength
    ) {
      throw protocolError()
    }
    const content = bytes.subarray(offset, offset + contentLength)
    offset += contentLength
    totalBytes += contentLength
    if (totalBytes > extensionInventoryLimits.maxTotalInputBytes) throw protocolError()
    if (!createHash("sha256").update(content).digest().equals(expectedDigest)) throw protocolError()
    records.push(Object.freeze({ path, content: Uint8Array.from(content) }))
  }
  if (offset !== input.byteLength) throw protocolError()
  return Object.freeze(records)
}

function candidatesFromRecord(record: WireRecord): ReadonlyArray<ExtensionInventoryCandidate> {
  if (record.path.startsWith(".opencode/plugin/") || record.path.startsWith(".opencode/plugins/")) {
    return [makeCandidate("plugin", record.path, "workspace_file", "local_path", 0)]
  }
  const parsed = parseStaticConfig(record.content)
  const pluginValue = ownValue(parsed, "plugin")
  const plugins = Array.isArray(pluginValue) ? pluginValue : []
  const pluginCandidates = plugins.map((value, index) =>
    makeCandidate("plugin", record.path, "config", classifyPluginReference(value), index),
  )
  const mcpContainer = mcpEntries(parsed, record.path)
  const mcpCandidates = Object.keys(mcpContainer).map((name, index) =>
    makeCandidate("mcp", record.path, "config", classifyMcpReference(mcpContainer[name]), index),
  )
  return [...pluginCandidates, ...mcpCandidates]
}

function parseStaticConfig(input: Uint8Array): Record<string, unknown> {
  const text = decodeUtf8(input)
  try {
    const parsed: unknown = JSON.parse(normalizeJsonc(text))
    const snapshot = snapshotJsonData(parsed)
    if (!isRecord(snapshot)) throw protocolError()
    return snapshot
  } catch {
    throw protocolError()
  }
}

function mcpEntries(parsed: Record<string, unknown>, path: string): Record<string, unknown> {
  const mcp = ownValue(parsed, "mcp")
  const mcpServers = ownValue(parsed, "mcpServers")
  if (isRecord(mcp)) return mcp
  if (isRecord(mcpServers)) return mcpServers
  if (path === ".mcp.json") return parsed
  return Object.create(null)
}

function makeCandidate(
  kind: "plugin" | "mcp",
  rawPath: string,
  source: "config" | "workspace_file",
  referenceClass: ExtensionInventoryCandidate["referenceClass"],
  ordinal: number,
): ExtensionInventoryCandidate {
  const sourcePath = publicSourcePath(rawPath)
  const referenceDigest = digest(canonicalJson({ kind, sourcePath, ordinal, referenceClass }))
  const candidateID = digest(canonicalJson({ kind, sourcePath, ordinal, referenceDigest }))
  return Object.freeze({
    candidateID,
    kind,
    displayName: `${kind === "plugin" ? "Plugin" : "MCP"} candidate ${candidateID.slice(7, 15)}`,
    source,
    sourcePath,
    referenceClass,
    referenceDigest,
    state: "inactive",
    verification: "not_verified",
  })
}

function classifyPluginReference(input: unknown): ExtensionInventoryCandidate["referenceClass"] {
  if (typeof input !== "string") return "unknown"
  if (/^https?:\/\//i.test(input)) return "remote"
  if (input.startsWith("./") || input.startsWith("../") || input.startsWith("/")) return "local_path"
  if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[~^<>=*0-9a-z._-]+)?$/i.test(input)) return "package"
  return "unknown"
}

function classifyMcpReference(input: unknown): ExtensionInventoryCandidate["referenceClass"] {
  if (!isRecord(input)) return "unknown"
  if (typeof ownValue(input, "url") === "string") return "remote"
  if (typeof ownValue(input, "command") === "string") return "process"
  return "unknown"
}

function publicSourcePath(path: string) {
  const segments = path.split("/")
  if (segments.every((segment) => /^[A-Za-z0-9._-]{1,128}$/.test(segment))) return path
  const parent = segments.slice(0, -1).join("/")
  return `${parent}/[redacted-${createHash("sha256").update("path-class\0" + path).digest("hex").slice(0, 8)}]`
}

function allowedWirePath(path: string) {
  if (["opencode.json", "opencode.jsonc", ".mcp.json", ".opencode/opencode.json", ".opencode/opencode.jsonc"].includes(path)) {
    return true
  }
  const prefixes = [".opencode/plugin/", ".opencode/plugins/"]
  return prefixes.some((prefix) => {
    if (!path.startsWith(prefix)) return false
    const name = path.slice(prefix.length)
    return name.length > 0 && !name.includes("/") && name !== "." && name !== ".." && !hasUnsafeText(name)
  })
}

function makeFacts(input: ExecuteExtensionInventoryInput) {
  requireProposalInput(input)
  const parsedProposal = parseExtensionInventoryProposal(input.proposal)
  if (!parsedProposal.ok) throw new TypeError("The extension inventory proposal is invalid")
  const expected = proposeExtensionInventory({
    operationID: input.operationID,
    policyAskedAt: input.policyAskedAt,
    session: input.session,
    helper: input.helper,
  })
  if (canonicalJson(parsedProposal.value) !== canonicalJson(expected)) {
    throw new TypeError("The inventory authority differs from the displayed proposal")
  }
  requireTimeline(input, expected.authorizationExpiresAt)

  const report = deepFreeze(structuredClone(input.session.report))
  const repositoryBaseline = input.session.repositoryBaseline
    ? deepFreeze(structuredClone(input.session.repositoryBaseline))
    : undefined
  const baselineAuthority = makeControlledWriteBaselineAuthority(report, repositoryBaseline)
  const operationID = requireOperationID(input.operationID)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const dispatchRequestID = requireDispatchRequestID(deterministicUUID(operationID, "dispatch:1"))
  const executorClaimID = requireExecutorClaimID(deterministicUUID(operationID, "claim:1"))
  const receiptID = requireReceiptID(deterministicUUID(operationID, "receipt:1"))
  const correlationID = deterministicUUID(operationID, "correlation")
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const resources = [
    `workspace:extension-allowlist#${digest(canonicalJson({ identity: report.identity, securityDigest: report.securityDigest }))}`,
    `process:extension-helper#${expected.helper.digest}`,
    "ipc:private-parent-pipe",
  ] as const
  const intent = {
    kind: "extension_inventory",
    schemaVersion: 1,
    parameters: {
      capabilityDigest: expected.capabilityDigest,
      allowlistDigest: digest(canonicalJson(expected.allowlist)),
      resourceClassDigest: digest(canonicalJson(expected.resourceClasses)),
      boundary: expected.boundary,
    },
  } as const
  const baseline = {
    kind: "workspace",
    locationID: `local:${report.root}`,
    workspaceIdentity: report.identity!,
    trustDigest: baselineAuthority.baselineDigest,
    repository: baselineAuthority.repository,
    policyDigest: extensionInventoryPolicyDigest,
    adapterDigest: extensionInventoryAdapterDigest,
  } as const
  const completionCriterion = "redacted_inventory_observed"
  const admittedPayload = {
    admissionKey: digest(canonicalJson({ actor, baseline, intent, resources })),
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
        { resource: resources[0], mode: "read_allowlist_only" },
        { resource: resources[1], mode: "execute_once" },
        { resource: resources[2], mode: "private_output_only" },
      ],
      partialEffect: "reconciliation_required",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "medium",
      classification: "host_read_only_extension_inventory_no_sandbox",
      rationaleDigest: digest("native allowlisted read with host process and no sandbox"),
    },
    reversibility: { kind: "irreversible" },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: "redacted-inventory-observer", version: "1", digest: extensionInventoryObserverDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: expected.capabilityDigest }],
    },
  } as const
  const dispatchRequest = requireDispatchRequest({
    dispatchRequestID,
    operationID,
    attemptID,
    capabilityGrantID,
    capabilityDigest: expected.capabilityDigest,
    baselineDigest: baselineAuthority.baselineDigest,
    executor: extensionInventoryExecutor,
    adapterDigest: extensionInventoryAdapterDigest,
    idempotencyKey: digest(canonicalJson({ operationID, attemptID, capabilityDigest: expected.capabilityDigest })),
    requestedAt: input.recordingStartedAt,
    authorizationExpiresAt: expected.authorizationExpiresAt,
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
          ruleID: "extension-inventory-explicit-consent",
          policyDigest: extensionInventoryPolicyDigest,
          previewDigest: digest(canonicalJson(expected)),
          capabilityDigest: expected.capabilityDigest,
          approverClass: "workspace-user",
          expiresAt: expected.authorizationExpiresAt,
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
              capabilityDigest: expected.capabilityDigest,
              attemptID,
              baselineDigest: baselineAuthority.baselineDigest,
              expiresAt: expected.authorizationExpiresAt,
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
    capabilityDigest: expected.capabilityDigest,
    dispatchRequestID,
    executorClaimID,
    receiptID,
    correlationID,
    baselineTrustDigest: requireContentDigest(baselineAuthority.baselineDigest),
    authorizationExpiresAt: expected.authorizationExpiresAt,
    proposal: expected,
    report,
    resources,
    eventIDs,
    commands: input.consent.decision === "approved" ? [...common, decision, dispatch] : [...common, decision],
  }
}

async function recordDenied(
  input: ExecuteExtensionInventoryInput,
  facts: ReturnType<typeof makeFacts>,
): Promise<DurableExtensionInventoryResult> {
  const operation = await runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      const results = yield* ledger.appendBatch(facts.commands)
      return results.at(-1)?.operation ?? null
    }),
  )
  if (!operation || operation.state !== "denied") {
    throw new ExtensionInventoryCoordinationError("state_unavailable", "The durable denial was not recorded")
  }
  return durableResult(operation, null, null)
}

async function readDispatch(input: ExecuteExtensionInventoryInput, facts: ReturnType<typeof makeFacts>) {
  return runWithLedger(input.ledgerFilename, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.initialize()
      return yield* ledger.getDispatchSnapshot(facts.dispatchRequestID)
    }),
  )
}

async function ingestReceipt(
  input: ExecuteExtensionInventoryInput,
  facts: ReturnType<typeof makeFacts>,
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
          redaction: "sensitive_redacted",
          externalBlobDigest: null,
        },
      })
    }),
  )
}

async function ingestPendingReceipt(input: ExecuteExtensionInventoryInput, facts: ReturnType<typeof makeFacts>) {
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
    throw new ExtensionInventoryCoordinationError("recovery_unavailable", "The pending receipt binding is invalid")
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
  input: ExecuteExtensionInventoryInput,
  facts: ReturnType<typeof makeFacts>,
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
      digest: digest("extension-inventory-receipt-missing"),
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
              componentDigest: extensionInventoryAdapterDigest,
            },
            correlationID: facts.correlationID,
            redaction: "sensitive_redacted",
            externalBlobDigest: null,
          },
        })
      }),
    () => observedAt,
  )
  return durableResult(recorded.operation, null, null)
}

function makeReceipt(
  facts: ReturnType<typeof makeFacts>,
  fencingToken: number,
  startedAt: string,
  endedAt: string,
  observation: ExtensionInventoryObservation,
) {
  const reportDigest = observation.report
    ? digest(`astra.redacted-extension-inventory.v1\0${canonicalJson(observation.report)}`)
    : null
  const observationDigest = digest(
    canonicalJson({
      started: observation.started,
      termination: observation.termination,
      reportDigest,
      candidateCount: observation.report?.candidates.length ?? null,
      sourceFileCount: observation.report?.sourceFileCount ?? null,
      sourceByteCount: observation.report?.sourceByteCount ?? null,
      stopReason: observation.stopReason ?? null,
    }),
  )
  const outcome = classifyObservation(observation)
  const receiptObservation: OperationReceipt["observation"] =
    outcome === "completed_observed_not_verified"
      ? { kind: "effect_completed", completionDigest: observationDigest, assurance: "observed_not_verified" }
      : outcome === "failed_without_effect"
        ? { kind: "no_effect_proved", proofDigest: observationDigest }
        : { kind: "effect_unknown", observationDigest }
  return requireReceipt({
    receiptID: facts.receiptID,
    operationID: facts.operationID,
    attemptID: facts.attemptID,
    dispatchRequestID: facts.dispatchRequestID,
    executorClaimID: facts.executorClaimID,
    capabilityGrantID: facts.capabilityGrantID,
    capabilityDigest: facts.capabilityDigest,
    fencingToken,
    adapter: { identity: extensionInventoryExecutor, version: "1", digest: extensionInventoryAdapterDigest },
    effectClass: "host_command",
    resources: facts.resources,
    startedAt,
    endedAt,
    observation: receiptObservation,
    verificationContext:
      outcome === "completed_observed_not_verified"
        ? {
            schemaVersion: 3,
            admittedBaselineDigest: facts.baselineTrustDigest,
            workspaceIdentity: facts.report.identity!,
            executionBoundary: "host_no_sandbox",
            observationDigest,
            limitations: [
              "native helper exit and redacted static parse were observed",
              "extension behavior, provenance, and safety were not verified",
              "extensions remain inactive",
              "host execution was not sandboxed",
            ],
          }
        : {
            admittedBaselineDigest: facts.baselineTrustDigest,
            postEffectWorkspaceDigest: null,
            workspaceIdentity: facts.report.identity!,
            targetIdentity: null,
            preflightLimits: facts.report.limits,
            activationGuard: "allowed",
          },
    output: {
      digest: observationDigest,
      bytes: observation.report ? Buffer.byteLength(canonicalJson(observation.report)) : 0,
      preview:
        outcome === "completed_observed_not_verified"
          ? `INVENTORY OBSERVED — NOT VERIFIED • ${observation.report!.candidates.length} INACTIVE CANDIDATES`
          : outcome === "failed_without_effect"
            ? "NO WORKSPACE READ — INVENTORY PROCESS NOT STARTED"
            : "EFFECT UNKNOWN — INVENTORY OUTPUT WITHHELD",
    },
  })
}

function durableResult(
  operation: OperationRecord,
  receipt: OperationReceipt | null,
  inventory: ExtensionInventoryReport | null,
): DurableExtensionInventoryResult {
  if (
    operation.state !== "denied" &&
    operation.state !== "completed" &&
    operation.state !== "failed" &&
    operation.state !== "reconciliation_required"
  ) {
    throw new ExtensionInventoryCoordinationError(
      "recovery_unavailable",
      `Operation state ${operation.state} is outside the inventory boundary`,
    )
  }
  return Object.freeze({
    operationID: operation.operationID,
    state: operation.state,
    status:
      operation.state === "denied"
        ? "denied_without_effect"
        : operation.state === "completed"
          ? "completed_observed_not_verified"
          : operation.state === "failed"
            ? "failed_without_effect"
            : "effect_unknown",
    sequence: operation.sequence,
    lastCursor: operation.lastCursor,
    receiptID: receipt?.receiptID ?? null,
    boundaryLabel: extensionInventoryBoundaryLabel,
    inventory,
  })
}

function requireRecoveryBinding(dispatch: NonNullable<Awaited<ReturnType<typeof readDispatch>>>, facts: ReturnType<typeof makeFacts>) {
  if (
    dispatch.request.operationID !== facts.operationID ||
    dispatch.request.attemptID !== facts.attemptID ||
    dispatch.request.capabilityDigest !== facts.capabilityDigest ||
    dispatch.request.executor !== extensionInventoryExecutor ||
    dispatch.request.adapterDigest !== extensionInventoryAdapterDigest
  ) {
    throw new ExtensionInventoryCoordinationError("invalid_input", "The durable inventory authority differs")
  }
}

async function openTrustedHelper(expected: ExtensionInventoryHelperIdentity) {
  try {
    const pathFacts = await lstat(expected.canonicalPath)
    const handle = await open(expected.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      requireTrustedHelperFacts(pathFacts, before)
      const helperDigest = await digestFileHandle(handle, helperMaximumBytes)
      const after = await handle.stat()
      if (!sameFileIdentity(before, after)) throw new TypeError("The extension inventory helper changed")
      const current = {
        canonicalPath: await realpath(expected.canonicalPath),
        device: String(after.dev),
        inode: String(after.ino),
        size: after.size,
        digest: helperDigest,
      }
      if (canonicalJson(current) !== canonicalJson(expected)) throw new TypeError("The extension inventory helper changed")
      return handle
    } catch (cause) {
      await handle.close()
      throw cause
    }
  } catch {
    return null
  }
}

async function createPrivateHelperSnapshot(
  source: Awaited<ReturnType<typeof open>>,
  destinationPath: string,
  expected: ExtensionInventoryHelperIdentity,
) {
  let destination: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await source.stat()
    if (
      String(before.dev) !== expected.device ||
      String(before.ino) !== expected.inode ||
      before.size !== expected.size
    ) {
      throw new TypeError("The extension inventory helper changed")
    }
    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o700,
    )
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      const read = await source.read(buffer, 0, buffer.byteLength, position)
      if (read.bytesRead === 0) break
      position += read.bytesRead
      if (position > helperMaximumBytes) throw new TypeError("The extension inventory helper is too large")
      hash.update(buffer.subarray(0, read.bytesRead))
      let written = 0
      while (written < read.bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          read.bytesRead - written,
          position - read.bytesRead + written,
        )
        if (result.bytesWritten <= 0) throw new TypeError("The private helper snapshot could not be written")
        written += result.bytesWritten
      }
    }
    const after = await source.stat()
    const copiedDigest = requireContentDigest(`sha256:${hash.digest("hex")}`)
    if (!sameFileIdentity(before, after) || position !== expected.size || copiedDigest !== expected.digest) {
      throw new TypeError("The extension inventory helper changed during snapshot")
    }
    await destination.sync()
    await destination.chmod(0o500)
    await destination.close()
    destination = undefined

    const snapshotFacts = await lstat(destinationPath)
    const snapshot = await open(destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const openedFacts = await snapshot.stat()
      requireTrustedHelperFacts(snapshotFacts, openedFacts)
      if ((await digestFileHandle(snapshot, helperMaximumBytes)) !== expected.digest) {
        throw new TypeError("The private helper snapshot digest differs")
      }
      return snapshot
    } catch (cause) {
      await snapshot.close()
      throw cause
    }
  } catch (cause) {
    await destination?.close().catch(() => undefined)
    try {
      unlinkSync(destinationPath)
    } catch {}
    throw cause
  }
}

async function cleanupPrivateHelperSnapshot(privateStateDirectory: string, operationID: OperationID) {
  const snapshotPath = resolve(privateStateDirectory, `.astra-extension-helper-${operationID}`)
  const facts = await lstat(snapshotPath).catch((cause: unknown) => {
    if (isNodeError(cause, "ENOENT")) return null
    throw cause
  })
  if (!facts) return
  const uid = process.getuid?.()
  if (
    !facts.isFile() ||
    facts.isSymbolicLink() ||
    facts.nlink !== 1 ||
    (uid !== undefined && facts.uid !== uid)
  ) {
    return
  }
  unlinkSync(snapshotPath)
}

function requireTrustedHelperFacts(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>) {
  const currentUID = process.getuid?.()
  if (
    !left.isFile() ||
    left.isSymbolicLink() ||
    !right.isFile() ||
    left.nlink !== 1 ||
    right.nlink !== 1 ||
    (Number(right.mode) & 0o111) === 0 ||
    (Number(right.mode) & 0o022) !== 0 ||
    Number(right.size) <= 0 ||
    Number(right.size) > helperMaximumBytes ||
    (currentUID !== undefined && Number(right.uid) !== 0 && Number(right.uid) !== currentUID) ||
    !sameFileIdentity(left, right)
  ) {
    throw new TypeError("The extension inventory helper identity is not trusted")
  }
}

async function digestFileHandle(handle: Awaited<ReturnType<typeof open>>, maximum: number) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (true) {
    const read = await handle.read(buffer, 0, buffer.byteLength, position)
    if (read.bytesRead === 0) break
    position += read.bytesRead
    if (position > maximum) throw new TypeError("The extension inventory helper is too large")
    hash.update(buffer.subarray(0, read.bytesRead))
  }
  return requireContentDigest(`sha256:${hash.digest("hex")}`)
}

function sameFileIdentity(
  left: {
    dev: number | bigint
    ino: number | bigint
    mode: number | bigint
    size: number | bigint
    mtimeMs: number | bigint
    ctimeMs: number | bigint
    nlink: number | bigint
  },
  right: typeof left,
) {
  return (
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    String(left.mode) === String(right.mode) &&
    String(left.size) === String(right.size) &&
    String(left.mtimeMs) === String(right.mtimeMs) &&
    String(left.ctimeMs) === String(right.ctimeMs) &&
    String(left.nlink) === String(right.nlink)
  )
}

function classifyObservation(observation: ExtensionInventoryObservation): DurableExtensionInventoryResult["status"] {
  if (!observation.started) return "failed_without_effect"
  if (
    !observation.stopReason &&
    observation.termination.kind === "exited" &&
    observation.termination.exitCode === 0 &&
    observation.report
  ) {
    return "completed_observed_not_verified"
  }
  return "effect_unknown"
}

function notStartedObservation(reason: NonNullable<ExtensionInventoryObservation["stopReason"]>): ExtensionInventoryObservation {
  return Object.freeze({
    started: false,
    termination: { kind: "exited", exitCode: 125 } as const,
    stdoutDigest: sha256(new Uint8Array()),
    stdoutBytes: 0,
    stderrDigest: sha256(new Uint8Array()),
    stderrBytes: 0,
    report: null,
    stopReason: reason,
  })
}

function startedUnknownObservation(
  reason: NonNullable<ExtensionInventoryObservation["stopReason"]>,
): ExtensionInventoryObservation {
  return Object.freeze({
    started: true,
    termination: { kind: "unconfirmed" } as const,
    stdoutDigest: sha256(new Uint8Array()),
    stdoutBytes: 0,
    stderrDigest: sha256(new Uint8Array()),
    stderrBytes: 0,
    report: null,
    stopReason: reason,
  })
}

function requireReadableChildStream(input: unknown): ReadableStream<Uint8Array> {
  if (!(input instanceof ReadableStream)) throw new TypeError("The private helper stream is unavailable")
  return input
}

function notify(callback: (() => void) | undefined) {
  try {
    callback?.()
  } catch {}
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

function killProcessGroup(child: Bun.Subprocess, signal: NodeJS.Signals) {
  try {
    if (child.pid > 0) process.kill(-child.pid, signal)
    return
  } catch {}
  try {
    child.kill(signal)
  } catch {}
}

function readU16(view: DataView, offset: number, length: number) {
  if (offset + 2 > length) throw protocolError()
  return view.getUint16(offset)
}

function readU32(view: DataView, offset: number, length: number) {
  if (offset + 4 > length) throw protocolError()
  return view.getUint32(offset)
}

function readU64(view: DataView, offset: number, length: number) {
  if (offset + 8 > length) throw protocolError()
  return view.getBigUint64(offset)
}

function decodeUtf8(input: Uint8Array) {
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(input)
    if (output.includes("\0")) throw protocolError()
    return output
  } catch {
    throw protocolError()
  }
}

function protocolError() {
  return new TypeError("The private extension inventory protocol was rejected")
}

function normalizeJsonc(input: string) {
  let output = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const current = input[index]!
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === "\\") escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
      continue
    }
    if (current === "/" && input[index + 1] === "/") {
      output += "  "
      index += 2
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") {
        output += " "
        index++
      }
      if (index < input.length) output += input[index]
      continue
    }
    if (current === "/" && input[index + 1] === "*") {
      output += "  "
      index += 2
      let closed = false
      while (index < input.length) {
        if (input[index] === "*" && input[index + 1] === "/") {
          output += "  "
          index++
          closed = true
          break
        }
        output += input[index] === "\n" || input[index] === "\r" ? input[index]! : " "
        index++
      }
      if (!closed) throw protocolError()
      continue
    }
    output += current
  }
  if (inString) throw protocolError()

  let normalized = ""
  inString = false
  escaped = false
  for (let index = 0; index < output.length; index++) {
    const current = output[index]!
    if (inString) {
      normalized += current
      if (escaped) escaped = false
      else if (current === "\\") escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      normalized += current
      continue
    }
    if (current === ",") {
      let next = index + 1
      while (/\s/.test(output[next] ?? "")) next++
      if (output[next] === "}" || output[next] === "]") continue
    }
    normalized += current
  }
  return normalized
}

function snapshotJsonData(input: unknown, depth = 0, budget = { fields: 0 }): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw protocolError()
    return input
  }
  if (typeof input !== "object" || depth > 16) throw protocolError()
  const prototype = Object.getPrototypeOf(input)
  if (Array.isArray(input)) {
    if (prototype !== Array.prototype || input.length > 1024) throw protocolError()
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
      throw protocolError()
    }
    return input.map((value) => {
      if (++budget.fields > 4096) throw protocolError()
      return snapshotJsonData(value, depth + 1, budget)
    })
  }
  if (prototype !== Object.prototype && prototype !== null) throw protocolError()
  const keys = Reflect.ownKeys(input)
  if (keys.length > 1024) throw protocolError()
  const output: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw protocolError()
    }
    if (++budget.fields > 4096) throw protocolError()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) throw protocolError()
    Object.defineProperty(output, key, {
      value: snapshotJsonData(descriptor.value, depth + 1, budget),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return output
}

function ownValue(input: Record<string, unknown>, key: string) {
  return Object.hasOwn(input, key) ? input[key] : undefined
}

function hasUnsafeText(input: string) {
  return /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(input)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function requireProposalInput(input: ProposeExtensionInventoryInput) {
  if (process.platform !== "darwin") throw new TypeError("Extension inventory is currently available on macOS")
  if (input.session.mode !== "activate-once") throw new TypeError("Activate once is required")
  const report = input.session.report
  if (report.completeness !== "complete" || !report.identity || !report.securityDigest) {
    throw new TypeError("A complete trusted workspace report is required")
  }
  if (resolve(report.root) !== report.root) throw new TypeError("The workspace root must be canonical")
  if (inside(report.root, input.helper.canonicalPath)) {
    throw new TypeError("The trusted inventory helper must remain outside the workspace")
  }
  if (input.session.repositoryBaseline && input.session.repositoryBaseline.root.canonicalPath !== report.root) {
    throw new TypeError("The Git baseline does not belong to the workspace")
  }
  requireOperationID(input.operationID)
  requireCanonicalTimestamp(input.policyAskedAt)
  if (!parseContentDigest(input.helper.digest).ok) throw new TypeError("The helper digest is invalid")
}

function inside(root: string, candidatePath: string) {
  return canonicalAliases(root).some((candidateRoot) => {
    const candidate = relative(candidateRoot, resolve(candidatePath))
    return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
  })
}

function canonicalAliases(input: string) {
  const path = resolve(input)
  if (process.platform !== "darwin") return [path]
  if (path === "/private") return [path]
  if (path.startsWith("/private/")) return [path, path.slice("/private".length)]
  if (path === "/tmp" || path.startsWith("/tmp/") || path === "/var" || path.startsWith("/var/")) {
    return [path, `/private${path}`]
  }
  return [path]
}

function requireTimeline(input: ExecuteExtensionInventoryInput, expiresAt: string) {
  const times = [input.policyAskedAt, input.consent.decidedAt, input.recordingStartedAt].map((value) =>
    Date.parse(requireCanonicalTimestamp(value)),
  )
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) {
    throw new TypeError("Extension inventory observations must be monotonic")
  }
  if (times[2]! >= Date.parse(expiresAt)) throw new TypeError("Extension inventory consent expired")
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
  return { ...input, schemaVersion: 1, redaction: "sensitive_redacted", externalBlobDigest: null }
}

function requireCanonicalTimestamp(input: string) {
  const milliseconds = Date.parse(input)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw new TypeError("Extension inventory times must be canonical UTC timestamps")
  }
  return input
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The extension inventory Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string) {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The extension inventory attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string) {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The extension inventory capability ID is invalid")
  return parsed.value
}

function requireDispatchRequestID(input: string) {
  const parsed = parseDispatchRequestID(input)
  if (!parsed.ok) throw new TypeError("The extension inventory dispatch ID is invalid")
  return parsed.value
}

function requireExecutorClaimID(input: string) {
  const parsed = parseExecutorClaimID(input)
  if (!parsed.ok) throw new TypeError("The extension inventory claim ID is invalid")
  return parsed.value
}

function requireReceiptID(input: string) {
  const parsed = parseReceiptID(input)
  if (!parsed.ok) throw new TypeError("The extension inventory receipt ID is invalid")
  return parsed.value
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The extension inventory digest is invalid")
  return parsed.value
}

function requireDispatchRequest(input: unknown) {
  const parsed = parseDispatchRequest(input)
  if (!parsed.ok) throw new TypeError("The extension inventory dispatch request is invalid")
  return parsed.value
}

function requireReceipt(input: unknown) {
  const parsed = parseOperationReceipt(input)
  if (!parsed.ok) throw new TypeError("The redacted extension inventory receipt is invalid")
  return parsed.value
}

function requireUncertainty(input: unknown): OperationEffectUncertainty {
  const parsed = parseOperationEffectUncertainty(input)
  if (!parsed.ok) throw new TypeError("The extension inventory uncertainty is invalid")
  return parsed.value
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
  if (typeof input !== "object" || depth > 18) throw new TypeError("Inventory input must be plain data")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new TypeError("Inventory input must be plain data")
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw new TypeError("Inventory input symbols are forbidden")
    if (Array.isArray(input) && key === "length") continue
    if (++budget.fields > 4096) throw new TypeError("Inventory input is too large")
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) throw new TypeError("Inventory input accessors are forbidden")
    assertDataOnly(descriptor.value, depth + 1, budget)
  }
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  for (const value of Object.values(input)) deepFreeze(value)
  return Object.freeze(input)
}

function sha256(input: Uint8Array) {
  return requireContentDigest(`sha256:${createHash("sha256").update(input).digest("hex")}`)
}

async function exists(path: string) {
  return (await lstat(path).catch(() => null)) !== null
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}
