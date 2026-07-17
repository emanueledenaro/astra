# Astra Delivery Status

Updated: 2026-07-17

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Canonical repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Branch: `astra`
- Latest implementation checkpoint: `9c818ac3e` (`fix(astra): block unsafe Git activation`)
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
- A separate append-only executor spool now preserves immutable receipts across process and database reopen.
- Receipt ingestion binds the Operation, attempt, dispatch request, executor claim, capability, fencing token, adapter, admitted effect class, resources, and timing before atomically appending the observed outcome.
- Recovery distinguishes a pending outbox, a claimed Operation without a receipt, and an ingested receipt. Exact receipt replay is idempotent; divergent replay fails closed.
- Storage schema v4 migrates an authentic v1 denial ledger without losing its events.
- Static preflight recognizes `.git` directories, files, symlinks, case variants, physical repository ancestors, and repository ancestry reached through intermediate symlinks without executing Git or traversing Git contents.
- Git workspaces remain readable but cannot activate or reach the demo effect until a complete Git baseline exists. The controlled write revalidates this guard again at the effect boundary.

## Honest limits

- The approved controlled write still uses the Phase D in-memory path. It is not connected to the durable ledger yet.
- The durable outbox, capability reservation/consumption, executor claim, receipt spool, and receipt ingestion are implemented but deliberately not connected to the CLI effect executor yet.
- The current CLI `VERIFIED` label comes from same-process exact readback in the Phase D adapter. It is not yet the independent durable verifier required by the final Operation contract and will be replaced by the next coordinator increment.
- Recovery across receipt spool and ledger is implemented. Crash reconciliation for an effect that occurred before a receipt was durably spooled, lease renewal, cancellation, and independent verification are not yet implemented.
- `HOST EXECUTION — NO SANDBOX` is accurate: the positive demo effect is a direct, bounded host write.
- Git workspaces are restricted to the bounded read-only report until Astra can capture a complete Git baseline; no non-Git baseline is invented.
- Trust is process-local and never persisted in this increment.
- Provider, plugin, skill, and MCP compatibility is preserved structurally but not yet activated behind Astra trust and isolation.

## Verification evidence

- Exact toolchain: Bun `1.3.14`; frozen install succeeds without lockfile changes.
- Domain: 38 tests, 1,924 assertions; typecheck passes.
- Executor: 5 tests, 18 assertions; typecheck passes.
- Ledger: 37 tests, 146 assertions; typecheck passes.
- Runtime: 26 tests, 99 assertions; both strict runtime and isolated SQLite-adapter typechecks pass.
- CLI: 20 tests, 114 assertions; typecheck passes.
- Total: 126 tests and 2,301 assertions.
- Scoped Oxlint: 0 warnings, 0 errors. Prettier check passes.
- Real demo matrix passes: malicious read-only fixture, durable denial, approved create-only write, exact SHA-256 readback, and zero network-canary requests.
- The receipt-recovery review found no blocker. It recorded one coordinator invariant: only the coordinator may acknowledge a spooled receipt after exact ledger ingestion.
- The Git-preflight review found four P1 bypasses involving nested repositories, case-variant metadata, late Git creation, and physical ancestry through symlinks. All four were corrected, covered by negative tests, and independently rechecked with no blocker remaining.

## Roadmap

### Local demo

Current: Workspace Gate, durable no-effect denial, outbox, capability reservation/consumption, one-shot fenced claim, receipt spool, receipt ingestion, and fail-closed Git activation guard are working. Next, connect one approved controlled effect through the complete durable coordinator and independent verifier.

### Hardening

Add effect-specific crash reconciliation, lease renewal, complete Git baseline, capability policy, macOS sandbox backend, and hostile Git/process fixtures.

### Professional release

Complete provider parity, credential broker, isolated plugin/skill/MCP lifecycle, Git Control Plane, TUI integration, multi-platform matrix, SBOM, signing, notarization, packaging, update and rollback rehearsal.

## Blockers

- No local implementation blocker is active.
- Public fork, push, publication, release, signing, notarization, and deployment require separate product-owner authorization.

## Next executable work

1. Add the durable coordinator for approval, dispatch, claim, effect, receipt spooling, ledger ingestion, and acknowledgement.
2. Add crash points around the effect and prove that uncertain effects are never retried blindly.
3. Add a separate verifier that alone may append `verification.passed` and emit `VERIFIED`.
4. Connect the approved CLI path only after the coordinator crash matrix passes.
5. Implement the isolated read-only Git baseline adapter before enabling Git activation.
