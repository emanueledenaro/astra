# Astra macOS Work-Ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing safe Astra prototype into one coherent macOS product flow: useful launch surfaces, governed multi-provider chat, visible delegated work, reviewable atomic patches, accurate evidence, and governed Git task completion.

**Architecture:** Keep the OpenCode TUI and provider registry, but project all Astra product state from parent-owned typed coordinators. The child TUI renders state and submits intent; every network, file, shell, Git, credential, plugin, skill, or MCP effect crosses the existing Operation Kernel. Extend existing Astra packages in place and keep the host executor behind its current backend boundary so sandbox hardening remains additive.

**Tech Stack:** Bun 1.3.x, TypeScript, SolidJS, OpenTUI, Effect, SQLite/Drizzle, OpenCode provider adapters, existing Astra domain/runtime/executor/ledger/git packages.

## Global Constraints

- Preserve OpenCode history, MIT attribution, provider registry, and compatible provider configuration.
- Do not initialize repository-controlled config, plugins, MCP, LSP, formatters, providers, scripts, or Git during workspace open.
- Do not let the TUI, provider model, or subagent grant effect authority.
- Bind every approval to exact resources, workspace identity, Git baseline, and content digests.
- Keep `HOST EXECUTION — NO SANDBOX` visible whenever host effects are possible.
- Treat rejection as a durable no-effect result.
- Never infer `VERIFIED` from process exit zero, provider completion, or an unverified receipt.
- Keep Manual Review as the session default. Auto Review is session-only and may approve only policy-defined low-risk operations.
- Keep push, deployment, publication, destructive actions, and credential changes behind separate manual approval.
- Do not resume sandbox implementation in this milestone.
- Use English for code, comments, docs, identifiers, and commits.
- Run tests and typechecks from package directories, never from the repository root.
- Commit each completed task locally. Do not push, publish, release, tag, or deploy.

---

## Delivery Slice A: Product Entry and Global Control

### Task 1: Make the Launchpad the real default product surface

**Files:**

- Create: `packages/astra-domain/src/launchpad.ts`
- Modify: `packages/astra-domain/package.json`
- Modify: `packages/astra-domain/src/index.ts`
- Modify: `packages/tui/src/astra/no-workspace-mode.tsx`
- Modify: `packages/tui/test/astra/no-workspace-mode.test.tsx`
- Modify: `packages/astra-cli/src/index.ts`
- Modify: `packages/astra-cli/test/cli.test.ts`

**Contract:**

```ts
export type AstraLaunchpadDecision =
  | Readonly<{ kind: "create-project" }>
  | Readonly<{ kind: "open-workspace"; path: string }>
  | Readonly<{ kind: "continue-session"; sessionID: string }>
  | Readonly<{ kind: "open-system" }>
  | Readonly<{ kind: "exit" }>

export type AstraLaunchpadSnapshot = Readonly<{
  recentSessions: ReadonlyArray<Readonly<{ sessionID: string; workspaceRoot: string; updatedAt: string }>>
}>
```

- [ ] Add failing domain tests that reject relative/control-character paths and malformed recent-session records.
- [ ] Add failing TUI tests for Create, Open, Continue, System, Exit, compact layout, and the visible `NO WORKSPACE · NO PROJECT EFFECTS` boundary.
- [ ] Implement a keyboard-first Launchpad in the existing no-workspace module. It may render supplied data but must retain an inert import graph.
- [ ] Return a typed decision from `runAstraNoWorkspaceMode`; do not execute effects inside the TUI module.
- [ ] Make the CLI parent handle Open and System decisions. Opening a path must enter the existing Workspace Gate.
- [ ] Leave Create and Continue disabled with truthful `NOT AVAILABLE YET` labels until Tasks 3 and 8 provide their parent coordinators; never fake success.
- [ ] Run `bun test test/launchpad.test.ts && bun typecheck` from `packages/astra-domain`.
- [ ] Run `bun test test/astra/no-workspace-mode.test.tsx && bun typecheck` from `packages/tui`.
- [ ] Run `bun test test/cli.test.ts && bun typecheck` from `packages/astra-cli`.
- [ ] Commit: `feat(tui): add Astra launchpad`

### Task 2: Replace inert System Mode with a global Control Center

**Files:**

