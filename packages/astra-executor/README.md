# Astra Executor Receipt Spool

This package owns the durable handoff between an executor observation and the Astra Operation ledger. Its SQLite database must be placed in Astra application state, outside every opened workspace and separate from the Operation ledger.

Current guarantees:

- Receipt rows and ingestion acknowledgements are append-only and expose no delete API.
- Receipt IDs, attempts, dispatch requests, and executor claims accept exact replays only.
- An acknowledgement binds one receipt to one exact ledger event ID and digest. The mutation is available only through coordinator-internal composition; the public `ReceiptSpool` can inspect pending and acknowledged history but cannot hide pending work.
- Pending reads are bounded and survive process restart.
- SQLite uses WAL, foreign keys, a busy timeout, and `synchronous=FULL`.
- Receipt insertion and acknowledgement have fault-injection tests proving transaction rollback.

This package does not execute effects, contact providers, initialize extensions, or claim that a receipt is verified. It only preserves typed executor observations until the ledger accepts them.
