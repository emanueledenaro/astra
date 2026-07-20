import { canonicalJson, digest } from "./controlled-write-authority"
import type { ContentDigest } from "@astra/domain/operation-contract"

export type CertifiedProviderID = "anthropic" | "openai"
export type CertifiedProviderCredentialProfile =
  | "anthropic-api-key"
  | "openai-api-key"
  | "openai-codex-oauth"

export type CertifiedProviderAdapter = Readonly<{
  certification: "CERTIFIED"
  providerID: CertifiedProviderID
  credentialProfile: CertifiedProviderCredentialProfile
  adapterID:
    | "anthropic.messages.api-key.v1"
    | "openai.responses.api-key.v1"
    | "openai.responses.codex-oauth.v1"
  adapterDigest: ContentDigest
  destination: Readonly<{
    method: "POST"
    origin: "https://api.anthropic.com" | "https://api.openai.com" | "https://chatgpt.com"
    path: "/v1/messages" | "/v1/responses" | "/backend-api/codex/responses"
  }>
  credential: Readonly<{
    headerName: "x-api-key" | "authorization"
    scheme: "raw" | "bearer"
    accountHeaderName: "chatgpt-account-id" | null
  }>
}>

type AdapterDefinition = Omit<CertifiedProviderAdapter, "adapterDigest">

const definitions = [
  {
    certification: "CERTIFIED",
    providerID: "anthropic",
    credentialProfile: "anthropic-api-key",
    adapterID: "anthropic.messages.api-key.v1",
    destination: { method: "POST", origin: "https://api.anthropic.com", path: "/v1/messages" },
    credential: { headerName: "x-api-key", scheme: "raw", accountHeaderName: null },
  },
  {
    certification: "CERTIFIED",
    providerID: "openai",
    credentialProfile: "openai-api-key",
    adapterID: "openai.responses.api-key.v1",
    destination: { method: "POST", origin: "https://api.openai.com", path: "/v1/responses" },
    credential: { headerName: "authorization", scheme: "bearer", accountHeaderName: null },
  },
  {
    certification: "CERTIFIED",
    providerID: "openai",
    credentialProfile: "openai-codex-oauth",
    adapterID: "openai.responses.codex-oauth.v1",
    destination: { method: "POST", origin: "https://chatgpt.com", path: "/backend-api/codex/responses" },
    credential: { headerName: "authorization", scheme: "bearer", accountHeaderName: "chatgpt-account-id" },
  },
] as const satisfies ReadonlyArray<AdapterDefinition>

/** The only provider and credential combinations Astra may dispatch in certified mode. */
export const certifiedProviderAdapterRegistry: ReadonlyArray<CertifiedProviderAdapter> = Object.freeze(
  definitions.map((definition) =>
    deepFreeze({
      ...definition,
      adapterDigest: digest(canonicalJson({ schemaVersion: 1, ...definition })),
    }),
  ),
)

/** Resolves only an exact provider and credential profile pair; URLs are never used as identity. */
export function resolveCertifiedProviderAdapter(
  providerID: string,
  credentialProfile: string,
): CertifiedProviderAdapter | null {
  return (
    certifiedProviderAdapterRegistry.find(
      (adapter) => adapter.providerID === providerID && adapter.credentialProfile === credentialProfile,
    ) ?? null
  )
}

/** Revalidates the exact canonical destination immediately before dispatch preparation. */
export function resolveCertifiedProviderDispatch(input: Readonly<{
  providerID: string
  credentialProfile: string
  destination: Readonly<{ method: string; origin: string; path: string }>
}>): CertifiedProviderAdapter | null {
  const adapter = resolveCertifiedProviderAdapter(input.providerID, input.credentialProfile)
  if (!adapter) return null
  return input.destination.method === adapter.destination.method &&
    input.destination.origin === adapter.destination.origin &&
    input.destination.path === adapter.destination.path
    ? adapter
    : null
}

function deepFreeze<Value>(input: Value): Value {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  Object.freeze(input)
  for (const value of Object.values(input)) deepFreeze(value)
  return input
}
