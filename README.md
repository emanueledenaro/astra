# Astra

**A predictable, security-first AI development system built on OpenCode.**

Astra is being designed so a developer can always see what the AI intends to do, which authority it has, what changed, what was independently verified, what remains uncertain, and how to recover. It reuses OpenCode while adding an explicit workspace gate, durable operations, bounded authority, visible Git state, and fail-closed effects.

## Command experience

The product command contract is:

```bash
astra             # Start Astra in No Workspace mode
astra .           # Propose the current directory as a workspace
astra /path       # Propose a specific directory as a workspace
astra system      # Start directly in System Mode
```

Selecting a directory never activates it automatically. Astra must first show the bounded preflight and require the appropriate trust and effect decisions. `astra open <path>` remains an explicit compatibility alias for scripts and automation.

Current implementation status:

| Command             | Status                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `astra .`           | Working local macOS product path                                    |
| `astra /path`       | Working; intermediate path aliases are canonicalized before opening |
| `astra open <path>` | Working compatibility alias                                         |
| `astra`             | Working Launchpad in a terminal; help in non-TTY use                 |
| `astra system`      | Working global Control Center without workspace authority            |

## Current local demo

The current macOS checkpoint includes:

- a real no-argument Launchpad for creating a governed local project, opening a workspace, or entering System;
- a dedicated `astra system` Control Center for provider, extension, session, receipt, backend, and review-mode facts without workspace authority;
- a real terminal Workspace Gate with the Lynx identity;
- bounded static preflight without workspace code, provider, plugin, MCP, LSP, formatter, shell, or normal OpenCode bootstrap;
- explicit `read-only`, `inspect Git`, `activate once`, and `exit` decisions with no persistent trust;
- visible progress during bounded Git inspection instead of a blank terminal;
- sandboxed, read-only Git observation and an exact ephemeral baseline before activation;
- a capability-bound Operation Kernel with durable consent, dispatch, receipts, recovery, and independent verification;
- an explicitly labelled bounded host-process backend for the current create-only verification effect;
- a private, digest-bound session authority that is revalidated again inside the TUI process;
- a fail-closed OpenCode safe-start that skips project persistence and automatic Git, provider, plugin, skill, MCP, LSP, and formatter initialization;
- clear `READ ONLY • EFFECTS DENIED` and `ACTIVE ONCE • GOVERNED EFFECTS ONLY` states;
- an inherited prompt that stays disabled while `ctrl+p` opens the governed action surface;
- an Astra cockpit with the conversation on the left and live workspace, operation, provider, Git, permission, and current parent-agent state on the right;
- selectable certified Anthropic, OpenAI API-key, and OpenAI Codex OAuth chat routes with per-turn consent and parent-owned durable history;
- exact provider/model recovery and verified transcript reload after restarting Astra on the same workspace;
- an explicit `/connect` handoff that previews the credential-store write, captures and exactly reads back the secret in the trusted parent, and returns to the same workspace session;
- governed Git stage, unstage, and exact local commit in one activated session;
- governed host shell with an exact script/cwd/environment preview, local approval or rejection, bounded output, durable receipts, and explicit unrestricted-host warnings;
- governed literal workspace search, controlled create-only write, extension inventory and quarantine, skill activation, MCP activation, and read-only operation evidence.

From this repository:

```bash
bun install --frozen-lockfile
bun run --cwd packages/astra-cli start -- .
```

If the local `astra` launcher is already linked:

```bash
astra .
astra /absolute/path/to/workspace
```

The earlier controlled-write vertical slice remains available only as a developer verification path:

```bash
bun run --cwd packages/astra-cli verify:demo
```

> [!IMPORTANT]
> Astra is not yet a work-ready release candidate. `Activate once` enables only parent-governed actions with an exact preview and explicit consent. The governed shell executes an approved exact script through `/bin/zsh -f -c` and truthfully declares unrestricted host filesystem and network authority; its output is observed, never independently verified. The inherited OpenCode prompt, general file editing, LSP, formatters, arbitrary plugin code, MCP tool invocation, and destructive or remote Git actions remain blocked. Live two-turn OpenAI chat through the inherited Codex OAuth credential has been observed on this Mac, including restart recovery and rejection without network dispatch. `/connect` currently configures Anthropic and uses exact post-write readback, but remains a setup handoff without a durable Operation receipt. Every connected host effect is labelled `HOST EXECUTION — NO SANDBOX`. General sandboxing is preserved as future work and deferred to hardening. The inherited OpenCode documentation below describes the compatibility baseline, not a released Astra product.

See [UPSTREAM.md](UPSTREAM.md) for the exact source baseline, license provenance, and remote policy.
See [docs/astra/ROADMAP.md](docs/astra/ROADMAP.md) for the current product sequence.

---

## Inherited OpenCode documentation

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
