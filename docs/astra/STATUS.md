# Astra Delivery Status

Updated: 2026-07-19 (local macOS readiness checkpoint; not yet pushed or independently reviewed)

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
- macOS operation storage now uses bounded SQLite busy handling and avoids unsafe
  cleanup races; consecutive Git stage, unstage, stage, and commit operations share an
  exact verified repository-authority chain in one activated session.
- Full local macOS package verification and the developer demo matrix are green. A real
  PTY smoke verified Git stage, durable rejection without effect, an exact local commit,
  and the read-only Operations ledger. Chat stopped fail-closed because this Mac has no
  Anthropic API credential configured.

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Bottom line

Astra launches a real Workspace Gate and TUI on macOS through `astra .` or `astra /path`. `astra system` opens a separate inert System Mode without admitting or scanning a workspace and keeps `SYSTEM MODE • NO WORKSPACE • EFFECTS DENIED` visible. Read-only and Activate once are bound to a private session authority. The inherited OpenCode prompt and ungoverned effects remain blocked, while the `ctrl+p` command surface exposes parent-governed chat, controlled write, Git stage/unstage/local commit, literal workspace search, extension inventory, skill activation, MCP activation, and operation evidence.

This is a verified local product checkpoint, not a work-ready release candidate. Governed effects cross the Operation Kernel through explicit previews and consent, durable authority, receipts, recovery, and scoped verification where an independent criterion exists. Every active workspace surface keeps `HOST EXECUTION — NO SANDBOX` visible and does not claim host network isolation or OS-enforced filesystem scope.

General macOS sandboxing is deferred to hardening. The experimental sandbox work is preserved under `packages/astra-sandbox`, but it is dormant and has unresolved timeout and cleanup review findings, so it is excluded from the working product checkpoint. The read-only Git observer continues to use its separate, existing Seatbelt boundary. Neither is a dependency for the next usable product slice.

## Repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Branch: `macos-readiness` (local only; based on `origin/astra`)
- OpenCode baseline: `453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d`
- History: full clone; MIT license, attribution, and provider source registry preserved
- Remotes: `origin` is the Astra fork; `upstream` fetches OpenCode and has push disabled
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
| `A`                 | Activates one session after a current baseline; only governed actions exist |
| `Q`                 | Exits without storing trust or launching the inherited workspace runtime    |
| `Ctrl+P`            | Opens the governed action surface; the inherited prompt remains disabled    |

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
- The inherited prompt is visibly disabled; typed input and Enter do not submit an operation, and the UI directs the user to `ctrl+p` for governed actions.

### Git read-only authority

- Git inspection is an explicit user decision and runs through a sealed Apple-owned Git copy under the macOS Seatbelt boundary.
- Network, repository writes, process forks, helpers, hooks, filters, pager, editor, signer, and unsupported metadata layouts fail closed.
- The baseline binds workspace and Git identity, HEAD, refs, logical index, tracked and untracked bytes, symlink targets, executable bits, selected Git metadata, observer identity, limits, and one canonical digest.
- Git progress stays visible as `INSPECTING GIT`; Activate once is textually marked locked until the baseline is current.
- Baseline capture uses a 15-second budget per boundary scan and a 60-second end-to-end decision budget; overruns are reported as blocked after cleanup, not falsely described as repository drift.

### Durable Operation Kernel

- Typed Operation states, immutable intent/authority/dispatch/effect/verification facts, append-only SQLite ledger, outbox, one-shot capability claim, fencing token, receipt spool, recovery, and reconciliation-required states support the connected governed product actions.
- The approved effect is bound to one immutable capability digest covering the exact executable identity, program, arguments, working directory, input, workspace identity, create-only target, environment, limits, and declared execution boundary.
- Host Bun starts from `/` with automatic installation, workspace environment loading, and workspace Bun configuration disabled; a hostile `bunfig.toml`, preload, and `.env` canary remains untouched.
- Denial is durable and produces no dispatch or effect.
- Approved execution revalidates workspace and Git authority before the effect.
- A missing or ambiguous receipt never triggers a blind retry.
- Only the verifier can append exact evidence and reach the scoped `VERIFIED` state; a zero exit code is insufficient.
- Connected product effects use bounded parent-owned adapters on the real host and remain `HOST EXECUTION — NO SANDBOX`.
- Host networking is truthfully declared as not isolated. Create-only scope is enforced by the sealed worker and repeated application checks, not by the host OS.

### TUI and Lynx

- `astra system` dynamically loads a dedicated TUI only after a TTY check; it does not open a workspace or create Astra state and exits with `Q`, `Esc`, or `Ctrl-C`.
- The public launcher disables cwd-controlled Bun config, preload, `.env`, and auto-install before Astra starts. System Mode stays in that inert process and does not bootstrap workspace services.
- The real Workspace Gate and safe OpenCode-derived TUI render on macOS.
- Full and compact terminal layouts have tests.
- Lynx has deterministic terminal frames and an illustrated two-frame raster concept pack under `assets/lynx`.
- The illustrated pack is not yet wired into a terminal animation; the current TUI uses the deterministic terminal Lynx.

## Latest integration evidence

