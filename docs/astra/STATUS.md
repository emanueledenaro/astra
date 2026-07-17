# Astra Delivery Status

Updated: 2026-07-17

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Canonical repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Working branch: `durable-coordinator`
- Public-preparation boundary: local branch `astra` at `57f3d1bb8` (`docs(astra): record command contract and checkpoints`)
- Latest implementation checkpoint: `092f51b4b` (`feat(cli): show Git baseline lifecycle`)
- Git baseline checkpoint: `15b606463` (`feat(git): capture bounded repository baselines`)
- Durable authority checkpoint: `102e2a598` (`feat(runtime): bind Git baselines to denied operations`)
- Audited OpenCode baseline: `453b61e27b2f6c2752a60dd7d8412bdcf4e0aa3d`
- History: full local clone; the repository is not shallow
- Remotes in this checkout: fetch-only; push URLs are disabled
- Public repository preparation is handled separately from this active worktree.

## Implemented locally

- OpenCode provenance, MIT license, provider registry, and audited baseline are preserved.
- Unknown workspace open uses bounded static preflight without normal OpenCode bootstrap.
- Read-only, Activate once, Exit, explicit effect approval, visible Operation state, and exact marker readback work on macOS.
- Typed Operation contracts and the append-only SQLite ledger are implemented.
- A rejected controlled write is recorded atomically as `admitted -> policy.ask -> approval.rejected -> denied`.
- The denied projection is reopened from a read-only database connection and shown with its sequence and cursor.
- Read-only and Exit do not initialize Astra app state. Denial never dispatches the planned effect.
- Ledger paths that resolve into the workspace through symlinks are rejected before SQLite can write.
- An approved Operation can now reserve one globally unique capability, append an immutable dispatch outbox request, and be accepted through the specialized one-shot claim API.
- `dispatch.requested` and its outbox commit atomically. `executor.accepted`, capability consumption, executor claim, and the monotonic fencing token also commit atomically.
- Approval, dispatch, and claim use an internal trusted clock and bind the admitted baseline, adapter digest, attempt, causation, actor, and event timestamps. Expired, reused, mismatched, competing, or backdated claims fail closed.
- A separate append-only executor spool now preserves immutable receipts across process and database reopen.
- Receipt ingestion binds the Operation, attempt, dispatch request, executor claim, capability, fencing token, adapter, admitted effect class, resources, and timing before atomically appending the observed outcome.
- The approved CLI path now uses the durable coordinator. It revalidates the exact durable Operation, claim, capability, fence, adapter, baseline, authority, and minimum remaining lease immediately before the create-only effect.
- An active exact claim remains in progress and is never retried. A missing receipt becomes uncertain only after claim expiry. Recovery transfers exact pending receipts without rerunning the effect.
- Executor receipts bind the admitted baseline, bounded post-effect workspace digest, preflight limits, activation guard, workspace identity, and executor-created target identity.
- The verifier reopens durable state and the target independently, checks the workspace before and after fresh target reads, checks it again before evidence ingestion, and alone can append terminal verification evidence.
- Drift, a new `.git` marker, a replaced inode, a foreign workspace, an expired authority, or an ambiguous effect becomes `reconciliation_required`; none can produce `VERIFIED`.
- Generic ledger and spool APIs expose neither success-producing evidence ingestion nor receipt acknowledgement. Privileged mutations use internal process-local capability composition.
- Ledger and receipt-spool SQLite families cannot overlap through their base, journal, shared-memory, or WAL paths.
- Storage schema v5 migrates authentic v1-v4 ledgers without losing events.
- Static preflight recognizes `.git` directories, files, symlinks, case variants, physical repository ancestors, and repository ancestry reached through intermediate symlinks without executing Git or traversing Git contents.
- An explicit `[G] inspect Git` decision now loads a separate read-only Git package only after user choice. Ordinary open and read-only paths remain process-free.
- The macOS Git observer reports branch, HEAD, local upstream distance, stash count, staged, unstaged, untracked, and conflict state from strict bounded machine-readable output. A file staged and then modified appears in both views.
- Git runs from a sealed ephemeral copy made from one verified root-owned source handle. The sandbox denies network, repository writes, process forks, and every child execution; the copy is identity-checked before use and removed afterward.
- Repository helpers, filters, fsmonitor uncertainty, hidden index flags, submodules, linked worktrees, external object stores, metadata symlinks, malformed output, truncation, timeout, drift, and unsupported layouts fail closed instead of producing a clean report.
- The same twice-observed porcelain output now produces a typed staged `HEAD -> index` and unstaged `index -> worktree` metadata diff. Exact Git modes and HEAD/index object IDs remain bound to the observation digest; worktree content remains explicitly unhashed.
- Both root-scoped index views are cross-checked against status. Duplicate or control-character paths, intent-to-add, unsupported modes, unexplained conflict stages, conflict stage drift, mixed SHA-1/SHA-256 observations, and all-zero branch object IDs fail closed.
- Explicit Git baseline capture now binds repository identity, exact HEAD, refs, logical index, tracked and untracked raw content, symlink link text, executable state, selected direct Git metadata, observer identity, limits, and one canonical snapshot digest.
- Baseline capture runs only after the explicit Git decision. It uses the sealed sandboxed Git observer, a workspace-scoped file-read policy, bounded traversal and content reads, config/include rejection, repeated observations, and an end-to-end deadline.
- Revalidation accepts only `current`, `stale`, or `blocked`. `current` is bound to the exact snapshot supplied by the caller and is always displayed as `NOT VERIFIED`.
- The Operation contract has a truthful Git snapshot-authority form. A denied Operation may persist its snapshot digest, observation digest, repository identity, exact HEAD, and `not_verified` state without manufacturing legacy tracked/untracked facts.
- Git snapshot authority must match both the preflight workspace identity and the opened canonical path before the denial ledger can be created.
- The CLI now renders `NOT CAPTURED -> CAPTURING -> CURRENT/STALE/BLOCKED` after `[G] inspect Git`. Adapter results are runtime-validated; malformed, unrelated, blocked, or mismatched results fail closed.
- Git workspaces remain readable but cannot activate or reach the demo effect until a complete Git baseline exists. The controlled write revalidates this guard again at the effect boundary.

