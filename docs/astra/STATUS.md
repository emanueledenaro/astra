# Astra Delivery Status

Updated: 2026-07-19 (post-consolidation; see AUDIT.md on the audit branch for the
independently verified assessment of everything below)

## 2026-07-19 delta

- The recovered development line plus audit fixes merged into the protected `astra`
  mainline (PR #4); the day's product slices merged next (PR #5).
- All recovered typecheck errors are fixed: every astra package and `packages/tui`
  compile clean.
- Kernel recovery liveness wedges (stale receipt, pending outbox, spurious corruption
  reads) are closed with fault-injection tests; packed branch refs are now blocked at
  commit prepare time instead of failing mid-effect.
- New product surfaces, each parent-side behind per-operation approval: governed local
  git commit in the TUI, read-only operation/evidence/recovery views, and consented
  multi-turn chat (history in parent memory only, per-turn approval and grant).
- Lynx v2 illustrated identity (flat-vector SVG states + logo, checksummed manifest)
  replaces the pixel-art direction.
- Linux verification: domain 119, ledger 54, executor 8, sandbox 12, TUI astra suites
  128 — all green; astra-git/runtime/cli fail only at their macOS platform gates
  (fail-closed). Full macOS re-verification is the next owner-side step
  (docs/astra/macos-verification.md).

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Bottom line

Astra launches a real Workspace Gate and TUI on macOS through `astra .` or `astra /path`. `astra system` now opens a separate inert System Mode without admitting or scanning a workspace and keeps `SYSTEM MODE • NO WORKSPACE • EFFECTS DENIED` visible. Read-only and Activate once are bound to a private session authority, but every inherited AI, shell, general write, provider, plugin, skill, MCP, LSP, formatter, and VCS mutation remains blocked in the product TUI.

This is a verified safe-opening and host-execution checkpoint, not a release candidate. One developer verification effect crosses the Operation Kernel through a bounded host process with explicit consent, durable authority, receipts, recovery, and independent verification. It is always labelled `HOST EXECUTION — NO SANDBOX`; the UI does not claim host network isolation or OS-enforced filesystem scope.

General macOS sandboxing is deferred to hardening. The experimental sandbox work is preserved under `packages/astra-sandbox`, but it is dormant and has unresolved timeout and cleanup review findings, so it is excluded from the working product checkpoint. The read-only Git observer continues to use its separate, existing Seatbelt boundary. Neither is a dependency for the next usable product slice.

## Repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Branch: `durable-coordinator`
- OpenCode baseline: `453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d`
- History: full clone; MIT license, attribution, and provider source registry preserved
- Remotes: fetch-only in this checkout; push URLs disabled
- External state: no push, publication, release, signing, notarization, or deploy from this worktree

## Working product surface

| Surface             | Current behavior                                                            |
| ------------------- | --------------------------------------------------------------------------- |
| `astra .`           | Opens the current directory through the real Workspace Gate                 |
| `astra /path`       | Opens an explicit path; safe intermediate aliases become canonical          |
| `astra open <path>` | Compatibility alias                                                         |
| `astra`             | No Workspace mode planned; currently prints help                            |
| `astra system`      | Opens inert System Mode; no workspace authority, control socket, or effects |
| `R`                 | Opens TUI with `READ ONLY • EFFECTS DENIED`                                 |
| `G`                 | Runs bounded sandboxed Git inspection with visible progress                 |
| `A`                 | Available only after a current Git baseline; effects remain blocked         |
| `Q`                 | Exits without storing trust or launching the inherited workspace runtime    |

## Implemented and verified

### Safe workspace admission

- Bounded static preflight runs before normal OpenCode bootstrap.
- Workspace-controlled config, scripts, providers, plugins, skills, MCP, LSP, formatters, Git, and network are not initialized during open.
- Intermediate path aliases are canonicalized without accepting a symlink as the workspace root.
- Read-only and Activate once create no persistent trust.
- The exact workspace identity, security digest, mode, effect policy, and optional Git baseline are stored in a private `0600` authority file inside a private temporary directory.
- The TUI process checks file ownership, mode, digest, freshness, root binding, device, inode, security digest, and Git baseline again before instance admission.
- Safe Astra instances are synthetic and in-memory; they do not call the inherited Git project resolver or create `.git/opencode`.

### Fail-closed inherited runtime

- Safe-start configuration is synthetic and exactly deny-all.
- The child environment is allowlisted and strips provider, cloud, Git, proxy, SSH, and credential variables.
- Project config, account config, model refresh, default/external plugins, external skills, Claude ingestion, MCP auth, LSP downloads, and automatic updates are disabled.
- Provider execution, inherited VCS apply, and MCP lifecycle paths have independent safe-start guards.
- Astra TUI synchronization requests only the safe configuration and does not load project, VCS, provider, account, session, extension, MCP, LSP, or formatter state.
- The prompt is visibly locked; typed input and Enter do not submit an operation.

### Git read-only authority

- Git inspection is an explicit user decision and runs through a sealed Apple-owned Git copy under the macOS Seatbelt boundary.
- Network, repository writes, process forks, helpers, hooks, filters, pager, editor, signer, and unsupported metadata layouts fail closed.
- The baseline binds workspace and Git identity, HEAD, refs, logical index, tracked and untracked bytes, symlink targets, executable bits, selected Git metadata, observer identity, limits, and one canonical digest.
- Git progress stays visible as `INSPECTING GIT`; Activate once is textually marked locked until the baseline is current.
- Baseline capture uses a 15-second budget per boundary scan and a 60-second end-to-end decision budget; overruns are reported as blocked after cleanup, not falsely described as repository drift.

### Durable Operation Kernel

- Typed Operation states, immutable intent/authority/dispatch/effect/verification facts, append-only SQLite ledger, outbox, one-shot capability claim, fencing token, receipt spool, recovery, and reconciliation-required states are implemented for the create-only developer slice.
- The approved effect is bound to one immutable capability digest covering the exact executable identity, program, arguments, working directory, input, workspace identity, create-only target, environment, limits, and declared execution boundary.
- Host Bun starts from `/` with automatic installation, workspace environment loading, and workspace Bun configuration disabled; a hostile `bunfig.toml`, preload, and `.env` canary remains untouched.
- Denial is durable and produces no dispatch or effect.
- Approved execution revalidates workspace and Git authority before the effect.
- A missing or ambiguous receipt never triggers a blind retry.
- Only the verifier can append exact evidence and reach the scoped `VERIFIED` state; a zero exit code is insufficient.
- The positive slice uses a bounded child process on the real host, remains `HOST EXECUTION — NO SANDBOX`, and is not connected to the product TUI.
- Host networking is truthfully declared as not isolated. Create-only scope is enforced by the sealed worker and repeated application checks, not by the host OS.

### TUI and Lynx

- `astra system` dynamically loads a dedicated TUI only after a TTY check; it does not open a workspace or create Astra state and exits with `Q`, `Esc`, or `Ctrl-C`.
- The public launcher disables cwd-controlled Bun config, preload, `.env`, and auto-install before Astra starts. System Mode stays in that inert process and does not bootstrap workspace services.
- The real Workspace Gate and safe OpenCode-derived TUI render on macOS.
- Full and compact terminal layouts have tests.
- Lynx has deterministic terminal frames and an illustrated two-frame raster concept pack under `assets/lynx`.
- The illustrated pack is not yet wired into a terminal animation; the current TUI uses the deterministic terminal Lynx.

## Latest integration evidence

- macOS owner-side run on `d3039866f` used Bun `1.3.14`; `bun install` completed with
  `Checked 2427 installs across 2712 packages (no changes)`.
- Both native helpers built. `astra-git-commit-native` sanitizer tests: 13 pass,
  0 fail, 54 expectations. The additional `astra-extension-inventory-native`
  sanitizer run: 11 pass, 0 fail, 422 expectations.
- Package results: domain 119/0 (2,442 expectations), executor 8/0 (24), sandbox
  12/0 (59), runtime 207/0 (914), and TUI 297 pass/0 fail/1 skip (965) are green.
  Typecheck passes for those five packages and for ledger and git.
- Ledger is red: 53 pass, 1 fail, 427 expectations. The failing test is
  `snapshot-consistent ledger reads under a concurrent committed writer > keeps paired read statements on one snapshot instead of reporting spurious corruption`;
  SQLite returned `database is locked`, `errno: 261`,
  `code: "SQLITE_BUSY_RECOVERY"` at `PRAGMA journal_mode = WAL;`.
- Git is red: 95 pass, 1 fail, 1 error, 361 expectations. Test
  `governed local Git commit adapter > blocks detached, unborn, empty staged state, conflicts, submodules, split index and locks`
  timed out after 5,000 ms; the subsequent unhandled assertion expected
  `reason: "index_lock_present"` and received `reason: "baseline_stale"`.
- CLI is red: 175 pass, 2 fail, 1 error, 910 expectations. The TUI control test
  failed with `error: The Astra control socket path is too long`; the operations
  view test failed to load `@effect/sql-sqlite-bun`. CLI typecheck is also red:
  `TS2307` for `@effect/sql-sqlite-bun`, `effect`, and
  `effect/unstable/sql/SqlClient` in `test/operation-view-control.test.ts`.
- Combined package observation: 966 passing tests, 4 failing tests, 2 reported
  unhandled errors, 1 skip, and 6,102 expectations. This is not a green gate.
- `verify:demo` is green and ended with `DEMO MATRIX PASS`: read-only produced zero
  workspace effects, rejection was durable without dispatch or marker, one approved
  create-only marker reached independent verification, the network canary received
  zero requests, and no trust was persisted.
- Real `astra system` PTY smoke displayed
  `SYSTEM MODE • NO WORKSPACE • EFFECTS DENIED` and `Q` exited with code 0. With
  fresh HOME/XDG roots it created no Astra config, data, or authority state; Bun did
  create four transpiler-cache `.pile` files under the isolated cache root.
- Real `astra .` PTY smoke reached gate, current Git baseline, Activate once, and the
  globally visible `HOST EXECUTION — NO SANDBOX` boundary. A governed stage of
  `smoke.txt` reached `VERIFIED • SELECTED INDEX + PRESERVATION` and appeared with
  its receipt in `/operations`.
- The immediate same-session commit is red: its preview was blocked with
  `REASON baseline stale` and no effect was claimed. After exiting, reopening the
  fixture, recapturing the baseline, and activating once, the governed commit reached
  `VERIFIED • COMMIT BYTES + REPOSITORY STATE`; `/operations` showed the verified
  `git_commit_local` event and ingested receipt. The resulting fixture commit is
  `72d0ff4` by `Astra macOS Verification <astra-verification@local.invalid>`.
- Commit-message entry did not preserve the requested text in the PTY smoke: the
  requested `test: verify macOS product smoke` was committed as `oke`.
- Astra Chat loaded the trusted Anthropic catalog and model `claude-fable-5`, but no
  turn could be dispatched: the exact blocker was `credential unavailable`, followed
  by `Add an Anthropic API key with the existing OpenCode authentication flow.` The
  required multi-turn, per-turn approval, and history-byte checks were therefore not
  executable.

## Remaining release-candidate work

| Area                        | State and next dependency                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| General effect bridge       | Partial: chat, controlled write, git stage/unstage/commit, search are governed; shell effects next   |
| macOS sandbox               | Deferred to hardening; prototype preserved and backend boundary remains injectable                  |
| Git Control Plane mutations | Stage/unstage/commit shipped (commit is macOS-only, packed refs blocked at prepare); branch, fetch, merge/rebase, recovery actions missing |
| Providers and credentials   | Governed multi-turn chat shipped (per-turn consent, parent-only history); persistence, streaming, and non-Anthropic providers missing |
| Plugins, skills, and MCP    | Inventory, quarantine, skill activation, and observed remote MCP activation shipped; MCP tool invocation, plugin containment, and capability grants for extensions missing |
| Complete TUI/CLI            | Operation/evidence/recovery views shipped (dispatched operations only — ledger list API pending); agent queue and richer provider/extension views missing |
| Upstream compatibility      | Intake workflow, drift gates, parity, and rehearsal missing                                         |
| Hardening                   | Full E2E, hostile fixtures, scans, SBOM, performance, accessibility, Linux/Windows matrix missing   |
| Local release candidate     | Package, version, changelog, checksums, provenance, recovery manual, and final demo missing         |

## Safety invariants

- Opening an unknown workspace never executes workspace-controlled content.
- Important operations always have visible state and never report a stronger result than the evidence proves.
- Rejecting an operation produces no effect.
- Push, publication, deploy, release, destructive operations, signing, and notarization remain behind a separate product-owner decision.

## Blockers

- No local implementation blocker is active.
- Real Linux and Windows verification will require those environments; interfaces and reproducible tests must be prepared locally first.
- Public release actions remain intentionally blocked pending explicit product-owner authorization.

## Next executable work

1. Connect a real OpenCode provider turn to the Astra chat through a visible, consented network Operation.
2. Route bounded shell and file changes through the same capability, ledger, receipt, recovery, and verification boundaries.
3. Build typed Git stage/unstage and local commit operations in the TUI; keep push unavailable without separate authorization.
4. Add governed plugin, skill, and MCP discovery and activation without weakening safe workspace opening.
5. Complete the TUI operation, evidence, recovery, Git, provider, and extension views.
6. Harden the product, integrate the preserved sandbox backend, verify multiple platforms, and prepare a local release candidate.
