# Astra Operation Ledger

This package owns Astra's append-only Operation event ledger. It uses the generic Effect `SqlClient` through OpenCode's Effect Drizzle SQLite adapter, so the runtime remains responsible for selecting and scoping the concrete SQLite file.

The ledger currently supports durable denial and one bounded dispatch lifecycle:

```text
operation.admitted -> policy.ask -> approval.rejected -> denied
operation.admitted -> policy.ask -> approval.granted -> dispatch.requested -> executor.accepted
```

## Current guarantees

- Event, global cursor, and projection updates commit in one `IMMEDIATE` transaction.
- `dispatch.requested` and its immutable outbox record commit atomically.
- Approval reserves one globally unique capability. The specialized one-shot claim API consumes that capability with one exact pending request, allocates a monotonic fencing token, and appends `executor.accepted` atomically.
- Exact claim retries are idempotent; competing, mismatched, and expired claims fail closed. Claimed requests are never auto-reclaimed.
- Storage schema v3 migrates authentic v1 ledgers in place and preserves existing denial events.
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

The outbox and claim are not connected to an effect executor. Receipt spooling, effect execution, lease renewal, reconciliation, and CLI integration remain later increments.
