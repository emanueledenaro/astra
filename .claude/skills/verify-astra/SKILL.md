---
name: verify-astra
description: Run the full Astra verification gate (tests + typecheck per package + demo matrix). Use after changing any astra-* package or before pushing.
---

Run the complete Astra verification gate and report a single pass/fail table:

1. For each package in `packages/astra-*` (skip `astra-sandbox` unless asked — it is
   the dormant prototype, excluded from the working-product gate):
   run `bun test` and `bun typecheck` from inside the package directory.
2. Run the end-to-end demo matrix: `bun run --cwd packages/astra-cli verify:demo`.
3. If `tools/astra-git-commit-native` sources changed in the working diff, build with
   `./build.sh` and run `./sanitizer-test.sh` before the astra-git tests.
4. Compare the resulting counts with `docs/astra/STATUS.md` "Latest integration
   evidence" and flag drift (stale STATUS numbers are a known issue — report, don't
   silently accept).

Never run `bun test` from the repo root. Report failures with the exact failing
package, test name, and output — no summarizing away of red tests.
