import { createHash } from "node:crypto"
import { isAbsolute, normalize } from "node:path"
import {
  parseBoundedString,
  parseCanonicalTimestamp,
  parseExactRecord,
  parseNonNegativeInteger,
  parseNormalizedJsonArray,
} from "./operation-contract-validation"
import type { WorkspaceIdentity } from "./workspace-trust"

export const workSessionPhases = [
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
] as const

export type AstraWorkPhase = (typeof workSessionPhases)[number]

export const workSessionGenesisDigest = `sha256:${"0".repeat(64)}` as const

export type AstraWorkSessionActor = Readonly<{
  kind: "user" | "system" | "agent"
  actorID: string
}>

export type AstraAgentProjection = Readonly<{
  agentID: string
  parentAgentID: string | null
  label: string
  task: string
  activity: string
  state: "queued" | "working" | "waiting" | "completed" | "failed" | "cancelled" | "lost"
  effectAuthority: "none"
}>

export type AstraWorkSessionDecision = Readonly<{
  decisionID: string
  kind: string
  summary: string
  resources: ReadonlyArray<string>
  boundary: string
  state: "pending" | "approved" | "rejected" | "cancelled"
}>

export type AstraWorkSessionEvidence = Readonly<{
  evidenceID: string
  kind: "git" | "test" | "receipt"
  label: string
  value: string
  assurance: string
}>

export type AstraWorkSessionProjection = Readonly<{
  schemaVersion: 1
  sessionID: string
  workspaceRoot: string
  workspaceIdentity: WorkspaceIdentity
  sequence: number
  lastEventDigest: `sha256:${string}`
  projectionDigest: `sha256:${string}`
  objective: string | null
  phase: AstraWorkPhase
  intent: Readonly<{ summary: string; next: string }>
  agents: ReadonlyArray<AstraAgentProjection>
  decisions: ReadonlyArray<AstraWorkSessionDecision>
  evidence: ReadonlyArray<AstraWorkSessionEvidence>
  candidatePatchID: string | null
  reconciliationPending: boolean
  updatedAt: string
}>

export type AstraWorkSessionEventDraft =
  | Readonly<{
      type: "session.created"
      payload: Readonly<{
        objective: string | null
        intent: Readonly<{ summary: string; next: string }>
      }>
    }>
  | Readonly<{ type: "objective.updated"; payload: Readonly<{ objective: string | null }> }>
  | Readonly<{
      type: "intent.updated"
      payload: Readonly<{ intent: Readonly<{ summary: string; next: string }> }>
    }>
  | Readonly<{ type: "phase.changed"; payload: Readonly<{ phase: AstraWorkPhase }> }>
  | Readonly<{ type: "agent.added"; payload: Readonly<{ agent: AstraAgentProjection }> }>
  | Readonly<{
      type: "agent.state-changed"
      payload: Readonly<{ agentID: string; state: AstraAgentProjection["state"]; activity: string }>
    }>
  | Readonly<{
      type: "decision.requested"
      payload: Readonly<{
        decision: Readonly<{
          decisionID: string
          kind: string
          summary: string
          resources: ReadonlyArray<string>
          boundary: string
        }>
      }>
    }>
  | Readonly<{
      type: "decision.resolved"
      payload: Readonly<{ decisionID: string; outcome: "approved" | "rejected" | "cancelled" }>
    }>
  | Readonly<{ type: "evidence.recorded"; payload: Readonly<{ evidence: AstraWorkSessionEvidence }> }>
  | Readonly<{
      type: "candidate-patch.recorded"
      payload: Readonly<{ candidatePatchID: string; evidence: AstraWorkSessionEvidence }>
    }>
  | Readonly<{ type: "commit-ready.recorded"; payload: Readonly<{ evidence: AstraWorkSessionEvidence }> }>
  | Readonly<{ type: "session.completed"; payload: Readonly<{ evidence: AstraWorkSessionEvidence }> }>
  | Readonly<{
      type: "effect.ambiguous"
      payload: Readonly<{ operationID: string; summary: string }>
    }>
  | Readonly<{
      type: "reconciliation.recorded"
      payload: Readonly<{ nextPhase: AstraWorkPhase; evidence: AstraWorkSessionEvidence }>
    }>

type AstraWorkSessionEventBinding = Readonly<{
  schemaVersion: 1
  sessionID: string
  workspaceRoot: string
  workspaceIdentity: WorkspaceIdentity
  sequence: number
  previousDigest: `sha256:${string}`
  observedAt: string
  actor: AstraWorkSessionActor
  payloadDigest: `sha256:${string}`
  eventDigest: `sha256:${string}`
}>

