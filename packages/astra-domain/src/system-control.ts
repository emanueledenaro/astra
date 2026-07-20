import { parseBoundedString, parseCanonicalTimestamp, parseExactRecord } from "./operation-contract-validation"

const maximumProviders = 32
const maximumExtensions = 64
const maximumRecentSessions = 20
const maximumRecentReceipts = 64
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export type AstraSystemSnapshot = Readonly<{
  version: string
  executionBackend: "host-no-sandbox"
  reviewMode: "manual" | "auto-session"
  providers: ReadonlyArray<Readonly<{ id: string; name: string; credential: "present" | "missing" | "unknown" }>>
  extensions: ReadonlyArray<Readonly<{ kind: "skill" | "plugin" | "mcp"; id: string; state: string }>>
  recentSessions: ReadonlyArray<Readonly<{ sessionID: string; workspaceRoot: string; updatedAt: string }>>
  recentReceipts: ReadonlyArray<Readonly<{ operationID: string; state: string; observedAt: string }>>
}>

export type AstraSystemDecision =
  | Readonly<{ kind: "connect-provider"; providerID: string }>
  | Readonly<{ kind: "set-review-mode"; mode: "manual" | "auto-session" }>
  | Readonly<{ kind: "exit" }>

export type AstraSystemControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_system_snapshot" | "invalid_system_decision" }>

/** Accepts a bounded, display-only global snapshot with no credential-value field. */
export function parseAstraSystemSnapshot(input: unknown): AstraSystemControlParseResult<AstraSystemSnapshot> {
  const record = exact(input, [
    "version",
    "executionBackend",
    "reviewMode",
    "providers",
    "extensions",
    "recentSessions",
    "recentReceipts",
  ])
  if (!record) return invalidSnapshot()
  const version = parseBoundedString(record.version, "$.version", 128)
  if (!version.ok || record.executionBackend !== "host-no-sandbox") return invalidSnapshot()
  if (record.reviewMode !== "manual" && record.reviewMode !== "auto-session") return invalidSnapshot()
  const providers = parseProviders(record.providers)
  const extensions = parseExtensions(record.extensions)
  const recentSessions = parseRecentSessions(record.recentSessions)
  const recentReceipts = parseRecentReceipts(record.recentReceipts)
  if (!providers || !extensions || !recentSessions || !recentReceipts) return invalidSnapshot()
  return {
    ok: true,
    value: Object.freeze({
      version: version.value,
      executionBackend: "host-no-sandbox",
      reviewMode: record.reviewMode,
      providers,
      extensions,
      recentSessions,
      recentReceipts,
    }),
  }
}

/** Accepts only the narrow intent that the trusted parent can choose to route. */
export function parseAstraSystemDecision(input: unknown): AstraSystemControlParseResult<AstraSystemDecision> {
  const broad = parseExactRecord(input, ["kind", "providerID", "mode"])
  if (!broad.ok || typeof broad.value.kind !== "string") return invalidDecision()
  if (broad.value.kind === "connect-provider") {
    const providerID = parseBoundedString(broad.value.providerID, "$.providerID", 128)
    if (!providerID.ok || !exact(input, ["kind", "providerID"])) return invalidDecision()
    return { ok: true, value: Object.freeze({ kind: "connect-provider", providerID: providerID.value }) }
  }
  if (broad.value.kind === "set-review-mode") {
    if ((broad.value.mode !== "manual" && broad.value.mode !== "auto-session") || !exact(input, ["kind", "mode"])) {
      return invalidDecision()
    }
    return { ok: true, value: Object.freeze({ kind: "set-review-mode", mode: broad.value.mode }) }
  }
  if (broad.value.kind === "exit" && exact(input, ["kind"])) return { ok: true, value: Object.freeze({ kind: "exit" }) }
  return invalidDecision()
}

