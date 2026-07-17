# Astra Delivery Status

Updated: 2026-07-17

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Bottom line

Astra now launches a real Workspace Gate and TUI on macOS through `astra .` or `astra /path`. Read-only and Activate once are bound to a private session authority, but every inherited AI, shell, write, provider, plugin, skill, MCP, LSP, formatter, and VCS effect remains blocked.

This is a verified safe-opening checkpoint, not a release candidate. The next dependency is the macOS sandbox and capability kernel that will let selected effects cross the boundary without weakening it.

## Repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Branch: `durable-coordinator`
- OpenCode baseline: `453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d`
- History: full clone; MIT license, attribution, and provider source registry preserved
- Remotes: fetch-only in this checkout; push URLs disabled
- External state: no push, publication, release, signing, notarization, or deploy from this worktree

## Working product surface

| Surface             | Current behavior                                                         |
| ------------------- | ------------------------------------------------------------------------ |
| `astra .`           | Opens the current directory through the real Workspace Gate              |
| `astra /path`       | Opens an explicit path; safe intermediate aliases become canonical       |
| `astra open <path>` | Compatibility alias                                                      |
| `astra`             | No Workspace mode planned; currently prints help                         |
| `astra system`      | Planned; not implemented                                                 |
| `R`                 | Opens TUI with `READ ONLY • EFFECTS DENIED`                              |
| `G`                 | Runs bounded sandboxed Git inspection with visible progress              |
| `A`                 | Available only after a current Git baseline; effects remain blocked      |
| `Q`                 | Exits without storing trust or launching the inherited workspace runtime |

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
- Denial is durable and produces no dispatch or effect.
- Approved execution revalidates workspace and Git authority before the effect.
- A missing or ambiguous receipt never triggers a blind retry.
- Only the verifier can append exact evidence and reach the scoped `VERIFIED` state; a zero exit code is insufficient.
- The positive slice remains `HOST EXECUTION — NO SANDBOX` and is not connected to the product TUI.

### TUI and Lynx

- The real Workspace Gate and safe OpenCode-derived TUI render on macOS.
- Full and compact terminal layouts have tests.
- Lynx has deterministic terminal frames and an illustrated two-frame raster concept pack under `assets/lynx`.
- The illustrated pack is not yet wired into a terminal animation; the current TUI uses the deterministic terminal Lynx.

## Verification evidence

- Toolchain: Bun `1.3.14`; frozen install succeeds.
- Domain: 43 tests, 1,953 expectations; typecheck passes.
- Ledger: 46 tests, 175 expectations; typecheck passes.
- Runtime: 50 tests, 193 expectations; typecheck passes.
- Executor: 5 tests, 19 expectations; typecheck passes.
- Git: 44 tests, 157 expectations; typecheck passes.
- CLI: 57 tests, 270 expectations; typecheck passes.
- TUI: 216 pass, 1 skip, 558 expectations; typecheck passes. Existing KV fixture warnings are noisy but non-failing.
- OpenCode safe-boundary subset: 148 tests, 288 expectations; typecheck passes.
- Current verified total: 609 passing tests, 1 skipped test, and 3,613 expectations across the declared checkpoint.
- `git diff --check` passes; changed files pass Prettier after formatting.
- Real fixture: `G -> A` opened `ACTIVE ONCE • EFFECTS BLOCKED`; typed input did not submit; the complete fixture fingerprint stayed `a9fb1d24358e0d08776d051f2e63fd12b81d292b2e98d4147cc9d767bacc5f28`; no workspace file or authority directory remained.
- Real large-repository diagnosis proved that the earlier false `STALE` result was a timeout. With realistic bounded limits, two captures produced the same digest.
- Independent security review confirmed closure of the three safe-opening P1 findings: inherited project/Git startup, child authority replacement, and nested-symlink read escape.

## Remaining release-candidate work

| Area                        | State and next dependency                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| General effect bridge       | Missing; TUI must route every effect through the Operation Kernel                                 |
| macOS sandbox/capabilities  | Next; add immutable capability manifest, Seatbelt backend, probe, and fail-close                  |
| Git Control Plane mutations | Missing; add typed stage/unstage, commit, branch, fetch, merge/rebase, recovery                   |
| Providers and credentials   | Providers preserved structurally; parity gate and Keychain broker missing                         |
| Plugins, skills, and MCP    | Safe-start disabled; manifest, quarantine, capability grants, and isolation missing               |
| Complete TUI/CLI            | Agent queue, operation evidence, recovery, Git, provider, and extension views missing             |
| Upstream compatibility      | Intake workflow, drift gates, parity, and rehearsal missing                                       |
| Hardening                   | Full E2E, hostile fixtures, scans, SBOM, performance, accessibility, Linux/Windows matrix missing |
| Local release candidate     | Package, version, changelog, checksums, provenance, recovery manual, and final demo missing       |

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

1. Define the canonical execution capability manifest and bind its digest through authority, ledger, dispatch, receipt, and verification.
2. Implement and self-test the macOS Seatbelt backend with minimal environment, filesystem/network scope, timeout, and process-tree cleanup.
3. Route the first controlled TUI operation through the sandboxed Operation Kernel while preserving denial-without-effect.
4. Build typed Git stage/unstage and local commit operations; keep push unavailable.
5. Continue provider parity, Keychain broker, extension isolation, complete TUI/CLI, hardening, and local RC packaging.