export type AstraWorkSessionEvent = AstraWorkSessionEventBinding & AstraWorkSessionEventDraft

export type AstraWorkSessionParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{
      ok: false
      code: "invalid_input" | "invalid_event" | "invalid_projection" | "illegal_transition" | "stale_event"
    }>

const ordinaryPhaseTransitions = new Set([
  "idle\0analyzing",
  "idle\0blocked",
  "idle\0uncertain",
  "idle\0reconciliation-required",
  "analyzing\0plan-review",
  "analyzing\0working",
  "analyzing\0blocked",
  "analyzing\0uncertain",
  "analyzing\0reconciliation-required",
  "plan-review\0analyzing",
  "plan-review\0working",
  "plan-review\0blocked",
  "plan-review\0uncertain",
  "plan-review\0reconciliation-required",
  "working\0applying",
  "working\0checking",
  "working\0blocked",
  "working\0uncertain",
  "working\0reconciliation-required",
  "review-ready\0working",
  "review-ready\0applying",
  "review-ready\0checking",
  "review-ready\0blocked",
  "review-ready\0uncertain",
  "review-ready\0reconciliation-required",
  "applying\0working",
  "applying\0checking",
  "applying\0blocked",
  "applying\0uncertain",
  "applying\0reconciliation-required",
  "checking\0working",
  "checking\0blocked",
  "checking\0uncertain",
  "checking\0reconciliation-required",
  "commit-ready\0working",
  "commit-ready\0blocked",
  "commit-ready\0uncertain",
  "commit-ready\0reconciliation-required",
  "blocked\0idle",
  "blocked\0analyzing",
  "blocked\0plan-review",
  "blocked\0working",
  "blocked\0uncertain",
  "blocked\0reconciliation-required",
  "uncertain\0blocked",
  "uncertain\0reconciliation-required",
  "reconciliation-required\0blocked",
  "reconciliation-required\0uncertain",
])

const reconciliationTargets = new Set<AstraWorkPhase>([
  "idle",
  "analyzing",
  "plan-review",
  "working",
  "applying",
  "checking",
  "blocked",
])
const reconciliationProtectedPhases = new Set<AstraWorkPhase>([
  "working",
  "review-ready",
  "applying",
  "checking",
  "commit-ready",
  "completed",
])
const agentStates = new Set<AstraAgentProjection["state"]>([
  "queued",
  "working",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "lost",
])
const terminalAgentStates = new Set<AstraAgentProjection["state"]>(["completed", "failed", "cancelled", "lost"])
const agentTransitions = new Set([
  "queued\0working",
  "queued\0waiting",
  "queued\0cancelled",
  "working\0waiting",
  "working\0completed",
  "working\0failed",
  "working\0cancelled",
  "working\0lost",
  "waiting\0working",
  "waiting\0completed",
  "waiting\0failed",
  "waiting\0cancelled",
  "waiting\0lost",
])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const digestPattern = /^sha256:[0-9a-f]{64}$/u
const maximumAgents = 64
const maximumDecisions = 64
const maximumEvidence = 128

export function createAstraWorkSessionEvent(input: Readonly<{
  sessionID: string
  workspaceRoot: string
  workspaceIdentity: WorkspaceIdentity
  objective: string | null
  intent: Readonly<{ summary: string; next: string }>
  observedAt: string
  actor: AstraWorkSessionActor
}>): AstraWorkSessionParseResult<AstraWorkSessionEvent> {
  const record = exact(input, [
    "sessionID",
    "workspaceRoot",
    "workspaceIdentity",
    "objective",
    "intent",
    "observedAt",
    "actor",
  ])
  if (!record) return rejected("invalid_input")
  const sessionID = safeID(record.sessionID, 256)
  const workspaceRoot = absolutePath(record.workspaceRoot)
  const workspaceIdentity = parseIdentity(record.workspaceIdentity)
  const objective = nullableText(record.objective, 4_096)
  const intent = parseIntent(record.intent)
  const observedAt = canonicalTimestamp(record.observedAt)
  const actor = parseActor(record.actor)
  if (!sessionID || !workspaceRoot || !workspaceIdentity || objective === undefined || !intent || !observedAt || !actor) {
    return rejected("invalid_input")
  }
  return makeBoundEvent({
    schemaVersion: 1,
    sessionID,
    workspaceRoot,
    workspaceIdentity,
    sequence: 1,
    previousDigest: workSessionGenesisDigest,
    observedAt,
    actor,
    type: "session.created",
    payload: { objective, intent },
  })
}

