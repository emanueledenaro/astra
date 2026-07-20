import type { ParentAnthropicAuthReader } from "./provider-credential-broker"

export type ParentProviderAuthReaderHandle = ParentAnthropicAuthReader & Readonly<{ close: () => Promise<void> }>
export type ParentAnthropicAuthReaderHandle = ParentProviderAuthReaderHandle

type AuthReaderModule = Readonly<{
  createAstraProviderAuthReader: () => ParentProviderAuthReaderHandle
}>

/** Loads the narrow OpenCode Auth adapter only in Astra's trusted parent. */
export async function loadParentProviderAuthReader(): Promise<ParentProviderAuthReaderHandle> {
  const adapterUrl = new URL("../../opencode/src/astra/anthropic-auth-reader.ts", import.meta.url)
  const loaded: unknown = await import(adapterUrl.href)
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("createAstraProviderAuthReader" in loaded) ||
    typeof loaded.createAstraProviderAuthReader !== "function"
  ) {
    throw new Error("The Astra parent Auth adapter is unavailable")
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- export shape is checked immediately above.
  const reader = (loaded as AuthReaderModule).createAstraProviderAuthReader()
  if (typeof reader.close !== "function") throw new Error("The Astra parent Auth adapter is unavailable")
  return reader
}

/** Compatibility alias for the original Anthropic-only launcher wiring. */
export const loadParentAnthropicAuthReader = loadParentProviderAuthReader
