# Astra Operation Ledger

This package owns Astra's append-only Operation event ledger. It uses the generic Effect `SqlClient` through OpenCode's Effect Drizzle SQLite adapter, so the runtime remains responsible for selecting and scoping the concrete SQLite file.

The ledger currently supports durable denial and one bounded dispatch lifecycle:

```text
operation.admitted -> policy.ask -> approval.rejected -> denied
operation.admitted -> policy.ask -> approval.granted -> dispatch.requested -> executor.accepted
  -> effect.observed | execution.failed_without_effect | effect.unknown
effect.observed -> verification.started -> verification.passed | verification.failed | verification.unknown
```

## Current guarantees

- Event, global cursor, and projection updates commit in one `IMMEDIATE` transaction.
- `dispatch.requested` and its immutable outbox record commit atomically.
- Approval reserves one globally unique capability. The specialized one-shot claim API consumes that capability with one exact pending request, allocates a monotonic fencing token, and appends `executor.accepted` atomically.
- Exact claim retries are idempotent; competing, mismatched, and expired claims fail closed. Claimed requests are never auto-reclaimed.
- A specialized receipt API accepts only the exact claimed dispatch, capability, fencing token, and adapter. The receipt event, immutable receipt row, and projection commit atomically.
- Receipt observations map to `effect_observed`, `failed`, or `reconciliation_required`; they never imply independent verification.
- A claimed dispatch without a receipt remains active until the exact claim lease expires. Only then can a specialized, claim-bound uncertainty record enter `reconciliation_required`; it cannot synthesize executor timestamps or a receipt.
- Verifier-only internal composition binds the immutable receipt, admitted verification plan, verifier identity, snapshot, criteria, causation, and two verification events in one transaction. The generic `OperationLedger`, root package surface, and generic append path expose no success-producing evidence ingestion.
- Recovery reads distinguish a pending outbox, an accepted claim without a receipt, an ingested receipt, and a claim marked uncertain.
- Storage schema v5 migrates authentic v1-v4 ledgers in place and preserves existing events.
- Bounded event batches commit atomically; a rejected later event rolls back the complete batch.
- Appends compare the expected state and sequence before mutation.
- Event IDs are idempotent only for exact fact replays; divergent reuse fails closed.
- Admission keys are unique across Operations.
- Event digests use deterministic code-unit key ordering and bind the global cursor and previous digest.
- Initialization and every append run a bounded database-wide integrity scan before allowing mutation.
- Reopening the database replays and validates every aggregate, digest chain, projection, and global cursor sequence.
- SQLite is configured with WAL, foreign keys, a busy timeout, and `synchronous=FULL`.
- The public API has bounded reads and no delete operation.

## Deliberate current limits

The database-wide scan currently supports at most 100,000 events and 10,000 Operations. Checkpointed integrity roots and an explicit degraded-state recovery workflow must replace the full scan before those limits can be raised safely.

The 256-event aggregate read bound is fail-closed. Pagination and checkpointed projections must replace it before Operations are allowed to exceed that size.

The current demo uses one attempt only. General retry orchestration, lease renewal, owner-driven reconciliation actions, and multi-attempt aggregate storage remain later increments.