- Create: `packages/astra-domain/src/system-control.ts`
- Create: `packages/astra-domain/test/system-control.test.ts`
- Modify: `packages/astra-domain/package.json`
- Modify: `packages/astra-domain/src/index.ts`
- Modify: `packages/tui/src/astra/system-mode.tsx`
- Modify: `packages/tui/test/astra/system-mode.test.tsx`
- Create: `packages/astra-cli/src/system-control.ts`
- Create: `packages/astra-cli/test/system-control.test.ts`
- Modify: `packages/astra-cli/src/index.ts`

**Contract:**

```ts
export type AstraSystemSnapshot = Readonly<{
  version: string
  executionBackend: "host-no-sandbox"
  reviewMode: "manual" | "auto-session"
  providers: ReadonlyArray<Readonly<{ id: string; name: string; credential: "present" | "missing" | "unknown" }>>
  extensions: ReadonlyArray<Readonly<{ kind: "skill" | "plugin" | "mcp"; id: string; state: string }>>
  recentSessions: ReadonlyArray<Readonly<{ sessionID: string; workspaceRoot: string; updatedAt: string }>>
  recentReceipts: ReadonlyArray<Readonly<{ operationID: string; state: string; observedAt: string }>>
}>

export type AstraSystemDecision =
  | Readonly<{ kind: "connect-provider"; providerID: string }>
  | Readonly<{ kind: "set-review-mode"; mode: "manual" | "auto-session" }>
  | Readonly<{ kind: "exit" }>
```

- [ ] Test strict parsing and prove that snapshots contain credential presence only, never secrets.
- [ ] Test a wide and compact Control Center with Providers, Extensions, Sessions, Receipts, Diagnostics, and the exact `NO WORKSPACE AUTHORITY` boundary.
- [ ] Build the snapshot in the CLI parent from trusted provider metadata, global extension inventory, and ledger projections. Missing sources become explicit `unknown`/empty states.
- [ ] Keep project file, workspace Git, shell, and workspace Operation controls unavailable.
- [ ] Return decisions to the parent. Route credential setup through the trusted parent and preserve separate manual approval.
- [ ] Keep Auto Review in memory for this System session only; do not persist it.
- [ ] Run focused domain, TUI, and CLI tests plus each package typecheck.
- [ ] Commit: `feat(system): add global control center`

### Task 3: Add governed local project creation

**Files:**

- Create: `packages/astra-domain/src/project-creation-control.ts`
- Create: `packages/astra-domain/test/project-creation-control.test.ts`
- Create: `packages/astra-runtime/src/project-creation.ts`
- Create: `packages/astra-runtime/test/project-creation.test.ts`
- Create: `packages/astra-cli/src/project-creation-control.ts`
- Create: `packages/astra-cli/test/project-creation-control.test.ts`
- Modify: `packages/tui/src/astra/no-workspace-mode.tsx`
- Modify: `packages/tui/test/astra/no-workspace-mode.test.tsx`

**Contract:** Project creation collects name, absolute parent directory, objective, proposed stack, proposed files, and optional local Git initialization. It produces a preview first. Directory creation, every file write, dependency installation, and Git initialization are separate typed operations. Remote repository creation and push are not offered in this milestone.

- [ ] Write negative tests proving cancel/reject creates no directory and runs no process.
- [ ] Write stale-parent and existing-target tests that block before dispatch.
- [ ] Reuse the controlled-write and host-command coordinator patterns; do not bypass the ledger or invent a second executor.
- [ ] Add the guided Launchpad flow and return to the Workspace Gate only after the approved local project exists.
- [ ] Verify exact created paths and contents; report Git initialization as observed unless independently verified.
- [ ] Run focused tests and typechecks for domain, runtime, CLI, and TUI.
- [ ] Commit: `feat(project): govern local project creation`

---

## Delivery Slice B: One Observable Work Session

### Task 4: Define the durable work-session projection

**Files:**

- Create: `packages/astra-domain/src/work-session.ts`
- Create: `packages/astra-domain/test/work-session.test.ts`
- Create: `packages/astra-runtime/src/work-session-store.ts`
- Create: `packages/astra-runtime/test/work-session-store.test.ts`
- Modify: `packages/astra-domain/package.json`
- Modify: `packages/astra-runtime/package.json`

**Contract:**

