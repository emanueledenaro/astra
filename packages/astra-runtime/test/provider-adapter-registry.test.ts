import { describe, expect, test } from "bun:test"
import {
  certifiedProviderAdapterRegistry,
  resolveCertifiedProviderAdapter,
  resolveCertifiedProviderDispatch,
} from "../src/provider-adapter-registry"

describe("certified provider adapter registry", () => {
  test("contains only the exact certified Anthropic and OpenAI credential profiles", () => {
    expect(certifiedProviderAdapterRegistry.map(({ providerID, credentialProfile }) => [providerID, credentialProfile])).toEqual([
      ["anthropic", "anthropic-api-key"],
      ["openai", "openai-api-key"],
      ["openai", "openai-codex-oauth"],
    ])
  })

  test("resolves exact canonical destinations without inferring an adapter from a URL", () => {
    expect(resolveCertifiedProviderAdapter("anthropic", "anthropic-api-key")?.destination).toEqual({
      method: "POST",
      origin: "https://api.anthropic.com",
      path: "/v1/messages",
    })
    expect(resolveCertifiedProviderAdapter("openai", "openai-api-key")?.destination).toEqual({
      method: "POST",
      origin: "https://api.openai.com",
      path: "/v1/responses",
    })
    expect(resolveCertifiedProviderAdapter("openai", "openai-codex-oauth")?.destination).toEqual({
      method: "POST",
      origin: "https://chatgpt.com",
      path: "/backend-api/codex/responses",
    })
  })

  test("rejects unsupported providers, credential profiles, and destination mutations", () => {
    expect(resolveCertifiedProviderAdapter("openrouter", "openai-api-key")).toBeNull()
    expect(resolveCertifiedProviderAdapter("openai", "anthropic-api-key")).toBeNull()
    expect(resolveCertifiedProviderAdapter("openai", "openai-oauth")).toBeNull()

    expect(
      resolveCertifiedProviderDispatch({
        providerID: "openai",
        credentialProfile: "openai-api-key",
        destination: { method: "POST", origin: "https://proxy.example", path: "/v1/responses" },
      }),
    ).toBeNull()
    expect(
      resolveCertifiedProviderDispatch({
        providerID: "openai",
        credentialProfile: "openai-api-key",
        destination: { method: "POST", origin: "https://api.openai.com", path: "/chat/completions" },
      }),
    ).toBeNull()
  })

  test("publishes stable content digests for every certified adapter", () => {
    for (const adapter of certifiedProviderAdapterRegistry) {
      expect(adapter.adapterDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(adapter.certification).toBe("CERTIFIED")
    }
    expect(new Set(certifiedProviderAdapterRegistry.map((adapter) => adapter.adapterDigest)).size).toBe(3)
  })
})