export function makeAstraWorkSessionEvent(
  projectionInput: unknown,
  input: Readonly<{ observedAt: string; actor: AstraWorkSessionActor; draft: AstraWorkSessionEventDraft }>,
): AstraWorkSessionParseResult<AstraWorkSessionEvent> {
  const projection = parseAstraWorkSessionProjection(projectionInput)
  if (!projection.ok) return projection
  const record = exact(input, ["observedAt", "actor", "draft"])
  if (!record) return rejected("invalid_input")
  const observedAt = canonicalTimestamp(record.observedAt)
  const actor = parseActor(record.actor)
  const draft = parseDraft(record.draft)
  if (!observedAt || !actor || !draft || Date.parse(observedAt) < Date.parse(projection.value.updatedAt)) {
    return rejected("invalid_input")
  }
  const event = makeBoundEvent({
    schemaVersion: 1,
    sessionID: projection.value.sessionID,
    workspaceRoot: projection.value.workspaceRoot,
    workspaceIdentity: projection.value.workspaceIdentity,
    sequence: projection.value.sequence + 1,
    previousDigest: projection.value.lastEventDigest,
    observedAt,
    actor,
    ...draft,
  })
  if (!event.ok) return event
  const result = projectAstraWorkSessionEvent(projection.value, event.value)
  if (!result.ok) return result
  return event
}

export function parseAstraWorkSessionEvent(input: unknown): AstraWorkSessionParseResult<AstraWorkSessionEvent> {
  const record = exact(input, [
    "schemaVersion",
    "sessionID",
    "workspaceRoot",
    "workspaceIdentity",
    "sequence",
    "previousDigest",
    "observedAt",
    "actor",
    "type",
    "payload",
    "payloadDigest",
    "eventDigest",
  ])
  if (!record || record.schemaVersion !== 1) return rejected("invalid_event")
  const sessionID = safeID(record.sessionID, 256)
  const workspaceRoot = absolutePath(record.workspaceRoot)
  const workspaceIdentity = parseIdentity(record.workspaceIdentity)
  const sequence = nonNegativeInteger(record.sequence)
  const previousDigest = digestValue(record.previousDigest)
  const observedAt = canonicalTimestamp(record.observedAt)
  const actor = parseActor(record.actor)
  const draft = parseDraft({ type: record.type, payload: record.payload })
  const payloadDigest = digestValue(record.payloadDigest)
  const eventDigest = digestValue(record.eventDigest)
  if (
    !sessionID ||
    !workspaceRoot ||
    !workspaceIdentity ||
    sequence === null ||
    sequence < 1 ||
    !previousDigest ||
    !observedAt ||
    !actor ||
    !draft ||
    !payloadDigest ||
    !eventDigest
  ) {
    return rejected("invalid_event")
  }
  if (payloadDigest !== digest(`astra.work-session.payload.v1\0${canonicalJson(draft.payload)}`)) {
    return rejected("invalid_event")
  }
  const authority = {
    schemaVersion: 1,
    sessionID,
    workspaceRoot,
    workspaceIdentity,
    sequence,
    previousDigest,
    observedAt,
    actor,
    type: draft.type,
    payload: draft.payload,
    payloadDigest,
  } as const
  if (eventDigest !== digest(`astra.work-session.event.v1\0${canonicalJson(authority)}`)) {
    return rejected("invalid_event")
  }
  return accepted({ ...authority, eventDigest } as AstraWorkSessionEvent)
}

