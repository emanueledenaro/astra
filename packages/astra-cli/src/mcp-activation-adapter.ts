import { parseContentDigest } from "@astra/domain/operation-contract"
import { createPinnedMcpWire } from "@astra/runtime/mcp-pinned-fetch"
import type { McpActivationAdapter } from "@astra/runtime/mcp-activation-coordinator"
import { activateAstraControlledRemote } from "../../opencode/src/mcp/astra-controlled-remote"

/** Composes the fixed OpenCode exchange with Astra's exact-destination transport. */
export function createAstraMcpActivationAdapter(): McpActivationAdapter {
  return Object.freeze({
    descriptor: "astra-opencode:controlled-remote-mcp:v1",
    async connect(input) {
      const active = await activateAstraControlledRemote(
        createPinnedMcpWire(input.endpoint, {
          mode: input.endpoint.startsWith("http://127.0.0.1:") || input.endpoint.startsWith("http://[::1]:")
            ? "test_loopback"
            : "production_https",
        }),
        { signal: input.signal },
      )
      return Object.freeze({
        protocolVersion: active.protocolVersion,
        server: active.server,
        catalog: Object.freeze(active.catalog.map((entry) => {
          const digest = parseContentDigest(entry.inputSchemaDigest)
          if (!digest.ok) throw new TypeError("The controlled MCP catalog digest is invalid")
          return Object.freeze({ ...entry, inputSchemaDigest: digest.value })
        })),
        instructionsWithheld: true as const,
        close: active.stop,
      })
    },
  })
}
