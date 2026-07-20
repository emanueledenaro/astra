import { createHash } from "node:crypto"
import { OPEN_CODE_MODELS_DEV_SNAPSHOT, OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA } from "./provider-catalog-embedded"

const PROVIDER_ID = "anthropic" as const
const PROVIDER_NAME = "Anthropic" as const
const PROVIDER_NPM = "@ai-sdk/anthropic" as const
const OPENAI_PROVIDER_ID = "openai" as const
const OPENAI_PROVIDER_NAME = "OpenAI" as const
const OPENAI_PROVIDER_NPM = "@ai-sdk/openai" as const
const SOURCE_URL = "https://models.dev/api.json" as const
const OFFLINE_SOURCE = "packages/opencode/test/tool/fixtures/models-api.json" as const
const MAX_MODELS = 256
const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const
const OPENAI_PROVIDER_CONTENT_DIGEST =
  "sha256:b6ab732cf9035f66af2ab4572129c5f6acd615c0c3e44611735482dd5de05fce" as const
const OPENAI_CERTIFIED_MODELS = {
  "gpt-5.3-codex-spark": {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 128_000, input: 100_000, output: 32_000 },
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 400_000, input: 272_000, output: 128_000 },
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5",
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  },
} as const

type Digest = `sha256:${string}`
type Modality = (typeof MODALITIES)[number]

export type AstraProviderModel = Readonly<{
  id: string
  name: string
  limits: Readonly<{
    context: number
    input?: number
    output: number
  }>
}>

export type AstraProviderCatalogEntry = Readonly<{
  providerID: typeof PROVIDER_ID | typeof OPENAI_PROVIDER_ID
  providerName: typeof PROVIDER_NAME | typeof OPENAI_PROVIDER_NAME
  assurance: "CERTIFIED"
  dispatchable: true
  credentialProfiles: ReadonlyArray<"anthropic-api-key" | "openai-api-key" | "openai-codex-oauth">
  models: readonly AstraProviderModel[]
  provenance: Readonly<{
    sourceURL: typeof SOURCE_URL
    sourceContentDigest: Digest
    providerContentDigest: Digest
  }>
}>

export type AstraProviderCatalog = Readonly<{
  providers: ReadonlyArray<AstraProviderCatalogEntry>
}>

export type ProviderCatalogError = Readonly<{
  code: "catalog_unavailable"
  message: "Embedded OpenCode model catalog is unavailable."
}>

export type ProviderCatalogResult =
  | Readonly<{ ok: true; catalog: AstraProviderCatalog }>
  | Readonly<{ ok: false; error: ProviderCatalogError }>

/**
 * Reads the generated OpenCode ModelsDev projection and verifies that its
 * canonical Anthropic bytes still match the embedded provenance digest.
 */
export function readAstraProviderCatalog(): ProviderCatalogResult {
  try {
    return projectSnapshot(OPEN_CODE_MODELS_DEV_SNAPSHOT, OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA)
  } catch {
    return unavailable()
  }
}

function projectSnapshot(snapshot: unknown, metadataInput: unknown): ProviderCatalogResult {
  const metadata = projectMetadata(metadataInput)
  if (!metadata || !isRecord(snapshot) || !hasOnlyKeys(snapshot, [PROVIDER_ID])) return unavailable()
  const anthropic = snapshot[PROVIDER_ID]
  if (!isRecord(anthropic) || !hasOnlyKeys(anthropic, ["id", "name", "npm", "models"])) return unavailable()

  const providerID = anthropic.id
  const providerName = anthropic.name
  const providerNpm = anthropic.npm
  const modelEntries = anthropic.models
  if (
    providerID !== PROVIDER_ID ||
    providerName !== PROVIDER_NAME ||
    providerNpm !== PROVIDER_NPM ||
    !isRecord(modelEntries)
  ) {
    return unavailable()
  }

  const entries = Object.entries(modelEntries)
  if (entries.length === 0 || entries.length > MAX_MODELS) return unavailable()
  if (!isCanonicalOrder(entries.map(([catalogID]) => catalogID))) return unavailable()
  const models = entries.map(([catalogID, model]) => projectModel(catalogID, model))
  if (models.some((model) => model === null)) return unavailable()
  const validated = models.filter((model) => model !== null)
  const canonicalProvider = {
    id: providerID,
    name: providerName,
    npm: providerNpm,
    models: Object.fromEntries(validated.map((model) => [model.snapshot.id, model.snapshot])),
  }
  if (digest(JSON.stringify(canonicalProvider)) !== metadata.providerContentDigest) return unavailable()
  const openAIProvider = {
    id: OPENAI_PROVIDER_ID,
    name: OPENAI_PROVIDER_NAME,
    npm: OPENAI_PROVIDER_NPM,
    models: OPENAI_CERTIFIED_MODELS,
  }
  if (digest(JSON.stringify(openAIProvider)) !== OPENAI_PROVIDER_CONTENT_DIGEST) return unavailable()

  return Object.freeze({
    ok: true,
    catalog: Object.freeze({
      providers: Object.freeze([
        Object.freeze({
          providerID: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          assurance: "CERTIFIED" as const,
          dispatchable: true as const,
          credentialProfiles: Object.freeze(["anthropic-api-key" as const]),
          models: Object.freeze(validated.map((model) => model.publicModel)),
          provenance: Object.freeze(metadata),
        }),
        Object.freeze({
          providerID: OPENAI_PROVIDER_ID,
          providerName: OPENAI_PROVIDER_NAME,
          assurance: "CERTIFIED" as const,
          dispatchable: true as const,
          credentialProfiles: Object.freeze(["openai-api-key" as const, "openai-codex-oauth" as const]),
          models: Object.freeze(
            Object.values(OPENAI_CERTIFIED_MODELS).map((model) =>
              Object.freeze({
                id: model.id,
                name: model.name,
                limits: Object.freeze({ ...model.limit }),
              }),
            ),
          ),
          provenance: Object.freeze({
            sourceURL: SOURCE_URL,
            sourceContentDigest: metadata.sourceContentDigest,
            providerContentDigest: OPENAI_PROVIDER_CONTENT_DIGEST,
          }),
        }),
      ]),
    }),
  })
}

