import {
  resolveCertifiedProviderAdapter,
  type CertifiedProviderAdapter,
  type CertifiedProviderCredentialProfile,
  type CertifiedProviderID,
} from "@astra/runtime/provider-adapter-registry"

const DEFAULT_SELECTION = Object.freeze({
  providerID: "anthropic" as const,
  credentialProfile: "anthropic-api-key" as const,
})
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 300_000
const RANDOM_BYTES = 32
const MAX_HANDLE_ATTEMPTS = 4
const MAX_LIVE_GRANTS = 64
const MAX_SESSION_GRANTS = 4
const DEFAULT_AUTH_TIMEOUT_MS = 1_000
const MAX_AUTH_TIMEOUT_MS = 5_000

export type ProviderCredentialSelection = Readonly<{
  providerID: string
  credentialProfile: string
}>

type ResolvedCredential = Readonly<{
  providerID: CertifiedProviderID
  credentialProfile: CertifiedProviderCredentialProfile
  headerName: "x-api-key" | "authorization"
  headerValue: string
  additionalHeaders: ReadonlyArray<readonly [name: string, value: string]>
  expiresAt: number | null
  fingerprintMaterial: string
}>

type CredentialRecord = Readonly<{
  providerID: CertifiedProviderID
  credentialProfile: CertifiedProviderCredentialProfile
  headerName: "x-api-key" | "authorization"
  headerValue: string
  additionalHeaders: ReadonlyArray<readonly [name: string, value: string]>
  accountFingerprint: string
  sessionID: string
  issuedAtMonotonic: number
  expiresAtMonotonic: number
  expiresAt: number
}>

type ActiveIssue = Readonly<{ token: symbol }>

export type ParentAnthropicAuthReader = Readonly<{
  get: (providerID: CertifiedProviderID, signal: AbortSignal) => Promise<unknown>
}>

export type ProviderCredentialGrant = Readonly<{
  providerID: CertifiedProviderID
  credentialProfile?: CertifiedProviderCredentialProfile
  credentialHandle: string
  accountFingerprint: string
  headerName: "x-api-key" | "authorization"
  additionalHeaderNames?: ReadonlyArray<string>
  expiresAt: number
  sessionID: string
}>

export type ProviderCredentialError = Readonly<{
  code: "credential_unavailable" | "credential_invalid"
  message:
    | "Anthropic API credential is unavailable."
    | "OpenAI credential is unavailable."
    | "Provider credential is unavailable."
    | "Credential handle is invalid or expired."
}>

export type ProviderCredentialGrantResult =
  | Readonly<{ ok: true; grant: ProviderCredentialGrant }>
  | Readonly<{ ok: false; error: ProviderCredentialError }>

export type ParentTransportCredentialResult =
  | Readonly<{
      ok: true
      credential: Readonly<{
        providerID: CertifiedProviderID
        credentialProfile?: CertifiedProviderCredentialProfile
        headerName: "x-api-key" | "authorization"
        headerValue: string
        additionalHeaders?: ReadonlyArray<readonly [name: string, value: string]>
        accountFingerprint: string
      }>
    }>
  | Readonly<{ ok: false; error: ProviderCredentialError }>

export type ParentProviderCredentialBroker = Readonly<{
  issueForSession: (
    sessionID: string,
    selection?: ProviderCredentialSelection,
  ) => Promise<ProviderCredentialGrantResult>
  revoke: (input: Readonly<{ credentialHandle: string; sessionID: string }>) => boolean
  takeForParentTransport: (
    input: Readonly<{ credentialHandle: string; sessionID: string }>,
  ) => ParentTransportCredentialResult
}>

export type ParentProviderCredentialBrokerOptions = Readonly<{
  auth: ParentAnthropicAuthReader
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  monotonicNow?: () => number
  scheduleExpiry?: (callback: () => void, delayMs: number) => () => void
  authTimeoutMs?: number
  ttlMs?: number
}>

/**
 * Creates a parent-process-only, memory-resident credential broker. Its public
 * grant contains only an opaque one-shot handle and a session-scoped account
 * fingerprint. Only takeForParentTransport crosses the private transport edge.
 */