export function parseAstraWorkSessionProjection(
  input: unknown,
): AstraWorkSessionParseResult<AstraWorkSessionProjection> {
  const record = exact(input, [
    "schemaVersion",
    "sessionID",
    "workspaceRoot",
    "workspaceIdentity",
    "sequence",
    "lastEventDigest",
    "projectionDigest",
    "objective",
    "phase",
    "intent",
    "agents",
    "decisions",
    "evidence",
    "candidatePatchID",
    "reconciliationPending",
    "updatedAt",
  ])
  if (!record || record.schemaVersion !== 1) return rejected("invalid_projection")
  const sessionID = safeID(record.sessionID, 256)
  const workspaceRoot = absolutePath(record.workspaceRoot)
  const workspaceIdentity = parseIdentity(record.workspaceIdentity)
  const sequence = nonNegativeInteger(record.sequence)
  const lastEventDigest = digestValue(record.lastEventDigest)
  const projectionDigest = digestValue(record.projectionDigest)
  const objective = nullableText(record.objective, 4_096)
  const phase = parsePhase(record.phase)
  const intent = parseIntent(record.intent)
  const agents = parseAgents(record.agents)
  const decisions = parseDecisions(record.decisions)
  const evidence = parseEvidenceArray(record.evidence)
  const candidatePatchID = nullableID(record.candidatePatchID, 256)
  const reconciliationPending = typeof record.reconciliationPending === "boolean" ? record.reconciliationPending : null
  const updatedAt = canonicalTimestamp(record.updatedAt)
  if (
    !sessionID ||
    !workspaceRoot ||
    !workspaceIdentity ||
    sequence === null ||
    sequence < 1 ||
    !lastEventDigest ||
    !projectionDigest ||
    objective === undefined ||
    !phase ||
    !intent ||
    !agents ||
    !decisions ||
    !evidence ||
    candidatePatchID === undefined ||
    reconciliationPending === null ||
    !updatedAt
  ) {
    return rejected("invalid_projection")
  }
  const authority = {
    schemaVersion: 1,
    sessionID,
    workspaceRoot,
    workspaceIdentity,
    sequence,
    lastEventDigest,
    objective,
    phase,
    intent,
    agents,
    decisions,
    evidence,
    candidatePatchID,
    reconciliationPending,
    updatedAt,
  } as const
  if (projectionDigest !== computeAstraWorkSessionProjectionDigest(authority)) {
    return rejected("invalid_projection")
  }
  return accepted({ ...authority, projectionDigest })
}

export function projectAstraWorkSessionEvent(
  previousInput: unknown,
  eventInput: unknown,
): AstraWorkSessionParseResult<AstraWorkSessionProjection> {
  const event = parseAstraWorkSessionEvent(eventInput)
  if (!event.ok) return event
  if (previousInput === null) return projectInitialEvent(event.value)
  const previous = parseAstraWorkSessionProjection(previousInput)
  if (!previous.ok) return previous
  if (!matchingBinding(previous.value, event.value)) return rejected("stale_event")
  if (event.value.type === "session.created") return rejected("illegal_transition")
  return applyEvent(previous.value, event.value)
}

function computeAstraWorkSessionProjectionDigest(
  projection: Omit<AstraWorkSessionProjection, "projectionDigest">,
): `sha256:${string}` {
  return digest(`astra.work-session.projection.v1\0${canonicalJson(projection)}`)
}

function projectInitialEvent(event: AstraWorkSessionEvent): AstraWorkSessionParseResult<AstraWorkSessionProjection> {
  if (
    event.type !== "session.created" ||
    event.sequence !== 1 ||
    event.previousDigest !== workSessionGenesisDigest
  ) {
    return rejected("illegal_transition")
  }
  return finalizeProjection({
    schemaVersion: 1,
    sessionID: event.sessionID,
    workspaceRoot: event.workspaceRoot,
    workspaceIdentity: event.workspaceIdentity,
    sequence: event.sequence,
    lastEventDigest: event.eventDigest,
    objective: event.payload.objective,
    phase: "idle",
    intent: event.payload.intent,
    agents: [],
    decisions: [],
    evidence: [],
    candidatePatchID: null,
    reconciliationPending: false,
    updatedAt: event.observedAt,
  })
}

