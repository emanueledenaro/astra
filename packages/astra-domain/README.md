# `@astra/domain`

Pure domain contracts for Astra.

The first slice implements the complete canonical Operation topology from ADR-0002: admission, 15 states, all state-changing transitions, and accepted same-state facts. It proves structural transition legality only. Policy decisions, evidence validation, persistence, capabilities, execution, recovery probes, and external effects belong to later packages and must complete their own checks before producing an accepted event.

Strict runtime decoders also define immutable `DispatchRequest` and one-shot `ExecutorClaim` facts. They carry distinct branded IDs, exact authority and attempt links, canonical timestamps, and a positive fencing token without granting execution authority by themselves.

The package additionally owns the pure, compact Git repository baseline
contract and strict runtime parsers. The contract contains no filesystem or Git
access and does not represent the separate workspace security digest. Runtime
code must compose those independent facts later when building an Operation
baseline. Snapshot parsing recomputes the canonical SHA-256 authority digest,
and revalidation results are accepted only when `current` uses equal digests or
`stale` uses different digests.

```sh
bun test
bun run demo
```

The demo is intentionally local and deterministic. It is not a durable ledger, sandbox, provider integration, or production security certification.
