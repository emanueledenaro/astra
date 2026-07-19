---
description: Review the current diff as an Astra vertical slice (rules + invariants + tests)
---

Review the current working diff (or the branch diff vs `astra` if the tree is clean)
as an Astra vertical slice. Check, in this order:

1. **Security invariants** (`.claude/rules/security-invariants.md`): does any change
   execute workspace-controlled content on open, report unverified success, produce
   effects on denial, mislabel a boundary, persist trust, or leak credentials?
   Actively hunt TOCTOU (check-vs-use), missing `O_NOFOLLOW`/`O_EXCL`, unbounded
   reads, env leakage into spawned processes.
2. **Architecture** (`.claude/rules/architecture.md`): dependency direction respected;
   effects stay in the parent; inherited-code changes are surgical guards; domain
   stays pure; new effect kinds follow the coordinator pattern.
3. **Style** (AGENTS.md): no `any`, no `else`, avoid `try/catch` outside effect
   seams, no aliased/star imports, exact-key parsing for external data, English only.
4. **Tests** (`.claude/rules/testing-qa.md`): security changes have
   negative-capability tests; crash seams have fault injection; package boundary
   tests updated; no mocks of the code under test.
5. **Honesty**: docs/labels updated to match behavior (STATUS.md drift, README
   claims, preview text).

Output: findings ranked critical/major/minor with `file:line`, then a verdict:
merge-ready / needs-fixes / needs-redesign. Do not fix anything unless asked.
