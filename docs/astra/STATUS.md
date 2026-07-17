# Astra Delivery Status

Updated: 2026-07-17

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Canonical repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Branch: `astra`
- Latest implementation checkpoint: `c5d886b7b` (`feat(astra): add durable dispatch claims`)
- Audited OpenCode baseline: `453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d`
- History: full local clone; the repository is not shallow
- Remotes: fetch-only; push URLs are disabled

## Implemented locally

- OpenCode provenance, MIT license, provider registry, and audited baseline are preserved.
- Unknown workspace open uses bounded static preflight without normal OpenCode bootstrap.
- Read-only, Activate once, Exit, explicit effect approval, visible Operation state, and exact marker readback work on macOS.
- Typed Operation contracts and the append-only SQLite ledger are implemented.
- A rejected controlled write is recorded atomically as `admitted -> policy.ask -> approval.rejected -> denied`.
- The denied projection is reopened from a read-only database connection and shown with its sequence and cursor.
- Read-only and Exit do not initialize Astra app state. Denial never dispatches the planned effect.
- Ledger paths that resolve into the workspace through symlinks are rejected before SQLite can write.
- An approved Operation can now reserve one globally unique capability, append an immutable dispatch outbox request, and be accepted through the specialized one-shot claim API.
- `dispatch.requested` and its outbox commit atomically. `executor.accepted`, capability consumption, executor claim, and the monotonic fencing token also commit atomically.
- Approval, dispatch, and claim use an internal trusted clock and bind the admitted baseline, adapter digest, attempt, causation, actor, and event timestamps. Expired, reused, mismatched, competing, or backdated claims fail closed.
- Storage schema v3 migrates an authentic v1 denial ledger without losing its events.

## Honest limits

- The approved controlled write still uses the Phase D in-memory path. It is not connected to the durable ledger yet.
- The durable outbox, capability reservation/consumption, executor claim, and fencing kernel are implemented but deliberately not connected to an effect executor yet.
- Receipt spooling, effect ingestion, lease renewal, crash recovery, and reconciliation are not implemented.
- `HOST EXECUTION — NO SANDBOX` is accurate: the positive demo effect is a direct, bounded host write.
- Git workspaces are refused by the denial recorder until Astra can capture a complete Git baseline; no non-Git baseline is invented.
- Trust is process-local and never persisted in this increment.
- Provider, plugin, skill, and MCP compatibility is preserved structurally but not yet activated behind Astra trust and isolation.

## Verification evidence

- Exact toolchain: Bun `1.3.14`; frozen install succeeds without lockfile changes.
- Domain: 38 tests, 1,924 assertions; typecheck passes.
- Ledger: 30 tests, 103 assertions; typecheck passes.
- Runtime: 17 tests, 68 assertions; both strict runtime and isolated SQLite-adapter typechecks pass.
- CLI: 15 tests, 79 assertions; typecheck passes.
- Total: 100 tests and 2,174 assertions.
- Scoped Oxlint: 0 warnings, 0 errors. Prettier check passes.
- Real demo matrix passes: malicious read-only fixture, durable denial, approved create-only write, exact SHA-256 readback, and zero network-canary requests.
- The single independent review for the dispatch increment found no P0 and two P1 authority gaps. Trusted-time expiry, capability reuse, baseline/adapter/actor binding, envelope consistency, and authentic migration findings were corrected and covered by negative tests.

## Roadmap

### Local demo

Current: Workspace Gate, durable no-effect denial, outbox, capability reservation/consumption, and one-shot fenced claim are working. Next, add the separate receipt spool and reconciliation boundary before connecting one approved effect.

### Hardening

Add idempotent receipt spooling and ingestion, effect-specific crash reconciliation, lease renewal, complete Git baseline, capability policy, macOS sandbox backend, and hostile Git/process fixtures.

### Professional release

Complete provider parity, credential broker, isolated plugin/skill/MCP lifecycle, Git Control Plane, TUI integration, multi-platform matrix, SBOM, signing, notarization, packaging, update and rollback rehearsal.

## Blockers

- No local implementation blocker is active.
- Public fork, push, publication, release, signing, notarization, and deployment require separate product-owner authorization.

## Next executable work

1. Add a separate durable receipt spool with exact idempotency and no delete API.
2. Ingest claim-bound receipts without treating them as verification.
3. Add crash reconciliation and prove that no effect is retried blindly.
4. Connect the approved controlled write only after the complete crash matrix passes.
