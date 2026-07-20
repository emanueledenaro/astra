import {
  providerConversationGenesisDigest,
  type AstraProviderConversation,
  type AstraProviderConversationTurn,
} from "@astra/domain/work-session"
import {
  appendDurableWorkSession,
  loadDurableWorkSession,
  type AstraDurableWorkSession,
} from "@astra/runtime/work-session-store"

export type ParentProviderConversationHistory = Readonly<{
  load: () => Promise<AstraProviderConversation>
  append: (
    priorHistoryDigest: `sha256:${string}`,
    turn: AstraProviderConversationTurn,
    observedAt: string,
  ) => Promise<AstraProviderConversation>
}>

/** Binds provider transcript reads and appends to one parent-owned durable work session. */
export function createParentProviderConversationHistory(durableSessionID: string): ParentProviderConversationHistory {
  return Object.freeze({
    async load() {
      return conversationFromRecord(await loadDurableWorkSession(durableSessionID), durableSessionID)
    },
    async append(priorHistoryDigest, turn, observedAt) {
      const current = await loadDurableWorkSession(durableSessionID)
      const conversation = conversationFromRecord(current, durableSessionID)
      if (conversation.historyDigest !== priorHistoryDigest) throw new Error("Provider conversation history is stale")
      const appended = await appendDurableWorkSession({
        sessionID: durableSessionID,
        expectedSequence: current.projection.sequence,
        observedAt,
        actor: { kind: "system", actorID: "astra-parent" },
        draft: { type: "provider.turn-recorded", payload: { priorHistoryDigest, turn } },
      })
      return conversationFromRecord(appended, durableSessionID)
    },
  })
}

function conversationFromRecord(record: AstraDurableWorkSession, durableSessionID: string): AstraProviderConversation {
  if (record.projection.sessionID !== durableSessionID) throw new Error("Provider conversation session is unavailable")
  if (record.projection.schemaVersion === 2) return record.projection.conversation
  return Object.freeze({
    turns: Object.freeze([]),
    historyDigest: providerConversationGenesisDigest,
    totalBytes: 0,
  })
}
