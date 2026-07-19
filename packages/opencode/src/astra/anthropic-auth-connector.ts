import * as prompts from "@clack/prompts"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Effect, ManagedRuntime } from "effect"
import { Auth } from "@/auth"

export type AstraAnthropicConnectionResult =
  | Readonly<{ status: "stored"; providerID: "anthropic"; verification: "exact_readback" }>
  | Readonly<{ status: "cancelled" }>

export type AstraAnthropicConnectorDependencies = Readonly<{
  readSecret: () => Promise<string | undefined>
  storeAndVerifySecret: (secret: string) => Promise<boolean>
  report: (result: AstraAnthropicConnectionResult) => void
}>

/**
 * Captures and stores the Anthropic API key inside the trusted parent process.
 * The return value contains no credential material.
 */
export async function connectAstraAnthropicCredential(
  dependencies: AstraAnthropicConnectorDependencies = defaultDependencies(),
): Promise<AstraAnthropicConnectionResult> {
  const secret = await dependencies.readSecret()
  if (secret === undefined) {
    const result = Object.freeze({ status: "cancelled" as const })
    dependencies.report(result)
    return result
  }
  if (secret.length === 0 || secret.length > 4096) throw new TypeError("The Anthropic API key is invalid")
  if (!(await dependencies.storeAndVerifySecret(secret))) {
    throw new Error("The Anthropic credential write could not be verified")
  }
  const result = Object.freeze({
    status: "stored" as const,
    providerID: "anthropic" as const,
    verification: "exact_readback" as const,
  })
  dependencies.report(result)
  return result
}

function defaultDependencies(): AstraAnthropicConnectorDependencies {
  return {
    async readSecret() {
      prompts.intro("Astra provider connection")
      prompts.log.info("Provider: Anthropic")
      prompts.log.info("Write: global OpenCode credential store")
      prompts.log.info("Network: no provider request during setup")
      prompts.log.warn("Audit: setup handoff only; durable Operation receipt is not implemented yet")
      const value = await prompts.password({
        message: "Enter your Anthropic API key",
        validate: (input) => {
          if (!input) return "Required"
          if (input.length > 4096) return "Credential is too long"
          return undefined
        },
      })
      return prompts.isCancel(value) ? undefined : value
    },
    async storeAndVerifySecret(secret) {
      const runtime = ManagedRuntime.make(AppNodeBuilder.build(Auth.node), { memoMap })
      try {
        return await runtime.runPromise(
          Auth.Service.use((auth) =>
            Effect.gen(function* () {
              yield* auth.set("anthropic", { type: "api", key: secret })
              const stored = yield* auth.get("anthropic")
              return stored?.type === "api" && stored.key === secret
            }),
          ),
        )
      } finally {
        await runtime.dispose()
      }
    },
    report(result) {
      prompts.outro(
        result.status === "stored"
          ? "Anthropic credential stored and read back exactly. Returning to Astra."
          : "Provider connection cancelled. Returning to Astra.",
      )
    },
  }
}
