# Repo map & branch topology

Updated: 2026-07-19 (during the round-2 audit).

## Branches (origin)

- `astra` — protected fork mainline. **Currently far behind**: holds only the first
  2 foundation commits (`ee661ea`, `8fafb9f`).
- `astra-foundation` — +10 commits: durable denial ledger, dispatch claims, receipt
  recovery, command-contract docs.
- `durable-coordinator` — the real integration line: +55 commits over `astra-foundation`
  (safe-start TUI integration, provider credential broker, governed chat/MCP/skills,
  git stage/unstage, Lynx, docs/astra/STATUS.md + ROADMAP.md).
- `local-recovery` — `durable-coordinator` + commit `b0fd520` "chore: recover local
  work": the recovered in-flight Git commit slice (git-commit-mutation, astra-git
  commit.ts, coordinator, native C helper, ADR-0002). **Does not typecheck** (3 known
  errors) — recovered mid-flight, preserved intentionally with `--no-verify`.
- `claude/project-audit-04u7l4` — audit branch (AUDIT.md + this scaffolding).
- Hundreds of `origin/*` branches/tags are upstream opencode noise accidentally pushed
  by `git push --all`; cleanup pending. Ignore them.

Consolidation plan: PR `local-recovery` → `astra` (protected branch requires a PR),
after fixing the 3 type errors. Then delete the noise branches.

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
