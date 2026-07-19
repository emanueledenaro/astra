# Runbook

## Run the demo slice (macOS)

```bash
bun run --cwd packages/astra-cli demo -- /absolute/path/to/workspace   # gate flow
bun run --cwd packages/astra-cli verify:demo                            # full matrix
```

`astra .` / `astra /path` / `astra system` are the product entrypoints on the
integrated branches (`durable-coordinator`+).

## Verify a package

```bash
cd packages/<name> && bun test && bun typecheck
```

## Build the native git helper (needed for astra-git commit tests)

```bash
cd tools/astra-git-commit-native && ./build.sh && ./sanitizer-test.sh
```

## Inspect a ledger (durable operations)

The ledger and receipt spool are separate SQLite families stored outside the
workspace. They are append-only by contract — never UPDATE/DELETE rows by hand; a
manual edit breaks the per-event hash chain and every subsequent integrity scan.
For diagnosis, open read-only copies. Recovery states: `pending_outbox`,
`claimed_no_receipt`, `receipt_ingested`, `claim_uncertain` (see
`astra-ledger/src/ledger.ts` `decodeDispatchSnapshot`).

## Upstream sync (policy)

`UPSTREAM.md` defines the contract: fetch-only `upstream` remote (configure per
machine: `git remote add upstream https://github.com/anomalyco/opencode.git` and
disable its push URL), baseline tag `opencode-baseline-453b61e`. Never push to
upstream. Intake workflow/drift gates are roadmap work — do ad-hoc merges only with
product-owner approval.

## When something reports reconciliation_required

That is the honest "unknown" state, not an error to retry. Read the operation's
events + receipt/uncertainty records first; a blind re-run is exactly what the
kernel exists to prevent.
