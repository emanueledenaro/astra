# Astra runtime

This private package owns the first Astra workspace preflight composition root, the separately loaded controlled demo effect, its durable coordinator, and an independent verifier boundary.

`workspace-preflight.ts` has negative capabilities: it performs bounded static filesystem reads and imports no OpenCode bootstrap, process, network, Git, provider, plugin, MCP, LSP, formatter, package, credential, or write runtime. It records the `.git` entry as a directory, regular file, or symlink without traversing it. A bounded regular `.git` file is digested with no-follow reads; directories, referenced gitdirs, and symlink targets are never inspected.

Report completeness and activation authority are separate. A complete static report remains useful read-only, while any `.git` form returns `git_baseline_not_inspected` until a real Git-aware baseline exists. The controlled write lives behind a distinct export and is loaded only after ephemeral activation and explicit approval.

The approved path now records admission, approval, outbox dispatch, one-shot claim, executor receipt, spool acknowledgement, and independent evidence in durable application state outside the workspace. The writer reports observation only. Its receipt binds the admitted baseline, bounded post-effect workspace digest, activation guard, preflight limits, and the created target identity. A separate verifier checks those durable facts against the caller report, scans the workspace before and after fresh target reads, scans again immediately before evidence ingestion, and treats drift, replacement, or foreign input as `verification.unknown`.

The current retry budget is deliberately `maxAttempts: 1`. An accepted claim remains visibly in progress until its lease expires; only then may a missing receipt become `reconciliation_required`. Recovery never reruns the effect. Immediately before the create-only host call, the coordinator revalidates the exact durable claim, capability, fence, adapter, baseline, authority, and a five-second minimum lease. Receipt transfer after spool or ledger handoff crashes uses exact replay only.

Evidence ingestion and receipt acknowledgement are absent from the generic ledger and spool APIs. Internal package composition uses process-local symbol closures to expose those mutations only to the verifier and coordinator modules. This is an API capability boundary, not OS isolation: the verifier still runs sequentially in the Astra CLI process. A dedicated verifier process and sandbox remain required before hostile in-process extensions can be treated as isolated.

This remains a macOS demo slice. It is not a sandbox, persistent trust system, general-purpose executor, hostile-plugin isolation boundary, or release-ready runtime.
