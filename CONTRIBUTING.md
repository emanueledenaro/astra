# Contributing to Astra

Astra is a predictable, security-first AI development system built on the OpenCode architecture. The project is currently completing its operational foundation before expanding the user-facing product.

## Before starting

- Search existing Issues and Discussions.
- Use Discussions for product questions and early ideas.
- Open an Issue for a reproducible defect or a scoped implementation proposal.
- Agree on the approach before starting a large feature, cross-cutting refactor, provider change, or trust-boundary change.

Changes that only affect unchanged OpenCode behavior usually belong upstream. Astra work should focus on Astra-specific product behavior or the smallest integration required to preserve compatibility.

## Development rules

- Use English for code, comments, documentation, commits, and pull requests.
- Preserve the MIT license, OpenCode provenance, provider compatibility, and upstream history.
- Use conventional commit and pull-request titles such as `fix(cli): reject unsafe activation`.
- Keep branch names to at most three hyphen-separated words without slashes or type prefixes.
- Keep changes small and avoid unrelated refactors.
- Never describe a command exit, provider response, or observed effect as verified success without independent evidence.
- Never execute repository-controlled code while opening an unknown workspace.
- Never bypass approval, sandbox, test, or Git hooks to make a contribution pass.

Read [AGENTS.md](AGENTS.md) before changing code. More specific instructions in the repository also apply.

## Validation

Run tests and typechecks from the affected package directory. Root-level test execution is intentionally blocked.

Document:

- the behavior changed;
- negative cases proving that rejected operations have no effect;
- the commands used for validation;
- limitations or evidence that remains unavailable.

## Pull requests

Pull requests should:

- link a scoped Issue when one exists;
- explain the user or developer impact;
- identify new effects, authority, persistence, network, process, credential, Git, plugin, or MCP behavior;
- include focused tests;
- separate implemented behavior from planned behavior;
- avoid generated summaries that the author has not personally verified.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) and must not be reported in a public Issue or pull request.
