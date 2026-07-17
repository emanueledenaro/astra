# `@astra/git`

Private, read-only Git inspection boundary for Astra.

The first macOS backend supports only an absolute canonical workspace root with
one direct `.git` directory. It rejects worktrees, submodules, nested or
ancestor repositories, symlinked roots, metadata symlinks, external object
layouts, case variants, hidden index states, and incomplete scans before it can
report a complete observation.

Inspection opens the root-owned Apple developer Git without following a final
symlink, then copies bytes from that same handle into a size-bounded private
ephemeral executable. The copy is synced, sealed read/execute-only, identified
by inode and SHA-256, revalidated before every use, run directly under
`sandbox-exec`, and removed in `finally`. It never uses Astra app state.

The sandbox denies network, filesystem writes, process forks, and every process
execution except that exact ephemeral Git. Results are bounded observations,
not a trust decision, activation grant, durable baseline, or verification
claim. `assume-unchanged` and `skip-worktree` always block. A readable
fsmonitor-valid tag blocks explicitly; if strict sandboxing prevents Git from
reading fsmonitor state without IPC, inspection reports fsmonitor as
uninspectable and remains blocked.

Repository filters that require a helper process make inspection fail closed.
The backend never retries with unsandboxed Git.

The complete report also contains a typed, ephemeral metadata diff derived from
the same twice-observed porcelain output. Staged entries describe `HEAD ->
index` with exact mode and object IDs. Unstaged entries describe `index ->
worktree`; worktree content remains explicitly unhashed. The diff is bound to
the raw observation digest and never represents a durable baseline, patch, or
verification verdict.

Both index reads are root-scoped and cross-checked against ordinary status
entries. Conflict stage metadata is preserved internally and checked exactly
against index stages 1, 2, and 3. Mixed SHA-1/SHA-256 observations,
intent-to-add, duplicate or control-character paths, unsupported modes, and
inconsistent index records block the report. Untracked and conflict contents
are not inspected in this increment.