```ts
export type AstraWorkPhase =
  | "idle" | "analyzing" | "plan-review" | "working" | "review-ready"
  | "applying" | "checking" | "commit-ready" | "completed" | "blocked"
  | "uncertain" | "reconciliation-required"

export type AstraAgentProjection = Readonly<{
  agentID: string
  parentAgentID: string | null
  label: string
  task: string
  activity: string
  state: "queued" | "working" | "waiting" | "completed" | "failed" | "cancelled" | "lost"
  effectAuthority: "none"
}>

export type AstraWorkSessionProjection = Readonly<{
  sessionID: string
  workspaceRoot: string
  objective: string | null
  phase: AstraWorkPhase
  intent: Readonly<{ summary: string; next: string }>
  agents: ReadonlyArray<AstraAgentProjection>
  decisions: ReadonlyArray<Readonly<{ decisionID: string; kind: string; summary: string }>>
  evidence: ReadonlyArray<Readonly<{ kind: "git" | "test" | "receipt"; label: string; value: string; assurance: string }>>
  candidatePatchID: string | null
  updatedAt: string
}>
```

- [ ] Test legal phase transitions and reject illegal success shortcuts.
- [ ] Test that subagents always have `effectAuthority: "none"`.
- [ ] Store session projections and append-only events in a dedicated SQLite file under Astra app state, not inside the workspace.
- [ ] Test exact reload after process restart and explicit session deletion/export.
- [ ] Never resume an ambiguous effect automatically.
- [ ] Run domain/runtime tests and typechecks.
- [ ] Commit: `feat(session): persist observable work state`

### Task 5: Expose one typed session event stream to the TUI

**Files:**

- Create: `packages/astra-domain/src/work-session-control.ts`
- Create: `packages/astra-domain/test/work-session-control.test.ts`
- Create: `packages/astra-cli/src/work-session-control-handler.ts`
- Create: `packages/astra-cli/test/work-session-control.test.ts`
- Modify: `packages/astra-cli/src/tui-control-server.ts`
- Modify: `packages/astra-cli/src/tui-launcher.ts`
- Create: `packages/tui/src/astra/work-session-client.ts`
- Create: `packages/tui/test/astra/work-session-client.test.ts`

**Protocol methods:** `work-session.snapshot`, `work-session.subscribe`, `work-session.decide`, and `work-session.cancel`. Reuse the existing authenticated per-session Unix socket, size limits, request IDs, and fail-closed parsing.

- [ ] Test wrong token, wrong session, oversized frames, malformed event order, disconnect, reconnect, and cancellation.
- [ ] Project only parent-owned state. Do not derive completion from TUI-local state.
- [ ] Ensure a lost connection renders `STATE UNAVAILABLE`, never idle or success.
- [ ] Run focused tests and package typechecks.
- [ ] Commit: `feat(control): stream Astra work state`

### Task 6: Make the cockpit adaptive and contextual

**Files:**

- Modify: `packages/tui/src/component/astra-cockpit.tsx`
- Create: `packages/tui/src/component/astra-control-rail.tsx`
- Create: `packages/tui/src/component/astra-review-mode.tsx`
- Modify: `packages/tui/src/routes/home.tsx`
- Modify: `packages/tui/test/cli/tui/astra-cockpit.test.tsx`
- Create: `packages/tui/test/cli/tui/astra-review-mode.test.tsx`

- [ ] Add failing snapshots/assertions for wide, medium, narrow, short, decision, multi-agent, review-ready, failed-agent, and reconciliation states.
- [ ] Keep chat as the entire left work area during analysis and execution.
- [ ] Render only contextual `INTENT`, `WORK TREE`, `PROOF`, and conditional `DECISION` sections.
- [ ] Make the top bar exactly one row: workspace, branch, provider/model, review mode.
- [ ] Give a pending decision visual priority without hiding its exact resources or boundary.
- [ ] On narrow terminals, keep chat full screen and expose the rail via a documented keyboard toggle.
- [ ] Enter Review Mode only for a complete candidate patch; returning to chat preserves scroll and draft input.
- [ ] Keep Lynx a compact coordinator-state indicator and honor reduced motion.
- [ ] Run TUI focused tests and typecheck.
- [ ] Commit: `feat(tui): add adaptive Astra work surface`

---

## Delivery Slice C: Governed AI Work and Delegation

### Task 7: Generalize provider control to the OpenCode provider registry

**Files:**

