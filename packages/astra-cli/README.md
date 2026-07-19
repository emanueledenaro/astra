# Astra CLI demo

Run the first macOS workspace-trust vertical slice:

```sh
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace
```

The workspace opens through a bounded static preflight. The terminal shows the static preflight digest, the exact `.git` entry form when present, and whether activation is available. This digest covers bounded root metadata and selected regular files; it is not a Git or worktree snapshot.

A workspace with an exact direct `.git` directory offers an explicit `[G] inspect Git` decision while `Activate once` remains unavailable. This read-only macOS inspection is sandboxed, bounded, and fail-closed; it does not capture a durable baseline, inspect submodules, persist trust, enable activation, or claim verification. `.git` files, symlinks, case variants, ancestor repositories, nested repositories, and gitlinks remain unsupported. No flag or scripted decision overrides this guard.

Non-Git workspaces may choose read-only, activate once, or exit. Activation is process-local and does not persist trust. The optional demo marker is a create-only host write that requires a second exact approval. Its executor receipt is stored and ingested before a separate verifier reopens the target; only durable independent evidence may produce the scoped `VERIFIED` result.

For deterministic verification:

```sh
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision read-only
bun run ./packages/astra-cli/src/index.ts inspect-git /absolute/path/to/git-workspace
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision activate-once --approval deny
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision activate-once --approval approve
```

This demo does not start the OpenCode runtime and does not provide persistent trust, shell access, network access, a durable Git baseline, write-capable Git, provider, plugin, MCP, LSP, formatter, package, or credential execution. The only Git process is the explicit read-only macOS inspection described above.
