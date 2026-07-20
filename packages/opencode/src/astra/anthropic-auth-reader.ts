import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { ManagedRuntime } from "effect"
import { Auth } from "@/auth"

const runtime = ManagedRuntime.make(AppNodeBuilder.build(Auth.node), { memoMap })

/**
 * Reads only an existing certified OpenCode provider Auth record. The caller receives
 * the decoded record inside the parent process; this module never initializes
 * providers, plugins, sessions, skills, MCP, or workspace configuration.
 */
export function createAstraProviderAuthReader() {
  return Object.freeze({
    get(providerID: "anthropic" | "openai", signal: AbortSignal) {
      if (providerID !== "anthropic" && providerID !== "openai") return Promise.resolve(undefined)
      return runtime.runPromise(
        Auth.Service.use((auth) => auth.get(providerID)),
        { signal },
      )
    },
    close() {
      return runtime.dispose()
    },
  })
}

/** Compatibility alias for the first Anthropic-only parent integration. */
export const createAstraAnthropicAuthReader = createAstraProviderAuthReader
