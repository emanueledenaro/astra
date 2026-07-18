# Astra Project Audit — 2026-07-18

Independent audit of the repository state after the initial foundation work (commits `ee661ea` and `8fafb9f`, 2026-07-17). Method: full read of the three `astra-*` packages (~2,800 new lines), docs/spec provenance review, monorepo integration review, and empirical verification (tests, demo matrix, typecheck) executed in an isolated environment.

## Executive summary

The project is in **good foundational shape**. Astra is a fork of opencode (baseline `453b61e`) with exactly two commits of new work adding three cleanly layered packages: `@astra/domain` (pure state machines), `@astra/runtime` (bounded preflight + controlled write), `@astra/cli` (demo gate). The code is coherent, deliberately written, strict, and its headline security claims **hold up against the code and against adversarial tests**. All 50 tests pass, the `verify:demo` negative/positive matrix passes, and all three packages typecheck clean.

The real gaps are not in the code: they are **(1) zero CI coverage for the new packages**, **(2) provenance documentation that overstates reality** (missing ADR-0002, missing baseline tag, missing `upstream` remote), and **(3) a handful of semantic-fidelity defects** in the audit-trail/naming layer — significant for a project whose entire value proposition is audit-trail fidelity.

## Verification results (executed during this audit)

| Check | Result |
|---|---|
| `bun test` in `packages/astra-domain` | 26 pass / 0 fail (1,861 assertions) |
| `bun test` in `packages/astra-runtime` | 13 pass / 0 fail |
| `bun test` in `packages/astra-cli` | 11 pass / 0 fail |
| `bun run verify:demo` (hostile fixture, network canary, HOME isolation) | **DEMO MATRIX PASS** — zero effects read-only, zero effects on deny, one verified create-only marker on approve, zero network requests, zero persisted state |
| `tsgo --noEmit` in all three packages | Clean, zero errors |
| Root `bun install` | **Fails** — upstream dependency `ghostty-web` (GitHub tarball) unreachable in this environment; unrelated to the astra packages. Workspace links for `@astra/*` were created manually to run the checks above. |

## Security claims — verified against code

All README claims for the demo slice are real, not aspirational:

