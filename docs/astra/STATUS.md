# Astra Delivery Status

Updated: 2026-07-17

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Canonical repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Branch: `astra`
- Latest implementation checkpoint: `0dd1b814e` (`feat(astra): persist denied operations from workspace gate`)
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

## Honest limits

- The approved controlled write still uses the Phase D in-memory path. It is not connected to the durable ledger yet.
- Durable dispatch, outbox, executor claim, fencing, receipt spool, crash recovery, and reconciliation are not implemented.
- `HOST EXECUTION — NO SANDBOX` is accurate: the positive demo effect is a direct, bounded host write.
- Git workspaces are refused by the denial recorder until Astra can capture a complete Git baseline; no non-Git baseline is invented.
- Trust is process-local and never persisted in this increment.
- Provider, plugin, skill, and MCP compatibility is preserved structurally but not yet activated behind Astra trust and isolation.

## Verification evidence

- Exact toolchain: Bun `1.3.14`; frozen install succeeds without lockfile changes.
- Domain: 37 tests, 1,916 assertions; typecheck passes.
- Ledger: 15 tests, 44 assertions; typecheck passes.
- Runtime: 17 tests, 68 assertions; both strict runtime and isolated SQLite-adapter typechecks pass.
- CLI: 15 tests, 79 assertions; typecheck passes.
- Total: 84 tests and 2,107 assertions.
- Scoped Oxlint: 0 warnings, 0 errors. Prettier check passes.
- Real demo matrix passes: malicious read-only fixture, durable denial, approved create-only write, exact SHA-256 readback, and zero network-canary requests.
- One independent review found no P0. Its atomicity, timestamp, read-only, path-containment, typecheck-isolation, and projection-identity findings were corrected and covered by tests.

## Roadmap

### Local demo

Current: Workspace Gate and durable no-effect denial are working. Next, connect one approved operation only after the durable outbox and receipt boundary exists.

### Hardening

Add crash-point tests, outbox claim with lease and fencing token, idempotent receipt spool, reconciliation, complete Git baseline, capability policy, macOS sandbox backend, and hostile Git/process fixtures.

### Professional release

Complete provider parity, credential broker, isolated plugin/skill/MCP lifecycle, Git Control Plane, TUI integration, multi-platform matrix, SBOM, signing, notarization, packaging, update and rollback rehearsal.

## Blockers

- No local implementation blocker is active.
- Public fork, push, publication, release, signing, notarization, and deployment require separate product-owner authorization.

## Next executable work

1. Add a durable outbox transition before any executor contact.
2. Add one-shot executor claim with lease and fencing token.
3. Add a durable receipt spool and crash reconciliation.
4. Connect the approved controlled write only after the no-blind-retry tests pass.
