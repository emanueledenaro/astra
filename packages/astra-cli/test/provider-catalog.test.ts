import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import type { ProviderCatalogResult } from "../src/provider-catalog"
import { OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA } from "../src/provider-catalog-embedded"
import { readAstraProviderCatalog } from "../src/provider-catalog"

const textModel = {
  id: "claude-text",
  name: "Claude Text",
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 200_000, input: 190_000, output: 10_000 },
} as const

describe("Astra provider catalog", () => {
  test("accepts an exactly bound canonical Anthropic snapshot", async () => {
    const snapshot = makeSnapshot({ "claude-text": textModel })
    const result = await readBuiltCatalog(JSON.stringify(snapshot), JSON.stringify(metadataFor(snapshot)))

    expect(result).toMatchObject({
      ok: true,
      catalog: {
        providers: [{ providerID: "anthropic" }, { providerID: "openai" }],
      },
    })
    if (!result.ok) return
    expect(anthropicProvider(result)).toEqual({
      providerID: "anthropic",
      providerName: "Anthropic",
      assurance: "CERTIFIED",
      dispatchable: true,
      credentialProfiles: ["anthropic-api-key"],
      models: [
        {
          id: "claude-text",
          name: "Claude Text",
          limits: { context: 200_000, input: 190_000, output: 10_000 },
        },
      ],
      provenance: {
        sourceURL: "https://models.dev/api.json",
        sourceContentDigest: `sha256:${"1".repeat(64)}`,
        providerContentDigest: digest(JSON.stringify(snapshot.anthropic)),
      },
    })
  })

  test("loads only non-empty official Anthropic API models in local source mode", () => {
    const result = readAstraProviderCatalog()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const provider = anthropicProvider(result)
    expect(provider.providerID).toBe("anthropic")
    expect(provider.providerName).toBe("Anthropic")
    expect(provider.models.length).toBeGreaterThan(0)
    expect(provider.models.every((model) => model.id.startsWith("claude-"))).toBe(true)
    expect(new Set(provider.models.map((model) => model.id)).size).toBe(provider.models.length)
    expect(provider.models.map((model) => model.id)).toEqual(
      provider.models.map((model) => model.id).sort(compareCodeUnits),
    )
    expect(provider.provenance.sourceURL).toBe("https://models.dev/api.json")
    expect(provider.provenance.sourceContentDigest).toBe(OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA.sourceContentDigest)
    expect(provider.provenance.providerContentDigest).toBe(OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA.providerContentDigest)
  })

  test("fails closed when a build has no embedded snapshot or metadata", async () => {
    expect((await readBuiltCatalog("undefined", "undefined")).ok).toBe(false)
    expect((await readBuiltCatalog(JSON.stringify(makeSnapshot({ "claude-text": textModel })), "undefined")).ok).toBe(
      false,
    )
  })

  test("rejects snapshot tampering when the provider digest is stale", async () => {
    const original = makeSnapshot({ "claude-text": textModel })
    const tampered = makeSnapshot({
      "claude-text": {
        ...textModel,
        limit: { ...textModel.limit, output: 99_999 },
      },
    })
    const result = await readBuiltCatalog(JSON.stringify(tampered), JSON.stringify(metadataFor(original)))

    expect(result.ok).toBe(false)
  })

  test("rejects non-canonical API fields, adapters, models, and ordering", async () => {
    const snapshot = makeSnapshot({ "claude-text": textModel })
    const api = {
      anthropic: { ...snapshot.anthropic, api: "https://proxy.invalid" },
    }
    const npm = {
      anthropic: { ...snapshot.anthropic, npm: "@hostile/adapter" },
    }
    const audio = makeSnapshot({
      "claude-audio": {
        id: "claude-audio",
        name: "Claude Audio",
        modalities: { input: ["audio"], output: ["audio"] },
        limit: { context: 10, output: 5 },
      },
    })
    const unsorted = makeSnapshot({
      "claude-z": { ...textModel, id: "claude-z", name: "Claude Z" },
      "claude-a": { ...textModel, id: "claude-a", name: "Claude A" },
    })

    expect((await readBuiltCatalog(JSON.stringify(api), JSON.stringify(metadataFor(api)))).ok).toBe(false)
    expect((await readBuiltCatalog(JSON.stringify(npm), JSON.stringify(metadataFor(npm)))).ok).toBe(false)
    expect((await readBuiltCatalog(JSON.stringify(audio), JSON.stringify(metadataFor(audio)))).ok).toBe(false)
    expect((await readBuiltCatalog(JSON.stringify(unsorted), JSON.stringify(metadataFor(unsorted)))).ok).toBe(false)
  })

  test("sanitizes a hostile build injection without leaking its error", async () => {
    const result = await readBuiltCatalog(
      `({ get anthropic() { throw new Error("sk-ant-secret"); } })`,
      JSON.stringify(metadataFor(makeSnapshot({ "claude-text": textModel }))),
    )

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret")
  })

  test("copies validated fields once so stateful getters cannot change public data", async () => {
    const snapshot = makeSnapshot({ "claude-text": textModel })
    const result = await readBuiltCatalog(
      `(() => {
        let reads = 0;
        return {
          anthropic: {
            id: "anthropic",
            get name() { reads += 1; return reads === 1 ? "Anthropic" : "sk-ant-secret"; },
            npm: "@ai-sdk/anthropic",
            models: ${JSON.stringify(snapshot.anthropic.models)}
          }
        };
      })()`,
      JSON.stringify(metadataFor(snapshot)),
    )

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret")
  })

  test("returns immutable public catalog data", async () => {
    const snapshot = makeSnapshot({ "claude-text": textModel })
    const result = await readBuiltCatalog(JSON.stringify(snapshot), JSON.stringify(metadataFor(snapshot)))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const provider = anthropicProvider(result)
    expect(Object.isFrozen(result.catalog)).toBe(true)
    expect(Object.isFrozen(result.catalog.providers)).toBe(true)
    expect(Object.isFrozen(provider.models)).toBe(true)
    expect(Object.isFrozen(provider.models[0])).toBe(true)
    expect(Object.isFrozen(provider.models[0]?.limits)).toBe(true)
    expect(Object.isFrozen(provider.provenance)).toBe(true)
  })
})

