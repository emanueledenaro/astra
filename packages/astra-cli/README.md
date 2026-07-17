# Astra CLI demo

Run the first macOS workspace-trust vertical slice:

```sh
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace
```

The workspace opens through a bounded static preflight. The terminal shows the static preflight digest, the exact `.git` entry form when present, and whether activation is available. This digest covers bounded root metadata and selected regular files; it is not a Git or worktree snapshot.

A workspace with a `.git` directory, regular file, or symlink remains available read-only, but `Activate once` and controlled effects fail closed with `GIT BASELINE NOT INSPECTED`. No flag or scripted decision overrides this guard. Non-Git workspaces may choose read-only, activate once, or exit. Activation is process-local and does not persist trust. The optional demo marker is a create-only host write that requires a second exact approval and is independently read back before the scoped `VERIFIED` result appears.

For deterministic verification:

```sh
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision read-only
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision activate-once --approval deny
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision activate-once --approval approve
```

This demo does not start the OpenCode runtime and does not provide a sandbox, persistent trust, shell, network, Git execution or baseline inspection, provider, plugin, MCP, LSP, formatter, package, or credential execution.
