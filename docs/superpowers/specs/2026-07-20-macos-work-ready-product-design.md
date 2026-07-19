# Astra macOS work-ready product design

Status: approved by the product owner on 2026-07-20.

## Outcome

Astra becomes a professional terminal AI development environment that makes intent, authority, execution, delegation, Git state, and evidence continuously understandable. It reuses the OpenCode engine and provider registry while adding an Astra-owned control plane around risky effects.

The first delivery target is a work-ready macOS core. Plugin and MCP hardening, a general sandbox, full provider certification, Linux and Windows certification, and release packaging follow without weakening the first product's claims.

## Product invariants

- Opening a workspace never executes repository-controlled code or initializes plugins, MCP, LSP, formatters, providers, or repository scripts.
- The TUI never performs risky effects directly. Shell, processes, file writes, Git mutations, network egress, provider calls, and extension activation cross the Operation Kernel.
- Every important operation has a visible state and never reports stronger guarantees than the available evidence.
- Rejection produces no effect.
- `HOST EXECUTION — NO SANDBOX` remains visible whenever host effects are possible.
- Push, publication, deployment, destructive actions, and credential changes always require separate manual approval.

## Entry points

- `astra` opens the Launchpad.
- `astra .` proposes the current directory as a workspace.
- `astra /absolute/path` proposes the specified directory.
- `astra system` opens the inert system surface without a workspace.

## Launchpad

When no project is open, Astra shows a keyboard-first launch surface with one primary action and no effects:

1. Create a new project.
2. Open an existing workspace.
3. Continue a recent local session.
4. Exit or open System Mode.

Creating a project is guided. Astra collects the project name, location, and desired outcome; proposes the stack, files, commands, and Git initialization; previews each effect; and executes only approved operations. Dependency installation and remote repository creation are separate decisions. Astra never creates a GitHub repository or pushes automatically.

Visual reference: [Launchpad](../../astra/design/launchpad-reference.png). This image defines hierarchy and identity, not literal implementation dimensions.

## Workspace admission

Before the work surface appears, Astra performs a bounded static preflight and shows:

- workspace path;
- scan limits and observed surfaces;
- Git baseline state;
- trust posture;
- read-only, activate-once, and exit choices.

Trust is session-only in this delivery. Activation is never persisted automatically.

## Daily work surface

The normal desktop-terminal layout is adaptive:

- one-row context bar: workspace, branch, provider/model, and review mode;
- left work area, normally about 70 percent: the complete chat and current user-facing artifact;
- right control rail, normally about 30 percent: contextual operational control;
- one-row boundary bar: execution boundary and relevant shortcuts.

The left area remains the full chat during planning and execution. A patch is not a permanent chat section.

The control rail contains only sections that answer a current user question:

- `INTENT`: what Astra is trying to achieve and what happens next;
- `WORK TREE`: which coordinator and subagents exist, their state, and their current action;
- `PROOF`: compact observed Git, test, and receipt facts.

`DECISION` appears only while user authority is required and temporarily receives visual priority. Empty, redundant, or decorative sections do not render. Git, tests, and receipts are not separate permanent panels.

Visual reference: [Cockpit](../../astra/design/cockpit-reference.png). The approved correction takes precedence over the image: the left side is chat during work, and the diff replaces the left view only in Review Mode.

### Responsive behavior

- Wide terminal: chat and control rail remain side by side near 70/30.
- Medium terminal: the control rail narrows and secondary details collapse.
- Narrow or short terminal: chat becomes full-screen and control opens as a keyboard-accessible view.
- Astra never clips required decisions, boundary labels, or operation state.

### Lynx

Lynx communicates coordinator state rather than decorating the screen. The work surface uses a small state mark or compact illustration. It may animate for working, attention, blocked, or completed states and must respect reduced-motion preferences. The terminal glyph fallback remains functional when image protocols are unavailable.

## Task journey

1. The developer describes an objective in chat.
2. Astra previews provider-bound context. Sending or approving the request grants that bounded egress only.
3. Astra analyzes read-only and proposes a plan.
4. The developer approves the plan.
5. Astra may create visible subagents automatically after plan approval. Subagents never receive direct authority for risky effects.
6. Chat remains visible while the right rail reports intent, work tree, decisions, and proof.
7. Astra prepares one complete candidate patch without applying it.
8. When ready, Astra reports `REVIEW READY`. It never steals focus while the developer is typing.
9. Review Mode replaces the left chat view with the full diff. The developer may inspect files, exclude files, return to chat, approve, or reject.
10. Rejection changes nothing. Approval authorizes only the reviewed patch and selected files.
11. Astra applies the patch through the Operation Kernel.
12. Authorized tests run and report accurate observed states.
13. The left view returns to chat with a concise outcome and evidence summary.
14. Astra proposes a local commit for the task.

