# Astra runtime

This private package owns the first Astra workspace preflight composition root and the separately loaded controlled demo effect.

`workspace-preflight.ts` has negative capabilities: it performs bounded static filesystem reads and imports no OpenCode bootstrap, process, network, Git, provider, plugin, MCP, LSP, formatter, package, credential, or write runtime. The controlled write lives behind a distinct export and is loaded only after ephemeral activation and explicit approval.

This is a macOS demo slice. It is not a sandbox, persistent trust system, durable ledger, or release-ready executor.