export function createParentProviderCredentialBroker(
  options: ParentProviderCredentialBrokerOptions,
): ParentProviderCredentialBroker {
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance)
  const randomBytes = options.randomBytes ?? secureRandomBytes
  const scheduleExpiry = options.scheduleExpiry ?? scheduleDefaultExpiry
  const authTimeoutMs = requireAuthTimeout(options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS)
  const ttlMs = requireTTL(options.ttlMs ?? DEFAULT_TTL_MS)
  const fingerprintSalt = safeRandomBytes(randomBytes)
  const records = new Map<string, CredentialRecord>()
  const expiryCancellations = new Map<string, () => void>()
  const activeIssues = new Map<string, Set<ActiveIssue>>()

  const issueForSession = async (
    sessionID: string,
    selection: ProviderCredentialSelection = DEFAULT_SELECTION,
  ): Promise<ProviderCredentialGrantResult> => {
    const adapter = resolveCertifiedProviderAdapter(selection.providerID, selection.credentialProfile)
    if (!adapter || !isSessionID(sessionID)) return unavailableCredential(selection.providerID)
    const requestedAt = readMonotonicTime(monotonicNow)
    if (requestedAt === undefined) return unavailableCredential(adapter.providerID)
    purgeExpired(records, expiryCancellations, requestedAt)
    if (!hasIssueCapacity(records, activeIssues, sessionID)) return unavailableCredential(adapter.providerID)

    const activeIssue = addActiveIssue(activeIssues, sessionID)
    try {
      const authReadAt = readWallTime(now)
      if (authReadAt === undefined) return unavailableCredential(adapter.providerID)
      const credential = await readProviderCredential(options.auth, adapter, authTimeoutMs, authReadAt)
      if (!credential || !fingerprintSalt) return unavailableCredential(adapter.providerID)
      const accountFingerprint = await fingerprint(credential.fingerprintMaterial, fingerprintSalt)
      if (!accountFingerprint) return unavailableCredential(adapter.providerID)

      const issuedAt = readWallTime(now)
      const issuedAtMonotonic = readMonotonicTime(monotonicNow)
      if (issuedAt === undefined || issuedAtMonotonic === undefined) return unavailableCredential(adapter.providerID)
      const expiresAt = Math.min(issuedAt + ttlMs, credential.expiresAt ?? Number.MAX_SAFE_INTEGER)
      const liveForMilliseconds = expiresAt - issuedAt
      const expiresAtMonotonic = issuedAtMonotonic + liveForMilliseconds
      if (!Number.isSafeInteger(expiresAt) || liveForMilliseconds <= 0 || !Number.isFinite(expiresAtMonotonic)) {
        return unavailableCredential(adapter.providerID)
      }

      purgeExpired(records, expiryCancellations, issuedAtMonotonic)
      if (!hasGrantCapacity(records, sessionID)) return unavailableCredential(adapter.providerID)
      const credentialHandle = allocateHandle(records, randomBytes)
      if (!credentialHandle) return unavailableCredential(adapter.providerID)

      records.set(
        credentialHandle,
        Object.freeze({
          providerID: credential.providerID,
          credentialProfile: credential.credentialProfile,
          headerName: credential.headerName,
          additionalHeaderNames: credential.additionalHeaders.map(([name]) => name),
          headerValue: credential.headerValue,
          additionalHeaders: credential.additionalHeaders,
          sessionID,
          issuedAtMonotonic,
          expiresAtMonotonic,
          expiresAt,
          accountFingerprint,
        }),
      )
      const cancelExpiry = safelyScheduleExpiry(
        scheduleExpiry,
        () => {
          records.delete(credentialHandle)
          expiryCancellations.delete(credentialHandle)
        },
        liveForMilliseconds,
      )
      if (!cancelExpiry || !records.has(credentialHandle)) {
        records.delete(credentialHandle)
        safelyCancelExpiry(cancelExpiry)
        return unavailableCredential(adapter.providerID)
      }
      expiryCancellations.set(credentialHandle, cancelExpiry)

      return Object.freeze({
        ok: true,
        grant: Object.freeze({
          providerID: credential.providerID,
          credentialProfile: credential.credentialProfile,
          credentialHandle,
          accountFingerprint,
          headerName: credential.headerName,
          expiresAt,
          sessionID,
        }),
      })
    } finally {
      removeActiveIssue(activeIssues, sessionID, activeIssue)
    }
  }

  const takeForParentTransport = (input: Readonly<{ credentialHandle: string; sessionID: string }>) => {
    if (!isCredentialHandle(input.credentialHandle) || !isSessionID(input.sessionID)) return invalidCredential()
    const record = records.get(input.credentialHandle)
    if (!record) return invalidCredential()

    removeGrant(records, expiryCancellations, input.credentialHandle)
    const consumedAt = readMonotonicTime(monotonicNow)
    if (
      record.sessionID !== input.sessionID ||
      consumedAt === undefined ||
      consumedAt < record.issuedAtMonotonic ||
      consumedAt >= record.expiresAtMonotonic
    )
      return invalidCredential()
    return Object.freeze({
      ok: true as const,
      credential: Object.freeze({
        providerID: record.providerID,
        credentialProfile: record.credentialProfile,
        headerName: record.headerName,
        headerValue: record.headerValue,
        additionalHeaders: record.additionalHeaders,
        accountFingerprint: record.accountFingerprint,
      }),
    })
  }

  const revoke = (input: Readonly<{ credentialHandle: string; sessionID: string }>) => {
    if (!isCredentialHandle(input.credentialHandle) || !isSessionID(input.sessionID)) return false
    const record = records.get(input.credentialHandle)
    if (!record || record.sessionID !== input.sessionID) return false
    removeGrant(records, expiryCancellations, input.credentialHandle)
    return true
  }

  return Object.freeze({ issueForSession, revoke, takeForParentTransport })
}