## Honest limits

- Coordinator and verifier are separated by restricted package APIs and process-local capabilities, but still run sequentially in one OS process. This is not protection from a fully compromised host process or hostile arbitrary module loading.
- `VERIFIED` currently proves the durable admitted baseline, bounded post-effect workspace snapshot, exact target inode, exact bytes, and SHA-256 under that process-local boundary. A dedicated verifier process and sandbox remain hardening work.
- The current executor supports one create-only demo effect and `maxAttempts: 1`. General retries, lease renewal, cancellation, and owner-driven reconciliation are not implemented.
- Recovery never retries an ambiguous effect. An effect that may have occurred before its receipt was durably spooled requires reconciliation.
- `HOST EXECUTION — NO SANDBOX` is accurate: the positive demo effect is a direct, bounded host write.
- Git inspection and baseline capture are macOS-only and support one canonical repository root with a direct `.git` directory. A captured baseline is ephemeral authority data, not a trust grant, mutation capability, persistent trust decision, or verification verdict.
- The denial ledger can preserve the exact baseline authority subset, but the current interactive Git flow still ends read-only. It does not yet carry the captured snapshot into same-process Activate once or approved Git-workspace effects.
- The Git diff is metadata-only and ephemeral. It does not return patch content, additions/deletions, an object ID for current worktree bytes, or untracked/conflict content. Intent-to-add remains unsupported and blocks inspection.
- Linked worktrees, `.git` files or symlinks, ancestor/nested repositories, submodules, external object layouts, and fsmonitor state remain explicitly unsupported. No non-Git or partial Git baseline is invented.
- The Git boundary is capped at 250,000 filesystem entries, five seconds per boundary scan, 10,000 reported Git entries, and bounded process output. Larger or slower repositories fail closed.
- Trust is process-local and never persisted in this increment.
- Provider, plugin, skill, and MCP compatibility is preserved structurally but not yet activated behind Astra trust and isolation.

## Verification evidence

