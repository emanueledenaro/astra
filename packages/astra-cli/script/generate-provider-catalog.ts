import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sourceURL = "https://models.dev/api.json"
const providerID = "anthropic"
const providerName = "Anthropic"
const providerNpm = "@ai-sdk/anthropic"
const providerEnvironment = "ANTHROPIC_API_KEY"
const maximumSourceBytes = 16 * 1024 * 1024
const maximumModels = 256
const retrievalTimeoutMilliseconds = 30_000
const outputPath = fileURLToPath(new URL("../src/provider-catalog-embedded.ts", import.meta.url))
const pinnedOfflineSourcePath = fileURLToPath(
  new URL("../../opencode/test/tool/fixtures/models-api.json", import.meta.url),
)
const pinnedOfflineSourceRepositoryPath = "packages/opencode/test/tool/fixtures/models-api.json"
const modalities = ["text", "audio", "image", "video", "pdf"] as const

type Modality = (typeof modalities)[number]

const options = parseOptions(process.argv.slice(2))

const source = options.offlineSource
  ? await readPinnedOfflineSource(options.offlineSource, options.check)
  : await fetchOfficialSource()
const snapshot = projectSource(source.text)
const generated = render(snapshot, source)

if (options.check) {
  if (!(await Bun.file(outputPath).exists())) throw new Error("Embedded provider catalog is missing.")
  if ((await Bun.file(outputPath).text()) !== generated) {
    throw new Error("Embedded provider catalog drifted from the official models.dev source.")
  }
  console.log(
    options.offlineSource
      ? "Embedded Anthropic provider catalog matches its pinned offline source."
      : "Embedded Anthropic provider catalog is current with the official source.",
  )
  process.exit(0)
}

await Bun.write(outputPath, generated)
console.log(`Generated ${Object.keys(snapshot.anthropic.models).length} Anthropic models from ${sourceURL}.`)

type Source = Readonly<{
  text: string
  mediaType: "application/json"
}>

type Options = Readonly<{ check: boolean; offlineSource: string | null }>

function parseOptions(arguments_: ReadonlyArray<string>): Options {
  if (arguments_.length === 0) return { check: false, offlineSource: null }
  if (arguments_.length === 1 && arguments_[0] === "--check") return { check: true, offlineSource: null }
  if (arguments_.length === 2 && arguments_[0] === "--offline-source" && arguments_[1]) {
    return { check: false, offlineSource: arguments_[1] }
  }
  if (arguments_.length === 3 && arguments_[0] === "--check" && arguments_[1] === "--offline-source") {
    const offlineSource = arguments_[2]
    if (!offlineSource) throw new Error("Offline source path is missing.")
    return { check: true, offlineSource }
  }
  throw new Error(
    "Usage: bun run ./script/generate-provider-catalog.ts [--offline-source <api.json> | --check [--offline-source <pinned-api.json>]]",
  )
}

async function fetchOfficialSource(): Promise<Source> {
  const response = await fetch(sourceURL, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(retrievalTimeoutMilliseconds),
  })
  if (!response.ok || response.url !== sourceURL) throw new Error("Official models.dev retrieval failed.")
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") throw new Error("Official models.dev response is not JSON.")
  const declaredBytes = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumSourceBytes) {
    throw new Error("Models.dev source exceeds the fixed byte limit.")
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumSourceBytes) throw new Error("Models.dev source exceeds the fixed byte limit.")
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    mediaType,
  }
}

async function readPinnedOfflineSource(path: string, requirePinnedDigest: boolean): Promise<Source> {
  if (resolve(path) !== pinnedOfflineSourcePath)
    throw new Error("Offline source path is not the canonical OpenCode fixture.")
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error("Pinned offline source does not exist.")
  if (file.size > maximumSourceBytes) throw new Error("Models.dev source exceeds the fixed byte limit.")
  const text = await file.text()
  if (requirePinnedDigest && digest(text) !== (await readPinnedSourceDigest())) {
    throw new Error("Offline source does not match the committed official source digest.")
  }
  return { text, mediaType: "application/json" }
}

async function readPinnedSourceDigest() {
  if (!(await Bun.file(outputPath).exists())) throw new Error("Embedded provider catalog is missing.")
  const embedded = await Bun.file(outputPath).text()
  const matches = [...embedded.matchAll(/sourceContentDigest: "(sha256:[0-9a-f]{64})"/gu)]
  if (matches.length !== 1 || !matches[0]?.[1]) throw new Error("Embedded official source digest is invalid.")
  return matches[0][1]
}

function projectSource(text: string) {
  const parsed: unknown = JSON.parse(text)
  const root = requireRecord(parsed, "Models.dev root")
  const provider = requireRecord(root[providerID], "Anthropic provider")
  if (provider.id !== providerID) throw new Error("Anthropic provider ID is not canonical.")
  if (provider.name !== providerName) throw new Error("Anthropic provider name is not canonical.")
  if (provider.api !== undefined) throw new Error("Anthropic provider unexpectedly overrides its canonical SDK API.")
  if (provider.npm !== providerNpm) throw new Error("Anthropic provider npm adapter is not canonical.")
  if (!Array.isArray(provider.env) || provider.env.length !== 1 || provider.env[0] !== providerEnvironment) {
    throw new Error("Anthropic provider credential contract is not canonical.")
  }

  const models = requireRecord(provider.models, "Anthropic models")
  const entries = Object.entries(models)
  if (entries.length === 0 || entries.length > maximumModels) throw new Error("Anthropic model count is invalid.")
  const projected = entries
    .map(([catalogID, model]) => projectModel(catalogID, model))
    .filter((model): model is NonNullable<typeof model> => model !== null)
    .sort((left, right) => compareCodeUnits(left.id, right.id))
  if (projected.length === 0) throw new Error("Anthropic catalog has no active text models.")

  return {
    anthropic: {
      id: providerID,
      name: providerName,
      npm: providerNpm,
      models: Object.fromEntries(projected.map((model) => [model.id, model])),
    },
  } as const
}