- Modify: `packages/astra-domain/src/provider-control.ts`
- Modify: `packages/astra-domain/test/provider-control.test.ts`
- Replace: `packages/astra-runtime/src/anthropic-one-turn.ts` usage with a provider-adapter boundary in `packages/astra-runtime/src/provider-turn-adapter.ts`
- Create: `packages/astra-runtime/src/provider-adapters/anthropic.ts`
- Create: `packages/astra-runtime/src/provider-adapters/openai.ts`
- Modify: `packages/astra-runtime/src/provider-turn-coordinator.ts`
- Modify: `packages/astra-cli/src/provider-catalog.ts`
- Modify: `packages/astra-cli/src/provider-control.ts`
- Modify: `packages/astra-cli/src/provider-credential-broker.ts`
- Modify: `packages/tui/src/feature-plugins/system/astra-chat.tsx`
- Modify focused tests in domain, runtime, CLI, and TUI.

**Contract:** Provider catalog entries use general string provider IDs and destinations validated by the selected trusted adapter. Anthropic and OpenAI/Codex are certified first. Other OpenCode providers remain visible as compatible/unverified and cannot be silently mapped to a certified adapter.

- [ ] Add failing tests for Anthropic, OpenAI/Codex, unsupported provider, destination mismatch, credential absence, provider failure, and rejection without egress.
- [ ] Generate provider metadata from the preserved OpenCode registry and keep the embedded snapshot drift check.
- [ ] Keep credentials in the trusted parent; the child receives presence/fingerprint only.
- [ ] Bind each turn to provider, model, destination, exact bounded context digest, and conversation history digest.
- [ ] Persist consented multi-turn history locally through the work-session store.
- [ ] Remove Anthropic-only labels from the TUI.
- [ ] Run `bun run check:provider-catalog`, focused tests, and package typechecks.
- [ ] Commit: `feat(provider): support certified provider adapters`

### Task 8: Add plan approval and visible bounded subagents

**Files:**

- Create: `packages/astra-domain/src/task-plan.ts`
- Create: `packages/astra-domain/test/task-plan.test.ts`
- Create: `packages/astra-runtime/src/task-coordinator.ts`
- Create: `packages/astra-runtime/test/task-coordinator.test.ts`
- Modify: `packages/astra-runtime/src/work-session-store.ts`
- Modify: `packages/astra-cli/src/work-session-control-handler.ts`
- Modify: `packages/tui/src/feature-plugins/system/astra-chat.tsx`
- Modify: `packages/tui/src/component/astra-control-rail.tsx`

- [ ] Test that analysis is read-only and a model-produced plan cannot start effects or agents before approval.
- [ ] Bind approval to the exact plan digest and workspace/Git baseline.
- [ ] After approval, allow the coordinator to create bounded read/analysis workers and show parent-child state live.
- [ ] Route every proposed risky effect back through the parent Operation Kernel; subagent APIs expose no approval or executor capability.
- [ ] Persist agent completion, failure, cancellation, and lost-contact events.
- [ ] Do not collapse a partial failure into overall success.
- [ ] Run focused tests and typechecks.
- [ ] Commit: `feat(agent): coordinate visible bounded workers`

### Task 9: Add Manual Review and deterministic Auto Review

**Files:**

- Create: `packages/astra-domain/src/review-policy.ts`
- Create: `packages/astra-domain/test/review-policy.test.ts`
- Create: `packages/astra-runtime/src/auto-reviewer.ts`
- Create: `packages/astra-runtime/test/auto-reviewer.test.ts`
- Modify: `packages/astra-runtime/src/task-coordinator.ts`
- Modify: `packages/tui/src/component/astra-control-rail.tsx`

- [ ] Encode an explicit low-risk allowlist; default every unknown operation to manual review.
- [ ] Prove Auto Review cannot approve push, deploy, publish, destructive actions, credentials, changed baselines, or broader resources.
- [ ] Record the exact policy rule and input digest in the approval fact.
- [ ] Keep mode session-only and allow immediate switch back to Manual Review.
- [ ] Run domain/runtime/TUI tests and typechecks.
- [ ] Commit: `feat(policy): add session auto review`

---

## Delivery Slice D: Atomic Patch, Evidence, and Git Completion

### Task 10: Model a complete candidate patch

**Files:**

- Create: `packages/astra-domain/src/candidate-patch.ts`
- Create: `packages/astra-domain/test/candidate-patch.test.ts`
- Create: `packages/astra-runtime/src/candidate-patch-store.ts`
- Create: `packages/astra-runtime/test/candidate-patch-store.test.ts`