async function readProviderCredential(
  auth: ParentAnthropicAuthReader,
  adapter: CertifiedProviderAdapter,
  timeoutMs: number,
  currentTime: number,
): Promise<ResolvedCredential | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  try {
    const input = await Promise.race([
      Promise.resolve().then(() => auth.get(adapter.providerID, controller.signal)),
      new Promise<undefined>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(undefined), {
          once: true,
        }),
      ),
    ])
    if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
    const type = "type" in input ? input.type : undefined
    if (adapter.credentialProfile === "anthropic-api-key" || adapter.credentialProfile === "openai-api-key") {
      const key = "key" in input ? input.key : undefined
      if (type !== "api" || !isHeaderValue(key)) return undefined
      return Object.freeze({
        providerID: adapter.providerID,
        credentialProfile: adapter.credentialProfile,
        headerName: adapter.credential.headerName,
        headerValue: adapter.credential.scheme === "bearer" ? `Bearer ${key}` : key,
        additionalHeaders: Object.freeze([]),
        expiresAt: null,
        fingerprintMaterial: `${adapter.providerID}\0${adapter.credentialProfile}\0${key}`,
      })
    }
    const access = "access" in input ? input.access : undefined
    const expires = "expires" in input ? input.expires : undefined
    const accountID = "accountId" in input ? input.accountId : undefined
    if (
      type !== "oauth" ||
      !isHeaderValue(access) ||
      typeof expires !== "number" ||
      !Number.isSafeInteger(expires) ||
      expires <= currentTime ||
      (accountID !== undefined && !isHeaderValue(accountID))
    ) {
      return undefined
    }
    const additionalHeaders = accountID
      ? Object.freeze([["chatgpt-account-id", accountID] as const])
      : Object.freeze([])
    return Object.freeze({
      providerID: adapter.providerID,
      credentialProfile: adapter.credentialProfile,
      headerName: adapter.credential.headerName,
      headerValue: `Bearer ${access}`,
      additionalHeaders,
      expiresAt: expires,
      fingerprintMaterial: `${adapter.providerID}\0${adapter.credentialProfile}\0${access}\0${accountID ?? ""}`,
    })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function isHeaderValue(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0 || input.length > 4_096) return false
  return !Array.from(input).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function hasIssueCapacity(
  records: ReadonlyMap<string, CredentialRecord>,
  activeIssues: ReadonlyMap<string, ReadonlySet<ActiveIssue>>,
  sessionID: string,
) {
  const activeCount = Array.from(activeIssues.values()).reduce((total, issues) => total + issues.size, 0)
  const liveForSession = Array.from(records.values()).filter((record) => record.sessionID === sessionID).length
  const activeForSession = activeIssues.get(sessionID)?.size ?? 0
  return records.size + activeCount < MAX_LIVE_GRANTS && liveForSession + activeForSession < MAX_SESSION_GRANTS
}

function hasGrantCapacity(records: ReadonlyMap<string, CredentialRecord>, sessionID: string) {
  return (
    records.size < MAX_LIVE_GRANTS &&
    Array.from(records.values()).filter((record) => record.sessionID === sessionID).length < MAX_SESSION_GRANTS
  )
}