function projectModel(catalogID: string, input: unknown) {
  if (!isIdentifier(catalogID)) throw new Error("Anthropic catalog contains an invalid model key.")
  const model = requireRecord(input, `Anthropic model ${catalogID}`)
  if (model.id !== catalogID) throw new Error(`Anthropic model ${catalogID} has a non-canonical ID.`)
  if (!isDisplayName(model.name)) throw new Error(`Anthropic model ${catalogID} has an invalid name.`)
  if (model.provider !== undefined) throw new Error(`Anthropic model ${catalogID} overrides the direct API adapter.`)
  if (
    model.status !== undefined &&
    model.status !== "alpha" &&
    model.status !== "beta" &&
    model.status !== "deprecated"
  ) {
    throw new Error(`Anthropic model ${catalogID} has an invalid status.`)
  }
  const modalities = requireRecord(model.modalities, `Anthropic model ${catalogID} modalities`)
  const inputModalities = requireModalities(modalities.input, catalogID, "input")
  const outputModalities = requireModalities(modalities.output, catalogID, "output")
  if (!inputModalities.includes("text") || outputModalities.length !== 1 || outputModalities[0] !== "text") {
    throw new Error(`Anthropic model ${catalogID} is not a canonical text API model.`)
  }
  const limit = requireRecord(model.limit, `Anthropic model ${catalogID} limits`)
  if (!hasOnlyKeys(limit, ["context", "input", "output"])) {
    throw new Error(`Anthropic model ${catalogID} has unknown limit fields.`)
  }
  if (!isTokenLimit(limit.context) || !isTokenLimit(limit.output)) {
    throw new Error(`Anthropic model ${catalogID} has invalid token limits.`)
  }
  if (limit.input !== undefined && !isTokenLimit(limit.input)) {
    throw new Error(`Anthropic model ${catalogID} has an invalid input token limit.`)
  }
  if (model.status === "deprecated") return null

  return {
    id: catalogID,
    name: model.name,
    modalities: { input: inputModalities, output: outputModalities },
    limit: {
      context: limit.context,
      ...(limit.input === undefined ? {} : { input: limit.input }),
      output: limit.output,
    },
  }
}

function requireModalities(input: unknown, modelID: string, direction: "input" | "output") {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5) {
    throw new Error(`Anthropic model ${modelID} has invalid ${direction} modalities.`)
  }
  if (!input.every(isModality)) {
    throw new Error(`Anthropic model ${modelID} has invalid ${direction} modalities.`)
  }
  if (new Set(input).size !== input.length) {
    throw new Error(`Anthropic model ${modelID} repeats a ${direction} modality.`)
  }
  return input
}

function render(snapshot: ReturnType<typeof projectSource>, source: Source) {
  const sourceContentDigest = digest(source.text)
  const providerContentDigest = digest(JSON.stringify(snapshot.anthropic))
  const modelLines = Object.entries(snapshot.anthropic.models).flatMap(([modelID, model]) => [
    `      ${JSON.stringify(modelID)}: {`,
    `        id: ${JSON.stringify(model.id)},`,
    `        name: ${JSON.stringify(model.name)},`,
    "        modalities: {",
    `          input: [${model.modalities.input.map((value) => JSON.stringify(value)).join(", ")}],`,
    `          output: [${model.modalities.output.map((value) => JSON.stringify(value)).join(", ")}],`,
    "        },",
    "        limit: {",
    `          context: ${model.limit.context},`,
    ...(model.limit.input === undefined ? [] : [`          input: ${model.limit.input},`]),
    `          output: ${model.limit.output},`,
    "        },",
    "      },",
  ])
  return `/**
 * Generated from the OpenCode models.dev source. Do not edit by hand.
 * Regenerate with: bun run generate:provider-catalog
 */
export const OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA = {
  schemaVersion: 1,
  sourceURL: ${JSON.stringify(sourceURL)},
  sourceContentDigest: ${JSON.stringify(sourceContentDigest)},
  providerContentDigest: ${JSON.stringify(providerContentDigest)},
  retrieval: {
    method: "GET",
    offlineReplay: "--check --offline-source <pinned-api.json>",
    offlineSource: ${JSON.stringify(pinnedOfflineSourceRepositoryPath)},
    mediaType: ${JSON.stringify(source.mediaType)},
  },
} as const

export const OPEN_CODE_MODELS_DEV_SNAPSHOT = {
  anthropic: {
    id: ${JSON.stringify(snapshot.anthropic.id)},
    name: ${JSON.stringify(snapshot.anthropic.name)},
    npm: ${JSON.stringify(snapshot.anthropic.npm)},
    models: {
${modelLines.join("\n")}
    },
  },
} as const
`
}

function requireRecord(input: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(input)) throw new Error(`${label} is invalid.`)
  return input
}

function hasOnlyKeys(input: Readonly<Record<string, unknown>>, allowed: ReadonlyArray<string>) {
  return Object.keys(input).every((key) => allowed.includes(key))
}

function isIdentifier(input: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input)
}

function compareCodeUnits(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isModality(input: unknown): input is Modality {
  return modalities.some((modality) => modality === input)
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function isDisplayName(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(input)
}

function isTokenLimit(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
