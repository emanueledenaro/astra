# Astra Product Roadmap

Updated: 2026-07-17

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

Updated 2026-07-19. The Workspace Gate, safe OpenCode TUI, read-only Git observer,
durable ledger, receipt spool, recovery, and independent verification are consolidated
on the `astra` mainline, now joined by governed multi-turn chat (per-turn consent),
git stage/unstage/commit in the TUI, and read-only operation/evidence/recovery views.
Next from section 1: shell and file effects through the kernel, MCP tool invocation
with capability grants, the remaining TUI views, then hardening. macOS re-verification
of the consolidated line is pending (docs/astra/macos-verification.md).
