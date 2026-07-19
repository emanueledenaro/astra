# Astra Delivery Status

Updated: 2026-07-18

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

- `astra system` was run from a hostile cwd containing `.env`, `bunfig.toml`, a preload canary, and a package script. The real PTY showed the exact deny-all status, `Q` exited with code 0, all four file SHA-256 values were unchanged, no Astra data directory appeared, and no child remained.
- Toolchain: Bun `1.3.14`; frozen install succeeds.
- Domain: 50 tests, 1,979 expectations; typecheck passes.
- Ledger: 47 tests, 181 expectations; typecheck passes.
- Runtime: 54 tests, 209 expectations; typecheck passes.
- Executor: 7 tests, 22 expectations; typecheck passes.
- CLI: 57 tests, 270 expectations; typecheck passes.
- Core provider catalog: 10 tests, 28 expectations; typecheck passes.
- OpenCode safe-boundary, Git, shell, extension, and MCP subset: 245 tests, 549 expectations; typecheck passes.
- OpenCode snapshot regression suite: 56 pass, 1 platform skip, 737 expectations.
- TUI: 216 pass, 1 skip, 558 expectations; typecheck passes. Existing KV fixture warnings are noisy but non-failing.
- Latest working-product integration gate: 742 passing tests, 2 skipped tests, and 4,533 expectations.
- The preserved sandbox prototype has 12 passing tests and 59 expectations, but is excluded from the working-product gate until its open timeout and cleanup findings are resolved during hardening.
- `git diff --check` passes; changed files pass Prettier after formatting.
- The developer demo matrix was rerun after integration: hostile read-only open produced zero effects, denial was durable with no dispatch, one approved create-only host effect reached independent exact verification, the network canary received zero requests during that fixture, and no trust was persisted.
- The capability preview truthfully reported that host network access was not isolated and that create-only scope was application-enforced.
- Real fixture: `G -> A` opened `ACTIVE ONCE • EFFECTS BLOCKED`; typed input did not submit; the complete fixture fingerprint stayed `a9fb1d24358e0d08776d051f2e63fd12b81d292b2e98d4147cc9d767bacc5f28`; no workspace file or authority directory remained.
- Real large-repository diagnosis proved that the earlier false `STALE` result was a timeout. With realistic bounded limits, two captures produced the same digest.
- Independent security review confirmed closure of the three safe-opening P1 findings: inherited project/Git startup, child authority replacement, and nested-symlink read escape.
- The latest independent review also confirmed closure of workspace Bun startup execution and generic safe-start Git process bypasses; no P0/P1 remains in the reviewed host checkpoint.

## Remaining release-candidate work

| Area                        | State and next dependency                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| General effect bridge       | Next; route provider, shell, and file effects through the Operation Kernel                         |
| macOS sandbox               | Deferred to hardening; prototype preserved and backend boundary remains injectable                 |
| Git Control Plane mutations | Missing; add typed stage/unstage, commit, branch, fetch, merge/rebase, recovery                    |
| Providers and credentials   | Next; provider registry is preserved, but usable governed chat and credential handling are missing |
| Plugins, skills, and MCP    | Safe-start disabled; manifest, quarantine, capability grants, and isolation missing                |
| Complete TUI/CLI            | Agent queue, operation evidence, recovery, Git, provider, and extension views missing              |
| Upstream compatibility      | Intake workflow, drift gates, parity, and rehearsal missing                                        |
| Hardening                   | Full E2E, hostile fixtures, scans, SBOM, performance, accessibility, Linux/Windows matrix missing  |
| Local release candidate     | Package, version, changelog, checksums, provenance, recovery manual, and final demo missing        |

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
