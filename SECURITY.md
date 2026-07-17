# Astra Security Policy

Astra is under active foundation development. It is not ready for production use and no released version is currently supported.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting:

https://github.com/emanueledenaro/astra/security/advisories/new

Include:

- the affected commit or branch;
- the operating system and relevant runtime versions;
- a minimal reproduction;
- the authority or trust boundary that was crossed;
- the observed effect and supporting evidence;
- any known workaround.

Remove credentials, personal data, proprietary source code, and unrelated logs before submitting. Reports must be reviewed and reproducible by the reporter, including when AI assisted with discovery or drafting.

## Current security boundary

The committed Astra demo provides a bounded workspace preflight, explicit activation and effect approval, durable operation records, and fail-closed guards for the implemented paths. It does not yet provide a production sandbox, a credential broker, isolated plugin or MCP execution, or complete Git activation.

The inherited OpenCode runtime contains capabilities that are not yet connected behind the Astra trust boundary. OpenCode documentation and behavior must not be interpreted as a released Astra security guarantee.

## Upstream findings

If a finding affects unchanged OpenCode code and is not caused by an Astra modification, follow the upstream OpenCode security policy. If the finding involves an Astra package, an Astra trust boundary, or the interaction between Astra and inherited code, report it privately to Astra first.

## Disclosure and rewards

Allow time to investigate and coordinate disclosure before publishing details. Astra does not currently operate a vulnerability reward program.
