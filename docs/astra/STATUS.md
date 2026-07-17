# Astra Delivery Status

Updated: 2026-07-17

## Objective

Produce a local Astra release candidate that is functional, independently verified, reproducible, and ready for a separate product-owner publication decision.

## Canonical repository

- Path: `/Users/emanueledenaro/Documents/progetti/Astra`
- Working branch: `durable-coordinator`
- Public-preparation boundary: local branch `astra` at `57f3d1bb8` (`docs(astra): record command contract and checkpoints`)
- Latest implementation checkpoint: `0dfd73eae` (`feat(git): add typed metadata diff snapshots`)
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
- Git workspaces remain readable but cannot activate or reach the demo effect until a complete Git baseline exists. The controlled write revalidates this guard again at the effect boundary.

## Honest limits

- Coordinator and verifier are separated by restricted package APIs and process-local capabilities, but still run sequentially in one OS process. This is not protection from a fully compromised host process or hostile arbitrary module loading.
- `VERIFIED` currently proves the durable admitted baseline, bounded post-effect workspace snapshot, exact target inode, exact bytes, and SHA-256 under that process-local boundary. A dedicated verifier process and sandbox remain hardening work.
- The current executor supports one create-only demo effect and `maxAttempts: 1`. General retries, lease renewal, cancellation, and owner-driven reconciliation are not implemented.
- Recovery never retries an ambiguous effect. An effect that may have occurred before its receipt was durably spooled requires reconciliation.
- `HOST EXECUTION — NO SANDBOX` is accurate: the positive demo effect is a direct, bounded host write.
- Git inspection is macOS-only and supports one canonical repository root with a direct `.git` directory. It is a current observation, not a durable baseline, trust grant, sandbox for later mutations, or verification verdict.
- The Git diff is metadata-only and ephemeral. It does not return patch content, additions/deletions, an object ID for current worktree bytes, or untracked/conflict content. Intent-to-add remains unsupported and blocks inspection.
- Linked worktrees, `.git` files or symlinks, ancestor/nested repositories, submodules, external object layouts, and fsmonitor state remain explicitly unsupported. No non-Git or partial Git baseline is invented.
- The Git boundary is capped at 250,000 filesystem entries, five seconds per boundary scan, 10,000 reported Git entries, and bounded process output. Larger or slower repositories fail closed.
- Trust is process-local and never persisted in this increment.
- Provider, plugin, skill, and MCP compatibility is preserved structurally but not yet activated behind Astra trust and isolation.

## Verification evidence

- Exact toolchain: Bun `1.3.14`; frozen install succeeds without lockfile changes.
- Git: 31 tests, 112 assertions; typecheck passes.
- Domain: 38 tests, 1,924 assertions; typecheck passes.
- Executor: 5 tests, 19 assertions; typecheck passes.
- Ledger: 45 tests, 171 assertions; typecheck passes.
- Runtime: 40 tests, 165 assertions; both strict runtime and isolated SQLite-adapter typechecks pass.
- CLI: 25 tests, 148 assertions; typecheck passes.
- Total: 184 tests and 2,539 assertions.
- Scoped Oxlint: 0 warnings, 0 errors. Prettier check passes.
- Frozen install and `git diff --check` pass.
- Real demo matrix passes: malicious read-only fixture, durable denial, approved create-only write, durable receipt transfer, independent exact evidence, and zero network-canary requests.
- Real Git diff demo passes against this Astra repository in about 10 seconds: the exact branch plus 10 unstaged paths were observed before the checkpoint, the metadata diff displayed its exact observation binding, the workspace remained `UNTRUSTED`, no app state was created, and no ephemeral Git executable remained.
- The receipt-recovery review found no blocker. It recorded one coordinator invariant: only the coordinator may acknowledge a spooled receipt after exact ledger ingestion.
- The Git-preflight review found four P1 bypasses involving nested repositories, case-variant metadata, late Git creation, and physical ancestry through symlinks. All four were corrected, covered by negative tests, and independently rechecked with no blocker remaining.
- The coordinator review found three P1 issues and two P2 issues involving verification binding, forged evidence, expired authority, active-claim concurrency, and SQLite/acknowledgement boundaries. All were corrected and the same reviewer repeated the attacks with no P0, P1, or P2 remaining in the declared demo boundary.
- The Git Control Plane review found three P1 issues and one P2 involving hidden index state, executable identity, external Git metadata, and scan deadlines. All were corrected; the same reviewer rechecked the fixes and the large-workspace optimization with no P0, P1, or P2 remaining in this read-only boundary.
- The metadata diff review found two P2 issues involving unexplained conflict stages and mixed object formats. The real demo also exposed root-relative index paths that depended on the launch directory. All were corrected; the same reviewer repeated the attacks and confirmed the conflict, object-format, and root-scope fixes with no P0, P1, or P2 remaining in this increment.

## Roadmap

### Local demo

Current: Workspace Gate, durable denial, approved create-only effect, outbox, capability reservation/consumption, one-shot fenced claim, receipt spool, exact recovery, independent durable verification, fail-closed Git activation guard, explicit sandboxed Git status, and a typed ephemeral metadata diff are working. Next, define a durable Git repository baseline while keeping every Git mutation disabled.

### Hardening

Add effect-specific reconciliation, lease renewal, complete durable Git baseline, capability policy, a separate verifier process, broader macOS sandbox backends, and hostile Git/process fixtures.

### Professional release

Complete provider parity, credential broker, isolated plugin/skill/MCP lifecycle, Git Control Plane, TUI integration, multi-platform matrix, SBOM, signing, notarization, packaging, update and rollback rehearsal.

## Blockers

- No local implementation blocker is active.
- GitHub preparation for the already closed `astra` boundary is authorized and handled in a separate worktree/chat.
- Release, package publication, signing, notarization, deployment, and publishing this active branch still require explicit product-owner authorization.

## Next executable work

1. Define a durable Git repository baseline without treating status output as sufficient authority.
2. Add worktree ownership and common-directory coordination before any Git mutation is enabled.
3. Keep stage, commit, fetch, push, rebase, merge, cleanup, and every other Git mutation disabled until each exact Operation, approval, effect, and verification contract exists.
4. Move verifier execution into a separate process during hardening without weakening the current evidence contract.
