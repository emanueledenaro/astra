# Architecture rules

## Package layering (dependency direction is one-way)

`@astra/domain` ← `@astra/git`, `@astra/executor`, `@astra/sandbox`
`@astra/domain` + those ← `@astra/ledger` ← `@astra/runtime` ← `@astra/cli`

- `@astra/domain` is pure: no filesystem, process, network, Git, database, provider,
  credential, extension, or UI access. Projectors and typed facts only.
- `@astra/runtime` owns every privileged effect (preflight reads, controlled writes,
  host execution, coordinators). Privileged modules are loaded lazily, only after
  explicit approval, via subpath exports.
- `@astra/cli` is the composition root: Workspace Gate, TUI launcher, private
  Unix-socket control servers. Real effects run in this parent process, never in the
  spawned TUI child.
- Inherited opencode packages: `Schema → Core/Protocol → Server`; `Client` may depend
  on Schema/Protocol but never Core/Server; `sdk-next` composes Client+Core+Server.

## Parent/child boundary (the central design fact)

The inherited opencode TUI runs as a child with `ASTRA_SAFE_START=1`, an 18-entry env
allowlist, and a synthetic deny-all config. It can never reach providers, network,
Git, plugins, MCP, or the filesystem on its own. Governed effects (chat turns, writes,
git stage/commit, MCP activation) execute in the parent behind per-operation approval
and the operation kernel, and are only surfaced to the child over authenticated private
sockets. Never move an effect into the child; never weaken a safe-start guard.

## Operation kernel

Every risky effect is a typed Operation: exact preview → explicit consent → durable
one-shot capability claim (fencing token) → bounded execution → receipt → independent
verification. The 15-state topology lives in `packages/astra-domain/src/operation.ts`
and is canonically specified in `docs/adr/ADR-0002-operation-topology.md`. New effect
kinds follow the existing coordinator pattern (`astra-runtime/src/*-coordinator.ts`).

## Changes to inherited opencode code

Keep them surgical: additive `if (Flag.ASTRA_SAFE_START)` guards at chokepoints, or
new `astra-*` files. Broad rewrites of inherited files make upstream merges painful —
avoid them. Never edit `src/generated`/`src/generated-effect`; regenerate instead.
