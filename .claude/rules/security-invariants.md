# Security invariants

These are product-defining. A change that violates one is wrong even if tests pass.

1. **Opening never executes.** Opening an unknown workspace must not execute
   workspace-controlled content: no scripts, hooks, plugins, config-driven binaries,
   fsmonitor, editors, pagers, signers. Preflight is bounded, static, symlink-refusing,
   size- and time-limited.
2. **No false success.** A tool result, process exit code, provider finish event, or
   observed effect is never verified success. `VERIFIED` is reachable only through
   independent evidence appended by the verifier. Ambiguity becomes
   `reconciliation_required` or `inconclusive` — never success, and never a blind retry.
3. **Denial has no effect.** A rejected operation produces no dispatch and no side
   effect, and the denial itself is durable.
4. **Honest boundaries.** Host execution is always labelled `HOST EXECUTION — NO
   SANDBOX`. Never present application-enforced scope as OS-enforced isolation.
   Network egress is previewed and consented per operation.
5. **No persistent trust.** Workspace trust is `TRUSTED_ONCE`, process-local, never
   written to disk. The authority handoff file is private (0600, digest-bound,
   freshness-checked) and short-lived.
6. **Authority is deterministic.** The model may propose intent; deterministic policy
   grants authority. Credentials never enter the child process or the model context;
   the parent-side broker hands out one-shot opaque grants.
7. **Publication is a human decision.** Push, release, package publication, signing,
   notarization, deploy: only with explicit product-owner approval.

When reviewing or writing code, actively look for: TOCTOU between check and use
(prefer fd-based rechecks, `O_NOFOLLOW`, `O_EXCL`, dev/ino identity), unbounded reads,
env/config leakage into spawned processes, and any path where an error could be
misreported as success.