The task is not complete when the patch is merely prepared. Completion requires the approved effect, the requested checks, and an accurate final state.

## Approval model

Manual Review is the default for every new session. Auto Review can be explicitly enabled for the current session only and is never persisted automatically.

Auto Review is an independent deterministic reviewer. It evaluates the exact operation, resources, workspace authority, Git baseline, and risk; records its reason; and cannot broaden the requested scope. It may approve low-risk in-session operations. Push, deployment, publication, destructive actions, and credential changes remain manual.

The developer can change review mode at any time. A pending decision shows exact resources, boundary, command or patch, and available actions.

## Providers and conversation

Astra preserves the complete OpenCode provider registry. Anthropic and OpenAI/Codex are the first certified provider paths; other providers remain compatible and are progressively verified.

Provider requests show the destination and bounded context before egress. Provider failure never mutates files. Multi-turn history, operation state, approvals, and receipts persist locally and can be resumed, exported, or deleted.

## Subagents

After a plan is approved, the coordinator may create bounded subagents automatically. The work tree shows parent-child relationships, task, current activity, state, and result. Subagents propose effects through the parent Operation Kernel and cannot approve their own effects.

Completing, failing, cancelling, or losing contact with a subagent produces an explicit event. Astra never collapses a partially failed team into an overall success.

## Patch review and file effects

Astra proposes one atomic task patch. Review Mode supports whole-patch approval, per-file exclusion, and rejection. The authorized patch is bound to content digests and the current workspace/Git baseline. A changed baseline invalidates authorization and requires a new review.

If application is partial or ambiguous, Astra stops and reports `RECONCILIATION REQUIRED`; it does not report success or continue to tests as though the patch were complete.

## Git task completion

After the approved patch and requested checks, Astra automatically proposes an English Conventional Commit message derived from the approved diff and observed evidence.

The commit preview includes:

- selected files and exact staged diff;
- proposed subject and optional body;
- author identity;
- observed test state;
- unrelated modifications excluded from the task.

When changes contain multiple independent concerns, Astra proposes separate commits. The developer may edit the message, exclude files, approve, or cancel. Stage and commit are distinct governed Git operations and execute only after approval. The result shows the commit hash, included paths, and receipt. Push is always a separate manual operation.

Commit messages never claim verification or passing tests without corresponding evidence.

## Technical architecture

Astra uses the recommended layered extension of OpenCode:

1. The TUI renders typed state and submits intent or decisions.
2. The session coordinator owns objectives, plans, conversation, and subagent orchestration.
3. OpenCode provider adapters preserve provider compatibility.
4. The Operation Kernel is the only gateway to provider egress, files, shell, Git, MCP, plugins, and other risky effects.
5. Manual or Auto Review grants bounded authority.
6. Effect adapters perform the authorized operation.
7. The durable ledger records lifecycle, authority, observed outcome, proof, and recovery data.
8. A typed event stream projects the real state into the TUI.

Host execution implements an execution-backend interface. A later sandbox backend replaces that adapter without rewriting chat, approvals, Git, operations, or TUI state.

## Operation states and recovery

Important operations use explicit states such as `proposed`, `awaiting_approval`, `approved`, `running`, `completed`, `denied`, `failed`, `cancelled`, `uncertain`, and `reconciliation_required`.

- A timeout or lost acknowledgement becomes `uncertain`, never success.
- A process exit of zero is an observed successful exit, not automatically a verified objective.
- Restart restores local chat, objective, work tree, operations, approvals, and receipts.
- Recoverable operations resume only when their contract permits it; ambiguous effects require reconciliation.
- A stale Git or workspace baseline blocks mutation.
- Provider failure leaves the workspace unchanged.

## First work-ready macOS acceptance

The product milestone is complete only when the real TUI demonstrates:

1. Launchpad and guided local project creation.
2. Safe admission of an existing workspace with no automatic effects.
3. Real Anthropic and OpenAI/Codex connection paths.
4. Multi-turn chat with bounded provider egress.
5. Plan review and approval.
6. Visible automatic subagents with no direct effect authority.
7. Complete Review Mode for a candidate patch.
8. Rejection without effects.
9. Controlled patch application.
10. Accurate test state without false verification.
11. Automatic commit-message proposal.
12. Governed local stage and commit.
13. Durable restart recovery.
14. Correct wide, medium, and compact terminal behavior.
15. Separate manual approval for push and every prohibited external action.

The milestone requires focused tests, negative effect tests, package typechecks, a real macOS smoke, and one independent code review with no open blocker.

## Deferred hardening

- General macOS sandbox enforcement and later Linux/Windows sandbox backends.
- Persistent workspace trust.
- Full provider certification beyond the first two paths.
- Complete plugin and MCP isolation and capability brokering.
- Cross-platform certification.
- Release packaging, Homebrew/npm publication, signing, and distribution.

Deferred work remains visible in the roadmap and must not be described as already implemented.