function applyEvent(
  previous: AstraWorkSessionProjection,
  event: Exclude<AstraWorkSessionEvent, { type: "session.created" }>,
): AstraWorkSessionParseResult<AstraWorkSessionProjection> {
  const base = {
    ...withoutProjectionDigest(previous),
    sequence: event.sequence,
    lastEventDigest: event.eventDigest,
    updatedAt: event.observedAt,
  }
  if (event.type === "objective.updated") return finalizeProjection({ ...base, objective: event.payload.objective })
  if (event.type === "intent.updated") return finalizeProjection({ ...base, intent: event.payload.intent })
  if (event.type === "phase.changed") {
    if (!ordinaryPhaseTransitions.has(`${previous.phase}\0${event.payload.phase}`)) {
      return rejected("illegal_transition")
    }
    if (previous.reconciliationPending && reconciliationProtectedPhases.has(event.payload.phase)) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({
      ...base,
      phase: event.payload.phase,
      reconciliationPending:
        previous.reconciliationPending ||
        event.payload.phase === "uncertain" ||
        event.payload.phase === "reconciliation-required",
    })
  }
  if (event.type === "agent.added") {
    if (previous.agents.length >= maximumAgents || previous.agents.some((agent) => agent.agentID === event.payload.agent.agentID)) {
      return rejected("illegal_transition")
    }
    if (
      event.payload.agent.parentAgentID !== null &&
      !previous.agents.some((agent) => agent.agentID === event.payload.agent.parentAgentID)
    ) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({ ...base, agents: [...previous.agents, event.payload.agent] })
  }
  if (event.type === "agent.state-changed") {
    const current = previous.agents.find((agent) => agent.agentID === event.payload.agentID)
    if (!current || terminalAgentStates.has(current.state) || !agentTransitions.has(`${current.state}\0${event.payload.state}`)) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({
      ...base,
      agents: previous.agents.map((agent) =>
        agent.agentID === event.payload.agentID
          ? { ...agent, state: event.payload.state, activity: event.payload.activity }
          : agent,
      ),
    })
  }
  if (event.type === "decision.requested") {
    if (
      previous.decisions.length >= maximumDecisions ||
      previous.decisions.some((decision) => decision.decisionID === event.payload.decision.decisionID)
    ) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({
      ...base,
      decisions: [...previous.decisions, { ...event.payload.decision, state: "pending" as const }],
    })
  }
  if (event.type === "decision.resolved") {
    const current = previous.decisions.find((decision) => decision.decisionID === event.payload.decisionID)
    if (!current || current.state !== "pending") return rejected("illegal_transition")
    return finalizeProjection({
      ...base,
      decisions: previous.decisions.map((decision) =>
        decision.decisionID === event.payload.decisionID ? { ...decision, state: event.payload.outcome } : decision,
      ),
    })
  }
  if (event.type === "evidence.recorded") return withEvidence(base, previous, event.payload.evidence)
  if (event.type === "candidate-patch.recorded") {
    if (
      previous.reconciliationPending ||
      (previous.phase !== "working" && previous.phase !== "checking") ||
      hasEvidence(previous, event.payload.evidence)
    ) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({
      ...base,
      phase: "review-ready",
      candidatePatchID: event.payload.candidatePatchID,
      evidence: [...previous.evidence, event.payload.evidence],
    })
  }
  if (event.type === "commit-ready.recorded") {
    if (
      previous.reconciliationPending ||
      (previous.phase !== "review-ready" && previous.phase !== "checking") ||
      event.payload.evidence.kind !== "git"
    ) {
      return rejected("illegal_transition")
    }
    if (hasEvidence(previous, event.payload.evidence)) return rejected("illegal_transition")
    return finalizeProjection({
      ...base,
      phase: "commit-ready",
      evidence: [...previous.evidence, event.payload.evidence],
    })
  }
  if (event.type === "session.completed") {
    if (previous.reconciliationPending || previous.phase !== "commit-ready" || hasEvidence(previous, event.payload.evidence)) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({
      ...base,
      phase: "completed",
      evidence: [...previous.evidence, event.payload.evidence],
    })
  }
  if (event.type === "effect.ambiguous") {
    return finalizeProjection({
      ...base,
      phase: "reconciliation-required",
      reconciliationPending: true,
      intent: { summary: event.payload.summary, next: `Reconcile Operation ${event.payload.operationID}` },
    })
  }
  if (event.type === "reconciliation.recorded") {
    if (
      (previous.phase !== "uncertain" && previous.phase !== "reconciliation-required") ||
      !reconciliationTargets.has(event.payload.nextPhase) ||
      hasEvidence(previous, event.payload.evidence)
    ) {
      return rejected("illegal_transition")
    }
    return finalizeProjection({
      ...base,
      phase: event.payload.nextPhase,
      reconciliationPending: false,
      evidence: [...previous.evidence, event.payload.evidence],
    })
  }
  return rejected("illegal_transition")
}

function withEvidence(
  base: Omit<AstraWorkSessionProjection, "projectionDigest">,
  previous: AstraWorkSessionProjection,
  evidence: AstraWorkSessionEvidence,
) {
  if (previous.evidence.length >= maximumEvidence || hasEvidence(previous, evidence)) {
    return rejected("illegal_transition")
  }
  return finalizeProjection({ ...base, evidence: [...previous.evidence, evidence] })
}

function hasEvidence(previous: AstraWorkSessionProjection, evidence: AstraWorkSessionEvidence) {
  return previous.evidence.length >= maximumEvidence || previous.evidence.some((item) => item.evidenceID === evidence.evidenceID)
}

function matchingBinding(previous: AstraWorkSessionProjection, event: AstraWorkSessionEvent) {
  return (
    event.sessionID === previous.sessionID &&
    event.workspaceRoot === previous.workspaceRoot &&
    event.workspaceIdentity.device === previous.workspaceIdentity.device &&
    event.workspaceIdentity.inode === previous.workspaceIdentity.inode &&
    event.sequence === previous.sequence + 1 &&
    event.previousDigest === previous.lastEventDigest &&
    Date.parse(event.observedAt) >= Date.parse(previous.updatedAt)
  )
}

