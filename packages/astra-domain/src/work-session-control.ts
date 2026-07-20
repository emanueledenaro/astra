import { parseAstraWorkSessionEvent, parseAstraWorkSessionProjection } from "./work-session"
import type { AstraWorkSessionEvent, AstraWorkSessionProjection } from "./work-session"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u
const digestPattern = /^sha256:[0-9a-f]{64}$/u
const identifierPattern = /^[\p{L}\p{N}][\p{L}\p{N}._:@/-]{0,255}$/u
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/u

export const workSessionControlRequestLimitBytes = 32 * 1_024
export const workSessionControlFrameLimitBytes = 512 * 1_024

export type AstraWorkSessionCursor = Readonly<{
  sequence: number
  lastEventDigest: `sha256:${string}`
  projectionDigest: `sha256:${string}`
}>

type Authority = Readonly<{
  schemaVersion: 1
  requestId: string
  sessionID: string
  token: string
}>

export type AstraWorkSessionControlRequest =
  | (Authority & Readonly<{ method: "work-session.snapshot" }>)
  | (Authority & Readonly<{ method: "work-session.subscribe"; cursor: AstraWorkSessionCursor }>)
  | (Authority &
      Readonly<{
        method: "work-session.decide"
        decisionID: string
        outcome: "approved" | "rejected"
      }>)
  | (Authority & Readonly<{ method: "work-session.cancel" }>)

export type AstraWorkSessionAcceptedFrame = Readonly<{
  schemaVersion: 1
  type: "accepted"
  requestId: string
}>

export type AstraWorkSessionSnapshotFrame = Readonly<{
  schemaVersion: 1
  type: "work-session.snapshot"
  requestId: string
  projection: AstraWorkSessionProjection
  cursor: AstraWorkSessionCursor
}>

export type AstraWorkSessionEventFrame = Readonly<{
  schemaVersion: 1
  type: "work-session.event"
  requestId: string
  event: AstraWorkSessionEvent
  projection: AstraWorkSessionProjection
  cursor: AstraWorkSessionCursor
}>

export type AstraWorkSessionTerminalFrame =
  | Readonly<{
      schemaVersion: 1
      type: "work-session.terminal"
      requestId: string
      status: "request_complete"
    }>
  | Readonly<{
      schemaVersion: 1
      type: "work-session.terminal"
      requestId: string
      status: "blocked"
      reason: string
    }>

export type AstraWorkSessionControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: "invalid_work_session_control" }>

/** Parses path-free control intents. The durable session is deliberately absent. */
export function parseAstraWorkSessionControlRequest(
  input: unknown,
): AstraWorkSessionControlParseResult<AstraWorkSessionControlRequest> {
  const broad = dataRecord(input)
  if (!broad) return invalid()
  const common = parseAuthority(broad)
  if (!common) return invalid()

  if (broad.method === "work-session.subscribe") {
    const value = exact(broad, ["schemaVersion", "method", "requestId", "sessionID", "token", "cursor"])
    const cursor = value ? parseAstraWorkSessionCursor(value.cursor) : invalid<AstraWorkSessionCursor>()
    if (!value || !cursor.ok) return invalid()
    return valid({ ...common, method: "work-session.subscribe", cursor: cursor.value })
  }
  if (broad.method === "work-session.decide") {
    const value = exact(broad, [
      "schemaVersion",
      "method",
      "requestId",
      "sessionID",
      "token",
      "decisionID",
      "outcome",
    ])
    if (
      !value ||
      !identifier(value.decisionID) ||
      (value.outcome !== "approved" && value.outcome !== "rejected")
    ) {
      return invalid()
    }
    return valid({ ...common, method: "work-session.decide", decisionID: value.decisionID, outcome: value.outcome })
  }
  if (broad.method !== "work-session.snapshot" && broad.method !== "work-session.cancel") return invalid()
  const value = exact(broad, ["schemaVersion", "method", "requestId", "sessionID", "token"])
  if (!value) return invalid()
  return valid({ ...common, method: broad.method })
}

export function parseAstraWorkSessionCursor(
  input: unknown,
): AstraWorkSessionControlParseResult<AstraWorkSessionCursor> {
  const value = exact(input, ["sequence", "lastEventDigest", "projectionDigest"])
  if (
    !value ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !digest(value.lastEventDigest) ||
    !digest(value.projectionDigest)
  ) {
    return invalid()
  }
  return valid({
    sequence: value.sequence as number,
    lastEventDigest: value.lastEventDigest,
    projectionDigest: value.projectionDigest,
  })
}

export function parseAstraWorkSessionAcceptedFrame(
  input: unknown,
): AstraWorkSessionControlParseResult<AstraWorkSessionAcceptedFrame> {
  const value = exact(input, ["schemaVersion", "type", "requestId"])
  if (!value || value.schemaVersion !== 1 || value.type !== "accepted" || !uuid(value.requestId)) return invalid()
  return valid({ schemaVersion: 1, type: "accepted", requestId: value.requestId })
}