**Contract:** A candidate patch contains an immutable patch ID, workspace identity, Git baseline digest, ordered file changes, before/after content digests, modes, symlink policy, total byte limits, and one aggregate digest. It is stored outside the workspace before review.

- [ ] Test create/modify/delete/rename, binary rejection, symlink rejection, traversal rejection, duplicate paths, oversized patch, stale baseline, and digest mismatch.
- [ ] Store candidate bytes atomically under private Astra state permissions.
- [ ] Support per-file exclusion by deriving a new patch and digest; never mutate an approved patch in place.
- [ ] Run domain/runtime tests and typechecks.
- [ ] Commit: `feat(patch): store immutable candidate patches`

### Task 11: Add Review Mode and governed atomic patch application

**Files:**

- Create: `packages/astra-domain/src/candidate-patch-control.ts`
- Create: `packages/astra-runtime/src/candidate-patch-coordinator.ts`
- Create: `packages/astra-executor/src/patch-worker.ts`
- Create: `packages/astra-cli/src/candidate-patch-control-handler.ts`
- Modify: `packages/astra-cli/src/tui-control-server.ts`
- Modify: `packages/tui/src/component/astra-review-mode.tsx`
- Add focused tests in domain, executor, runtime, CLI, and TUI.

- [ ] Write negative tests first: reject produces no file change; stale baseline, changed file, changed symlink, traversal, partial write, worker loss, and receipt loss never report success.
- [ ] Render the complete diff, changed paths, modes, byte counts, and excluded files.
- [ ] Bind approval to exact selected patch digest and current authority.
- [ ] Revalidate workspace identity, Git baseline, and every before digest immediately before dispatch.
- [ ] Apply through one parent-owned executor invocation using temp files plus atomic renames where supported.
- [ ] If the patch cannot be completed atomically or rolled back exactly, stop at `RECONCILIATION REQUIRED` with affected paths.
- [ ] Independently verify exact after digests before using scoped `VERIFIED` wording.
- [ ] Run focused tests and typechecks.
- [ ] Commit: `feat(patch): govern reviewed file changes`

### Task 12: Run approved checks with accurate evidence

**Files:**

- Create: `packages/astra-domain/src/check-operation.ts`
- Create: `packages/astra-runtime/src/check-coordinator.ts`
- Reuse and extend: `packages/astra-runtime/src/host-command.ts`
- Create: `packages/astra-cli/src/check-control-handler.ts`
- Modify: `packages/tui/src/component/astra-control-rail.tsx`
- Add focused tests in domain, runtime, CLI, and TUI.

- [ ] Preview exact command, cwd, environment names, timeout, output limit, and host boundary.
- [ ] Require approval unless the session Auto Review policy allows the exact check.
- [ ] Record stdout/stderr digests, exit code, signal, duration, truncation, and receipt.
- [ ] Label exit zero as `PASSED (OBSERVED COMMAND RESULT)`, not objective verification.
- [ ] Label timeout, signal, output truncation, and lost receipt accurately.
- [ ] Attach check evidence to the current patch/task projection.
- [ ] Run focused tests and typechecks.
- [ ] Commit: `feat(check): record governed task evidence`

### Task 13: Complete the local Git task workflow

**Files:**

- Create: `packages/astra-domain/src/git-branch-control.ts`
- Create: `packages/astra-domain/src/git-fetch-control.ts`
- Create: `packages/astra-git/src/branch.ts`
- Create: `packages/astra-git/src/fetch.ts`
- Extend existing stage/unstage/commit coordinators and TUI clients.
- Create: `packages/astra-runtime/src/commit-suggestion.ts`
- Modify: `packages/tui/src/feature-plugins/system/astra-git-control.tsx`
- Add focused tests in domain, git, runtime, CLI, and TUI.

- [ ] Refresh status/diff from the parent and show branch, upstream, ahead/behind, staged, unstaged, untracked, conflicts, and stash count.
- [ ] Add local branch creation/switch with preview and current-baseline binding.
- [ ] Add fetch as a network Operation with explicit remote/refspec preview and manual approval.
- [ ] Keep pull as an explicit fetch-plus-integration plan. Block automatic merge/rebase when the worktree is dirty or the result is not fast-forward; do not implement push here.
- [ ] Generate an English Conventional Commit suggestion from the approved selected diff and observed checks. Do not claim tests passed without evidence.
- [ ] Preview exact staged diff, author, message, excluded unrelated files, and receipt before commit.
- [ ] Preserve stage and commit as separate governed Operations.
- [ ] Show the exact commit hash and included paths after independent verification.
- [ ] Run focused tests and typechecks.
- [ ] Commit: `feat(git): complete local task workflow`