function makeBoundEvent(
  authority: Omit<AstraWorkSessionEventBinding, "payloadDigest" | "eventDigest"> & AstraWorkSessionEventDraft,
): AstraWorkSessionParseResult<AstraWorkSessionEvent> {
  const payloadDigest = digest(`astra.work-session.payload.v1\0${canonicalJson(authority.payload)}`)
  const eventAuthority = { ...authority, payloadDigest }
  const eventDigest = digest(`astra.work-session.event.v1\0${canonicalJson(eventAuthority)}`)
  return parseAstraWorkSessionEvent({ ...eventAuthority, eventDigest })
}

function finalizeProjection(
  authority: Omit<AstraWorkSessionProjection, "projectionDigest">,
): AstraWorkSessionParseResult<AstraWorkSessionProjection> {
  return parseAstraWorkSessionProjection({
    ...authority,
    projectionDigest: computeAstraWorkSessionProjectionDigest(authority),
  })
}

function parseDraft(input: unknown): AstraWorkSessionEventDraft | null {
  const broad = exact(input, ["type", "payload"])
  if (!broad || typeof broad.type !== "string") return null
  if (broad.type === "session.created") {
    const payload = exact(broad.payload, ["objective", "intent"])
    const objective = payload ? nullableText(payload.objective, 4_096) : undefined
    const intent = payload ? parseIntent(payload.intent) : null
    return payload && objective !== undefined && intent ? { type: broad.type, payload: { objective, intent } } : null
  }
  if (broad.type === "objective.updated") {
    const payload = exact(broad.payload, ["objective"])
    const objective = payload ? nullableText(payload.objective, 4_096) : undefined
    return payload && objective !== undefined ? { type: broad.type, payload: { objective } } : null
  }
  if (broad.type === "intent.updated") {
    const payload = exact(broad.payload, ["intent"])
    const intent = payload ? parseIntent(payload.intent) : null
    return payload && intent ? { type: broad.type, payload: { intent } } : null
  }
  if (broad.type === "phase.changed") {
    const payload = exact(broad.payload, ["phase"])
    const phase = payload ? parsePhase(payload.phase) : null
    return phase ? { type: broad.type, payload: { phase } } : null
  }
  if (broad.type === "agent.added") {
    const payload = exact(broad.payload, ["agent"])
    const agent = payload ? parseAgent(payload.agent) : null
    return agent ? { type: broad.type, payload: { agent } } : null
  }
  if (broad.type === "agent.state-changed") {
    const payload = exact(broad.payload, ["agentID", "state", "activity"])
    const agentID = payload ? safeID(payload.agentID, 128) : null
    const state = payload ? parseAgentState(payload.state) : null
    const activity = payload ? safeText(payload.activity, 2_048) : null
    return agentID && state && activity ? { type: broad.type, payload: { agentID, state, activity } } : null
  }
  if (broad.type === "decision.requested") {
    const payload = exact(broad.payload, ["decision"])
    const decision = payload ? parseDecisionRequest(payload.decision) : null
    return decision ? { type: broad.type, payload: { decision } } : null
  }
  if (broad.type === "decision.resolved") {
    const payload = exact(broad.payload, ["decisionID", "outcome"])
    const decisionID = payload ? safeID(payload.decisionID, 128) : null
    const outcome = payload ? parseDecisionOutcome(payload.outcome) : null
    return decisionID && outcome ? { type: broad.type, payload: { decisionID, outcome } } : null
  }
  if (broad.type === "evidence.recorded" || broad.type === "commit-ready.recorded" || broad.type === "session.completed") {
    const payload = exact(broad.payload, ["evidence"])
    const evidence = payload ? parseEvidence(payload.evidence) : null
    return evidence ? { type: broad.type, payload: { evidence } } : null
  }
  if (broad.type === "candidate-patch.recorded") {
    const payload = exact(broad.payload, ["candidatePatchID", "evidence"])
    const candidatePatchID = payload ? safeID(payload.candidatePatchID, 256) : null
    const evidence = payload ? parseEvidence(payload.evidence) : null
    return candidatePatchID && evidence ? { type: broad.type, payload: { candidatePatchID, evidence } } : null
  }
  if (broad.type === "effect.ambiguous") {
    const payload = exact(broad.payload, ["operationID", "summary"])
    const operationID = payload && typeof payload.operationID === "string" && uuidPattern.test(payload.operationID)
      ? payload.operationID
      : null
    const summary = payload ? safeText(payload.summary, 2_048) : null
    return operationID && summary ? { type: broad.type, payload: { operationID, summary } } : null
  }
  if (broad.type === "reconciliation.recorded") {
    const payload = exact(broad.payload, ["nextPhase", "evidence"])
    const nextPhase = payload ? parsePhase(payload.nextPhase) : null
    const evidence = payload ? parseEvidence(payload.evidence) : null
    return nextPhase && evidence ? { type: broad.type, payload: { nextPhase, evidence } } : null
  }
  return null
}

