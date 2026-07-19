type ConnectorModule = Readonly<{
  connectAstraAnthropicCredential: () => Promise<
    | Readonly<{ status: "stored"; providerID: "anthropic"; verification: "exact_readback" }>
    | Readonly<{ status: "cancelled" }>
  >
}>

/** Runs the narrow OpenCode credential adapter only in Astra's trusted parent. */
export async function connectParentAnthropicCredential() {
  const adapterUrl = new URL("../../opencode/src/astra/anthropic-auth-connector.ts", import.meta.url)
  const loaded: unknown = await import(adapterUrl.href)
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("connectAstraAnthropicCredential" in loaded) ||
    typeof loaded.connectAstraAnthropicCredential !== "function"
  ) {
    throw new Error("The Astra parent credential connector is unavailable")
  }
  return (loaded as ConnectorModule).connectAstraAnthropicCredential()
}
