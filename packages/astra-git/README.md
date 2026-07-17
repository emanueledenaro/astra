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
