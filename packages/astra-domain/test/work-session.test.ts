import { describe, expect, test } from "bun:test"
import {
  createAstraWorkSessionEvent,
  makeAstraWorkSessionEvent,
  parseAstraWorkSessionEvent,
  parseAstraWorkSessionProjection,
  projectAstraWorkSessionEvent,
  workSessionPhases,
  type AstraWorkSessionActor,
  type AstraWorkSessionEventDraft,
  type AstraWorkSessionProjection,
} from "../src/work-session"

const sessionID = "session-019f6c64"
const workspaceRoot = "/private/tmp/astra-work-session"
const workspaceIdentity = { device: "16777234", inode: "445566" } as const
const actor = { kind: "system", actorID: "astra-parent" } as const satisfies AstraWorkSessionActor
const startedAt = "2026-07-20T10:00:00.000Z"

describe("Astra work-session domain", () => {
  test("publishes the exact phase vocabulary", () => {
    expect(workSessionPhases).toEqual([
      "idle",
      "analyzing",
      "plan-review",
      "working",
      "review-ready",
      "applying",
      "checking",
      "commit-ready",
      "completed",
      "blocked",
      "uncertain",
      "reconciliation-required",
    ])
  })

  test("creates a deterministic, deeply frozen initial projection", () => {
    const event = initialEvent()
    const first = projectAstraWorkSessionEvent(null, event)
    const second = projectAstraWorkSessionEvent(null, event)

    expect(first).toEqual(second)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("fixture session must be accepted")
    expect(first.value).toMatchObject({
      schemaVersion: 1,
      sessionID,
      workspaceRoot,
      workspaceIdentity,
      sequence: 1,
      phase: "idle",
      objective: "Ship a controlled patch",
      intent: { summary: "Understand the task", next: "Inspect the workspace" },
      agents: [],
      decisions: [],
      evidence: [],
      candidatePatchID: null,
      updatedAt: startedAt,
    })
    expect(first.value.projectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(first.value)).toBe(true)
    expect(Object.isFrozen(first.value.intent)).toBe(true)
    expect(Object.isFrozen(first.value.agents)).toBe(true)
  })

  test("allowlists ordinary phase transitions and rejects every illegal pair", () => {
    const allowed = new Set([
      "idle>analyzing",
      "idle>blocked",
      "idle>uncertain",
      "idle>reconciliation-required",
      "analyzing>plan-review",
      "analyzing>working",
      "analyzing>blocked",
      "analyzing>uncertain",
      "analyzing>reconciliation-required",
      "plan-review>analyzing",
      "plan-review>working",
      "plan-review>blocked",
      "plan-review>uncertain",
      "plan-review>reconciliation-required",
      "working>applying",
      "working>checking",
      "working>blocked",
      "working>uncertain",
      "working>reconciliation-required",
      "review-ready>working",
      "review-ready>applying",
      "review-ready>checking",
      "review-ready>blocked",
      "review-ready>uncertain",
      "review-ready>reconciliation-required",
      "applying>working",
      "applying>checking",
      "applying>blocked",
      "applying>uncertain",
      "applying>reconciliation-required",
      "checking>working",
      "checking>blocked",
      "checking>uncertain",
      "checking>reconciliation-required",
      "commit-ready>working",
      "commit-ready>blocked",
      "commit-ready>uncertain",
      "commit-ready>reconciliation-required",
      "blocked>idle",
      "blocked>analyzing",
      "blocked>plan-review",
      "blocked>working",
      "blocked>uncertain",
      "blocked>reconciliation-required",
      "uncertain>blocked",
      "uncertain>reconciliation-required",
      "reconciliation-required>blocked",
      "reconciliation-required>uncertain",
    ])

    for (const from of workSessionPhases) {
      for (const to of workSessionPhases) {
        const projection = projectionAt(from)
        const event = makeAstraWorkSessionEvent(projection, {
          observedAt: later(projection.sequence),
          actor,
          draft: { type: "phase.changed", payload: { phase: to } },
        })
        expect(event.ok, `${from}>${to}`).toBe(allowed.has(`${from}>${to}`))
      }
    }
  })

  test("rejects direct success shortcuts and requires typed evidence events", () => {
    const analyzing = advance(initialProjection(), { type: "phase.changed", payload: { phase: "analyzing" } })
    expect(makeEvent(analyzing, { type: "phase.changed", payload: { phase: "review-ready" } }).ok).toBe(false)
    expect(makeEvent(analyzing, { type: "phase.changed", payload: { phase: "commit-ready" } }).ok).toBe(false)
    expect(makeEvent(analyzing, { type: "phase.changed", payload: { phase: "completed" } }).ok).toBe(false)

    const working = advance(analyzing, { type: "phase.changed", payload: { phase: "working" } })
    const reviewReady = advance(working, {
      type: "candidate-patch.recorded",
      payload: {
        candidatePatchID: "patch-01",
        evidence: evidence("evidence-patch", "receipt"),
      },
    })
    const checking = advance(reviewReady, { type: "phase.changed", payload: { phase: "checking" } })
    const commitReady = advance(checking, {
      type: "commit-ready.recorded",
      payload: { evidence: evidence("evidence-git", "git") },
    })
    const completed = advance(commitReady, {
      type: "session.completed",
      payload: { evidence: evidence("evidence-complete", "test") },
    })

    expect(reviewReady.phase).toBe("review-ready")
    expect(commitReady.phase).toBe("commit-ready")
    expect(completed.phase).toBe("completed")
    expect(completed.evidence.map((item) => item.evidenceID)).toEqual([
      "evidence-patch",
      "evidence-git",
      "evidence-complete",
    ])
  })

  test("requires typed reconciliation evidence before leaving uncertainty for work", () => {
    const uncertain = advance(initialProjection(), { type: "phase.changed", payload: { phase: "uncertain" } })
    expect(makeEvent(uncertain, { type: "phase.changed", payload: { phase: "working" } }).ok).toBe(false)

    const blocked = advance(uncertain, { type: "phase.changed", payload: { phase: "blocked" } })
    expect(makeEvent(blocked, { type: "phase.changed", payload: { phase: "working" } }).ok).toBe(false)

    const idle = advance(blocked, { type: "phase.changed", payload: { phase: "idle" } })
    const analyzing = advance(idle, { type: "phase.changed", payload: { phase: "analyzing" } })
    expect(makeEvent(analyzing, { type: "phase.changed", payload: { phase: "working" } }).ok).toBe(false)

    const reconciled = advance(uncertain, {
      type: "reconciliation.recorded",
      payload: { nextPhase: "working", evidence: evidence("reconciliation-proof", "receipt") },
    })
    expect(reconciled.phase).toBe("working")
    expect(reconciled.evidence.at(-1)?.evidenceID).toBe("reconciliation-proof")

    const ambiguous = advance(initialProjection(), {
      type: "effect.ambiguous",
      payload: {
        operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670431",
        summary: "The host effect is ambiguous",
      },
    })
    const ambiguousBlocked = advance(ambiguous, { type: "phase.changed", payload: { phase: "blocked" } })
    expect(makeEvent(ambiguousBlocked, { type: "phase.changed", payload: { phase: "working" } }).ok).toBe(false)
  })

  test("forces subagents to no authority and validates parent/terminal state rules", () => {
    const projection = initialProjection()
    const unauthorized = makeEvent(projection, {
      type: "agent.added",
      payload: { agent: agent("child", null, "working", "workspace-write" as "none") },
    })
    expect(unauthorized.ok).toBe(false)

    const parent = advance(projection, { type: "agent.added", payload: { agent: agent("parent") } })
    expect(
      makeEvent(parent, { type: "agent.added", payload: { agent: agent("orphan", "missing-agent") } }).ok,
    ).toBe(false)
    expect(makeEvent(parent, { type: "agent.added", payload: { agent: agent("parent") } }).ok).toBe(false)

    const child = advance(parent, { type: "agent.added", payload: { agent: agent("child", "parent") } })
    const done = advance(child, {
      type: "agent.state-changed",
      payload: { agentID: "child", state: "completed", activity: "Review complete" },
    })
    expect(
      makeEvent(done, {
        type: "agent.state-changed",
        payload: { agentID: "child", state: "working", activity: "Working again" },
      }).ok,
    ).toBe(false)
  })

  test("keeps decisions and evidence ordered, unique, bounded, and terminally immutable", () => {
    const requested = advance(initialProjection(), {
      type: "decision.requested",
      payload: {
        decision: {
          decisionID: "decision-1",
          kind: "plan",
          summary: "Approve the exact plan",
          resources: ["workspace:/private/tmp/astra-work-session"],
          boundary: "READ-ONLY ANALYSIS",
        },
      },
    })
    expect(requested.decisions.map((item) => item.decisionID)).toEqual(["decision-1"])
    expect(
      makeEvent(requested, {
        type: "decision.requested",
        payload: {
          decision: {
            decisionID: "decision-1",
            kind: "plan",
            summary: "Duplicate",
            resources: ["workspace:/private/tmp/astra-work-session"],
            boundary: "READ-ONLY ANALYSIS",
          },
        },
      }).ok,
    ).toBe(false)
    const resolved = advance(requested, {
      type: "decision.resolved",
      payload: { decisionID: "decision-1", outcome: "approved" },
    })
    expect(resolved.decisions[0]?.state).toBe("approved")
    expect(resolved.decisions[0]).toMatchObject({
      resources: ["workspace:/private/tmp/astra-work-session"],
      boundary: "READ-ONLY ANALYSIS",
    })
    expect(
      makeEvent(resolved, {
        type: "decision.resolved",
        payload: { decisionID: "decision-1", outcome: "rejected" },
      }).ok,
    ).toBe(false)

    const withEvidence = advance(resolved, {
      type: "evidence.recorded",
      payload: { evidence: evidence("evidence-1", "test") },
    })
    expect(
      makeEvent(withEvidence, {
        type: "evidence.recorded",
        payload: { evidence: evidence("evidence-1", "test") },
      }).ok,
    ).toBe(false)
  })

  test("fails closed on controls, oversized collections, and accessor-backed data", () => {
    expect(
      makeEvent(initialProjection(), {
        type: "intent.updated",
        payload: { intent: { summary: "unsafe\u001b[2J", next: "Continue" } },
      }).ok,
    ).toBe(false)

    let getterCalls = 0
    const accessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        getterCalls += 1
        return "phase.changed"
      },
    })
    expect(
      makeAstraWorkSessionEvent(initialProjection(), {
        observedAt: later(1),
        actor,
        draft: accessor as AstraWorkSessionEventDraft,
      }).ok,
    ).toBe(false)
    expect(getterCalls).toBe(0)

    const resourceAccessor = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        getterCalls += 1
        return "workspace:/private/tmp/astra-work-session"
      },
    })
    Object.defineProperty(resourceAccessor, "length", { value: 1 })
    expect(
      makeEvent(initialProjection(), {
        type: "decision.requested",
        payload: {
          decision: {
            decisionID: "decision-accessor",
            kind: "plan",
            summary: "Reject accessor resources",
            resources: resourceAccessor,
            boundary: "READ-ONLY ANALYSIS",
          },
        },
      }).ok,
    ).toBe(false)
    expect(getterCalls).toBe(0)

    const snapshot = { ...initialProjection(), evidence: Array.from({ length: 129 }, (_, index) => evidence(`e-${index}`)) }
    expect(parseAstraWorkSessionProjection(snapshot).ok).toBe(false)

    const event = initialEvent()
    const eventAccessor = Object.defineProperty({ ...event }, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1
        return event.payload
      },
    })
    expect(parseAstraWorkSessionEvent(eventAccessor).ok).toBe(false)
    expect(getterCalls).toBe(0)
  })

  test("binds events to session, workspace, sequence, previous digest, actor, time, and payload digest", () => {
    const projection = initialProjection()
    const event = makeEvent(projection, { type: "phase.changed", payload: { phase: "analyzing" } })
    expect(event.ok).toBe(true)
    if (!event.ok) throw new Error("event must be accepted")
    expect(event.value).toMatchObject({
      sessionID,
      workspaceRoot,
      workspaceIdentity,
      sequence: 2,
      previousDigest: projection.lastEventDigest,
      observedAt: later(1),
      actor,
    })
    expect(event.value.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(event.value.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect(
      projectAstraWorkSessionEvent(projection, {
        ...event.value,
        payloadDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toEqual({ ok: false, code: "invalid_event" })
  })
})

function initialEvent() {
  const result = createAstraWorkSessionEvent({
    sessionID,
    workspaceRoot,
    workspaceIdentity,
    objective: "Ship a controlled patch",
    intent: { summary: "Understand the task", next: "Inspect the workspace" },
    observedAt: startedAt,
    actor,
  })
  if (!result.ok) throw new Error("initial event fixture is invalid")
  return result.value
}

function initialProjection() {
  const result = projectAstraWorkSessionEvent(null, initialEvent())
  if (!result.ok) throw new Error("initial projection fixture is invalid")
  return result.value
}

function projectionAt(phase: (typeof workSessionPhases)[number]) {
  if (phase === "idle") return initialProjection()
  const idle = initialProjection()
  if (phase === "blocked" || phase === "uncertain" || phase === "reconciliation-required") {
    return advance(idle, { type: "phase.changed", payload: { phase } })
  }
  const analyzing = advance(idle, { type: "phase.changed", payload: { phase: "analyzing" } })
  if (phase === "analyzing") return analyzing
  const planReview = advance(analyzing, { type: "phase.changed", payload: { phase: "plan-review" } })
  if (phase === "plan-review") return planReview
  const working = advance(planReview, { type: "phase.changed", payload: { phase: "working" } })
  if (phase === "working") return working
  const reviewReady = advance(working, {
    type: "candidate-patch.recorded",
    payload: { candidatePatchID: "patch-phase", evidence: evidence("evidence-phase-patch") },
  })
  if (phase === "review-ready") return reviewReady
  if (phase === "applying") return advance(reviewReady, { type: "phase.changed", payload: { phase: "applying" } })
  const checking = advance(reviewReady, { type: "phase.changed", payload: { phase: "checking" } })
  if (phase === "checking") return checking
  const commitReady = advance(checking, {
    type: "commit-ready.recorded",
    payload: { evidence: evidence("evidence-phase-git", "git") },
  })
  if (phase === "commit-ready") return commitReady
  if (phase === "completed") {
    return advance(commitReady, {
      type: "session.completed",
      payload: { evidence: evidence("evidence-phase-complete", "test") },
    })
  }
  throw new Error(`unsupported phase fixture: ${phase}`)
}

function makeEvent(projection: AstraWorkSessionProjection, draft: AstraWorkSessionEventDraft) {
  return makeAstraWorkSessionEvent(projection, {
    observedAt: later(projection.sequence),
    actor,
    draft,
  })
}

function advance(projection: AstraWorkSessionProjection, draft: AstraWorkSessionEventDraft) {
  const event = makeEvent(projection, draft)
  if (!event.ok) throw new Error(`fixture event ${draft.type} was rejected: ${event.code}`)
  const result = projectAstraWorkSessionEvent(projection, event.value)
  if (!result.ok) throw new Error(`fixture projection ${draft.type} was rejected: ${result.code}`)
  return result.value
}

function later(sequence: number) {
  return new Date(Date.parse(startedAt) + sequence * 1_000).toISOString()
}

function evidence(evidenceID: string, kind: "git" | "test" | "receipt" = "receipt") {
  return { evidenceID, kind, label: "Observed evidence", value: `sha256:${"a".repeat(64)}`, assurance: "observed" } as const
}

function agent(
  agentID: string,
  parentAgentID: string | null = null,
  state: "queued" | "working" | "waiting" | "completed" | "failed" | "cancelled" | "lost" = "working",
  effectAuthority: "none" = "none",
) {
  return {
    agentID,
    parentAgentID,
    label: agentID,
    task: "Inspect bounded files",
    activity: "Reading",
    state,
    effectAuthority,
  } as const
}
