import { afterAll, describe, expect, test } from "bun:test"
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  computeGitRepositoryBaselineSnapshotDigest,
  type GitRepositoryBaselineSnapshot,
  type GitRepositoryBaselineSnapshotAuthority,
} from "@astra/domain/git-repository-baseline"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import { createControlledWritePlan, demoMarkerName } from "../src/controlled-write-plan"
import { proposeControlledWriteCapability } from "../src/controlled-write-capability"
import {
  DeniedOperationRecordingError,
  readDurableOperation,
  recordDeniedControlledWrite,
} from "../src/operation-ledger"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []
const operationID = "0196e4cb-5d80-7b1d-8fb2-263b81670431"
const recordingStartedMilliseconds = Date.now() - 1_000
const createdAt = new Date(recordingStartedMilliseconds - 181_000).toISOString()
const observation = {
  policyAskedAt: new Date(recordingStartedMilliseconds - 121_000).toISOString(),
  approvalRejectedAt: new Date(recordingStartedMilliseconds - 1_000).toISOString(),
  recordingStartedAt: new Date(recordingStartedMilliseconds).toISOString(),
} as const

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable denied controlled write", () => {
  test("persists, reopens, and idempotently replays a denial without touching the workspace", async () => {
    const root = await workspace()
    const filename = join(await temporaryDirectory("astra-runtime-state-"), "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)
    const capabilityProposal = await proposedCapability(plan, report)

    const first = await recordDeniedControlledWrite({ filename, plan, report, capabilityProposal, ...observation })
    expect(first).toMatchObject({ operationID, state: "denied", sequence: 3, lastCursor: 3 })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()

    const database = new Database(filename, { readonly: true })
    const timestamps = database.query("select recorded_at, observed_at from operation_event order by sequence").all()
    database.close()
    expect(timestamps).toEqual([
      { recorded_at: observation.recordingStartedAt, observed_at: createdAt },
      { recorded_at: observation.recordingStartedAt, observed_at: observation.policyAskedAt },
      { recorded_at: observation.recordingStartedAt, observed_at: observation.approvalRejectedAt },
    ])

    const filesBeforeRead = await readdir(join(filename, ".."))
    expect(await readDurableOperation(filename, operationID)).toEqual(first)
    expect(await readdir(join(filename, ".."))).toEqual(filesBeforeRead)
    expect(await recordDeniedControlledWrite({ filename, plan, report, capabilityProposal, ...observation })).toEqual(
      first,
    )
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("fails closed instead of inventing a non-Git baseline", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const filename = join(await temporaryDirectory("astra-runtime-state-"), "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)

    const rejection = proposedCapability(plan, report).catch((error) => error)
    expect(await rejection).toBeInstanceOf(TypeError)
    expect(await exists(filename)).toBeFalse()
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("persists an exact not-verified Git snapshot authority for a denied operation", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const filename = join(await temporaryDirectory("astra-runtime-state-"), "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)
    const repositoryBaseline = await gitRepositoryBaseline(report)
    const capabilityProposal = await proposedCapability(plan, report, repositoryBaseline)

    const operation = await recordDeniedControlledWrite({
      filename,
      plan,
      report,
      repositoryBaseline,
      capabilityProposal,
      ...observation,
    })

    expect(operation).toMatchObject({ operationID, state: "denied" })
    const database = new Database(filename, { readonly: true })
    const row = database
      .query<
        { repository_json: string },
        [string]
      >("select json_extract(payload_json, '$.baseline.repository') as repository_json from operation_event where operation_id = ? and sequence = 1")
      .get(operationID)
    database.close()
    if (!row || typeof row.repository_json !== "string") throw new Error("The admission repository baseline is missing")
    const persistedRepository: unknown = JSON.parse(row.repository_json)
    expect(persistedRepository).toEqual({
      kind: "git",
      schemaVersion: 1,
      snapshotDigest: repositoryBaseline.snapshotDigest,
      observationDigest: repositoryBaseline.observer.observationDigest,
      root: repositoryBaseline.root,
      head: repositoryBaseline.head,
      verification: "not_verified",
    })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("rejects a valid Git snapshot for a different workspace identity", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const filename = join(await temporaryDirectory("astra-runtime-state-"), "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)
    const repositoryBaseline = await gitRepositoryBaseline(report)
    const capabilityProposal = await proposedCapability(plan, report, repositoryBaseline)
    const { snapshotDigest: _snapshotDigest, ...currentAuthority } = repositoryBaseline
    const authority = {
      ...currentAuthority,
      root: { ...repositoryBaseline.root, inode: `${repositoryBaseline.root.inode}0` },
    } as const satisfies GitRepositoryBaselineSnapshotAuthority
    const mismatched = {
      ...authority,
      snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(authority),
    } as const satisfies GitRepositoryBaselineSnapshot

    const rejection = recordDeniedControlledWrite({
      filename,
      plan,
      report,
      repositoryBaseline: mismatched,
      capabilityProposal,
      ...observation,
    }).catch((error) => error)

    expect(await rejection).toMatchObject({ _tag: "DeniedOperationRecordingError", code: "workspace_mismatch" })
    expect(await exists(filename)).toBeFalse()
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("rejects a ledger parent symlink that resolves inside the workspace", async () => {
    const root = await workspace()
    const state = await temporaryDirectory("astra-runtime-state-")
    const linkedParent = join(state, "linked-state")
    await symlink(root, linkedParent)
    const filename = join(linkedParent, "operations.sqlite")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, operationID, createdAt)
    const capabilityProposal = await proposedCapability(plan, report)

    const rejection = recordDeniedControlledWrite({ filename, plan, report, capabilityProposal, ...observation }).catch(
      (error) => error,
    )
    expect(await rejection).toMatchObject({ code: "ledger_inside_workspace" })
    expect(await exists(join(root, "operations.sqlite"))).toBeFalse()
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("does not initialize or add sidecars while reading a truncated ledger", async () => {
    const state = await temporaryDirectory("astra-runtime-state-")
    const filename = join(state, "operations.sqlite")
    await writeFile(filename, "")

    const rejection = readDurableOperation(filename, operationID).catch((error) => error)
    expect(await rejection).toBeInstanceOf(DeniedOperationRecordingError)
    expect(await readFile(filename)).toEqual(Buffer.alloc(0))
    expect(await readdir(state)).toEqual(["operations.sqlite"])
  })
})

async function workspace() {
  const root = await temporaryDirectory("astra-runtime-ledger-")
  await writeFile(join(root, "package.json"), "{}\n")
  return root
}

async function proposedCapability(
  plan: ReturnType<typeof createControlledWritePlan>,
  report: WorkspaceTrustReport,
  repositoryBaseline?: GitRepositoryBaselineSnapshot,
) {
  return proposeControlledWriteCapability({
    plan,
    report,
    ...(repositoryBaseline ? { repositoryBaseline } : {}),
    policyAskedAt: observation.policyAskedAt,
  })
}

async function gitRepositoryBaseline(report: WorkspaceTrustReport): Promise<GitRepositoryBaselineSnapshot> {
  if (!report.identity) throw new Error("The fixture preflight must have a workspace identity")
  const gitFacts = await lstat(join(report.root, ".git"))
  const gitIdentity = {
    canonicalPath: join(report.root, ".git"),
    device: String(gitFacts.dev),
    inode: String(gitFacts.ino),
  }
  const authority = {
    schemaVersion: 1,
    mode: "bounded_read_only",
    durability: "ephemeral",
    verification: "not_verified",
    contentPolicy: {
      tracked: "raw_content_type_and_executable",
      untracked: "raw_content_type_and_executable",
      symlinks: "raw_link_text_no_follow",
      ignored: "excluded",
      specialFiles: "blocked",
    },
    root: { canonicalPath: report.root, ...report.identity },
    gitDirectory: gitIdentity,
    commonDirectory: gitIdentity,
    head: { kind: "unborn", symbolicRef: "refs/heads/main" },
    refs: { digest: `sha256:${"1".repeat(64)}`, count: 0 },
    index: {
      digest: `sha256:${"2".repeat(64)}`,
      metadataDigest: `sha256:${"3".repeat(64)}`,
      entryCount: 0,
    },
    worktree: {
      digest: `sha256:${"4".repeat(64)}`,
      ignored: "excluded",
      trackedPaths: 0,
      untrackedPaths: 0,
      contentEntries: 0,
      totalBytes: 0,
    },
    metadata: { digest: `sha256:${"5".repeat(64)}`, fileCount: 0, totalBytes: 0, externalConfig: "unsupported" },
    observer: {
      adapter: "astra.git-baseline.v1",
      adapterDigest: `sha256:${"6".repeat(64)}`,
      gitBinaryDigest: `sha256:${"7".repeat(64)}`,
      observationDigest: `sha256:${"8".repeat(64)}`,
    },
    limits: {
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      maxEntries: 128,
      maxBoundaryEntries: 128,
      maxBoundaryDurationMs: 1_000,
      maxGitBinaryBytes: 16_000_000,
      maxContentEntries: 128,
      maxFileBytes: 65_536,
      maxTotalBytes: 262_144,
      maxDurationMs: 2_000,
    },
  } as const satisfies GitRepositoryBaselineSnapshotAuthority
  return { ...authority, snapshotDigest: computeGitRepositoryBaselineSnapshotDigest(authority) }
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
