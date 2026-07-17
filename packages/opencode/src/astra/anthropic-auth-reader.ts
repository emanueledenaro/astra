import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { ManagedRuntime } from "effect"
import { Auth } from "@/auth"

const runtime = ManagedRuntime.make(AppNodeBuilder.build(Auth.node), { memoMap })

/**
 * Reads only the existing OpenCode Anthropic Auth record. The caller receives
 * the decoded record inside the parent process; this module never initializes
 * providers, plugins, sessions, skills, MCP, or workspace configuration.
 */
export function createAstraAnthropicAuthReader() {
  return Object.freeze({
    get(providerID: "anthropic", signal: AbortSignal) {
      if (providerID !== "anthropic") return Promise.resolve(undefined)
      return runtime.runPromise(Auth.Service.use((auth) => auth.get(providerID)), { signal })
    },
    close() {
      return runtime.dispose()
    },
  })
}
