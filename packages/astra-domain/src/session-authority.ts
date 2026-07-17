import { parseGitRepositoryBaselineSnapshot, type GitRepositoryBaselineSnapshot } from "./git-repository-baseline"
import type { WorkspaceIdentity } from "./workspace-trust"

export type AstraSessionAuthority = Readonly<{
  schemaVersion: 1
  sessionID: string
  issuedAt: string
  mode: "read-only" | "activate-once"
  effectPolicy: "deny"
  workspace: Readonly<{
    root: string
    identity: WorkspaceIdentity
    securityDigest: string
  }>
  repositoryBaseline: GitRepositoryBaselineSnapshot | null
}>

export type AstraSessionAuthorityParseResult =
  | Readonly<{ ok: true; value: AstraSessionAuthority }>
  | Readonly<{ ok: false; reason: string }>

export function parseAstraSessionAuthority(input: unknown): AstraSessionAuthorityParseResult {
  const record = exactRecord(input, [
    "schemaVersion",
    "sessionID",
    "issuedAt",
    "mode",
    "effectPolicy",
    "workspace",
    "repositoryBaseline",
  ])
  if (!record.ok) return record
  if (record.value.schemaVersion !== 1) return rejected("unsupported_schema_version")
  if (!uuid(record.value.sessionID)) return rejected("invalid_session_id")
  if (!timestamp(record.value.issuedAt)) return rejected("invalid_issued_at")
  if (record.value.mode !== "read-only" && record.value.mode !== "activate-once") {
    return rejected("invalid_mode")
  }
  if (record.value.effectPolicy !== "deny") return rejected("invalid_effect_policy")

  const workspace = exactRecord(record.value.workspace, ["root", "identity", "securityDigest"])
  if (!workspace.ok) return workspace
  if (typeof workspace.value.root !== "string" || workspace.value.root.length === 0) {
    return rejected("invalid_workspace_root")
  }
  if (!digest(workspace.value.securityDigest)) return rejected("invalid_workspace_digest")
  const identity = exactRecord(workspace.value.identity, ["device", "inode"])
  if (!identity.ok) return identity
  if (!positiveIntegerString(identity.value.device) || !positiveIntegerString(identity.value.inode)) {
    return rejected("invalid_workspace_identity")
  }

  const repositoryBaseline =
    record.value.repositoryBaseline === null
      ? null
      : parseGitRepositoryBaselineSnapshot(record.value.repositoryBaseline)
  if (repositoryBaseline !== null && !repositoryBaseline.ok) return rejected("invalid_repository_baseline")
  if (record.value.mode === "activate-once" && repositoryBaseline !== null) {
    const snapshot = repositoryBaseline.value
    if (
      snapshot.root.canonicalPath !== workspace.value.root ||
      snapshot.root.device !== identity.value.device ||
      snapshot.root.inode !== identity.value.inode
    ) {
      return rejected("repository_workspace_identity_mismatch")
    }
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      sessionID: record.value.sessionID,
      issuedAt: record.value.issuedAt,
      mode: record.value.mode,
      effectPolicy: "deny",
      workspace: {
        root: workspace.value.root,
        identity: { device: identity.value.device, inode: identity.value.inode },
        securityDigest: workspace.value.securityDigest,
      },
      repositoryBaseline: repositoryBaseline?.value ?? null,
    },
  }
}

function exactRecord(
  input: unknown,
  keys: ReadonlyArray<string>,
): Readonly<{ ok: true; value: Record<string, unknown> }> | Readonly<{ ok: false; reason: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return rejected("expected_record")
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
    return rejected("invalid_record_prototype")
  }
  const record = input as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !(key in record))) {
    return rejected("invalid_record_shape")
  }
  return { ok: true, value: record }
}

function rejected(reason: string) {
  return { ok: false as const, reason }
}

function uuid(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  )
}

function timestamp(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input
}

function digest(input: unknown): input is string {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/.test(input)
}

function positiveIntegerString(input: unknown): input is string {
  return typeof input === "string" && /^[1-9][0-9]*$/.test(input)
}
