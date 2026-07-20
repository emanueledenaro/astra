# Astra Project Audit

## Round 3 — 2026-07-20 (macOS verification + the cockpit line)

**Context.** After the 2026-07-19 consolidation (PR #4–#7), the owner-side macOS
verification ran and was merged (PR #8), and two new lines appeared:
`astra-cockpit` (66 commits, ~27k lines: Launchpad/Control Center/cockpit TUI,
OpenAI + Codex-OAuth providers, durable work-session store with resume, governed
explicit shell, defect fixes) and `claude/slack-session-2jmcli` (1 commit:
deterministic host-command allowlist policy).

### macOS verification (merged, PR #8)

Honest and valuable. Green: install, both native helpers under sanitizers, domain
119/0, runtime 207/0, TUI 297/0, `verify:demo` PASS, and the real product flows —
stage and commit both reached `VERIFIED` on a real PTY. Real defects found:
(a) commit message truncated to "oke" in the PTY; (b) control socket path over the
104-byte Unix limit on macOS; (c) missing `effect`/`@effect/sql-sqlite-bun` deps in
astra-cli tests; (d) ledger concurrent-writer WAL race (`SQLITE_BUSY_RECOVERY`);
(e) a git adapter test race. Chat untested only for lack of an Anthropic credential.

### astra-cockpit — provider/credential/transport audit

**No critical findings; all five security invariants upheld.** Verified clean:
credentials read-only from the opencode store, never persisted/refreshed by Astra,
never in child/preview/ledger/logs; broker one-shot discipline intact; preview→wire
TOCTOU closed (digests re-checked at send); OpenAI/Codex egress rides the same
pinned DNS/TLS transport (exactly two new frozen origins); streams bounded with
truncation-cannot-become-success framing checks; conversation persistence honestly
relabeled (`PARENT-OWNED DURABLE — VERIFIED ON LOAD`), 0600, hash-chained, outside
the workspace; resume never auto-fires a turn; per-turn consent strengthened (A/D
active only while the full preview is on screen). **Major (blocking):** Codex
responses over ~64 KiB are destroyed by the 64 KiB history cap vs the 1 MiB parser
bound — honest `reconciliation_required`, but it discards paid responses on the new
provider's happy path. Minor: `response.done` accepted without inner status check;
deadline expiry mislabeled as `response_framing_rejected`; catalog `sourceURL`
overstates provenance; child-triggerable exit-86 connect handoff (parent-owned
prompt, social-engineering surface only); Codex requests impersonate the opencode
client to chatgpt.com (`originator: opencode`) — a ToS/product-owner question.

### astra-cockpit — TUI/fixes audit

Fixed properly: (c) deps declared; (d) real fix (`busy_timeout` before WAL
conversion + honest test stabilization, assertions unweakened); (e) test timeout
raise plus a real product fix for the same-session `baseline_stale` defect
(parent-owned git session authority advancing only to independently verified
snapshots, with regression tests). Deny-all child preserved (no new env, no new
capability access, shell approve/reject deliberately not dispatchable commands);
prompt lock intact; labels truthful throughout (`METADATA ONLY`, `NOT VERIFIED`
literal types, `HOST FILESYSTEM/NETWORK UNRESTRICTED`); opencode touches surgical
(one guarded line + astra-* files). **Open findings:** P1 — (b) socket-path defect
NOT fixed in production (only a test prefix was shortened; product can still fail
to launch on long macOS temp dirs, fail-closed); P1 evidence integrity — the two
audit screenshots in the tip commit are byte-identical (the open-workspace evidence
is a duplicate of the launchpad image); P2 — the recorded "no P0/P1 remains open"
review predates three substantive tip commits; P2 — (a) "oke" truncation fix is
plausible (single-process TTY ownership) but root cause was never proven and no
PTY regression test types a long message.

### claude/slack-session-2jmcli

Sound, invariant-aligned (deterministic policy grants authority; model proposes),
well-tested, currently dormant (no caller). **Conflicts with the cockpit line** —
both rewrite `host-command.ts` incompatibly; must be rebased onto the cockpit's
request/preview shapes, not merged mechanically.

### Repo/process findings

- **GitHub Actions has never executed on the fork** — only Copilot review runs
  exist. The workflows are correctly wired since PR #6; Actions itself appears
  disabled (fork default). Owner action: enable Actions in repository settings.
- 992 upstream noise branches + ~1075 tags still pending owner deletion.
- Session-side pending work (uncommitted, in the session worktree): the completed
  and verified full-coverage operation-list slice (ledger `listOperations`), and
  two partial slices (MCP tool invocation, git branch create) interrupted by
  session limits. All three overlap files the cockpit rewrites.

### Recommended order

1. Codex fixes on `astra-cockpit`: the 64 KiB Codex response cap, the production
   socket-path fallback, replace the duplicate screenshot, re-run or re-scope the
   final review over the tip commits, add a PTY commit-message regression test.
2. Merge `astra-cockpit` (it is close: disciplined, invariant-respecting).
3. Rebase and land the session-side full-coverage views slice; resume the MCP tool
   and branch-create slices on the new base.
4. Rebase `claude/slack-session-2jmcli` onto the cockpit host-command shapes.
5. Owner: enable GitHub Actions; delete the noise branches/tags.

## Round 2 — 2026-07-19 (after local-work recovery)

**Context.** After round 1, ~65 commits of local work were recovered from the original
development machine and pushed: `astra-foundation` (+10), `durable-coordinator` (+55),
`local-recovery` (= coordinator + one recovery commit with in-flight work). Total new
surface: ~91k lines across 383 files, including packages `astra-git`, `astra-ledger`,
`astra-executor`, `astra-sandbox`, the safe-start TUI integration, `docs/astra/STATUS.md`
+ `ROADMAP.md`, and `docs/adr/ADR-0002`. Round 1's "the house is yet to be built"
assessment is superseded: the house is half-built, and well.

**Verdict.** Three deep audits (durable kernel; safe-start integration; recovered Git
commit slice) found no integrity-breaking defect. STATUS.md's substantive claims are
accurate against the code (its test counts are stale — the tree is ahead of the doc).

### Kernel (astra-ledger / astra-executor / astra-runtime)

Append-only SQLite ledger with per-event hash chain, CAS'd projections, immutable
outbox, one-shot capability claims with fencing tokens, separate receipt spool,
uncertainty records, verifier-gated `VERIFIED`. No false-success or double-effect path
found; fault-injection tests cover every crash seam. Open defects (all fail-closed,
liveness not integrity): **M-1** late receipt (endedAt past lease) permanently wedges
recovery in `host-command.ts` (missing the guard `controlled-write-coordinator.ts:197`
has); **M-2** fencing token not enforced at the resource (suspended process can produce
a zombie effect after lease expiry; small blast radius, create-only `O_EXCL`);
**M-3** crash between event batch and claim leaves host-command permanently
`dispatch_pending`; **M-4** non-transactional read pairs can report spurious
`LedgerCorruptionError` under concurrency. Low: verifier gate is module privacy, not a
privilege boundary; hash chain has no secret (fine for local single-user threat model —
document it); per-mutation full integrity scan is quadratic (documented bound).

### Safe-start integration (inherited opencode + TUI)

All four STATUS.md fail-closed claims verified TRUE: synthetic deny-all config,
18-entry child env allowlist, independent guards on provider/VCS/MCP/shell/write paths,
locked prompt. Governed effects (chat, writes, git stage, MCP) run in the parent behind
per-operation approval and private authenticated sockets; the child cannot self-initiate.
Authority-file handoff resists forge/swap (0700 dir + 0600 `wx` file, fd-based
revalidation, digest via env, freshness). Changes to inherited code are surgical
(~45 files, additive `ASTRA_SAFE_START` guards) — upstream merges stay tractable.
Low findings: `Config.loadGlobal()` and `Auth.get` are unguarded in safe start (inert
today, defense-in-depth gap); one `yield*` without `return` in `worktree/index.ts:276`.

### Recovered Git commit slice (in-flight work, commit b0fd520)

Governed macOS-only local `git commit`: TS-computed objects, quarantine install, native
C helper with pinned-FD authority (no argv, no env paths), CAS ref update, byte-exact
independent verification. Well-designed and well-tested, but recovered mid-flight:
**does not typecheck** (3 located errors: `git-commit-mutation.ts:430` unnarrowed
`unknown`, `:447` `noUncheckedIndexedAccess` on `scratch[0]`,
`astra-git/src/commit.ts:1020` literal-type `limits` override), has no product wiring,
missing package-exports entries (interim relative cross-package imports), and a stale
`boundary.test.ts`. Functional defects: **M1** packed-refs repositories (any repo after
`git gc`) can never commit and always orphan objects — must become a prepare-time block;
**M2** uninitialized stack read in the helper's frame parser (`main.c:122`); **M3**
prepare-time git runs unsandboxed honoring repo-local config (`core.fsmonitor` not
neutralized — inert today, brittle); **M4** reflog published before ref CAS. No shell,
no injection path, no false-success path found.

### Empirical verification (Linux container; macOS surfaces platform-gated)

| Suite | Result |
|---|---|
| astra-domain | 116 pass / 0 fail |
| astra-ledger | 53 pass / 0 fail |
| astra-executor | 8 pass / 0 fail |
| astra-sandbox | 12 pass / 0 fail |
| astra-runtime | 118 pass / 73 fail — failures are `unsupported_platform` / missing `xcrun` (macOS-only surfaces failing closed) |
| astra-cli | 114 pass / 47 fail — same platform causes |
| astra-git | 18 pass / 77 fail — same, plus unbuilt native helper and the known-stale boundary test |

Cross-platform core: 189/189 green. STATUS.md's 742-test green gate is a macOS number;
Linux runs confirm the fail-closed platform gating rather than contradicting it.

### Round-2 recommended actions (priority order)

1. Fix the 3 type errors; add the missing exports-map entries; update `boundary.test.ts`.
2. Block packed-refs at prepare (Git M1); reorder the helper length check (M2).
3. Close the kernel liveness wedges (M-1, M-3) and add the missing lease guard.
4. Open PR `local-recovery` → `astra` (protected) so the mainline reflects reality.
5. Delete the hundreds of upstream branches/tags accidentally pushed by `git push --all`.
6. Then the round-1 items that still stand: CI wiring (turbo `test` task + branch
   triggers), disable inherited scheduled workflows. UPSTREAM.md items are resolved
   (baseline tag now on origin; `upstream` remote remains per-machine config).

---

# Round 1 — 2026-07-18 (pre-recovery baseline)

> Note: superseded in scope by round 2 above — at the time of this audit only the first
> 2 commits existed on the remote. Findings below remain valid for the base slice.

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
