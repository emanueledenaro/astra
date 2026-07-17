export type GitInspectionLimits = Readonly<{
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  maxEntries: number
  maxBoundaryEntries: number
  maxBoundaryDurationMs: number
  maxGitBinaryBytes: number
}>

export type GitBranch = Readonly<{
  oid: string | null
  head: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  stashCount: number
  aheadBehindScope: "local_ref_only"
}>

export type GitPathState = Readonly<{
  path: string
  index: string
  worktree: string
}>

export type GitConflict = Readonly<{
  path: string
  code: string
}>

export type GitInspectionReport = Readonly<{
  status: "complete"
  mode: "bounded_read_only"
  baseline: "not_captured"
  activationAllowed: false
  verification: "not_verified"
  submodules: "not_inspected"
  workspaceRoot: string
  branch: GitBranch
  staged: ReadonlyArray<GitPathState>
  unstaged: ReadonlyArray<GitPathState>
  untracked: ReadonlyArray<string>
  conflicts: ReadonlyArray<GitConflict>
  entryCount: number
  outputDigest: `sha256:${string}`
  reportDigest: `sha256:${string}`
}>

export type GitInspectionBlockReason =
  | "unsupported_platform"
  | "invalid_limits"
  | "workspace_path_not_absolute"
  | "workspace_unreadable"
  | "workspace_not_directory"
  | "workspace_not_canonical"
  | "workspace_identity_changed"
  | "git_metadata_missing"
  | "git_metadata_not_directory"
  | "git_metadata_case_variant"
  | "git_metadata_identity_changed"
  | "git_commondir_unsupported"
  | "git_alternates_unsupported"
  | "git_metadata_symlink"
  | "git_worktree_metadata_unsupported"
  | "git_modules_metadata_unsupported"
  | "ancestor_git_repository"
  | "nested_git_repository"
  | "boundary_entry_limit_exceeded"
  | "boundary_time_limit_exceeded"
  | "boundary_unreadable"
  | "developer_directory_untrusted"
  | "git_binary_untrusted"
  | "sandbox_binary_untrusted"
  | "sandbox_profile_rejected"
  | "git_process_failed"
  | "git_process_stderr"
  | "git_process_timeout"
  | "git_stdout_limit_exceeded"
  | "git_stderr_limit_exceeded"
  | "git_output_invalid_utf8"
  | "git_output_malformed"
  | "git_entry_limit_exceeded"
  | "git_index_assume_unchanged"
  | "git_index_skip_worktree"
  | "git_index_fsmonitor_valid"
  | "git_index_fsmonitor_uninspectable"
  | "submodules_uninspected"
  | "observation_changed"
  | "git_ephemeral_copy_failed"
  | "git_ephemeral_identity_changed"
  | "git_ephemeral_cleanup_failed"

export type GitInspectionBlocked = Readonly<{
  status: "blocked"
  mode: "bounded_read_only"
  baseline: "not_captured"
  activationAllowed: false
  verification: "not_verified"
  submodules: "not_inspected"
  workspaceRoot: string
  reason: GitInspectionBlockReason
}>

export type GitInspectionResult = GitInspectionReport | GitInspectionBlocked
