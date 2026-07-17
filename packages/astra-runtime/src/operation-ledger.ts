import { createHash } from "node:crypto"
import { access, lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import {
  parseGitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import { parseOperationID, type ActorRef, type OperationID } from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import {
  makeOperationLedger,
  type OperationEventDraft,
  type OperationLedger,
  type OperationRecord,
} from "@astra/ledger"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import type { ControlledWritePlan } from "./controlled-write-plan"
import {
  validateControlledWriteCapabilityProposal,
  type ControlledWriteCapabilityProposal,
} from "./controlled-write-capability"

const policyDigest = digest("astra-policy:controlled-write-explicit-consent:v1")
const adapterDigest = digest("astra-runtime:controlled-write:bounded-host-process:v1")
const verifierDigest = digest("astra-verify:exact-file-readback:v1")

export type RecordDeniedControlledWriteInput = Readonly<{
  filename: string
  plan: ControlledWritePlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  capabilityProposal: ControlledWriteCapabilityProposal
  policyAskedAt: string
  approvalRejectedAt: string
  recordingStartedAt: string
}>

export class DeniedOperationRecordingError extends Error {
  readonly _tag = "DeniedOperationRecordingError"

  constructor(
    readonly code:
      | "incomplete_preflight"
      | "workspace_mismatch"
      | "git_baseline_unavailable"
      | "ledger_inside_workspace"
      | "unsafe_ledger_path"
      | "invalid_observation_time"
      | "invalid_operation_id"
      | "ledger_unavailable",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

/**
 * Persists the exact no-effect denial lifecycle for one controlled write.
 * It never dispatches the planned effect and refuses to invent repository authority.
 */
export async function recordDeniedControlledWrite(input: RecordDeniedControlledWriteInput): Promise<OperationRecord> {
  try {
    const facts = denialFacts(input)
    await assertSafeLedgerLocation(input.report.root, input.filename)
    await mkdir(dirname(resolve(input.filename)), { recursive: true })
    await assertSafeLedgerLocation(input.report.root, input.filename)
    return await runWithLedger(input.filename, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.initialize()
        const results = yield* ledger.appendBatch(facts.commands)
        const operation = results.at(-1)?.operation ?? null
        if (!operation || operation.state !== "denied") {
          return yield* Effect.die("Durable denial did not reach the denied state")
        }
        return operation
      }),
    )
  } catch (cause) {
    if (cause instanceof DeniedOperationRecordingError) throw cause
    throw new DeniedOperationRecordingError(
      "ledger_unavailable",
      "The denied Operation could not be recorded durably",
      cause,
    )
  }
}

/** Reads one Operation from a previously created ledger without creating a new database. */
export async function readDurableOperation(filename: string, operationID: string): Promise<OperationRecord | null> {
  await access(filename).catch((cause) => {
    throw new DeniedOperationRecordingError("ledger_unavailable", "The Operation ledger does not exist", cause)
  })
  const parsedID = parseOperationID(operationID)
  if (!parsedID.ok) {
    throw new DeniedOperationRecordingError("invalid_operation_id", "The Operation ID is not canonical")
  }
  return runWithLedger(filename, (ledger) => ledger.getOperation(parsedID.value), "read-only").catch((cause) => {
    if (cause instanceof DeniedOperationRecordingError) throw cause
    throw new DeniedOperationRecordingError("ledger_unavailable", "The Operation ledger could not be read", cause)
  })
}

function denialFacts(input: RecordDeniedControlledWriteInput) {
  const { plan, report } = input
  if (report.completeness !== "complete" || !report.identity || !report.securityDigest) {
    throw new DeniedOperationRecordingError("incomplete_preflight", "A complete preflight is required")
  }
  if (resolve(plan.workspaceRoot) !== resolve(report.root)) {
    throw new DeniedOperationRecordingError(
      "workspace_mismatch",
      "The plan and preflight refer to different workspaces",
    )
  }
  if (isInsideWorkspace(report.root, input.filename)) {
    throw new DeniedOperationRecordingError(
      "ledger_inside_workspace",
      "The Operation ledger must remain outside the workspace",
    )
  }
  const operationID = requireOperationID(plan.operationId)
  const repository = operationRepositoryBaseline(input)
  const capability = validateControlledWriteCapabilityProposal(input, input.capabilityProposal)
  const actor = { kind: "user", subject: "user:local-owner" } as const satisfies ActorRef
  const decisionID = deterministicUUID(operationID, "policy-decision")
  const verificationPlanID = deterministicUUID(operationID, "verification-plan")
  const correlationID = deterministicUUID(operationID, "correlation")
  const intent = {
    kind: "controlled_write",
    schemaVersion: 1,
    parameters: {
      expected: { bytes: Buffer.byteLength(plan.content), contentDigest: plan.contentDigest },
      target: plan.relativePath,
    },
  } as const
  const baseline = {
    kind: "workspace",
    locationID: `local:${report.root}`,
    workspaceIdentity: report.identity,
    trustDigest: report.securityDigest,
    repository,
    policyDigest,
    adapterDigest,
  } as const
  const resources = [`workspace:${plan.relativePath}`] as const
  const admissionKey = digest(canonicalJson({ actor, baseline, intent, resources }))
  const completionCriterion = "marker_exact_bytes"
  const admittedPayload = {
    admissionKey,
    intent,
    baseline,
    retryBudget: {
      maxAttempts: 1,
      eligibleFailureClasses: [],
      retrySafety: { kind: "proof_of_no_effect_required" },
      prohibitedWhen: ["effect_unknown", "baseline_changed"],
    },
    effectSpecification: {
      effectClass: "workspace_write",
      targetDescriptors: [{ resource: resources[0], mode: "create_only" }],
      partialEffect: "forbidden",
      completionCriteria: [completionCriterion],
    },
    resources,
    risk: {
      level: "low",
      classification: "bounded_create_only",
      rationaleDigest: digest("bounded create-only write; existing targets are never overwritten"),
    },
    reversibility: {
      kind: "reversible",
      strategy: "delete_created_file_only_if_exact_digest_matches",
    },
    verificationPlan: {
      verificationPlanID,
      verifier: { identity: "exact-file-readback", version: "1", digest: verifierDigest },
      criteria: [{ criterionID: completionCriterion, expectedObservationDigest: plan.contentDigest }],
    },
  } as const
  const previewDigest = digest(
    canonicalJson({ bytes: Buffer.byteLength(plan.content), digest: plan.contentDigest, target: plan.relativePath }),
  )
  const admittedAt = requireObservedTimeline(input)
  const expiresAt = new Date(Date.parse(input.policyAskedAt) + 300_000).toISOString()

  return {
    commands: [
      {
        expectedState: null,
        expectedSequence: 0,
        event: eventDraft(
          operationID,
          "operation.admitted",
          admittedPayload,
          input.recordingStartedAt,
          admittedAt,
          actor,
          correlationID,
        ),
      },
      {
        expectedState: "proposed",
        expectedSequence: 1,
        event: eventDraft(
          operationID,
          "policy.ask",
          {
            decisionID,
            ruleID: "controlled-write-explicit-consent",
            policyDigest,
            previewDigest,
            capabilityDigest: capability.capabilityDigest,
            approverClass: "workspace-user",
            expiresAt,
          },
          input.recordingStartedAt,
          input.policyAskedAt,
          actor,
          correlationID,
        ),
      },
      {
        expectedState: "awaiting_approval",
        expectedSequence: 2,
        event: eventDraft(
          operationID,
          "approval.rejected",
          { decisionID, reasonCode: "user_rejected" },
          input.recordingStartedAt,
          input.approvalRejectedAt,
          actor,
          correlationID,
        ),
      },
    ] as const,
  }
}

function operationRepositoryBaseline(input: RecordDeniedControlledWriteInput) {
  const gitWorkspace = input.report.surfaces.some((surface) => surface.kind === "git_metadata")
  if (!gitWorkspace) {
    if (input.repositoryBaseline) {
      throw new DeniedOperationRecordingError(
        "git_baseline_unavailable",
        "A Git repository baseline cannot authorize a non-Git workspace",
      )
    }
    return { kind: "non_git", markerDigest: input.report.securityDigest } as const
  }

  const parsed = parseGitRepositoryBaselineSnapshot(input.repositoryBaseline)
  if (!parsed.ok) {
    throw new DeniedOperationRecordingError(
      "git_baseline_unavailable",
      "A complete, valid Git repository baseline is required",
    )
  }
  if (
    parsed.value.root.canonicalPath !== input.report.root ||
    parsed.value.root.device !== input.report.identity?.device ||
    parsed.value.root.inode !== input.report.identity.inode
  ) {
    throw new DeniedOperationRecordingError(
      "workspace_mismatch",
      "The Git repository baseline and preflight refer to different workspace identities",
    )
  }
  return {
    kind: "git",
    schemaVersion: 1,
    snapshotDigest: parsed.value.snapshotDigest,
    observationDigest: parsed.value.observer.observationDigest,
    root: parsed.value.root,
    head: parsed.value.head,
    verification: parsed.value.verification,
  } as const
}

function eventDraft(
  operationID: OperationID,
  name: OperationEventDraft["name"],
  payload: Readonly<Record<string, unknown>>,
  recordedAt: string,
  observedAt: string,
  actor: ActorRef,
  correlationID: string,
): OperationEventDraft {
  return {
    eventID: deterministicUUID(operationID, name),
    operationID,
    name,
    schemaVersion: 1,
    recordedAt,
    observedAt,
    actor,
    causationID: null,
    correlationID,
    attemptID: null,
    payload,
    redaction: "internal",
    externalBlobDigest: null,
  }
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (parsed.ok) return parsed.value
  throw new DeniedOperationRecordingError("invalid_operation_id", "The controlled write has an invalid Operation ID")
}

function deterministicUUID(operationID: string, label: string): string {
  const bytes = createHash("sha256").update(operationID).update("\0").update(label).digest().subarray(0, 16)
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x80
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function requireObservedTimeline(input: RecordDeniedControlledWriteInput) {
  const timestamps = {
    created: { value: input.plan.createdAt, milliseconds: Date.parse(input.plan.createdAt) },
    asked: { value: input.policyAskedAt, milliseconds: Date.parse(input.policyAskedAt) },
    rejected: { value: input.approvalRejectedAt, milliseconds: Date.parse(input.approvalRejectedAt) },
    recording: { value: input.recordingStartedAt, milliseconds: Date.parse(input.recordingStartedAt) },
  }
  if (
    Object.values(timestamps).some(
      ({ value, milliseconds }) => !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value,
    ) ||
    timestamps.asked.milliseconds < timestamps.created.milliseconds ||
    timestamps.rejected.milliseconds < timestamps.asked.milliseconds ||
    timestamps.recording.milliseconds < timestamps.rejected.milliseconds
  ) {
    throw new DeniedOperationRecordingError(
      "invalid_observation_time",
      "Operation observations must be canonical, monotonic UTC timestamps",
    )
  }
  return input.plan.createdAt
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Admission facts must be canonical JSON")
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function isInsideWorkspace(workspace: string, filename: string) {
  const candidate = relative(resolve(workspace), resolve(filename))
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
}

async function assertSafeLedgerLocation(workspace: string, filename: string) {
  const workspacePath = await realpath(workspace).catch((cause) => {
    throw new DeniedOperationRecordingError("unsafe_ledger_path", "The workspace path cannot be canonicalized", cause)
  })
  const parentPath = await resolveUncreatedPath(dirname(resolve(filename)))
  if (isInsideWorkspace(workspacePath, parentPath)) {
    throw new DeniedOperationRecordingError(
      "ledger_inside_workspace",
      "The Operation ledger resolves inside the workspace",
    )
  }

  for (const candidate of [filename, `${filename}-journal`, `${filename}-shm`, `${filename}-wal`]) {
    const facts = await optionalLstat(candidate)
    if (!facts) continue
    if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1) {
      throw new DeniedOperationRecordingError(
        "unsafe_ledger_path",
        "The Operation ledger or a SQLite sidecar has an unsafe filesystem identity",
      )
    }
    const candidatePath = await realpath(candidate)
    if (isInsideWorkspace(workspacePath, candidatePath)) {
      throw new DeniedOperationRecordingError(
        "ledger_inside_workspace",
        "The Operation ledger resolves inside the workspace",
      )
    }
  }
}

async function resolveUncreatedPath(input: string) {
  let current = resolve(input)
  const missing: Array<string> = []
  while (true) {
    try {
      return resolve(await realpath(current), ...missing)
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT")) {
        throw new DeniedOperationRecordingError(
          "unsafe_ledger_path",
          "The Operation ledger parent cannot be canonicalized",
          cause,
        )
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new DeniedOperationRecordingError("unsafe_ledger_path", "No canonical ledger parent is available")
      }
      missing.unshift(basename(current))
      current = parent
    }
  }
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return null
    throw new DeniedOperationRecordingError("unsafe_ledger_path", "The Operation ledger path is unreadable", cause)
  }
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}

function runWithLedger<A, E>(
  filename: string,
  use: (ledger: OperationLedger) => Effect.Effect<A, E>,
  mode: "read-write" | "read-only" = "read-write",
) {
  const layer =
    mode === "read-only"
      ? SqliteClient.layer({ filename, readonly: true, readwrite: false, create: false, disableWAL: true })
      : SqliteClient.layer({ filename })
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* makeOperationLedger()
      return yield* use(ledger)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}