- **Bounded static preflight**: single non-recursive `opendir` capped at `maxEntries`, `lstat` only, symlinks recorded via `readlink` but never followed, content read only for a fixed root-file allowlist under per-file and total byte budgets, root-is-symlink rejected, fail-closed on any anomaly (`workspace-preflight.ts`).
- **No execution of repository-controlled code, no network**: zero `child_process`/`spawn`/`fetch`/net imports in any `astra-*/src`; tests plant malicious `package.json` scripts, an opencode plugin, `.mcp.json`, and git hooks, and assert zero sentinel files and zero canary-server requests. `preflight-boundary.test.ts` additionally bundles the module and inspects the import graph — a structural guarantee.
- **No persistent trust**: trust exists only as the in-memory `TRUSTED_ONCE` state, cleared on `process.ended`; `verify-demo.ts` asserts the redirected `HOME` stays empty.
- **Second approval + create-only write**: literal `APPROVE` required; write path is a compile-time constant filename opened with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`, with fsync + readback + dev/ino cross-check before `VERIFIED`. A post-create swap degrades to `effect_observed_unverified`, never a false `VERIFIED`.
- **15 explicit states**: `operation.ts` has exactly 15 states (9 active, 6 terminal), ~47 events, 50 transitions; `EFFECT_OBSERVED` and `VERIFIED` are genuinely distinct in both domain and CLI output.

## Findings

### A. Code quality (new packages)

**Major**

1. **Audit-trail infidelity in the gate**: every `prepareControlledWrite` failure reason (`target_already_exists`, `security_digest_changed`, `identity_changed`, …) is recorded as the single domain event `dispatch.proved_unclaimed` (`astra-cli/src/workspace-gate.ts:87`), which semantically means "proved no executor claimed the dispatch" — false for most of those causes. The domain lacks a "preparation refused" event. The printed human-readable reason is correct; the recorded state-machine event is not.
2. **`securityDigest`/"snapshot" naming overpromises**: the digest covers root-level entry metadata plus a few allowlisted root files' contents only. Nested file contents (`.opencode/plugins/*`, `.git/hooks/*`) are not covered, so `revalidateWorkspaceSnapshot` can report `matched: true` after a nested file was rewritten. Not exploitable today (nothing nested is ever executed or read), but unsound if any future feature gates real activation on this digest. Rename or document the bounded scope at the type level before reuse.

**Minor**

3. Preflight content open lacks `O_NOFOLLOW`/`O_NONBLOCK` (`workspace-preflight.ts:202`): an lstat→open FIFO swap can hang the scan (local DoS only; the post-open dev/ino check prevents misattribution). Inconsistent with `controlled-write.ts`, which does it right.
4. `digestBoundedFile` change-during-read check compares size/dev/ino but omits `mtimeMs`/`ctimeMs` (`workspace-preflight.ts:221`), so a size-preserving in-place edit during a scan is not flagged (caught only on next revalidation).
5. Total-byte-budget exhaustion is mislabeled as `file_byte_limit_exceeded`; `maxFileBytes`/`maxTotalBytes` have no upper bound in `validLimits` (large caller override → large allocation).
6. Interactive prompt loop is not robust to stdin EOF (`terminal-io.ts:20`) — unreachable in scripted paths, but the interactive binary can spin.
7. "Independently read back" wording: the production path reads back through the same write fd (sound, arguably stronger); the truly independent `verifyControlledWrite` is test-only. Align wording or wire the independent verifier.

**Informational**

- Large unused domain surface: the reconciliation/probe/recovery/lease vocabulary (~half of the 50 transitions) has unit tests but no runtime caller. Over-built relative to the demo, but consistently so and honestly disclaimed.
- The "independent" transition fixtures duplicate the same tables, so they guard against accidental edits, not wrong design.
- The no-import purity guard covers `workspace-trust.ts` only; `operation.ts` is equally pure but unguarded against regression.
- No TODO/FIXME/HACK/`@ts-ignore` markers anywhere; no half-finished stubs. Style matches the repo's AGENTS.md guide throughout.

### B. Monorepo integration & CI

**High**

1. **Astra tests never run in CI**: `turbo.json` has no generic `test` task, only a per-package allowlist (`opencode#test`, `@opencode-ai/core#test`, …) that does not include the astra packages — `bun turbo test` (what `test.yml` runs) skips them entirely.
2. **Push CI never fires on this fork**: every build/test/typecheck workflow triggers on `push: branches: [dev]`, and no `dev` branch exists (development is on `astra`). PR typecheck is also pinned to `dev`. Net: the new code has no automated CI at all. The only safety net is the local husky pre-push `bun typecheck`.

**Medium**

3. Inherited scheduled automations (`beta.yml` hourly publish, `close-issues`, `compliance-close` every 30 min, discord/PR bots) will run on the fork's default branch and fail or misbehave without upstream secrets — noise and risk.

**Low**

4. Astra tsconfigs do not extend the shared `@tsconfig/*` base (inline options are internally consistent and stricter than siblings).
5. Root `package.json` still identifies as `name: "opencode"` with anomalyco repository URL — rebrand incomplete.
6. `verify-demo.ts` and one test reach into `astra-runtime/test/support` via relative `../../` path, bypassing the package boundary.
7. Upstream-inherited clutter: triplicated `"options"` key in `.oxlintrc.json`, `screenshot-uk.png` at root, `artifacts/glm52-rise-video/` (all pre-baseline, not fork-added).

What works: `packages/*` workspace glob picks the packages up, catalog deps resolve, `bun.lock` is correctly updated, `bun turbo typecheck` covers them, formatting matches prettier/editorconfig, and isolation from the opencode packages is complete in both directions (by design).

### C. Documentation & provenance

1. **ADR-0002 is cited but absent**: `astra-domain/README.md`, tests, and fixtures all reference ADR-0002 as the canonical source of the 15-state topology; no ADR file exists anywhere in the repo.
2. **UPSTREAM.md makes two false claims about the local repo**: the baseline tag `opencode-baseline-453b61e` does not exist (no tags at all), and the "fetch-only `upstream` remote with disabled push" does not exist (only `origin` is configured). The baseline commit itself is accurate; UPSTREAM.md's own caveat partially hedges this, but the specific statements do not match reality — and there is currently no configured mechanism to pull upstream updates.
3. **AGENTS.md says the default branch is `dev`** — inherited from opencode, contradicts the actual `astra` branch and UPSTREAM.md itself.
4. `CONTEXT.md` and `specs/` are entirely inherited opencode content (V2 session runtime); there is no dedicated Astra roadmap document — the vision (Git Control Plane, Codex-compatible skills/plugins, animated Lynx, reproducible-source gate) exists only as scattered README sentences, none of it in code.
5. Minor: README demo command hides the `open` subcommand (`demo -- /path` resolves to `open -- /path`).

## Test quality assessment

Strong. Tests exercise real behavior (no mocks), include genuine adversarial fixtures (malicious scripts/plugins/hooks/symlinks/`.env` secret), a live network canary, byte-identical before/after workspace digests, and a bundle-graph negative-capability check. Gaps: `verify-demo.ts` isolates `HOME`/`TMPDIR` but not `XDG_*`; the planted `ASTRA_CANARY_SECRET` is never asserted absent from stdout; `verify:demo` is a script outside `bun test`, so CI must invoke it explicitly.

## Recommended actions (priority order)

1. **Wire CI** — add the astra packages to the turbo `test` pipeline (or add a generic `test` task), retarget workflow triggers from `dev` to `astra`, and disable/remove the inherited scheduled automations that cannot work on the fork.
2. **Commit ADR-0002** and fix UPSTREAM.md: either create the baseline tag + fetch-only `upstream` remote as documented, or amend the doc to describe the actual state.
3. **Fix the audit-trail defect** (finding A.1): introduce a "preparation refused" domain event instead of overloading `dispatch.proved_unclaimed`.
4. **Rename or scope-document `securityDigest`/snapshot** (finding A.2) before any future feature relies on it.
5. Hardening minors: `O_NOFOLLOW` on preflight content opens, mtime in the change-during-read check, upper bounds in `validLimits`, EOF-robust prompt loop.
6. Test gaps: assert the canary secret never reaches stdout; isolate `XDG_*` in `verify-demo.ts`; add a purity guard for `operation.ts`.
7. Housekeeping: extend shared tsconfig base, rebrand root `package.json`, update AGENTS.md default-branch note, export the test support module instead of `../../` imports.
