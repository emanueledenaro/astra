# Astra Operation Ledger

This package owns Astra's append-only Operation event ledger. It uses the generic Effect `SqlClient` through OpenCode's Effect Drizzle SQLite adapter, so the runtime remains responsible for selecting and scoping the concrete SQLite file.

The first increment supports one durable denial lifecycle:

```text
operation.admitted -> policy.ask -> approval.rejected -> denied
```

## Current guarantees

- Event, global cursor, and projection updates commit in one `IMMEDIATE` transaction.
- Bounded event batches commit atomically; a rejected later event rolls back the complete batch.
- Appends compare the expected state and sequence before mutation.
- Event IDs are idempotent only for exact fact replays; divergent reuse fails closed.
- Admission keys are unique across Operations.
- Event digests use deterministic code-unit key ordering and bind the global cursor and previous digest.
- Initialization and every append run a bounded database-wide integrity scan before allowing mutation.
- Reopening the database replays and validates every aggregate, digest chain, projection, and global cursor sequence.
- SQLite is configured with WAL, foreign keys, a busy timeout, and `synchronous=FULL`.
- The public API has bounded reads and no delete operation.

## Deliberate first-increment limits

The database-wide scan currently supports at most 100,000 events and 10,000 Operations. Checkpointed integrity roots and an explicit degraded-state recovery workflow must replace the full scan before those limits can be raised safely.

The 256-event aggregate read bound is fail-closed. Pagination and checkpointed projections must replace it before Operations are allowed to exceed that size.
