import {
  cursorForAstraWorkSessionProjection,
  type AstraWorkSessionCursor,
} from "@astra/domain/work-session-control"
import {
  parseAstraWorkSessionEvent,
  parseAstraWorkSessionProjection,
  projectAstraWorkSessionEvent,
  type AstraWorkSessionEvent,
  type AstraWorkSessionProjection,
} from "@astra/domain/work-session"
import {
  loadDurableWorkSession,
  type AstraDurableWorkSession,
} from "@astra/runtime/work-session-store"

export type AstraWorkSessionControl = Readonly<{
  snapshot: (cursor?: AstraWorkSessionCursor) => Promise<AstraDurableWorkSession>
  subscribe: (
    cursor: AstraWorkSessionCursor,
    signal: AbortSignal,
    publish: (event: AstraWorkSessionEvent, projection: AstraWorkSessionProjection) => Promise<void>,
  ) => Promise<void>
  decide: (decisionID: string, outcome: "approved" | "rejected") => Promise<void>
  cancel: () => Promise<void>
}>

type Dependencies = Readonly<{
  load: (sessionID: string) => Promise<AstraDurableWorkSession>
  decide: (decisionID: string, outcome: "approved" | "rejected") => Promise<void>
  cancel: () => Promise<void>
  pollIntervalMs?: number
}>

/** Parent-owned adapter over the one durable work session selected at launch. */
export function createAstraWorkSessionControl(
  durableSessionID: string,
  dependencies: Dependencies = {
    load: loadDurableWorkSession,
    async decide() {
      throw new Error("No parent decision coordinator is active")
    },
    async cancel() {
      throw new Error("No parent cancellation coordinator is active")
    },
  },
): AstraWorkSessionControl {
  const pollIntervalMs = positiveInteger(dependencies.pollIntervalMs) ?? 100
  const load = async (cursor?: AstraWorkSessionCursor) => {
    const record = requireRecord(await dependencies.load(durableSessionID), durableSessionID)
    if (cursor) requireCursor(record, cursor)
    return record
  }

  return Object.freeze({
    snapshot: load,
    async subscribe(cursor, signal, publish) {
      let current = await load(cursor)
      let sequence = current.projection.sequence
      while (!signal.aborted) {
        await delay(pollIntervalMs, signal)
        if (signal.aborted) return
        const next = await load()
        if (next.projection.sequence < sequence) throw new Error("Work-session sequence regressed")
        if (next.projection.sequence === sequence) continue
        const projections = replay(next)
        for (const item of projections.filter((item) => item.event.sequence > sequence)) {
          await publish(item.event, item.projection)
          sequence = item.event.sequence
        }
        current = next
        if (current.projection.sequence !== sequence) throw new Error("Work-session replay was incomplete")
      }
    },
    async decide(decisionID, outcome) {
      await dependencies.decide(decisionID, outcome)
    },
    async cancel() {
      await dependencies.cancel()
    },
  })
}

function requireRecord(input: AstraDurableWorkSession, durableSessionID: string) {
  const projection = parseAstraWorkSessionProjection(input.projection)
  if (!projection.ok || projection.value.sessionID !== durableSessionID) throw new Error("Work-session state is unavailable")
  const events = input.events.map((event) => parseAstraWorkSessionEvent(event))
  if (events.some((event) => !event.ok)) throw new Error("Work-session state is unavailable")
  const record = {
    projection: projection.value,
    events: events.map((event) => {
      if (!event.ok) throw new Error("Work-session state is unavailable")
      return event.value
    }),
  }
  const projections = replay(record)
  if (projections.at(-1)?.projection.projectionDigest !== projection.value.projectionDigest) {
    throw new Error("Work-session projection does not match its event chain")
  }
  return Object.freeze({ projection: projection.value, events: Object.freeze(record.events) })
}

function requireCursor(record: AstraDurableWorkSession, cursor: AstraWorkSessionCursor) {
  const found = replay(record).find((item) => item.projection.sequence === cursor.sequence)?.projection
  if (!found) throw new Error("Work-session cursor is unavailable")
  const expected = cursorForAstraWorkSessionProjection(found)
  if (
    expected.lastEventDigest !== cursor.lastEventDigest ||
    expected.projectionDigest !== cursor.projectionDigest
  ) {
    throw new Error("Work-session cursor is stale or invalid")
  }
}

function replay(record: AstraDurableWorkSession) {
  const projections: Array<Readonly<{ event: AstraWorkSessionEvent; projection: AstraWorkSessionProjection }>> = []
  let projection: AstraWorkSessionProjection | null = null
  for (const event of record.events) {
    const next = projectAstraWorkSessionEvent(projection, event)
    if (!next.ok) throw new Error("Work-session event chain is unavailable")
    projection = next.value
    projections.push({ event, projection: next.value })
  }
  return projections
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, milliseconds)
    const abort = () => done()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function positiveInteger(input: unknown) {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 ? input : null
}
