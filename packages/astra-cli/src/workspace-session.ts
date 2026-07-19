import {
  parseGitRepositoryBaselineCaptureResult,
  parseGitRepositoryBaselineRevalidationResult,
  type GitRepositoryBaselineCaptureResult,
  type GitRepositoryBaselineRevalidationResult,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { GitInspectionResult } from "@astra/git"
import { checkWorkspaceActivation, revalidateWorkspacePreflight, scanWorkspace } from "@astra/runtime/preflight"
import type { AstraWorkspaceGateView, AstraWorkspaceMode } from "@opencode-ai/tui/astra/workspace-gate-contract"
import { lstat, realpath } from "node:fs/promises"
import { resolve } from "node:path"

export type AstraWorkspaceSessionResult =
  | Readonly<{
      status: "opened"
      mode: "read-only" | "activate-once"
      report: WorkspaceTrustReport
      repositoryBaseline?: GitRepositoryBaselineSnapshot
      repositoryInspection?: Extract<GitInspectionResult, { status: "complete" }>
    }>
  | Readonly<{ status: "exited"; report: WorkspaceTrustReport }>

export type AstraWorkspaceSessionDependencies = Readonly<{
  present: (view: AstraWorkspaceGateView) => Promise<AstraWorkspaceMode>
  withProgress?: <T>(view: AstraWorkspaceGateView, operation: () => Promise<T>) => Promise<T>
  inspectGitWorkspace: (workspaceRoot: string) => Promise<GitInspectionResult>
  captureGitRepositoryBaseline: (workspaceRoot: string) => Promise<GitRepositoryBaselineCaptureResult>
  revalidateGitRepositoryBaseline: (
    workspaceRoot: string,
    snapshot: GitRepositoryBaselineSnapshot,
  ) => Promise<GitRepositoryBaselineRevalidationResult>
}>

/**
 * Selects a workspace mode without bootstrapping OpenCode or executing any
 * workspace-controlled code. The caller may start the full TUI only after an
 * `opened` result is returned.
 */
export async function openAstraWorkspaceSession(
  workspace: string,
  dependencies: AstraWorkspaceSessionDependencies,
): Promise<AstraWorkspaceSessionResult> {
  let report = await scanWorkspace(await canonicalWorkspacePath(workspace))
  let repositoryBaseline: GitRepositoryBaselineSnapshot | undefined
  let repositoryInspection: Extract<GitInspectionResult, { status: "complete" }> | undefined
  let git: AstraWorkspaceGateView["git"] = hasGitMetadata(report) ? "not-inspected" : "not-required"
  let state: AstraWorkspaceGateView["state"] = report.completeness === "complete" ? "awaiting-decision" : "blocked"
  let detail: string | undefined

  while (true) {
    const decision = await dependencies.present(
      makeGateView(report, state, git, repositoryBaseline !== undefined, detail),
    )
    if (decision === "exit") return { status: "exited", report }

    if (decision === "inspect-git") {
      const inspected = await runWithProgress(
        dependencies,
        makeGateView(report, "working", "inspecting", false, "Inspecting Git with bounded read-only checks."),
        () => inspectGitBoundary(report, dependencies),
      )
      repositoryBaseline = inspected.baseline
      repositoryInspection = inspected.inspection
      git = inspected.git
      state = inspected.state
      detail = inspected.detail
      continue
    }

    if (decision === "read-only") {
      const current = await revalidateWorkspacePreflight(report)
      if (!current.matched) {
        report = current.report
        repositoryBaseline = undefined
        repositoryInspection = undefined
        git = hasGitMetadata(report) ? "stale" : "not-required"
        state = "stale"
        detail = `Workspace changed: ${current.reason.replaceAll("_", " ")}`
        continue
      }
      return { status: "opened", mode: "read-only", report: current.report }
    }

    if (decision !== "activate-once") {
      state = "blocked"
      detail = "A supported explicit decision is required."
      continue
    }

    const activation = await runWithProgress(
      dependencies,
      makeGateView(
        report,
        "working",
        repositoryBaseline ? "inspecting" : git,
        false,
        repositoryBaseline
          ? "Revalidating the workspace and inspected Git baseline before activation."
          : "Revalidating the workspace before activation.",
      ),
      () => revalidateActivation(report, repositoryBaseline, dependencies),
    )
    const current = activation.workspace
    if (!current.matched) {
      report = current.report
      repositoryBaseline = undefined
      repositoryInspection = undefined
      git = hasGitMetadata(report) ? "stale" : "not-required"
      state = "stale"
      detail = `Workspace changed: ${current.reason.replaceAll("_", " ")}`
      continue
    }
    report = current.report

    if (!hasGitMetadata(report) && checkWorkspaceActivation(report).allowed) {
      return { status: "opened", mode: "activate-once", report }
    }
    if (!repositoryBaseline || !repositoryInspection) {
      state = "blocked"
      git = "not-inspected"
      detail = "Inspect Git before activating this workspace."
      continue
    }
    const inspectedBaseline = repositoryBaseline
    const inspectedRepository = repositoryInspection

    const revalidation = parseGitRepositoryBaselineRevalidationResult(activation.git)
    if (!revalidation.ok) {
      repositoryBaseline = undefined
      repositoryInspection = undefined
      git = "blocked"
      state = "blocked"
      detail = "Git revalidation failed closed. Inspect Git again."
      continue
    }
    if (revalidation.value.status === "blocked") {
      repositoryBaseline = undefined
      repositoryInspection = undefined
      git = "blocked"
      state = "blocked"
      detail = `Git revalidation was blocked: ${readableReason(revalidation.value.reason)}.`
      continue
    }
    if (
      revalidation.value.status === "stale" ||
      revalidation.value.expectedSnapshotDigest !== inspectedBaseline.snapshotDigest ||
      revalidation.value.currentSnapshotDigest !== inspectedBaseline.snapshotDigest
    ) {
      repositoryBaseline = undefined
      repositoryInspection = undefined
      git = "stale"
      state = "stale"
      detail = "Git changed after inspection. Inspect it again before activation."
      continue
    }
    return {
      status: "opened",
      mode: "activate-once",
      report,
      repositoryBaseline: inspectedBaseline,
      repositoryInspection: inspectedRepository,
    }
  }
}

function makeGateView(
  report: WorkspaceTrustReport,
  state: AstraWorkspaceGateView["state"],
  git: AstraWorkspaceGateView["git"],
  hasCurrentBaseline: boolean,
  detail: string | undefined,
): AstraWorkspaceGateView {
  return {
    workspace: report.root,
    state,
    preflight: report.completeness === "complete" ? "complete" : "blocked",
    git,
    activationAllowed:
      report.completeness === "complete" &&
      (hasCurrentBaseline || (!hasGitMetadata(report) && checkWorkspaceActivation(report).allowed)),
    scannedEntries: report.scannedEntries,
    scannedBytes: report.scannedBytes,
    surfaces: report.surfaces.map((surface) => ({ kind: surface.kind, path: surface.path })),
    blockers: report.blockers,
    ...(detail ? { detail } : {}),
  }
}

async function inspectGitBoundary(
  report: WorkspaceTrustReport,
  dependencies: AstraWorkspaceSessionDependencies,
): Promise<{
  baseline?: GitRepositoryBaselineSnapshot
  inspection?: Extract<GitInspectionResult, { status: "complete" }>
  git: AstraWorkspaceGateView["git"]
  state: AstraWorkspaceGateView["state"]
  detail: string
}> {
  if (report.completeness !== "complete" || !hasGitMetadata(report)) {
    return { git: "blocked", state: "blocked", detail: "Git inspection is unavailable for this workspace." }
  }

  const captured = parseGitRepositoryBaselineCaptureResult(
    await dependencies.captureGitRepositoryBaseline(report.root).catch(() => null),
  )
  if (!captured.ok || captured.value.status !== "complete") {
    return { git: "blocked", state: "blocked", detail: "Git baseline capture failed closed." }
  }
  if (!baselineMatchesReport(captured.value.snapshot, report)) {
    return { git: "blocked", state: "blocked", detail: "Git baseline does not match the workspace identity." }
  }

  const inspection = await dependencies.inspectGitWorkspace(report.root).catch(() => null)
  if (!inspection || inspection.workspaceRoot !== report.root || inspection.status !== "complete") {
    return { git: "blocked", state: "blocked", detail: "Bounded Git inspection failed closed." }
  }
  if (inspection.diff.observationDigest !== inspection.outputDigest) {
    return { git: "blocked", state: "blocked", detail: "Git report binding is invalid." }
  }

  const revalidated = parseGitRepositoryBaselineRevalidationResult(
    await dependencies.revalidateGitRepositoryBaseline(report.root, captured.value.snapshot).catch(() => null),
  )
  if (!revalidated.ok) {
    return { git: "blocked", state: "blocked", detail: "Git revalidation failed closed." }
  }
  if (revalidated.value.status === "blocked") {
    return {
      git: "blocked",
      state: "blocked",
      detail: `Git revalidation was blocked: ${readableReason(revalidated.value.reason)}.`,
    }
  }
  if (
    revalidated.value.status === "stale" ||
    revalidated.value.expectedSnapshotDigest !== captured.value.snapshot.snapshotDigest ||
    revalidated.value.currentSnapshotDigest !== captured.value.snapshot.snapshotDigest
  ) {
    return { git: "stale", state: "stale", detail: "Git changed while the inspection was being displayed." }
  }

  const branch = inspection.branch.head ?? inspection.branch.oid ?? "detached"
  const changes = inspection.entryCount === 1 ? "1 changed path" : `${inspection.entryCount} changed paths`
  return {
    baseline: captured.value.snapshot,
    inspection,
    git: "current",
    state: "awaiting-decision",
    detail: `${branch} · ${changes} · metadata only · not verified`,
  }
}

function hasGitMetadata(report: WorkspaceTrustReport) {
  return report.surfaces.some((surface) => surface.kind === "git_metadata")
}

function baselineMatchesReport(snapshot: GitRepositoryBaselineSnapshot, report: WorkspaceTrustReport) {
  return (
    report.identity !== null &&
    snapshot.root.canonicalPath === report.root &&
    snapshot.root.device === report.identity.device &&
    snapshot.root.inode === report.identity.inode
  )
}

function readableReason(reason: string) {
  return reason.replaceAll("_", " ")
}

function runWithProgress<T>(
  dependencies: AstraWorkspaceSessionDependencies,
  view: AstraWorkspaceGateView,
  operation: () => Promise<T>,
) {
  return dependencies.withProgress ? dependencies.withProgress(view, operation) : operation()
}

async function revalidateActivation(
  report: WorkspaceTrustReport,
  repositoryBaseline: GitRepositoryBaselineSnapshot | undefined,
  dependencies: AstraWorkspaceSessionDependencies,
) {
  const workspace = await revalidateWorkspacePreflight(report)
  if (!workspace.matched || !repositoryBaseline) return { workspace, git: null }
  const git = await dependencies
    .revalidateGitRepositoryBaseline(workspace.report.root, repositoryBaseline)
    .catch(() => null)
  return { workspace, git }
}

async function canonicalWorkspacePath(workspace: string) {
  const candidate = resolve(workspace)
  const before = await lstat(candidate).catch(() => null)
  if (!before?.isDirectory() || before.isSymbolicLink()) return candidate
  const physical = await realpath(candidate).catch(() => null)
  if (!physical) return candidate
  const [after, target] = await Promise.all([lstat(candidate).catch(() => null), lstat(physical).catch(() => null)])
  if (
    !after?.isDirectory() ||
    after.isSymbolicLink() ||
    !target?.isDirectory() ||
    target.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    after.dev !== target.dev ||
    after.ino !== target.ino
  ) {
    return candidate
  }
  return physical
}
