import { parseBoundedString, parseCanonicalTimestamp, parseExactRecord } from "./operation-contract-validation"

const maximumRecentSessions = 20

export type AstraLaunchpadDecision =
  | Readonly<{ kind: "create-project" }>
  | Readonly<{ kind: "open-workspace"; path: string }>
  | Readonly<{ kind: "continue-session"; sessionID: string }>
  | Readonly<{ kind: "open-system" }>
  | Readonly<{ kind: "exit" }>

export type AstraLaunchpadSnapshot = Readonly<{
  recentSessions: ReadonlyArray<Readonly<{ sessionID: string; workspaceRoot: string; updatedAt: string }>>
}>

export type AstraLaunchpadParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_launchpad_decision" | "invalid_launchpad_snapshot" }>

export function parseAstraLaunchpadDecision(input: unknown): AstraLaunchpadParseResult<AstraLaunchpadDecision> {
  const broad = parseExactRecord(input, ["kind", "path", "sessionID"])
  if (!broad.ok) return invalidDecision()

  if (broad.value.kind === "create-project" || broad.value.kind === "open-system" || broad.value.kind === "exit") {
    if (!exact(input, ["kind"])) return invalidDecision()
    return { ok: true, value: { kind: broad.value.kind } }
  }
  if (broad.value.kind === "open-workspace") {
    if (!exact(input, ["kind", "path"])) return invalidDecision()
    const path = absolutePath(broad.value.path)
    if (!path) return invalidDecision()
    return { ok: true, value: { kind: "open-workspace", path } }
  }
  if (broad.value.kind === "continue-session") {
    if (!exact(input, ["kind", "sessionID"])) return invalidDecision()
    const sessionID = parseBoundedString(broad.value.sessionID, "$.sessionID")
    if (!sessionID.ok) return invalidDecision()
    return { ok: true, value: { kind: "continue-session", sessionID: sessionID.value } }
  }
  return invalidDecision()
}

export function parseAstraLaunchpadSnapshot(input: unknown): AstraLaunchpadParseResult<AstraLaunchpadSnapshot> {
  const record = exact(input, ["recentSessions"])
  if (!record || !Array.isArray(record.recentSessions) || record.recentSessions.length > maximumRecentSessions) {
    return invalidSnapshot()
  }

  const recentSessions = record.recentSessions.map((entry, index) => parseRecentSession(entry, index))
  if (recentSessions.some((entry) => !entry.ok)) return invalidSnapshot()
  const values = recentSessions.flatMap((entry) => (entry.ok ? [entry.value] : []))
  if (new Set(values.map((entry) => entry.sessionID)).size !== values.length) return invalidSnapshot()
  return { ok: true, value: { recentSessions: values } }
}

function parseRecentSession(input: unknown, index: number) {
  const record = exact(input, ["sessionID", "workspaceRoot", "updatedAt"])
  if (!record) return invalidSnapshot()
  const sessionID = parseBoundedString(record.sessionID, `$.recentSessions[${index}].sessionID`)
  const workspaceRoot = absolutePath(record.workspaceRoot)
  const updatedAt = parseCanonicalTimestamp(record.updatedAt, `$.recentSessions[${index}].updatedAt`)
  if (!sessionID.ok || !workspaceRoot || !updatedAt.ok) return invalidSnapshot()
  return { ok: true as const, value: { sessionID: sessionID.value, workspaceRoot, updatedAt: updatedAt.value } }
}

function absolutePath(input: unknown) {
  const path = parseBoundedString(input, "$.path", 4_096)
  if (!path.ok || !path.value.startsWith("/")) return null
  return path.value
}

function exact(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  if (!parsed.ok || fields.some((field) => !Object.hasOwn(parsed.value, field))) return null
  return parsed.value
}

function invalidDecision(): AstraLaunchpadParseResult<never> {
  return { ok: false, reason: "invalid_launchpad_decision" }
}

function invalidSnapshot(): AstraLaunchpadParseResult<never> {
  return { ok: false, reason: "invalid_launchpad_snapshot" }
}