- Toolchain: Bun `1.3.14`; frozen install succeeds.
- Domain: 119 tests, 2,442 expectations; typecheck passes.
- Ledger: 54 tests, 506 expectations; typecheck passes.
- Runtime: 207 tests, 914 expectations; typecheck passes.
- Executor: 8 tests, 24 expectations; typecheck passes.
- Git: 96 tests, 361 expectations; typecheck passes.
- CLI: 187 tests, 967 expectations; typecheck passes.
- TUI: 300 pass, 1 platform skip, 970 expectations; typecheck passes. Existing KV fixture warnings are noisy but non-failing.
- Current connected-product gate: 971 passing tests, 1 skipped test, and 6,184 expectations across the packages above.
- The preserved sandbox prototype has 12 passing tests and 59 expectations, but is excluded from the working-product gate until its open timeout and cleanup findings are resolved during hardening.
- `git diff --check` passes; changed files pass Prettier after formatting.
- `verify:demo` reports `DEMO MATRIX PASS`: hostile read-only open produced zero effects, denial was durable with no dispatch, one approved create-only host effect reached independent exact verification, the network canary received zero requests during that fixture, and no trust was persisted.
- The capability preview truthfully reported that host network access was not isolated and that create-only scope was application-enforced.
- Real PTY fixture: `G -> A` opened `ACTIVE ONCE • GOVERNED EFFECTS ONLY`; Git stage reached `VERIFIED • SELECTED INDEX + PRESERVATION`; two rejected commit previews produced no Git effect; the approved commit reached `VERIFIED • COMMIT BYTES + REPOSITORY STATE` with exact subject `test: verify exact TUI message` and author `Astra Smoke <astra-smoke@example.invalid>`.
- The Operations view loaded the current commit and stage records from the durable ledger and exposed their event sequence, receipt, verifier evidence, and exact criterion without running an action.
- Governed chat accepted the exact local prompt but stopped at `BLOCKED • NO EFFECT CLAIMED` with `credential unavailable` before preview, credential handoff, or network dispatch. Multi-turn live chat therefore remains unobserved on this Mac.
- Real large-repository diagnosis proved that the earlier false `STALE` result was a timeout. With realistic bounded limits, two captures produced the same digest.
- Independent security review confirmed closure of the three safe-opening P1 findings: inherited project/Git startup, child authority replacement, and nested-symlink read escape.
- The latest independent review also confirmed closure of workspace Bun startup execution and generic safe-start Git process bypasses; no P0/P1 remains in the reviewed host checkpoint.

## Remaining release-candidate work

| Area                        | State and next dependency                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General effect bridge       | Partial: chat, controlled write, git stage/unstage/commit, search are governed; shell effects next                                                                         |
| macOS sandbox               | Deferred to hardening; prototype preserved and backend boundary remains injectable                                                                                         |
| Git Control Plane mutations | Stage/unstage/commit shipped (commit is macOS-only, packed refs blocked at prepare); branch, fetch, merge/rebase, recovery actions missing                                 |
| Providers and credentials   | Governed Anthropic chat is wired but lacks a configured credential on this Mac; provider selection, persistence, streaming, and non-Anthropic providers are missing        |
| Plugins, skills, and MCP    | Inventory, quarantine, skill activation, and observed remote MCP activation shipped; MCP tool invocation, plugin containment, and capability grants for extensions missing |
| Complete TUI/CLI            | Operation/evidence/recovery views shipped (dispatched operations only — ledger list API pending); agent queue and richer provider/extension views missing                  |
| Upstream compatibility      | Intake workflow, drift gates, parity, and rehearsal missing                                                                                                                |
| Hardening                   | Full E2E, hostile fixtures, scans, SBOM, performance, accessibility, Linux/Windows matrix missing                                                                          |
| Local release candidate     | Package, version, changelog, checksums, provenance, recovery manual, and final demo missing                                                                                |

## Safety invariants

- Opening an unknown workspace never executes workspace-controlled content.
- Important operations always have visible state and never report a stronger result than the evidence proves.
- Rejecting an operation produces no effect.
- Push, publication, deploy, release, destructive operations, signing, and notarization remain behind a separate product-owner decision.

## Blockers

- Live chat verification requires an Anthropic API credential configured through the existing OpenCode authentication flow; no credential was read, added, or modified during this checkpoint.
- Real Linux and Windows verification will require those environments; interfaces and reproducible tests must be prepared locally first.
- Public release actions remain intentionally blocked pending explicit product-owner authorization.

## Next executable work

1. Add governed shell execution with exact argv/cwd/environment preview, explicit approval, bounded output, receipts, and no blind retry.
2. Generalize chat from the current Anthropic-only path to the preserved OpenCode provider registry and authentication sources without exposing credentials to the child TUI.
3. Add governed file edits beyond the current create-only developer action, with exact diff preview and post-state verification.
4. Add MCP tool invocation and extension capability grants while keeping plugin code quarantined by default.
5. Complete branch/fetch/merge recovery flows, keeping push and destructive Git actions behind separate authorization.
6. Harden the product, integrate the preserved sandbox backend, verify multiple platforms, and prepare a local release candidate.
