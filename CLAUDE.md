# Astra — Claude Code guide

Astra is a predictable, security-first AI development system built as a fork of
[opencode](https://github.com/anomalyco/opencode) (baseline `453b61e`, see `UPSTREAM.md`).
Core idea: the developer can always see what the AI intends to do, with which authority,
what changed, what was independently verified, what remains uncertain, and how to recover.

**`AGENTS.md` is the authoritative engineering rulebook** (Astra rules, opencode style
guide, commit/branch conventions, SDK regeneration). Read it before writing code.
This file adds Claude-specific navigation; `.claude/rules/` splits the load-bearing
rules by topic; `.claude/context/` holds durable project knowledge.

## Layout

- `packages/astra-domain` — pure state machines and typed facts (no fs/process/network).
- `packages/astra-runtime` — preflight, controlled writes, host execution, coordinators.
- `packages/astra-ledger` — append-only SQLite operation ledger, claims, receipts.
- `packages/astra-executor` — durable receipt spool (NOT the process executor).
- `packages/astra-git` — governed Git observation and mutations (+ native C helper in
  `tools/astra-git-commit-native`).
- `packages/astra-sandbox` — dormant macOS Seatbelt prototype (do not wire up).
- `packages/astra-cli` — `astra` entrypoint: Workspace Gate, TUI launcher, control servers.
- `packages/tui/src/astra/` + `packages/tui/src/feature-plugins/system/astra-*` — Astra TUI.
- Everything else under `packages/` is inherited opencode; touch it only with surgical
  `ASTRA_SAFE_START` guards or as AGENTS.md allows.
- `docs/astra/` — STATUS.md (checkpoint truth), ROADMAP.md, Lynx assets docs.
- `docs/adr/` — architecture decision records (ADR-0002 = Operation topology).

## Commands

- Tests: `bun test` from inside a package dir — NEVER from the repo root.
- Typecheck: `bun typecheck` from a package dir (runs `tsgo --noEmit`); never raw `tsc`.
- Demo matrix: `bun run --cwd packages/astra-cli verify:demo`.
- Full monorepo install: `bun install` at root (network-heavy; needs GitHub tarball access).

## Non-negotiable invariants (see .claude/rules/security-invariants.md)

1. Opening an unknown workspace never executes workspace-controlled content.
2. An observed effect is never reported as verified success; `VERIFIED` requires
   independent evidence. Ambiguity becomes `reconciliation_required`/`inconclusive`.
3. Denial produces no effect. Fail closed, always.
4. Host execution is always labelled `HOST EXECUTION — NO SANDBOX`; never claim
   isolation that the OS does not enforce.
5. Push, publication, release, signing, deploy: only with explicit product-owner approval.

## Current state

See `.claude/context/repo-map.md` for branch topology and where the real work lives,
and `AUDIT.md` for the latest full project audit.
