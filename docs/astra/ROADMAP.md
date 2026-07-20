# Astra Product Roadmap

Updated: 2026-07-20

## Product rule

Astra may execute directly on the host before the general sandbox is ready, but every risky effect must show an exact preview, require explicit consent, pass through the Operation Kernel, produce durable state and receipts, and avoid false success. Host effects must always show `HOST EXECUTION — NO SANDBOX`.

## 1. Usable local product

- Real AI chat using the preserved OpenCode provider registry.
- Explicit provider and data-egress preview before the first governed network effect.
- Shell and file changes routed through typed Operations with denial without effect.
- Git Control Plane in the TUI for status, diff, stage, unstage, local commit, and recovery.
- Governed plugin, skill, and MCP discovery and activation.
- Complete TUI views for workspace state, operations, evidence, recovery, Git, providers, and extensions.
- No push, deploy, publication, destructive operation, or release without a separate authorization.

## 2. Hardening

- Resolve the preserved sandbox prototype's timeout and cleanup findings, then integrate it behind the existing executor boundary.
- Add stronger credential isolation, plugin and MCP isolation, hostile fixtures, crash reconciliation, and security scans.
- Verify macOS fully and prepare reproducible Linux and Windows test matrices.
- Expand accessibility, performance, recovery, upgrade, and upstream-compatibility gates.

## 3. Professional release

- Complete provider compatibility and migration rehearsal.
- Produce versioned local artifacts, checksums, SBOM, provenance, changelog, and recovery manual.
- Run the final end-to-end acceptance matrix and independent security review.
- Keep publication, package release, signing, notarization, and deployment behind the product owner's explicit decision.

## Current checkpoint

Updated 2026-07-20. The Workspace Gate, safe OpenCode TUI, read-only Git observer,
durable ledger, receipt spool, recovery, and independent verification are consolidated
on the `astra` mainline, now joined by governed multi-turn chat (per-turn consent),
git stage/unstage/commit in the TUI, and read-only operation/evidence/recovery views.
The local `astra-cockpit` line also closes operation-storage races, keeps Git
authority current across stage, unstage, and exact commit, and connects a governed
host shell with durable rejection, exact approval, bounded output, and truthful
unrestricted-host warnings. Its distinct two-column cockpit keeps the conversation on
the left and live operational control on the right. The familiar `/connect` command
now previews an Anthropic credential write, hands hidden input to the trusted parent,
requires exact post-write readback, and reopens the same session; cancellation without
a write was observed in a real PTY. This setup handoff does not yet produce a durable
Operation receipt and says so before consent. Certified Anthropic, OpenAI API-key, and
OpenAI Codex OAuth routes are selectable. Live two-turn Codex chat, durable transcript
reload, exact provider recovery, and rejection without dispatch are observed on macOS.
Next from section 1: final independent review, general verified file effects, a durable
credential-setup receipt, MCP tool invocation with capability grants, live
delegated-agent telemetry, richer extension views, and hardening.
