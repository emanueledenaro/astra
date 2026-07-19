# Testing & QA rules

## Running

- `bun test` only from inside a package directory. The repo root blocks it
  (`bunfig.toml` points test root at `do-not-run-tests-from-root`).
- `bun typecheck` from package dirs (`tsgo --noEmit`). Never raw `tsc`.
- End-to-end demo matrix: `bun run --cwd packages/astra-cli verify:demo` — hostile
  fixture, network canary, HOME isolation. Run it after touching gate/preflight/
  controlled-write code.
- Native helper: `tools/astra-git-commit-native/build.sh` builds it;
  `sanitizer-test.sh` runs ASan/UBSan. Required before running astra-git commit tests.

## Writing tests

- Test actual implementation against real fixtures; avoid mocks (AGENTS.md rule).
  The transition-table fixtures in `astra-domain/test/*-transition.fixture.ts` are a
  deliberate exception: an independent oracle for the state topology.
- Security features get **negative-capability tests**: plant hostile content
  (scripts, plugins, hooks, `.env` canaries, symlinks), run the flow, then assert
  zero sentinel files, zero network requests (live canary server), unchanged digests,
  zero persisted state. See `astra-runtime/test/preflight.test.ts` and
  `astra-cli/script/verify-demo.ts` for the pattern.
- Crash seams get fault-injection tests at every window (after claim/before effect,
  after effect/before spool, after spool/before ingest). See
  `astra-runtime/test/controlled-write-coordinator.test.ts`.
- Boundary tests: when a package's public surface changes, update its
  `boundary.test.ts` in the same commit.

## Gates before pushing

- All touched packages: tests green + typecheck clean.
- `git diff --check` passes; changed files pass Prettier.
- Conventional Commit message `type(scope): summary` (types: feat|fix|docs|chore|refactor|test).
