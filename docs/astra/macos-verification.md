# macOS verification checklist (owner-side handoff)

The 2026-07-19 consolidation was verified on Linux, where every macOS-only surface
fails closed by design. This checklist re-verifies those surfaces on a real Mac.
Run from a fresh `git checkout astra && git pull`.

## 1. Toolchain and install

```bash
bun --version          # STATUS baseline was 1.3.14
bun install            # full workspace install (needs GitHub tarball access)
```

## 2. Native helpers

```bash
cd tools/astra-git-commit-native && ./build.sh && ./sanitizer-test.sh && cd -
cd tools/astra-extension-inventory-native && ./build.sh && cd -
```

## 3. Package suites (each from its own directory: `bun test && bun typecheck`)

Expected: astra-domain, astra-ledger, astra-executor, astra-sandbox green everywhere;
astra-git, astra-runtime, astra-cli must now be green **including** the platform-gated
suites that fail on Linux. Pay attention to:

- `astra-git/test/commit.test.ts` — includes the new packed-refs prepare block
  ("blocks a packed branch ref before any object computation").
- `astra-runtime/test/host-command.test.ts` — includes the three new recovery
  fault-injection tests (batch/claim crash, stalled clock, poisoned spool receipt).
- `astra-cli/test/git-commit-control.test.ts` — deny/approve/verified paths run for
  real here (they only prove fail-closed behavior on Linux).
- `packages/tui` — full suite, not just the astra subset.

## 4. End-to-end demo matrix

```bash
bun run --cwd packages/astra-cli verify:demo
```

Expected: hostile read-only open with zero effects, durable denial without dispatch,
one approved create-only effect reaching independent verification, zero network canary
hits, zero persisted trust.

## 5. Product smoke (real TTY)

```bash
astra system        # inert System Mode; Q exits; no state created
astra .             # gate → G (git baseline) → A (activate once) → /git → stage, commit
```

For the commit flow: set `ASTRA_GIT_AUTHOR_NAME` / `ASTRA_GIT_AUTHOR_EMAIL` first
(missing identity fails closed as `identity_required`). Confirm the preview shows
`HOST EXECUTION — NO SANDBOX`, every repository write, and that `VERIFIED` appears
only after the readback. Then `/operations` should show the operation with its events
and receipt. Also run one multi-turn chat exchange and confirm each turn asks its own
approval and the preview reports history bytes.

## 6. Report back

Update `docs/astra/STATUS.md` "Latest integration evidence" with the real counts, or
record failures verbatim — a red suite here is information, not something to massage.