- Exact toolchain: Bun `1.3.14`; frozen install succeeds without lockfile changes.
- Git: 44 tests, 157 assertions; typecheck passes.
- Domain: 41 tests, 1,947 assertions; typecheck passes.
- Executor: 5 tests, 19 assertions; typecheck passes.
- Ledger: 45 tests, 171 assertions; typecheck passes.
- Runtime: 42 tests, 171 assertions; both strict runtime and isolated SQLite-adapter typechecks pass.
- CLI: 37 tests, 195 assertions; typecheck passes.
- Total: 214 tests and 2,660 assertions.
- Scoped Oxlint: 0 warnings, 0 errors. Prettier check passes.
- Frozen install and `git diff --check` pass.
- Real demo matrix passes: malicious read-only fixture, durable denial, approved create-only write, durable receipt transfer, independent exact evidence, and zero network-canary requests.
- Real Git baseline demo passes against this Astra repository: the exact branch plus eight unstaged and two untracked paths were observed, capture and immediate revalidation returned the same digest, the UI displayed `CURRENT • NOT VERIFIED`, the workspace remained `UNTRUSTED`, and no app state was created.
- The receipt-recovery review found no blocker. It recorded one coordinator invariant: only the coordinator may acknowledge a spooled receipt after exact ledger ingestion.
- The Git-preflight review found four P1 bypasses involving nested repositories, case-variant metadata, late Git creation, and physical ancestry through symlinks. All four were corrected, covered by negative tests, and independently rechecked with no blocker remaining.
- The coordinator review found three P1 issues and two P2 issues involving verification binding, forged evidence, expired authority, active-claim concurrency, and SQLite/acknowledgement boundaries. All were corrected and the same reviewer repeated the attacks with no P0, P1, or P2 remaining in the declared demo boundary.
- The Git Control Plane review found three P1 issues and one P2 involving hidden index state, executable identity, external Git metadata, and scan deadlines. All were corrected; the same reviewer rechecked the fixes and the large-workspace optimization with no P0, P1, or P2 remaining in this read-only boundary.
- The metadata diff review found two P2 issues involving unexplained conflict stages and mixed object formats. The real demo also exposed root-relative index paths that depended on the launch directory. All were corrected; the same reviewer repeated the attacks and confirmed the conflict, object-format, and root-scope fixes with no P0, P1, or P2 remaining in this increment.
- The Git baseline review found three blockers involving external config reads, caller mutation, and a non-global deadline. All were corrected with config sealing/read allowlists, normalized snapshot copies, and deadline propagation; the full Git suite and real revalidation pass.
- The Operations binding review found no blocker. Its residual identity-binding concern was removed by enforcing repository/workspace identity equality in the domain parser as well as the runtime admission boundary.
- The TUI integration review found two P1 issues and one P2 involving blocked inspection fallthrough, unrelated revalidation tuples, and malformed adapter output. All were corrected and the same reviewer confirmed closure with no blocker remaining.

## Roadmap

### Local demo

Current: Workspace Gate, durable denial, approved create-only effect, outbox, capability reservation/consumption, one-shot fenced claim, receipt spool, exact recovery, independent durable verification, fail-closed Git activation guard, sandboxed Git inspection, full ephemeral Git baseline capture, durable denial authority, and visible baseline lifecycle are working. Next, carry the explicit baseline through same-process Activate once without enabling Git mutations.

### Hardening

Add effect-specific reconciliation, lease renewal, persistent Git baseline lifecycle, capability policy, a separate verifier process, broader macOS sandbox backends, and hostile Git/process fixtures.

### Professional release

Complete provider parity, credential broker, isolated plugin/skill/MCP lifecycle, Git Control Plane, TUI integration, multi-platform matrix, SBOM, signing, notarization, packaging, update and rollback rehearsal.

## Blockers

- No local implementation blocker is active.
- GitHub preparation for the already closed `astra` boundary is authorized and handled in a separate worktree/chat.
- Release, package publication, signing, notarization, deployment, and publishing this active branch still require explicit product-owner authorization.

## Next executable work

1. Let an explicit same-process Git baseline decision unlock Activate once only while the exact snapshot remains current, then pass that snapshot into durable denial and approved-operation admission.
2. Add worktree ownership and common-directory coordination before any Git mutation is enabled.
3. Implement the first typed Git mutation Operation with preview, approval, receipt, verification, and rollback where safe; keep push disabled.
4. Move verifier execution into a separate process during hardening without weakening the current evidence contract.
