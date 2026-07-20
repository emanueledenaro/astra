/**
 * Generated from the OpenCode models.dev source. Do not edit by hand.
 * Regenerate with: bun run generate:provider-catalog
 */
export const OPEN_CODE_MODELS_DEV_SNAPSHOT_METADATA = {
  schemaVersion: 1,
  sourceURL: "https://models.dev/api.json",
  sourceContentDigest: "sha256:876afae217cdff37c7267ba757d4d375a64eb52cdb2caa24c7f027b5142e3265",
  providerContentDigest: "sha256:32d00a9c66d3c5928053ad6208cd0e94a86e899600549d91dd3ae60dbf3925d0",
  retrieval: {
    method: "GET",
    offlineReplay: "--check --offline-source <pinned-api.json>",
    offlineSource: "packages/opencode/test/tool/fixtures/models-api.json",
    mediaType: "application/json",
  },
} as const

export const OPEN_CODE_MODELS_DEV_SNAPSHOT = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-fable-5": {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 128000,
        },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (latest)",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 200000,
          output: 64000,
        },
      },
      "claude-haiku-4-5-20251001": {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 200000,
          output: 64000,
        },
      },
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (latest)",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 200000,
          output: 64000,
        },
      },
      "claude-opus-4-5-20251101": {
        id: "claude-opus-4-5-20251101",
        name: "Claude Opus 4.5",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 200000,
          output: 64000,
        },
      },
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 128000,
        },
      },
      "claude-opus-4-7": {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 128000,
        },
      },
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 128000,
        },
      },
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5 (latest)",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 64000,
        },
      },
      "claude-sonnet-4-5-20250929": {
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 64000,
        },
      },
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 128000,
        },
      },
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        limit: {
          context: 1000000,
          output: 128000,
        },
      },
    },
  },
} as const
