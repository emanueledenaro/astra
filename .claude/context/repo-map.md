# Repo map & branch topology

Updated: 2026-07-19 evening (after PR #4, #5, #6 merged).

## Branches (origin)

- `astra` — protected fork mainline, fully current: recovered line + audit fixes
  (PR #4), the product slices — governed git commit in the TUI, read-only
  operation/evidence/recovery views, consented multi-turn chat, Lynx v2 illustrated
  identity (PR #5) — and the docs/CI alignment (PR #6). All eight packages (astra-*
  plus tui) typecheck clean; Linux-green suites: domain 119, ledger 54, executor 8,
  sandbox 12, TUI astra 128 — zero failures; macOS surfaces fail closed pending the
  owner-side re-verification (docs/astra/macos-verification.md).
- `local-recovery`, `durable-coordinator`, `astra-foundation`, `product-slices`,
  `docs-alignment` — historical/merged lines contained in `astra`; deletable.
- `claude/project-audit-04u7l4` — audit branch (AUDIT.md + this scaffolding).
- Hundreds of `origin/*` branches/tags are upstream opencode noise accidentally pushed
  by `git push --all`; cleanup pending (owner task — bulk deletion needs human hands).

## Where things live

- New product code: `packages/astra-*`, `packages/tui/src/astra/`,
  `packages/tui/src/feature-plugins/system/astra-*.tsx`,
  `tools/astra-git-commit-native/`, `tools/astra-extension-inventory-native/`.
- Truthful checkpoint state: `docs/astra/STATUS.md` (verify claims against code — the
  round-2 audit found them accurate but partially stale vs the tree).
- Provenance: `UPSTREAM.md` (baseline commit `453b61e`; tag `opencode-baseline-453b61e`
  exists on origin). The `upstream` remote is per-machine config — not present in
  every checkout.
- Latest audit: `AUDIT.md` (root). Known open defects from it: 3 type errors in the
  recovered slice, packed-refs commit failure (M1), recovery liveness wedges (kernel
  M-1/M-3), fencing-at-resource gap (M-2), preflight `O_NOFOLLOW` minor.

## Environment gotchas

- Full `bun install` needs GitHub tarball access (`ghostty-web` dep of `packages/app`);
  in restricted environments remove that dep locally or install with
  `--ignore-scripts` and link `@astra/*` manually.
- CI workflows are still pinned to a nonexistent `dev` branch and turbo has no `test`
  task for astra packages — wiring CI is a known open task.
- macOS-only surfaces: Seatbelt observers, native helpers, the product demo itself.