function makeSnapshot(models: Readonly<Record<string, unknown>>) {
  return {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      models,
    },
  } as const
}

function metadataFor(snapshot: Readonly<{ anthropic: unknown }>) {
  return {
    schemaVersion: 1,
    sourceURL: "https://models.dev/api.json",
    sourceContentDigest: `sha256:${"1".repeat(64)}`,
    providerContentDigest: digest(JSON.stringify(snapshot.anthropic)),
    retrieval: {
      method: "GET",
      offlineReplay: "--check --offline-source <pinned-api.json>",
      offlineSource: "packages/opencode/test/tool/fixtures/models-api.json",
      mediaType: "application/json",
    },
  } as const
}

async function readBuiltCatalog(snapshotExpression: string, metadataExpression: string) {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/../src/provider-catalog.ts`],
    target: "bun",
    plugins: [
      {
        name: "astra-test-embedded-models",
        setup(builder) {
          builder.onLoad({ filter: /provider-catalog-embedded\.ts$/ }, () => ({
            contents: `
              export const OPEN_CODE_MODELS_DEV_SNAPSHOT = ${snapshotExpression};
              export const OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA = ${metadataExpression};
            `,
            loader: "ts",
          }))
        },
      },
    ],
  })
  if (!build.success || !build.outputs[0]) throw new Error("Provider catalog test bundle failed.")
  const moduleURL = URL.createObjectURL(new Blob([await build.outputs[0].text()], { type: "text/javascript" }))
  try {
    const module: unknown = await import(moduleURL)
    if (!isProviderCatalogModule(module)) throw new Error("Provider catalog test bundle has an invalid export.")
    return module.readAstraProviderCatalog()
  } finally {
    URL.revokeObjectURL(moduleURL)
  }
}

function isProviderCatalogModule(input: unknown): input is Readonly<{
  readAstraProviderCatalog: () => ProviderCatalogResult
}> {
  return (
    typeof input === "object" &&
    input !== null &&
    "readAstraProviderCatalog" in input &&
    typeof input.readAstraProviderCatalog === "function"
  )
}

function anthropicProvider(result: Extract<ProviderCatalogResult, { ok: true }>) {
  const provider = result.catalog.providers.find((candidate) => candidate.providerID === "anthropic")
  if (!provider) throw new Error("Anthropic test provider is missing")
  return provider
}

function compareCodeUnits(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
