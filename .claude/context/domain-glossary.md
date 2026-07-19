# Astra domain glossary

- **Operation** — a typed, durable unit of risky work. 15 explicit states (9 active,
  6 terminal), ~47 events, 50 transitions (`astra-domain/src/operation.ts`, ADR-0002).
  Semantic UI keys: `PLANNING … EFFECT_OBSERVED, VERIFYING, VERIFIED, FAILED,
  RECONCILIATION_REQUIRED, INCONCLUSIVE`.
- **Workspace trust** — 5-state machine (`UNTRUSTED, PREFLIGHT_BLOCKED,
  AWAITING_DECISION, TRUSTED_ONCE, STALE`). Trust is process-local, never persisted.
- **Workspace Gate** — the terminal UI (Lynx identity) where the user decides
  read-only / activate once / exit for a scanned workspace.
- **Preflight** — bounded static scan of a workspace root: non-recursive, lstat-based,
  symlink-refusing, allowlisted content digests, byte/time budgets. Produces the
  `WorkspaceTrustReport` with a `securityDigest` (bounded-root scope!).
- **Authority file** — private 0600 file in a mkdtemp'd dir binding workspace identity,
  digest, mode, effect policy, and optional Git baseline; the TUI child revalidates it
  (fd-based, digest, freshness) before instance admission.
- **Safe start** — `ASTRA_SAFE_START=1` mode of the inherited opencode runtime:
  synthetic deny-all config, env allowlist, independent guards on provider/VCS/MCP/
  shell/write paths. The child TUI always runs in safe start.
- **Operation kernel / ledger** — append-only SQLite event log with per-event hash
  chain, CAS'd projections, dispatch outbox, one-shot capability claims with fencing
  tokens, receipts, uncertainty records (`astra-ledger`).
- **Capability manifest/digest** — canonical JSON covering executable identity
  (path/dev/ino/sha256), program, arguments, cwd, stdin, workspace identity,
  create-only targets, env allowlist, limits, isolation boundary. The approved effect
  is bound to exactly this digest.
- **Receipt / spool** — the executor's outcome record, written to a separate SQLite
  spool first, then ingested into the ledger under ~15 binding checks
  (`astra-executor/src/spool.ts`).
- **Verifier** — the only actor that can append evidence and reach `VERIFIED`;
  requires byte-exact independent re-observation. Exit code 0 yields at most
  `completed_observed_not_verified`.
- **Reconciliation required** — honest "we don't know" terminal-ish state after
  ambiguity (missing/late receipt, ref race, expired lease). Never auto-retried.
- **Git baseline / observer** — read-only Git inspection through a sealed Apple git
  under macOS Seatbelt; binds refs, index, tracked/untracked bytes into one digest.
  `Activate once` requires a current baseline.
- **Git Control Plane** — governed Git mutations (stage/unstage implemented; local
  commit WIP via `astra-git/src/commit.ts` + native helper with pinned-FD authority).
- **Credential broker** — parent-only, in-memory, one-shot opaque grants (`cred_…`);
  raw keys cross only the private transport edge, never the child or the model.
- **HOST EXECUTION — NO SANDBOX** — mandatory truthful label for host effects;
  the dormant Seatbelt sandbox (`astra-sandbox`) is preserved but not wired.
- **Lynx** — the mascot/identity. v1 pixel-art pack is archived; v2 direction is a
  professionally illustrated animated mascot (see docs/astra/lynx + pending task).
