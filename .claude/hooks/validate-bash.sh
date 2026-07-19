#!/bin/sh
# PreToolUse hook for Bash: enforce two repo rules before a command runs.
# Inert unless wired in .claude/settings.json (hooks.PreToolUse, matcher "Bash").
# Exit 2 blocks the call and feeds stderr back to Claude.

input=$(cat)
command=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)

case "$command" in
  *"bun test"*)
    case "$command" in
      *"--cwd"*|*"packages/"*|*"cd "*|*"tools/"*) ;;
      *)
        echo "Blocked: run 'bun test' from inside a package directory, never the repo root (see AGENTS.md / bunfig.toml guard)." >&2
        exit 2
        ;;
    esac
    ;;
esac

case "$command" in
  *"tsc "*|*" tsc"*)
    echo "Blocked: use 'bun typecheck' (tsgo) from a package directory instead of raw tsc (see AGENTS.md)." >&2
    exit 2
    ;;
esac

exit 0
