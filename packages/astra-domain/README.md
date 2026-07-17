# `@astra/domain`

Pure domain contracts for Astra.

The first slice implements the complete canonical Operation topology from ADR-0002: admission, 15 states, all state-changing transitions, and accepted same-state facts. It proves structural transition legality only. Policy decisions, evidence validation, persistence, capabilities, execution, recovery probes, and external effects belong to later packages and must complete their own checks before producing an accepted event.

```sh
bun test
bun run demo
```

The demo is intentionally local and deterministic. It is not a durable ledger, sandbox, provider integration, or production security certification.
