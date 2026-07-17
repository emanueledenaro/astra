# Astra runtime

This private package owns the first Astra workspace preflight composition root and the separately loaded controlled demo effect.

`workspace-preflight.ts` has negative capabilities: it performs bounded static filesystem reads and imports no OpenCode bootstrap, process, network, Git, provider, plugin, MCP, LSP, formatter, package, credential, or write runtime. It records the `.git` entry as a directory, regular file, or symlink without traversing it. A bounded regular `.git` file is digested with no-follow reads; directories, referenced gitdirs, and symlink targets are never inspected.

Report completeness and activation authority are separate. A complete static report remains useful read-only, while any `.git` form returns `git_baseline_not_inspected` until a real Git-aware baseline exists. The controlled write lives behind a distinct export and is loaded only after ephemeral activation and explicit approval.

This is a macOS demo slice. It is not a sandbox, persistent trust system, durable ledger, or release-ready executor.
