import { describe, expect, test } from "bun:test"
import {
  createAstraWorkSessionEvent,
  makeAstraWorkSessionEvent,
  projectAstraWorkSessionEvent,
} from "../src/work-session"
import {
  parseAstraWorkSessionAcceptedFrame,
  parseAstraWorkSessionControlRequest,
  parseAstraWorkSessionEventFrame,
  parseAstraWorkSessionSnapshotFrame,
  parseAstraWorkSessionTerminalFrame,
} from "../src/work-session-control"

const requestId = "019f6c64-25e9-7ce2-8817-45becb7e02fe"
const authoritySessionID = "019f6c64-25e9-7ce2-8817-45becb7e02ff"
const token = "A".repeat(43)

describe("Astra work-session control protocol", () => {
  test("accepts only exact path-free authority-bound requests", () => {
    const base = { schemaVersion: 1, requestId, sessionID: authoritySessionID, token }
    const requests = [
      { ...base, method: "work-session.snapshot" },
      { ...base, method: "work-session.subscribe", cursor: cursor(initialProjection()) },
      { ...base, method: "work-session.decide", decisionID: "decision-1", outcome: "approved" },
      { ...base, method: "work-session.cancel" },
    ] as const

    for (const request of requests) expect(parseAstraWorkSessionControlRequest(request).ok).toBe(true)
    for (const key of ["workspaceRoot", "workspace", "durableSessionID", "path"]) {
      expect(parseAstraWorkSessionControlRequest({ ...requests[0], [key]: "/private/tmp/other" }).ok).toBe(false)
    }
    expect(parseAstraWorkSessionControlRequest({ ...requests[1], cursor: { ...requests[1].cursor, sequence: -1 } }).ok).toBe(false)
    expect(parseAstraWorkSessionControlRequest({ ...requests[2], outcome: "allow" }).ok).toBe(false)
  })

  test("fails closed without invoking accessors or accepting terminal controls", () => {
    let calls = 0
    const accessor = Object.defineProperty({}, "method", {
      enumerable: true,
      get() {
        calls += 1
        return "work-session.snapshot"
      },
    })
    expect(parseAstraWorkSessionControlRequest(accessor).ok).toBe(false)
    expect(calls).toBe(0)
    expect(
      parseAstraWorkSessionControlRequest({
        schemaVersion: 1,
        method: "work-session.decide",
        requestId,
        sessionID: authoritySessionID,
        token,
        decisionID: "unsafe\u001b[2J",
        outcome: "approved",
      }).ok,
    ).toBe(false)
  })

  test("binds accepted, snapshot, event, and terminal frames exactly", () => {
    const first = initialProjection()
    const nextEvent = makeAstraWorkSessionEvent(first, {
      observedAt: "2026-07-20T10:00:01.000Z",
      actor: { kind: "system", actorID: "astra-parent" },
      draft: { type: "phase.changed", payload: { phase: "analyzing" } },
    })
    if (!nextEvent.ok) throw new Error("event fixture rejected")
    const next = projectAstraWorkSessionEvent(first, nextEvent.value)
    if (!next.ok) throw new Error("projection fixture rejected")

    expect(parseAstraWorkSessionAcceptedFrame({ schemaVersion: 1, type: "accepted", requestId }).ok).toBe(true)
    expect(
      parseAstraWorkSessionSnapshotFrame({
        schemaVersion: 1,
        type: "work-session.snapshot",
        requestId,
        projection: first,
        cursor: cursor(first),
      }).ok,
    ).toBe(true)
    expect(
      parseAstraWorkSessionEventFrame({
        schemaVersion: 1,
        type: "work-session.event",
        requestId,
        event: nextEvent.value,
        projection: next.value,
        cursor: cursor(next.value),
      }).ok,
    ).toBe(true)
    expect(
      parseAstraWorkSessionTerminalFrame({
        schemaVersion: 1,
        type: "work-session.terminal",
        requestId,
        status: "request_complete",
      }).ok,
    ).toBe(true)
    expect(
      parseAstraWorkSessionTerminalFrame({
        schemaVersion: 1,
        type: "work-session.terminal",
        requestId,
        status: "blocked",
        reason: "state_unavailable",
      }).ok,
    ).toBe(true)
  })

  test("rejects mismatched cursors, sessions, digests, extra keys, and accessors", () => {
    const projection = initialProjection()
    const snapshot = {
      schemaVersion: 1,
      type: "work-session.snapshot",
      requestId,
      projection,
      cursor: cursor(projection),
    } as const
    expect(parseAstraWorkSessionSnapshotFrame({ ...snapshot, cursor: { ...snapshot.cursor, sequence: 2 } }).ok).toBe(false)
    expect(parseAstraWorkSessionSnapshotFrame({ ...snapshot, cursor: { ...snapshot.cursor, projectionDigest: digest("f") } }).ok).toBe(false)
    expect(parseAstraWorkSessionSnapshotFrame({ ...snapshot, extra: true }).ok).toBe(false)

    const event = createAstraWorkSessionEvent({
      sessionID: "different-session",
      workspaceRoot: "/private/tmp/astra-work-session",
      workspaceIdentity: { device: "1", inode: "2" },
      objective: null,
      intent: { summary: "Different", next: "Stop" },
      observedAt: "2026-07-20T10:00:00.000Z",
      actor: { kind: "system", actorID: "astra-parent" },
    })
    if (!event.ok) throw new Error("cross-session fixture rejected")
    expect(
      parseAstraWorkSessionEventFrame({
        schemaVersion: 1,
        type: "work-session.event",
        requestId,
        event: event.value,
        projection,
        cursor: cursor(projection),
      }).ok,
    ).toBe(false)

    let calls = 0
    const accessor = Object.defineProperty({ ...snapshot }, "projection", {
      enumerable: true,
      get() {
        calls += 1
        return projection
      },
    })
    expect(parseAstraWorkSessionSnapshotFrame(accessor).ok).toBe(false)
    expect(calls).toBe(0)
  })
})

function initialProjection() {
  const event = createAstraWorkSessionEvent({
    sessionID: "work-session-1",
    workspaceRoot: "/private/tmp/astra-work-session",
    workspaceIdentity: { device: "1", inode: "2" },
    objective: "Keep work observable",
    intent: { summary: "Inspect", next: "Report" },
    observedAt: "2026-07-20T10:00:00.000Z",
    actor: { kind: "system", actorID: "astra-parent" },
  })
  if (!event.ok) throw new Error("event fixture rejected")
  const projection = projectAstraWorkSessionEvent(null, event.value)
  if (!projection.ok) throw new Error("projection fixture rejected")
  return projection.value
}

function cursor(projection: ReturnType<typeof initialProjection>) {
  return {
    sequence: projection.sequence,
    lastEventDigest: projection.lastEventDigest,
    projectionDigest: projection.projectionDigest,
  }
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
}
