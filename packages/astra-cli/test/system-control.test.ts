import { describe, expect, test } from "bun:test"
import {
  buildAstraSystemSnapshot,
  routeAstraSystemDecision,
  type AstraSystemControlDependencies,
} from "../src/system-control"

const dependencies: AstraSystemControlDependencies = {
  readCatalog: () => ({
    ok: true,
    catalog: {
      providerID: "anthropic",
      providerName: "Anthropic",
      models: [],
      provenance: {
        sourceURL: "https://models.dev/api.json",
        sourceContentDigest: `sha256:${"1".repeat(64)}`,
        providerContentDigest: `sha256:${"2".repeat(64)}`,
      },
    },
  }),
  readCredential: async () => ({ type: "api", key: "sk-ant-parent-only" }),
  listGlobalExtensions: async () => [{ kind: "plugin", id: "global-plugin", state: "recorded" }],
  listOperations: async () => ({
    coverage: "dispatched_operations_only",
    operations: [
      {
        operationID: "90000000-0000-4000-8000-000000000001",
        intentKind: "provider_turn",
        state: "succeeded",
        semanticKey: "succeeded",
        sequence: 8,
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    ],
  }),
}

describe("Astra global System Control parent", () => {
  test("builds a secret-free snapshot from global-only trusted projections", async () => {
    const snapshot = await buildAstraSystemSnapshot("manual", dependencies)

    expect(snapshot).toMatchObject({
      version: "1.18.3",
      executionBackend: "host-no-sandbox",
      reviewMode: "manual",
      providers: [{ id: "anthropic", name: "Anthropic", credential: "present" }],
      extensions: [{ kind: "plugin", id: "global-plugin", state: "recorded" }],
      recentSessions: [],
      recentReceipts: [
        {
          operationID: "90000000-0000-4000-8000-000000000001",
          state: "succeeded",
          observedAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("sk-ant-parent-only")
  })

  test("keeps unavailable global sources explicit as unknown or empty", async () => {
    const snapshot = await buildAstraSystemSnapshot("auto-session", {
      ...dependencies,
      readCredential: async () => {
        throw new Error("auth unavailable")
      },
      listGlobalExtensions: async () => {
        throw new Error("inventory unavailable")
      },
      listOperations: async () => {
        throw new Error("ledger unavailable")
      },
    })

    expect(snapshot.reviewMode).toBe("auto-session")
    expect(snapshot.providers).toEqual([{ id: "anthropic", name: "Anthropic", credential: "unknown" }])
    expect(snapshot.extensions).toEqual([])
    expect(snapshot.recentSessions).toEqual([])
    expect(snapshot.recentReceipts).toEqual([])
  })

  test("routes only missing-provider setup through the trusted parent and keeps review in this session", async () => {
    const calls: Array<string> = []
    const missing = await buildAstraSystemSnapshot("manual", {
      ...dependencies,
      readCredential: async () => undefined,
    })
    const present = await buildAstraSystemSnapshot("manual", dependencies)
    const connector = async () => {
      calls.push("anthropic")
    }

    expect(await routeAstraSystemDecision(missing, { kind: "set-review-mode", mode: "auto-session" }, connector)).toEqual({
      kind: "continue",
      reviewMode: "auto-session",
    })
    expect(await routeAstraSystemDecision(missing, { kind: "connect-provider", providerID: "anthropic" }, connector)).toEqual({
      kind: "continue",
      reviewMode: "manual",
    })
    expect(await routeAstraSystemDecision(present, { kind: "connect-provider", providerID: "anthropic" }, connector)).toEqual({
      kind: "blocked",
      reviewMode: "manual",
    })
    expect(await routeAstraSystemDecision(missing, { kind: "exit" }, connector)).toEqual({ kind: "exit" })
    expect(calls).toEqual(["anthropic"])
  })
})
