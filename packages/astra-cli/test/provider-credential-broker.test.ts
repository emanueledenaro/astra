import { describe, expect, test } from "bun:test"
import { createParentProviderCredentialBroker } from "../src/provider-credential-broker"

const API_KEY = "sk-ant-private-test-key"

describe("parent provider credential broker", () => {
  test("issues exact OpenAI API-key and valid Codex OAuth profiles without refresh or writes", async () => {
    const records = new Map<string, unknown>([
      ["api", { type: "api", key: "sk-openai-private-key" }],
      [
        "oauth",
        {
          type: "oauth",
          access: "private-codex-access",
          refresh: "private-codex-refresh",
          expires: 120_000,
          accountId: "acct-work",
        },
      ],
    ])
    let selected = "api"
    const forbidden = { writes: 0, refreshes: 0 }
    const auth = {
      get: async (providerID: "anthropic" | "openai") => {
        expect(providerID).toBe("openai")
        return records.get(selected)
      },
      set: async () => {
        forbidden.writes += 1
      },
      refresh: async () => {
        forbidden.refreshes += 1
      },
    }
    const broker = createParentProviderCredentialBroker({
      auth,
      now: () => 1_000,
      monotonicNow: () => 1_000,
    })

    const api = await broker.issueForSession("session-api", {
      providerID: "openai",
      credentialProfile: "openai-api-key",
    })
    expect(api.ok).toBe(true)
    if (!api.ok) return
    expect(api.grant).toMatchObject({
      providerID: "openai",
      credentialProfile: "openai-api-key",
      headerName: "authorization",
    })
    expect(broker.takeForParentTransport(api.grant)).toMatchObject({
      ok: true,
      credential: {
        providerID: "openai",
        credentialProfile: "openai-api-key",
        headerName: "authorization",
        headerValue: "Bearer sk-openai-private-key",
        additionalHeaders: [],
      },
    })

    selected = "oauth"
    const oauth = await broker.issueForSession("session-oauth", {
      providerID: "openai",
      credentialProfile: "openai-codex-oauth",
    })
    expect(oauth.ok).toBe(true)
    if (!oauth.ok) return
    expect(oauth.grant).toMatchObject({
      providerID: "openai",
      credentialProfile: "openai-codex-oauth",
      headerName: "authorization",
    })
    expect(JSON.stringify(oauth.grant)).not.toContain("acct-work")
    expect(broker.takeForParentTransport(oauth.grant)).toMatchObject({
      ok: true,
      credential: {
        providerID: "openai",
        credentialProfile: "openai-codex-oauth",
        headerName: "authorization",
        headerValue: "Bearer private-codex-access",
        additionalHeaders: [["chatgpt-account-id", "acct-work"]],
      },
    })
    expect(forbidden).toEqual({ writes: 0, refreshes: 0 })
  })

  test("fails closed for expired Codex OAuth and an exact profile mismatch without refreshing", async () => {
    let reads = 0
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async () => {
          reads += 1
          return {
            type: reads === 1 ? "oauth" : "api",
            access: "expired-access",
            refresh: "must-not-be-used",
            expires: 1_000,
            key: "wrong-profile-key",
          }
        },
      },
      now: () => 1_000,
      monotonicNow: () => 1_000,
    })

    expect(
      await broker.issueForSession("session-oauth", {
        providerID: "openai",
        credentialProfile: "openai-codex-oauth",
      }),
    ).toMatchObject({ ok: false, error: { code: "credential_unavailable" } })
    expect(
      await broker.issueForSession("session-api", {
        providerID: "openai",
        credentialProfile: "openai-codex-oauth",
      }),
    ).toMatchObject({ ok: false, error: { code: "credential_unavailable" } })
  })

  test("rejects unsupported provider and credential profile pairs before reading Auth", async () => {
    let reads = 0
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async () => {
          reads += 1
          return { type: "api", key: API_KEY }
        },
      },
    })

    expect(
      await broker.issueForSession("session-1", {
        providerID: "openrouter",
        credentialProfile: "openai-api-key",
      }),
    ).toMatchObject({ ok: false })
    expect(
      await broker.issueForSession("session-1", {
        providerID: "openai",
        credentialProfile: "anthropic-api-key",
      }),
    ).toMatchObject({ ok: false })
    expect(reads).toBe(0)
  })

  test("reads only Anthropic API auth and returns a secret-free public grant", async () => {
    const calls: string[] = []
    const forbidden = { enumeration: 0, writes: 0, network: 0 }
    const auth = {
      get: async (providerID: "anthropic" | "openai") => {
        calls.push(providerID)
        return { type: "api", key: API_KEY, metadata: { account: "private" } }
      },
      all: async () => {
        forbidden.enumeration += 1
        throw new Error("Auth.all must not be called")
      },
      set: async () => {
        forbidden.writes += 1
        throw new Error("Auth.set must not be called")
      },
      fetch: async () => {
        forbidden.network += 1
        throw new Error("network must not be called")
      },
    }
    const broker = createParentProviderCredentialBroker({
      auth,
    })

    const result = await broker.issueForSession("session-1")

    expect(calls).toEqual(["anthropic"])
    expect(forbidden).toEqual({ enumeration: 0, writes: 0, network: 0 })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(JSON.stringify(result)).not.toContain("private")
    if (!result.ok) return
    expect(result.grant.providerID).toBe("anthropic")
    expect(result.grant.headerName).toBe("x-api-key")
    expect(result.grant.credentialHandle).toMatch(/^cred_[a-f0-9]{64}$/)
    expect(result.grant.accountFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test("rejects OAuth and does not leak auth fields through errors", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async () => ({
          type: "oauth",
          access: API_KEY,
          refresh: "private-refresh-token",
          expires: Date.now() + 1_000,
        }),
      },
    })

    const result = await broker.issueForSession("session-1")

    expect(result).toEqual({
      ok: false,
      error: {
        code: "credential_unavailable",
        message: "Anthropic API credential is unavailable.",
      },
    })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(JSON.stringify(result)).not.toContain("private-refresh-token")
  })

  test("does not leak a failing Auth.get cause", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async () => {
          throw new Error(`failed to load ${API_KEY}`)
        },
      },
    })

    const result = await broker.issueForSession("session-1")

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  test("sanitizes a resolved auth object with hostile getters", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async () =>
          Object.defineProperty({}, "type", {
            get: () => {
              throw new Error(API_KEY)
            },
          }),
      },
    })

    const result = await broker.issueForSession("session-1")

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  test("rejects an API key that could inject a transport header", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async () => ({
          type: "api",
          key: `${API_KEY}\r\nx-unsafe: value`,
        }),
      },
    })

    const result = await broker.issueForSession("session-1")

    expect(result).toEqual({
      ok: false,
      error: {
        code: "credential_unavailable",
        message: "Anthropic API credential is unavailable.",
      },
    })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  test("binds a handle to one session and consumes it on the first attempt", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
    })
    const issued = await broker.issueForSession("session-1")
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    const wrongSession = broker.takeForParentTransport({
      credentialHandle: issued.grant.credentialHandle,
      sessionID: "session-2",
    })
    expect(wrongSession).toEqual({
      ok: false,
      error: {
        code: "credential_invalid",
        message: "Credential handle is invalid or expired.",
      },
    })
    expect(
      broker.takeForParentTransport({
        credentialHandle: issued.grant.credentialHandle,
        sessionID: "session-1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "credential_invalid",
        message: "Credential handle is invalid or expired.",
      },
    })
  })

  test("returns the API key only across the private one-shot parent transport edge", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
    })
    const issued = await broker.issueForSession("session-1")
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    const taken = broker.takeForParentTransport({
      credentialHandle: issued.grant.credentialHandle,
      sessionID: "session-1",
    })
    expect(taken).toEqual({
      ok: true,
      credential: {
        providerID: "anthropic",
        credentialProfile: "anthropic-api-key",
        headerName: "x-api-key",
        headerValue: API_KEY,
        additionalHeaders: [],
        accountFingerprint: issued.grant.accountFingerprint,
      },
    })
    expect(
      broker.takeForParentTransport({
        credentialHandle: issued.grant.credentialHandle,
        sessionID: "session-1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "credential_invalid",
        message: "Credential handle is invalid or expired.",
      },
    })
  })

  test("revokes only an exact session-bound handle and releases its capacity", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
    })
    const issued = await Promise.all(Array.from({ length: 4 }, () => broker.issueForSession("session-1")))
    expect(issued.every((result) => result.ok)).toBe(true)
    const first = issued[0]
    if (!first?.ok) throw new Error("Expected an issued credential")

    expect(
      broker.revoke({
        credentialHandle: first.grant.credentialHandle,
        sessionID: "session-2",
      }),
    ).toBe(false)
    expect(
      broker.revoke({
        credentialHandle: first.grant.credentialHandle,
        sessionID: "session-1",
      }),
    ).toBe(true)
    expect(
      broker.revoke({
        credentialHandle: first.grant.credentialHandle,
        sessionID: "session-1",
      }),
    ).toBe(false)
    expect(
      broker.takeForParentTransport({
        credentialHandle: first.grant.credentialHandle,
        sessionID: "session-1",
      }),
    ).toMatchObject({ ok: false })
    expect((await broker.issueForSession("session-1")).ok).toBe(true)
  })

  test("keeps the non-secret account fingerprint stable inside one parent broker", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
    })

    const first = await broker.issueForSession("session-1")
    const second = await broker.issueForSession("session-2")

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.grant.accountFingerprint).toBe(second.grant.accountFingerprint)
    expect(first.grant.credentialHandle).not.toBe(second.grant.credentialHandle)
  })

  test("allocates colliding handles atomically across concurrent issues", async () => {
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
      randomBytes: (length) => new Uint8Array(length),
    })

    const results = await Promise.all([broker.issueForSession("session-1"), broker.issueForSession("session-2")])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toHaveLength(1)
  })

  test("caps live grants and releases capacity when the expiry callback runs", async () => {
    const expiryCallbacks: Array<() => void> = []
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
      scheduleExpiry: (callback) => {
        expiryCallbacks.push(callback)
        return () => undefined
      },
    })

    const grants = await Promise.all(Array.from({ length: 4 }, () => broker.issueForSession("session-1")))
    expect(grants.every((result) => result.ok)).toBe(true)
    expect(await broker.issueForSession("session-1")).toEqual({
      ok: false,
      error: {
        code: "credential_unavailable",
        message: "Anthropic API credential is unavailable.",
      },
    })

    expiryCallbacks[0]?.()
    expect((await broker.issueForSession("session-1")).ok).toBe(true)
  })

  test("expires handles and never returns an expired key", async () => {
    let now = 1_000
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
      now: () => now,
      monotonicNow: () => now,
      ttlMs: 50,
    })
    const issued = await broker.issueForSession("session-1")
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    now = issued.grant.expiresAt

    const result = broker.takeForParentTransport({
      credentialHandle: issued.grant.credentialHandle,
      sessionID: "session-1",
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: "credential_invalid",
        message: "Credential handle is invalid or expired.",
      },
    })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  test("fails closed and consumes the handle when the monotonic clock becomes invalid", async () => {
    let now = 1_000
    const broker = createParentProviderCredentialBroker({
      auth: { get: async () => ({ type: "api", key: API_KEY }) },
      now: () => now,
      monotonicNow: () => now,
    })
    const issued = await broker.issueForSession("session-1")
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    now = Number.NaN

    expect(
      broker.takeForParentTransport({
        credentialHandle: issued.grant.credentialHandle,
        sessionID: "session-1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "credential_invalid",
        message: "Credential handle is invalid or expired.",
      },
    })
  })

  test("releases active capacity after bounded never-settling auth reads", async () => {
    let blocked = true
    const broker = createParentProviderCredentialBroker({
      auth: {
        get: async (_providerID, signal) => {
          if (!blocked) return { type: "api", key: API_KEY }
          return await new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            }),
          )
        },
      },
      authTimeoutMs: 5,
    })

    const timedOut = await Promise.all(Array.from({ length: 4 }, () => broker.issueForSession("session-1")))
    expect(timedOut.every((result) => !result.ok)).toBe(true)
    blocked = false
    expect((await broker.issueForSession("session-1")).ok).toBe(true)
  })
})