function parseProviders(input: unknown) {
  if (!Array.isArray(input) || input.length > maximumProviders) return null
  const providers = input.map((entry, index) => {
    const record = exact(entry, ["id", "name", "credential"])
    const id = record ? parseBoundedString(record.id, `$.providers[${index}].id`, 128) : undefined
    const name = record ? parseBoundedString(record.name, `$.providers[${index}].name`, 160) : undefined
    if (
      !record ||
      !id?.ok ||
      !name?.ok ||
      (record.credential !== "present" && record.credential !== "missing" && record.credential !== "unknown")
    ) {
      return null
    }
    return Object.freeze({ id: id.value, name: name.value, credential: record.credential })
  })
  if (providers.some((provider) => provider === null)) return null
  const values = providers.flatMap((provider) => (provider ? [provider] : []))
  if (new Set(values.map((provider) => provider.id)).size !== values.length) return null
  return Object.freeze(values)
}

function parseExtensions(input: unknown) {
  if (!Array.isArray(input) || input.length > maximumExtensions) return null
  const extensions = input.map((entry, index) => {
    const record = exact(entry, ["kind", "id", "state"])
    const id = record ? parseBoundedString(record.id, `$.extensions[${index}].id`, 256) : undefined
    const state = record ? parseBoundedString(record.state, `$.extensions[${index}].state`, 128) : undefined
    if (
      !record ||
      !id?.ok ||
      !state?.ok ||
      (record.kind !== "skill" && record.kind !== "plugin" && record.kind !== "mcp")
    ) {
      return null
    }
    return Object.freeze({ kind: record.kind, id: id.value, state: state.value })
  })
  if (extensions.some((extension) => extension === null)) return null
  const values = extensions.flatMap((extension) => (extension ? [extension] : []))
  if (new Set(values.map((extension) => `${extension.kind}\u0000${extension.id}`)).size !== values.length) return null
  return Object.freeze(values)
}

function parseRecentSessions(input: unknown) {
  if (!Array.isArray(input) || input.length > maximumRecentSessions) return null
  const sessions = input.map((entry, index) => {
    const record = exact(entry, ["sessionID", "workspaceRoot", "updatedAt"])
    const sessionID = record ? parseBoundedString(record.sessionID, `$.recentSessions[${index}].sessionID`, 256) : undefined
    const workspaceRoot = record
      ? parseBoundedString(record.workspaceRoot, `$.recentSessions[${index}].workspaceRoot`, 4_096)
      : undefined
    const updatedAt = record ? parseCanonicalTimestamp(record.updatedAt, `$.recentSessions[${index}].updatedAt`) : undefined
    if (!record || !sessionID?.ok || !workspaceRoot?.ok || !workspaceRoot.value.startsWith("/") || !updatedAt?.ok) {
      return null
    }
    return Object.freeze({ sessionID: sessionID.value, workspaceRoot: workspaceRoot.value, updatedAt: updatedAt.value })
  })
  if (sessions.some((session) => session === null)) return null
  const values = sessions.flatMap((session) => (session ? [session] : []))
  if (new Set(values.map((session) => session.sessionID)).size !== values.length) return null
  return Object.freeze(values)
}

function parseRecentReceipts(input: unknown) {
  if (!Array.isArray(input) || input.length > maximumRecentReceipts) return null
  const receipts = input.map((entry, index) => {
    const record = exact(entry, ["operationID", "state", "observedAt"])
    const state = record ? parseBoundedString(record.state, `$.recentReceipts[${index}].state`, 128) : undefined
    const observedAt = record ? parseCanonicalTimestamp(record.observedAt, `$.recentReceipts[${index}].observedAt`) : undefined
    if (!record || typeof record.operationID !== "string" || !uuidPattern.test(record.operationID) || !state?.ok || !observedAt?.ok) {
      return null
    }
    return Object.freeze({ operationID: record.operationID, state: state.value, observedAt: observedAt.value })
  })
  if (receipts.some((receipt) => receipt === null)) return null
  const values = receipts.flatMap((receipt) => (receipt ? [receipt] : []))
  if (new Set(values.map((receipt) => receipt.operationID)).size !== values.length) return null
  return Object.freeze(values)
}

function exact(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  if (!parsed.ok || fields.some((field) => !Object.hasOwn(parsed.value, field))) return null
  return parsed.value
}

function invalidSnapshot(): AstraSystemControlParseResult<never> {
  return { ok: false, reason: "invalid_system_snapshot" }
}

function invalidDecision(): AstraSystemControlParseResult<never> {
  return { ok: false, reason: "invalid_system_decision" }
}