function addActiveIssue(activeIssues: Map<string, Set<ActiveIssue>>, sessionID: string) {
  const issue = Object.freeze({ token: Symbol(sessionID) })
  const sessionIssues = activeIssues.get(sessionID) ?? new Set<ActiveIssue>()
  sessionIssues.add(issue)
  activeIssues.set(sessionID, sessionIssues)
  return issue
}

function removeActiveIssue(activeIssues: Map<string, Set<ActiveIssue>>, sessionID: string, issue: ActiveIssue) {
  const sessionIssues = activeIssues.get(sessionID)
  if (!sessionIssues) return
  sessionIssues.delete(issue)
  if (sessionIssues.size === 0) activeIssues.delete(sessionID)
}

function purgeExpired(
  records: Map<string, CredentialRecord>,
  expiryCancellations: Map<string, () => void>,
  currentTime: number,
) {
  records.forEach((record, handle) => {
    if (currentTime < record.issuedAtMonotonic || currentTime >= record.expiresAtMonotonic) {
      removeGrant(records, expiryCancellations, handle)
    }
  })
}

function removeGrant(
  records: Map<string, CredentialRecord>,
  expiryCancellations: Map<string, () => void>,
  handle: string,
) {
  records.delete(handle)
  const cancelExpiry = expiryCancellations.get(handle)
  expiryCancellations.delete(handle)
  safelyCancelExpiry(cancelExpiry)
}

function safelyScheduleExpiry(
  scheduleExpiry: (callback: () => void, delayMs: number) => () => void,
  callback: () => void,
  delayMs: number,
) {
  try {
    return scheduleExpiry(callback, delayMs)
  } catch {
    return undefined
  }
}

function scheduleDefaultExpiry(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

function safelyCancelExpiry(cancelExpiry: (() => void) | undefined) {
  try {
    cancelExpiry?.()
  } catch {
    return
  }
}

function readWallTime(now: () => number) {
  try {
    const value = now()
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

function readMonotonicTime(now: () => number) {
  try {
    const value = now()
    return Number.isFinite(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

function allocateHandle(records: ReadonlyMap<string, CredentialRecord>, randomBytes: (length: number) => Uint8Array) {
  for (const _attempt of Array.from({ length: MAX_HANDLE_ATTEMPTS })) {
    const random = safeRandomBytes(randomBytes)
    if (!random) return undefined
    const handle = `cred_${toHex(random)}`
    if (!records.has(handle)) return handle
  }
  return undefined
}

async function fingerprint(apiKey: string, salt: Uint8Array) {
  const key = new TextEncoder().encode(apiKey)
  const input = new Uint8Array(salt.length + key.length)
  input.set(salt)
  input.set(key, salt.length)
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
    return `sha256:${toHex(digest)}`
  } catch {
    return undefined
  } finally {
    input.fill(0)
    key.fill(0)
  }
}

function safeRandomBytes(randomBytes: (length: number) => Uint8Array) {
  try {
    const value = randomBytes(RANDOM_BYTES)
    return value.length === RANDOM_BYTES ? Uint8Array.from(value) : undefined
  } catch {
    return undefined
  }
}

function secureRandomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toHex(input: Uint8Array) {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function isSessionID(input: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
}

function isCredentialHandle(input: string) {
  return /^cred_[a-f0-9]{64}$/.test(input)
}

function requireTTL(input: number) {
  if (!Number.isSafeInteger(input) || input <= 0 || input > MAX_TTL_MS) {
    throw new TypeError("Credential broker TTL must be a positive bounded integer.")
  }
  return input
}

function requireAuthTimeout(input: number) {
  if (!Number.isSafeInteger(input) || input <= 0 || input > MAX_AUTH_TIMEOUT_MS) {
    throw new TypeError("Credential broker auth timeout must be a positive bounded integer.")
  }
  return input
}

function unavailableCredential(providerID?: string): ProviderCredentialGrantResult {
  const message =
    providerID === "anthropic"
      ? "Anthropic API credential is unavailable."
      : providerID === "openai"
        ? "OpenAI credential is unavailable."
        : "Provider credential is unavailable."
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "credential_unavailable",
      message,
    }),
  })
}

function invalidCredential(): ParentTransportCredentialResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "credential_invalid",
      message: "Credential handle is invalid or expired.",
    }),
  })
}