### Task 14: Restore sessions and expose reconciliation

**Files:**

- Modify: `packages/astra-runtime/src/work-session-store.ts`
- Modify: `packages/astra-runtime/src/operation-storage.ts`
- Modify: `packages/astra-cli/src/system-control.ts`
- Modify: `packages/tui/src/astra/no-workspace-mode.tsx`
- Create: `packages/tui/src/component/astra-recovery-view.tsx`
- Add restart/recovery tests in runtime, CLI, and TUI.

- [ ] Restore chat, objective, plan, work tree, candidate patch, decisions, operations, approvals, receipts, and evidence after restart.
- [ ] Revalidate workspace identity and Git baseline before resuming a session.
- [ ] Resume only read-only/coordinator work automatically. Require a new decision for stale authority and reconciliation for ambiguous effects.
- [ ] Make Continue Session functional from Launchpad.
- [ ] Add export and delete actions with exact local paths and manual confirmation for deletion.
- [ ] Run focused tests and typechecks.
- [ ] Commit: `feat(recovery): resume Astra work sessions`

---

## Delivery Slice E: Integration and Work-Ready Gate

### Task 15: Run the real macOS acceptance matrix

**Files:**

- Modify: `packages/astra-cli/script/verify-demo.ts`
- Create: `packages/astra-cli/script/verify-work-ready.ts`
- Modify: `docs/astra/macos-verification.md`
- Modify: `docs/astra/STATUS.md`
- Modify: `docs/astra/ROADMAP.md`

- [ ] Run frozen install from the documented toolchain.
- [ ] Run `bun test` and `bun typecheck` from `packages/astra-domain`, `packages/astra-ledger`, `packages/astra-executor`, `packages/astra-runtime`, `packages/astra-git`, `packages/astra-cli`, and `packages/tui`.
- [ ] Run `bun run verify:demo` from `packages/astra-cli`.
- [ ] Prove workspace open causes zero file, process, network, plugin, MCP, LSP, formatter, or repository-script effects.
- [ ] Prove provider-turn rejection causes zero egress and patch/check/Git rejection causes zero effect.
- [ ] Smoke `astra`, `astra system`, and `astra .` in a real PTY at wide and compact sizes.
- [ ] Smoke Anthropic and OpenAI/Codex connect, bounded multi-turn chat, plan approval, visible subagents, `REVIEW READY`, file exclusion, rejection, controlled apply, approved checks, commit suggestion, stage, commit, operations, restart, and recovery.
- [ ] Set `ASTRA_GIT_AUTHOR_NAME` and `ASTRA_GIT_AUTHOR_EMAIL` only for the isolated smoke fixture.
- [ ] Confirm no push, remote repository creation, publication, deploy, release, tag, signing, or notarization occurred.
- [ ] Record measured counts and exact failures; do not hide inherited or platform failures.
- [ ] Commit: `docs(astra): record work-ready evidence`

### Task 16: Perform one independent blocker review

**Files:** Review the complete diff from commit `e946818a8` through Task 15. Modify only files needed for confirmed findings, then update `docs/astra/STATUS.md`.

- [ ] Ask one independent reviewer to inspect invariants, authority boundaries, no-effect denials, stale baseline handling, truthful assurance wording, credential isolation, responsive UX, and provider compatibility.
- [ ] Fix confirmed P0/P1 findings with focused regression tests.
- [ ] Rerun every affected package test/typecheck and the real work-ready smoke.
- [ ] Record remaining P2/P3 findings without claiming the milestone is complete if any blocker remains.
- [ ] Run `git diff --check` and confirm the worktree contains only intended changes.
- [ ] Commit: `fix(astra): close work-ready review findings` only when fixes exist; otherwise `docs(astra): record work-ready review`.

## Completion Evidence

The milestone is complete only when all task checkboxes are satisfied, the real TUI demonstrates the approved journey, the negative cases prove no effect, the positive flow produces exact observable outcomes, all relevant package checks are green or explicitly reported, and the independent review has no open blocker. Publication and cross-platform release remain separate work.