function parseAgents(input: unknown) {
  const array = normalizedArray(input, maximumAgents)
  if (!array) return null
  const values: Array<AstraAgentProjection> = []
  const ids = new Set<string>()
  for (const item of array) {
    const agent = parseAgent(item)
    if (!agent || ids.has(agent.agentID) || (agent.parentAgentID !== null && !ids.has(agent.parentAgentID))) return null
    ids.add(agent.agentID)
    values.push(agent)
  }
  return values
}

function parseAgent(input: unknown): AstraAgentProjection | null {
  const record = exact(input, [
    "agentID",
    "parentAgentID",
    "label",
    "task",
    "activity",
    "state",
    "effectAuthority",
  ])
  if (!record || record.effectAuthority !== "none") return null
  const agentID = safeID(record.agentID, 128)
  const parentAgentID = nullableID(record.parentAgentID, 128)
  const label = safeText(record.label, 256)
  const task = safeText(record.task, 2_048)
  const activity = safeText(record.activity, 2_048)
  const state = parseAgentState(record.state)
  if (!agentID || parentAgentID === undefined || !label || !task || !activity || !state || parentAgentID === agentID) {
    return null
  }
  return { agentID, parentAgentID, label, task, activity, state, effectAuthority: "none" }
}

function parseAgentState(input: unknown): AstraAgentProjection["state"] | null {
  return typeof input === "string" && agentStates.has(input as AstraAgentProjection["state"])
    ? (input as AstraAgentProjection["state"])
    : null
}

function parseDecisions(input: unknown) {
  const array = normalizedArray(input, maximumDecisions)
  if (!array) return null
  const values: Array<AstraWorkSessionDecision> = []
  const ids = new Set<string>()
  for (const item of array) {
    const record = exact(item, ["decisionID", "kind", "summary", "resources", "boundary", "state"])
    const decisionID = record ? safeID(record.decisionID, 128) : null
    const kind = record ? safeID(record.kind, 128) : null
    const summary = record ? safeText(record.summary, 2_048) : null
    const resources = record ? parseResources(record.resources) : null
    const boundary = record ? safeText(record.boundary, 256) : null
    const state = record ? parseDecisionState(record.state) : null
    if (!decisionID || !kind || !summary || !resources || !boundary || !state || ids.has(decisionID)) return null
    ids.add(decisionID)
    values.push({ decisionID, kind, summary, resources, boundary, state })
  }
  return values
}

function parseDecisionRequest(input: unknown) {
  const record = exact(input, ["decisionID", "kind", "summary", "resources", "boundary"])
  const decisionID = record ? safeID(record.decisionID, 128) : null
  const kind = record ? safeID(record.kind, 128) : null
  const summary = record ? safeText(record.summary, 2_048) : null
  const resources = record ? parseResources(record.resources) : null
  const boundary = record ? safeText(record.boundary, 256) : null
  return decisionID && kind && summary && resources && boundary
    ? { decisionID, kind, summary, resources, boundary }
    : null
}

function parseResources(input: unknown) {
  const array = normalizedArray(input, 64)
  if (!array || array.length === 0) return null
  const resources = array.map((item) => safeText(item, 1_024))
  if (resources.some((item) => item === null)) return null
  const values = resources.flatMap((item) => (item ? [item] : []))
  return new Set(values).size === values.length ? values : null
}

function parseDecisionState(input: unknown): AstraWorkSessionDecision["state"] | null {
  return input === "pending" || input === "approved" || input === "rejected" || input === "cancelled" ? input : null
}

function parseDecisionOutcome(input: unknown): "approved" | "rejected" | "cancelled" | null {
  return input === "approved" || input === "rejected" || input === "cancelled" ? input : null
}

function parseEvidenceArray(input: unknown) {
  const array = normalizedArray(input, maximumEvidence)
  if (!array) return null
  const values: Array<AstraWorkSessionEvidence> = []
  const ids = new Set<string>()
  for (const item of array) {
    const evidence = parseEvidence(item)
    if (!evidence || ids.has(evidence.evidenceID)) return null
    ids.add(evidence.evidenceID)
    values.push(evidence)
  }
  return values
}

