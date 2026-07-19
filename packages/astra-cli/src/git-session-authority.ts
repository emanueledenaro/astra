import {
  parseGitRepositoryBaselineCaptureResult,
  parseGitRepositoryBaselineRevalidationResult,
  type GitRepositoryBaselineCaptureResult,
  type GitRepositoryBaselineRevalidationResult,
  type GitRepositoryBaselineSnapshot,
} from "@astra/domain/git-repository-baseline"
import {
  captureGitRepositoryBaseline,
  inspectGitWorkspace,
  revalidateGitRepositoryBaseline,
  type GitInspectionResult,
} from "@astra/git"
import type { AstraWorkspaceSessionResult } from "./workspace-session"

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>
type CompleteInspection = Extract<GitInspectionResult, { status: "complete" }>

export type AstraGitSessionAuthoritySnapshot = Readonly<{
  baseline: GitRepositoryBaselineSnapshot
  inspection: CompleteInspection
}>

export type AstraGitSessionAuthority = Readonly<{
  current: () => AstraGitSessionAuthoritySnapshot | null
  advance: (
    expectedCurrentSnapshotDigest: `sha256:${string}`,
    verifiedNextSnapshotDigest: `sha256:${string}`,
  ) => Promise<"advanced" | "invalidated">
  invalidate: () => void
}>

export type AstraGitSessionAuthorityDependencies = Readonly<{
  captureBaseline: (workspaceRoot: string) => Promise<GitRepositoryBaselineCaptureResult>
  inspect: (workspaceRoot: string) => Promise<GitInspectionResult>
  revalidate: (
    workspaceRoot: string,
    snapshot: GitRepositoryBaselineSnapshot,
  ) => Promise<GitRepositoryBaselineRevalidationResult>
}>

/** Keeps the parent-owned Git authority current across verified local mutations. */
export function createAstraGitSessionAuthority(
  session: OpenedWorkspace,
  dependencies: AstraGitSessionAuthorityDependencies = defaultDependencies,
): AstraGitSessionAuthority {
  let revision = 0
  let authority = initialAuthority(session)

  const invalidate = () => {
    authority = null
    revision++
  }

  return {
    current: () => authority,
    invalidate,
    async advance(expectedCurrentSnapshotDigest, verifiedNextSnapshotDigest) {
      const approved = authority
      const expectedRevision = revision
      if (!approved || approved.baseline.snapshotDigest !== expectedCurrentSnapshotDigest) {
        invalidate()
        return "invalidated"
      }

      const next = await captureStableAuthority(session, verifiedNextSnapshotDigest, dependencies)
      if (revision !== expectedRevision) return "invalidated"
      if (!next) {
        invalidate()
        return "invalidated"
      }
      authority = next
      revision++
      return "advanced"
    },
  }
}

export async function advanceAstraGitSessionAuthority(
  authority: AstraGitSessionAuthority | undefined,
  expectedCurrentSnapshotDigest: `sha256:${string}`,
  verifiedNextSnapshotDigest: `sha256:${string}`,
) {
  if (!authority) return
  await authority.advance(expectedCurrentSnapshotDigest, verifiedNextSnapshotDigest).catch(() => authority.invalidate())
}

const defaultDependencies: AstraGitSessionAuthorityDependencies = {
  captureBaseline: captureGitRepositoryBaseline,
  inspect: inspectGitWorkspace,
  revalidate: revalidateGitRepositoryBaseline,
}

function initialAuthority(session: OpenedWorkspace): AstraGitSessionAuthoritySnapshot | null {
  const baseline = session.repositoryBaseline
  const inspection = session.repositoryInspection
  if (!baseline || !inspection || !authorityMatchesSession(session, baseline, inspection)) return null
  return Object.freeze({ baseline, inspection })
}

async function captureStableAuthority(
  session: OpenedWorkspace,
  verifiedNextSnapshotDigest: `sha256:${string}`,
  dependencies: AstraGitSessionAuthorityDependencies,
): Promise<AstraGitSessionAuthoritySnapshot | null> {
  const captured = parseGitRepositoryBaselineCaptureResult(
    await dependencies.captureBaseline(session.report.root).catch(() => null),
  )
  if (
    !captured.ok ||
    captured.value.status !== "complete" ||
    captured.value.snapshot.snapshotDigest !== verifiedNextSnapshotDigest
  ) {
    return null
  }
  const baseline = captured.value.snapshot
  const inspection = await dependencies.inspect(session.report.root).catch(() => null)
  if (!inspection || inspection.status !== "complete" || !authorityMatchesSession(session, baseline, inspection)) {
    return null
  }
  const revalidated = parseGitRepositoryBaselineRevalidationResult(
    await dependencies.revalidate(session.report.root, baseline).catch(() => null),
  )
  if (
    !revalidated.ok ||
    revalidated.value.status !== "current" ||
    revalidated.value.expectedSnapshotDigest !== verifiedNextSnapshotDigest ||
    revalidated.value.currentSnapshotDigest !== verifiedNextSnapshotDigest
  ) {
    return null
  }
  return Object.freeze({ baseline, inspection })
}

function authorityMatchesSession(
  session: OpenedWorkspace,
  baseline: GitRepositoryBaselineSnapshot,
  inspection: CompleteInspection,
) {
  return (
    session.report.identity !== null &&
    baseline.root.canonicalPath === session.report.root &&
    baseline.root.device === session.report.identity.device &&
    baseline.root.inode === session.report.identity.inode &&
    inspection.workspaceRoot === session.report.root &&
    inspection.diff.observationDigest === inspection.outputDigest
  )
}
