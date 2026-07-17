import { OPEN_CODE_MODELS_DEV_SNAPSHOT } from "./provider-catalog-embedded"

const PROVIDER_ID = "anthropic" as const
const MAX_MODELS = 256

export type AstraProviderModel = Readonly<{
  id: string
  name: string
  limits: Readonly<{
    context: number
    input?: number
    output: number
  }>
}>

export type AstraProviderCatalog = Readonly<{
  providerID: typeof PROVIDER_ID
  providerName: string
  models: readonly AstraProviderModel[]
}>

export type ProviderCatalogError = Readonly<{
  code: "catalog_unavailable"
  message: "Embedded OpenCode model catalog is unavailable."
}>

export type ProviderCatalogResult =
  | Readonly<{ ok: true; catalog: AstraProviderCatalog }>
  | Readonly<{ ok: false; error: ProviderCatalogError }>

/**
 * Reads only the build-injected OpenCode ModelsDev snapshot and projects it
 * into Astra's deliberately small public model catalog. Source-mode launches
 * without the build injection fail closed; this boundary has no effectful input.
 */
export function readAstraProviderCatalog(): ProviderCatalogResult {
  try {
    return projectSnapshot(OPEN_CODE_MODELS_DEV_SNAPSHOT)
  } catch {
    return unavailable()
  }
}

function projectSnapshot(snapshot: unknown | undefined): ProviderCatalogResult {
  if (!isRecord(snapshot)) return unavailable()
  const anthropic = snapshot[PROVIDER_ID]
  if (!isRecord(anthropic)) return unavailable()
  const providerID = anthropic.id
  const providerName = anthropic.name
  const modelEntries = anthropic.models
  if (providerID !== PROVIDER_ID || !isDisplayName(providerName) || !isRecord(modelEntries)) return unavailable()

  const entries = Object.entries(modelEntries)
  if (entries.length > MAX_MODELS) return unavailable()
  const models = entries.flatMap(([catalogID, model]) => projectModel(catalogID, model))
  if (models.length === 0) return unavailable()

  return Object.freeze({
    ok: true,
    catalog: Object.freeze({
      providerID: PROVIDER_ID,
      providerName: providerName.trim(),
      models: Object.freeze(models.sort((left, right) => left.id.localeCompare(right.id))),
    }),
  })
}

function projectModel(catalogID: string, input: unknown): readonly AstraProviderModel[] {
  if (!isModelID(catalogID) || !isRecord(input)) return []
  const modelID = input.id
  const modelName = input.name
  const status = input.status
  const modalities = input.modalities
  const limit = input.limit
  if (modelID !== catalogID || !isDisplayName(modelName) || status === "deprecated") return []
  if (!isTextModel(modalities) || !isRecord(limit)) return []
  const context = limit.context
  const modelInput = limit.input
  const output = limit.output
  if (!isTokenLimit(context) || !isTokenLimit(output)) return []
  if (modelInput !== undefined && !isTokenLimit(modelInput)) return []

  const limits = Object.freeze({
    context,
    ...(modelInput === undefined ? {} : { input: modelInput }),
    output,
  })
  return [
    Object.freeze({
      id: catalogID,
      name: modelName.trim(),
      limits,
    }),
  ]
}

function isTextModel(input: unknown) {
  if (!isRecord(input)) return false
  const modelInput = input.input
  const output = input.output
  if (!Array.isArray(modelInput) || !Array.isArray(output)) return false
  return modelInput.includes("text") && output.includes("text")
}

function isModelID(input: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
}

function isDisplayName(input: unknown): input is string {
  if (typeof input !== "string") return false
  const value = input.trim()
  return value.length > 0 && value.length <= 160 && !Array.from(value).some(isControlCharacter)
}

function isControlCharacter(input: string) {
  const code = input.charCodeAt(0)
  return code <= 31 || code === 127
}

function isTokenLimit(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
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
