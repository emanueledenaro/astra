# Astra Command Integration Design

Status: approved by the product owner on 2026-07-20.

## Outcome

Astra exposes the useful OpenCode command surface through one authoritative,
professional, and governed command system. A developer can open `/help`, see only
commands that are genuinely usable in the current state, discover the same set through
autocomplete and the command palette, and execute a command without encountering a
second routing or policy system.

The milestone adapts existing OpenCode behavior instead of rebuilding it. It preserves
the OpenCode provider registry, sessions, models, configuration-derived commands, and
extension contributions while placing risky effects behind Astra's Operation Kernel.

The result is not an inventory of visible names. Every discovered command is either:

- available and connected to a verified route; or
- excluded from the operational catalog with a precise, recorded technical reason.

## Scope

The milestone includes:

- session, navigation, and configuration commands such as `/new`, `/sessions`,
  `/workspaces`, `/models`, `/agents`, `/connect`, `/mcps`, `/skills`, `/status`,
  `/help`, and `/exit`;
- work commands such as `/init`, `/review`, `/search`, `/editor`, `/write`, and
  `/shell`;
- Astra Git commands such as `/git`, `/git-stage`, `/git-commit`, status, diff, and a
  task-scoped commit-message proposal;
- observability through `/operations`, operation timelines, receipts, subagent state,
  errors, and recovery state;
- commands derived from OpenCode configuration, skills, plugins, and MCP servers;
- existing OpenCode providers and the familiar `/connect` flow;
- Astra's adaptive work surface: chat on the left, operational control on the right,
  and Review Mode only when a patch or diff requires attention.

The milestone does not include a general macOS sandbox, automatic push or deployment,
new providers not already supported by OpenCode, release publication, or broad OpenCode
architecture rewrites.

## Product invariants

- No shell, process, file write, Git mutation, provider egress, or effectful plugin or
  MCP action starts without an exact preview and explicit authority.
- The preview identifies the action, target, resources, expected impact, and execution
  boundary.
- `HOST EXECUTION — NO SANDBOX` remains visible whenever an available action can affect
  the Mac.
- Rejection produces no effect.
- Important operations have visible, truthful lifecycle state.
- A command exit code, provider finish event, or observed effect is not independently
  verified success.
- Subagents and extensions cannot approve or broaden their own authority.
- Push, deploy, publication, release, destructive reset, and remote mutation require a
  separate manual authorization.
- Help, autocomplete, palette, shortcuts, availability, policy, and routing derive from
  one command source of truth.

## Chosen architecture

### Authoritative registry

`AstraCommandRegistry` is the single command source of truth. Commands are registered
as typed descriptors before they become visible or executable. The registry validates
identity, aliases, metadata, requirements, authority, and routing, rejects collisions,
and publishes an immutable snapshot for the current product state.

The registry is authoritative; the OpenTUI keymap is a projection and dispatch surface,
not a second command catalog. The current static Safe Start allowlist remains only as a
temporary compatibility guard and is removed after every reachable command is covered
by the registry.

### Command descriptor

Each descriptor contains:

- a stable canonical command ID;
- slash name and aliases;
- title, concise description, category, and source;
- supported surfaces such as help, autocomplete, palette, shortcut, or internal-only;
- requirements for workspace, provider, durable session, Git, skill, plugin, or MCP;
- one classification: `safe/read-only`, `requires provider`, `requires workspace`, or
  `risky effect`;
- current availability and an exact unavailable reason where applicable;
- an execution route owned by the trusted parent;
- preview and approval requirements for effects;
- assurance and evidence expectations for the result.

Descriptors are strict data. They do not contain arbitrary effect callbacks originating
from untrusted configuration or a child TUI.

### Registry snapshot

The trusted parent evaluates registered descriptors against a bounded runtime context:

- admitted workspace and session authority;
- selected provider and credential-profile availability without secret material;
- current Git capability and baseline state;
- enabled built-in Astra surfaces;
- validated skill, plugin, and MCP contributions;
- review mode and execution boundary.

It then publishes an immutable, digest-bound command snapshot to the TUI. The TUI uses
that exact snapshot for help, autocomplete, palette entries, descriptions, disabled
reasons, and local navigation intent. It never grants command authority itself.

Availability is recalculated when the authoritative context changes. A stale snapshot
cannot authorize a command.

### Adapters

Commands enter the registry through bounded adapters:

1. The OpenCode built-in adapter maps inherited application and session commands to
   Astra descriptors while reusing their safe behavior.
2. The Astra feature adapter registers governed chat, file, shell, Git, operation, and
   extension surfaces.
3. The dynamic contribution adapter accepts configuration, skill, plugin, and MCP
   commands only after strict validation and policy classification.

An adapter cannot bypass the registry or install a second slash-command route. Dynamic
commands without complete requirements, authority metadata, and an approved route are
excluded fail-closed. Their source and exclusion reason remain available in the global
Control Center diagnostics.

### Routing

The command flow is:

```text
user input
  -> exact command or alias resolution
  -> current snapshot and availability validation
  -> safe parent route or typed Operation proposal
  -> exact preview in the Control Rail
  -> manual or permitted session-only review decision
  -> bounded effect through the Operation Kernel
  -> durable receipt and truthful result projection
```

Safe navigation can dispatch directly inside the trusted product boundary. Risky
commands cannot own a direct handler. They produce a typed intent that is revalidated
by the parent and converted into an Operation.