function projectMetadata(input: unknown): AstraProviderCatalogEntry["provenance"] | null {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["schemaVersion", "sourceURL", "sourceContentDigest", "providerContentDigest", "retrieval"])
  ) {
    return null
  }
  const retrieval = input.retrieval
  if (
    input.schemaVersion !== 1 ||
    input.sourceURL !== SOURCE_URL ||
    !isDigest(input.sourceContentDigest) ||
    !isDigest(input.providerContentDigest) ||
    !isRecord(retrieval) ||
    !hasOnlyKeys(retrieval, ["method", "offlineReplay", "offlineSource", "mediaType"]) ||
    retrieval.method !== "GET" ||
    retrieval.offlineReplay !== "--check --offline-source <pinned-api.json>" ||
    retrieval.offlineSource !== OFFLINE_SOURCE ||
    retrieval.mediaType !== "application/json"
  ) {
    return null
  }
  return {
    sourceURL: SOURCE_URL,
    sourceContentDigest: input.sourceContentDigest,
    providerContentDigest: input.providerContentDigest,
  }
}

function projectModel(catalogID: string, input: unknown) {
  if (!isModelID(catalogID) || !isRecord(input)) return null
  if (!hasOnlyKeys(input, ["id", "name", "modalities", "limit"])) return null
  const modelID = input.id
  const modelName = input.name
  const modalities = input.modalities
  const limit = input.limit
  if (modelID !== catalogID || !isDisplayName(modelName)) return null
  if (!isRecord(modalities) || !hasOnlyKeys(modalities, ["input", "output"])) return null
  const inputModalities = copyModalities(modalities.input)
  const outputModalities = copyModalities(modalities.output)
  if (!inputModalities || !outputModalities) return null
  if (!inputModalities.includes("text") || outputModalities.length !== 1 || outputModalities[0] !== "text") return null
  if (!isRecord(limit) || !hasAllowedKeys(limit, ["context", "input", "output"])) return null
  const context = limit.context
  const modelInput = limit.input
  const output = limit.output
  if (!isTokenLimit(context) || !isTokenLimit(output)) return null
  if (modelInput !== undefined && !isTokenLimit(modelInput)) return null

  const canonicalLimit = {
    context,
    ...(modelInput === undefined ? {} : { input: modelInput }),
    output,
  }
  return {
    snapshot: {
      id: catalogID,
      name: modelName,
      modalities: { input: inputModalities, output: outputModalities },
      limit: canonicalLimit,
    },
    publicModel: Object.freeze({
      id: catalogID,
      name: modelName,
      limits: Object.freeze(canonicalLimit),
    }),
  }
}

function copyModalities(input: unknown): Array<Modality> | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MODALITIES.length) return null
  const copy = Array.from(input)
  if (!copy.every(isModality) || new Set(copy).size !== copy.length) return null
  return copy
}

function isCanonicalOrder(modelIDs: ReadonlyArray<string>) {
  return modelIDs.every((modelID, index) => index === 0 || compareCodeUnits(modelIDs[index - 1]!, modelID) < 0)
}

function compareCodeUnits(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isModelID(input: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input)
}

function isDisplayName(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(input)
}

function isTokenLimit(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
}

function isModality(input: unknown): input is Modality {
  return MODALITIES.some((modality) => modality === input)
}

function isDigest(input: unknown): input is Digest {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input)
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function hasOnlyKeys(input: Readonly<Record<string, unknown>>, allowed: ReadonlyArray<string>) {
  const keys = Object.keys(input)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}

function hasAllowedKeys(input: Readonly<Record<string, unknown>>, allowed: ReadonlyArray<string>) {
  return Object.keys(input).every((key) => allowed.includes(key))
}

function digest(input: string): Digest {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function unavailable(): ProviderCatalogResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "catalog_unavailable",
      message: "Embedded OpenCode model catalog is unavailable.",
    }),
  })
}