function parseEvidence(input: unknown): AstraWorkSessionEvidence | null {
  const record = exact(input, ["evidenceID", "kind", "label", "value", "assurance"])
  const evidenceID = record ? safeID(record.evidenceID, 128) : null
  const label = record ? safeText(record.label, 256) : null
  const value = record ? safeText(record.value, 4_096) : null
  const assurance = record ? safeText(record.assurance, 512) : null
  if (
    !record ||
    !evidenceID ||
    !label ||
    !value ||
    !assurance ||
    (record.kind !== "git" && record.kind !== "test" && record.kind !== "receipt")
  ) {
    return null
  }
  return { evidenceID, kind: record.kind, label, value, assurance }
}

function parseIntent(input: unknown) {
  const record = exact(input, ["summary", "next"])
  const summary = record ? safeText(record.summary, 2_048) : null
  const next = record ? safeText(record.next, 2_048) : null
  return summary && next ? { summary, next } : null
}

function parseActor(input: unknown): AstraWorkSessionActor | null {
  const record = exact(input, ["kind", "actorID"])
  const actorID = record ? safeID(record.actorID, 128) : null
  if (!record || !actorID || (record.kind !== "user" && record.kind !== "system" && record.kind !== "agent")) {
    return null
  }
  return { kind: record.kind, actorID }
}

function parseIdentity(input: unknown): WorkspaceIdentity | null {
  const record = exact(input, ["device", "inode"])
  const device = record ? safeID(record.device, 128) : null
  const inode = record ? safeID(record.inode, 128) : null
  return device && inode ? { device, inode } : null
}

function parsePhase(input: unknown): AstraWorkPhase | null {
  return typeof input === "string" && (workSessionPhases as ReadonlyArray<string>).includes(input)
    ? (input as AstraWorkPhase)
    : null
}

function normalizedArray(input: unknown, maximum: number): ReadonlyArray<unknown> | null {
  const parsed = parseNormalizedJsonArray(input, "$")
  return parsed.ok && parsed.value.length <= maximum ? parsed.value : null
}

function exact(input: unknown, fields: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, fields)
  if (!parsed.ok || fields.some((field) => !Object.hasOwn(parsed.value, field))) return null
  return parsed.value
}

function safeText(input: unknown, maximum: number) {
  const parsed = parseBoundedString(input, "$", maximum)
  return parsed.ok ? parsed.value : null
}

function safeID(input: unknown, maximum: number) {
  const value = safeText(input, maximum)
  return value && /^[\p{L}\p{N}][\p{L}\p{N}._:@/-]*$/u.test(value) ? value : null
}

function nullableText(input: unknown, maximum: number) {
  if (input === null) return null
  return safeText(input, maximum) ?? undefined
}

function nullableID(input: unknown, maximum: number) {
  if (input === null) return null
  return safeID(input, maximum) ?? undefined
}

function absolutePath(input: unknown) {
  const value = safeText(input, 4_096)
  return value && isAbsolute(value) && normalize(value) === value ? value : null
}

function canonicalTimestamp(input: unknown) {
  const parsed = parseCanonicalTimestamp(input, "$")
  return parsed.ok ? parsed.value : null
}

function nonNegativeInteger(input: unknown) {
  const parsed = parseNonNegativeInteger(input, "$")
  return parsed.ok ? parsed.value : null
}

function digestValue(input: unknown): `sha256:${string}` | null {
  return typeof input === "string" && digestPattern.test(input) ? (input as `sha256:${string}`) : null
}

function digest(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function canonicalJson(input: unknown): string {
  if (input === null || typeof input === "string" || typeof input === "boolean") return JSON.stringify(input)
  if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`
  if (typeof input !== "object") throw new TypeError("Work-session data must be canonical JSON")
  return `{${Object.entries(input)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`
}

function withoutProjectionDigest(projection: AstraWorkSessionProjection): Omit<AstraWorkSessionProjection, "projectionDigest"> {
  const { projectionDigest: _projectionDigest, ...authority } = projection
  return authority
}

function accepted<Value>(value: Value): AstraWorkSessionParseResult<Value> {
  return { ok: true, value: deepFreeze(value) }
}

function rejected(code: Exclude<AstraWorkSessionParseResult<never>, { ok: true }>["code"]): AstraWorkSessionParseResult<never> {
  return { ok: false, code }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}