Remote TUI events, plugin messages, MCP traffic, and subagents cannot dispatch local
approval or rejection commands. Shortcut, slash, palette, and remote-event paths all
pass through the same registry resolution and parent validation.

## Discovery and interaction

Typing `/` queries the current registry projection. Available commands are grouped by
purpose:

```text
SESSION      /new /sessions /workspaces
AI           /connect /models /agents
WORK         /init /review /search /editor /write /shell
GIT          /git /git-stage /git-commit
EXTENSIONS   /skills /mcps
CONTROL      /operations /status /help /exit
```

Each result can show its description, shortcut, requirements, risk class, and source.
Configuration- or extension-derived entries identify their contributor.

`/help` and autocomplete show only commands that are usable in the current state. The
global Control Center provides a separate diagnostic inventory of excluded commands and
their reasons. This keeps the operational surface honest without hiding compatibility
information from the developer.

OpenCode slash names and aliases are preserved when they are unambiguous. A collision
between canonical names or aliases rejects the later contribution; Astra never chooses
a silent winner.

## TUI behavior

- Chat remains the left work area.
- Help and the command palette appear as temporary overlays.
- A risky command raises `DECISION` in the right Control Rail without replacing chat.
- The rail displays the exact command, target, resources, authority, boundary, and
  available decisions before consent.
- A patch or diff replaces the left area only in Review Mode.
- The result returns to the rail as lifecycle state, evidence, and receipt; chat receives
  a concise outcome summary.
- Compact layouts cannot expose approve or reject controls until the exact preview has
  been rendered through their accessible control view.

Commands and lifecycle state remain visible independently. Losing the parent state
stream results in `STATE UNAVAILABLE`, never a fabricated idle or successful state.

## Command classes

### Safe and read-only

Navigation, help, status, selection dialogs, bounded read-only inspection, and other
commands with no risky effect can execute without an Operation when their requirements
are satisfied. Their availability is still parent-owned.

### Provider or workspace required

Commands that need a provider, credential profile, admitted workspace, durable session,
or current Git state remain absent from the operational catalog until those requirements
are true. Selection and connection actions can remain available when their purpose is to
satisfy the missing requirement.

### Risky effects

Credential changes, provider egress, shell, editor/process launch, file writes, Git
mutations, extension activation, and MCP tool invocation require a typed Operation.
Their descriptors define preview requirements and result assurance but do not perform
the effect.

## Error handling

- Unknown command: show suggestions from the same current registry snapshot.
- Unavailable command: show the precise unmet requirement and perform no effect.
- Invalid dynamic contribution: exclude it and record a bounded diagnostic.
- Alias or command collision: reject the conflicting contribution fail-closed.
- Rejected command: record `DENIED` with no dispatch.
- Lost acknowledgement or ambiguous outcome: show `UNCERTAIN` or
  `RECONCILIATION REQUIRED`.
- Process exit zero: report the observed exit, not objective verification.
- Parent state loss: show `STATE UNAVAILABLE` and disable decisions.
- Registry snapshot drift: re-resolve and require a new decision instead of executing
  against stale metadata.

## Migration sequence

The implementation is limited to six command-integration cycles:

1. Inventory all reachable OpenCode and Astra commands and produce the authoritative
   classification matrix.
2. Introduce the registry and derive `/help`, autocomplete, palette, shortcuts, and
   policy from its snapshot.
3. Connect session, workspace, provider, model, agent, and configuration commands.
4. Connect work, file, shell, review, and Git commands through the Operation Kernel.
5. Connect skills, plugins, MCP, configuration-derived commands, and observability.
6. Run the complete real-product smoke, close confirmed defects, and complete one
   independent read-only guard review.

Each cycle begins with a failing test or observable product gap, connects a small command
group, runs focused verification, and records evidence before the next group. Broad
unrelated refactors are excluded.

## Verification

### Registry invariants

- Help, autocomplete, palette, shortcuts, policy, and routing consume the same snapshot.
- Canonical IDs and aliases are unique.
- Unavailable or hidden commands cannot be invoked through alternate surfaces.
- Dynamic contributions without valid metadata are rejected.
- Snapshot mutation or stale context fails closed.

### Negative effect tests

- Rejecting shell launches no process.
- Rejecting write changes no file.
- Rejecting Git changes neither index nor refs.
- Rejecting provider egress opens no network dispatch.
- Rejecting plugin or MCP effects activates nothing.

### Product evidence

- `/help` exactly matches the usable command inventory.
- `/connect` selects a preserved OpenCode provider and a real chat receives a response.
- `/skills`, `/mcps`, and `/agents` show real parent-owned resources.
- `/operations` shows completed, denied, failed, and uncertain outcomes accurately.
- A task with changes produces a commit-message proposal derived from the reviewed diff
  but never commits without consent.
- A real macOS TUI smoke covers provider, multi-turn chat, rejected shell, approved file
  change, approved stage and commit, and visible receipt.
- A read-only independent review finds no violation of the product invariants.

Affected packages must pass their unit and integration tests, typechecks, lint, build,
and diff checks. A command is not considered complete until it has been invoked through
the real Astra TUI.

## Completion

The milestone is complete only when every supported OpenCode command has an authoritative
classification and is either usable through Astra or excluded with a recorded reason;
the operational command surfaces are consistent; all risky paths are governed; the real
smoke passes; and the independent review has no open guard violation.

General sandboxing, automatic external publication, new providers, and unrelated
OpenCode rewrites remain outside this milestone and visible in the product backlog.
