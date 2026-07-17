import type { ParentAnthropicAuthReader } from "./provider-credential-broker"

export type ParentAnthropicAuthReaderHandle = ParentAnthropicAuthReader & Readonly<{ close: () => Promise<void> }>

type AuthReaderModule = Readonly<{
  createAstraAnthropicAuthReader: () => ParentAnthropicAuthReaderHandle
}>

/** Loads the narrow OpenCode Auth adapter only in Astra's trusted parent. */
export async function loadParentAnthropicAuthReader(): Promise<ParentAnthropicAuthReaderHandle> {
  const adapterUrl = new URL("../../opencode/src/astra/anthropic-auth-reader.ts", import.meta.url)
  const loaded: unknown = await import(adapterUrl.href)
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("createAstraAnthropicAuthReader" in loaded) ||
    typeof loaded.createAstraAnthropicAuthReader !== "function"
  ) {
    throw new Error("The Astra parent Auth adapter is unavailable")
  }
  const reader = (loaded as AuthReaderModule).createAstraAnthropicAuthReader()
  if (typeof reader.close !== "function") throw new Error("The Astra parent Auth adapter is unavailable")
  return reader
}