export function parseAstraWorkSessionSnapshotFrame(
  input: unknown,
): AstraWorkSessionControlParseResult<AstraWorkSessionSnapshotFrame> {
  const value = exact(input, ["schemaVersion", "type", "requestId", "projection", "cursor"])
  const projection = value ? parseAstraWorkSessionProjection(value.projection) : { ok: false as const }
  const cursor = value ? parseAstraWorkSessionCursor(value.cursor) : invalid<AstraWorkSessionCursor>()
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.type !== "work-session.snapshot" ||
    !uuid(value.requestId) ||
    !projection.ok ||
    !cursor.ok ||
    !cursorMatches(cursor.value, projection.value)
  ) {
    return invalid()
  }
  return valid({
    schemaVersion: 1,
    type: "work-session.snapshot",
    requestId: value.requestId,
    projection: projection.value,
    cursor: cursor.value,
  })
}

export function parseAstraWorkSessionEventFrame(
  input: unknown,
): AstraWorkSessionControlParseResult<AstraWorkSessionEventFrame> {
  const value = exact(input, ["schemaVersion", "type", "requestId", "event", "projection", "cursor"])
  const event = value ? parseAstraWorkSessionEvent(value.event) : { ok: false as const }
  const projection = value ? parseAstraWorkSessionProjection(value.projection) : { ok: false as const }
  const cursor = value ? parseAstraWorkSessionCursor(value.cursor) : invalid<AstraWorkSessionCursor>()
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.type !== "work-session.event" ||
    !uuid(value.requestId) ||
    !event.ok ||
    !projection.ok ||
    !cursor.ok ||
    event.value.sessionID !== projection.value.sessionID ||
    event.value.workspaceRoot !== projection.value.workspaceRoot ||
    event.value.workspaceIdentity.device !== projection.value.workspaceIdentity.device ||
    event.value.workspaceIdentity.inode !== projection.value.workspaceIdentity.inode ||
    event.value.sequence !== projection.value.sequence ||
    event.value.eventDigest !== projection.value.lastEventDigest ||
    !cursorMatches(cursor.value, projection.value)
  ) {
    return invalid()
  }
  return valid({
    schemaVersion: 1,
    type: "work-session.event",
    requestId: value.requestId,
    event: event.value,
    projection: projection.value,
    cursor: cursor.value,
  })
}

export function parseAstraWorkSessionTerminalFrame(
  input: unknown,
): AstraWorkSessionControlParseResult<AstraWorkSessionTerminalFrame> {
  const broad = dataRecord(input)
  if (broad?.status === "request_complete") {
    const value = exact(broad, ["schemaVersion", "type", "requestId", "status"])
    if (!value || value.schemaVersion !== 1 || value.type !== "work-session.terminal" || !uuid(value.requestId)) {
      return invalid()
    }
    return valid({ schemaVersion: 1, type: "work-session.terminal", requestId: value.requestId, status: "request_complete" })
  }
  const value = exact(broad, ["schemaVersion", "type", "requestId", "status", "reason"])
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.type !== "work-session.terminal" ||
    !uuid(value.requestId) ||
    value.status !== "blocked" ||
    !reason(value.reason)
  ) {
    return invalid()
  }
  return valid({
    schemaVersion: 1,
    type: "work-session.terminal",
    requestId: value.requestId,
    status: "blocked",
    reason: value.reason,
  })
}

export function cursorForAstraWorkSessionProjection(projection: AstraWorkSessionProjection): AstraWorkSessionCursor {
  return Object.freeze({
    sequence: projection.sequence,
    lastEventDigest: projection.lastEventDigest,
    projectionDigest: projection.projectionDigest,
  })
}

function parseAuthority(input: Readonly<Record<string, unknown>>): Authority | null {
  if (
    input.schemaVersion !== 1 ||
    !uuid(input.requestId) ||
    !uuid(input.sessionID) ||
    !token(input.token)
  ) {
    return null
  }
  return { schemaVersion: 1, requestId: input.requestId, sessionID: input.sessionID, token: input.token }
}

function cursorMatches(cursor: AstraWorkSessionCursor, projection: AstraWorkSessionProjection) {
  return (
    cursor.sequence === projection.sequence &&
    cursor.lastEventDigest === projection.lastEventDigest &&
    cursor.projectionDigest === projection.projectionDigest
  )
}

function dataRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const value: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    value[key] = descriptor.value
  }
  return value
}

function exact(input: unknown, fields: ReadonlyArray<string>) {
  const value = dataRecord(input)
  if (!value || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    return null
  }
  return Object.keys(value).some((field) => !fields.includes(field)) ? null : value
}

function uuid(input: unknown): input is string {
  return typeof input === "string" && uuidPattern.test(input)
}

function token(input: unknown): input is string {
  return typeof input === "string" && tokenPattern.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}

function identifier(input: unknown): input is string {
  return typeof input === "string" && identifierPattern.test(input) && !/\p{C}/u.test(input)
}

function reason(input: unknown): input is string {
  return typeof input === "string" && reasonPattern.test(input)
}

function valid<Value>(value: Value): AstraWorkSessionControlParseResult<Value> {
  return { ok: true, value: deepFreeze(value) }
}

function invalid<Value = never>(): AstraWorkSessionControlParseResult<Value> {
  return { ok: false, reason: "invalid_work_session_control" }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
