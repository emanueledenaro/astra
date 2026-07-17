# Astra CLI demo

Run the first macOS workspace-trust vertical slice:

```sh
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace
```

The workspace opens through a bounded static preflight. The terminal then offers read-only, activate once, or exit. Activation is process-local and does not persist trust. The optional demo marker is a create-only host write that requires a second exact approval and is independently read back before the scoped `VERIFIED` result appears.

For deterministic verification:

```sh
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision read-only
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision activate-once --approval deny
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace --decision activate-once --approval approve
```

This demo does not start the OpenCode runtime and does not provide a sandbox, persistent trust, shell, network, Git, provider, plugin, MCP, LSP, formatter, package, or credential execution.
