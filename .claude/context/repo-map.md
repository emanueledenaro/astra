# Repo map & branch topology

Updated: 2026-07-19 (after PR #4 merged the recovered line into the mainline).

## Branches (origin)

- `astra` — protected fork mainline, **now current**: full recovered development line
  (durable kernel, safe-start TUI integration, governed chat/MCP/skills/git-stage,
  git commit slice) plus the round-2 audit fixes, merged via PR #4 (`78e455e`).
  All seven astra packages typecheck clean; cross-platform suites 190/190 green.
- `local-recovery`, `durable-coordinator`, `astra-foundation` — historical lines now
  contained in `astra`; safe to delete after a settling period.
- `claude/project-audit-04u7l4` — audit branch (AUDIT.md + this scaffolding), rebased
  onto the merged mainline.
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
