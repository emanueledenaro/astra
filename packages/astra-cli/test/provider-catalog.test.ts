import { describe, expect, test } from "bun:test"
import type { ProviderCatalogResult } from "../src/provider-catalog"
import { readAstraProviderCatalog } from "../src/provider-catalog"

describe("Astra provider catalog", () => {
  test("projects only bounded Anthropic text models from the build-injected snapshot", async () => {
    const result = await readBuiltCatalog(
      JSON.stringify({
        other: { id: "other", secret: "must-not-leak", models: {} },
        anthropic: {
          id: "anthropic",
          name: " Anthropic ",
          api: "https://private.example.invalid",
          env: ["ANTHROPIC_API_KEY"],
          models: {
            "claude-text": {
              id: "claude-text",
              name: " Claude Text ",
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 200_000, input: 190_000, output: 10_000 },
              cost: { input: 123 },
            },
            "claude-audio": {
              id: "claude-audio",
              name: "Claude Audio",
              modalities: { input: ["audio"], output: ["audio"] },
              limit: { context: 1, output: 1 },
            },
            "claude-old": {
              id: "claude-old",
              name: "Claude Old",
              status: "deprecated",
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 1, output: 1 },
            },
          },
        },
      }),
    )

    expect(result).toEqual({
      ok: true,
      catalog: {
        providerID: "anthropic",
        providerName: "Anthropic",
        models: [
          {
            id: "claude-text",
            name: "Claude Text",
            limits: { context: 200_000, input: 190_000, output: 10_000 },
          },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain("must-not-leak")
    expect(JSON.stringify(result)).not.toContain("ANTHROPIC_API_KEY")
    expect(JSON.stringify(result)).not.toContain("private.example.invalid")
  })

  test("fails closed when the build has no embedded snapshot", () => {
    expect(readAstraProviderCatalog()).toEqual({
      ok: false,
      error: {
        code: "catalog_unavailable",
        message: "Embedded OpenCode model catalog is unavailable.",
      },
    })
  })

  test("sanitizes a hostile build injection without leaking its error", async () => {
    const result = await readBuiltCatalog(`({ get anthropic() { throw new Error("sk-ant-secret"); } })`)

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret")
  })

  test("copies validated fields once so stateful getters cannot change public data", async () => {
    const result = await readBuiltCatalog(`(() => {
      let reads = 0;
      return {
        anthropic: {
          id: "anthropic",
          get name() { reads += 1; return reads === 1 ? "Anthropic" : "sk-ant-secret"; },
          models: {
            claude: {
              id: "claude",
              name: "Claude",
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 10, output: 5 }
            }
          }
        }
      };
    })()`)

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret")
    if (!result.ok) return
    expect(result.catalog.providerName).toBe("Anthropic")
  })

  test("returns immutable public catalog data", async () => {
    const result = await readBuiltCatalog(
      JSON.stringify({
        anthropic: {
          id: "anthropic",
          name: "Anthropic",
          models: {
            claude: {
              id: "claude",
              name: "Claude",
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 10, output: 5 },
            },
          },
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.isFrozen(result.catalog)).toBe(true)
    expect(Object.isFrozen(result.catalog.models)).toBe(true)
    expect(Object.isFrozen(result.catalog.models[0])).toBe(true)
    expect(Object.isFrozen(result.catalog.models[0]?.limits)).toBe(true)
  })
})

async function readBuiltCatalog(snapshotExpression: string) {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/../src/provider-catalog.ts`],
    target: "bun",
    plugins: [
      {
        name: "astra-test-embedded-models",
        setup(builder) {
          builder.onLoad({ filter: /provider-catalog-embedded\.ts$/ }, () => ({
            contents: `export const OPEN_CODE_MODELS_DEV_SNAPSHOT = ${snapshotExpression}`,
            loader: "ts",
          }))
        },
      },
    ],
  })
  if (!build.success || !build.outputs[0]) throw new Error("Provider catalog test bundle failed.")
  const moduleURL = URL.createObjectURL(new Blob([await build.outputs[0].text()], { type: "text/javascript" }))
  try {
    const module = (await import(moduleURL)) as Readonly<{
      readAstraProviderCatalog: () => ProviderCatalogResult
    }>
    return module.readAstraProviderCatalog()
  } finally {
    URL.revokeObjectURL(moduleURL)
  }
}
