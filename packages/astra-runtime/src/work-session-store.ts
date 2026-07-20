import {
  createWorkSessionStoreInternal,
  workSessionStateRootInternal,
  type AppendWorkSessionInput,
  type CreateWorkSessionInput,
  type DeleteWorkSessionInput,
} from "./work-session-store-internal"

/** Creates one parent-owned durable work session under the effective macOS account state root. */
export function createDurableWorkSession(input: CreateWorkSessionInput) {
  return createWorkSessionStoreInternal({ stateRoot: workSessionStateRootInternal() }).create(input)
}

/** Atomically appends one validated event and advances its durable projection. */
export function appendDurableWorkSession(input: AppendWorkSessionInput) {
  return createWorkSessionStoreInternal({ stateRoot: workSessionStateRootInternal() }).append(input)
}

/** Reloads and verifies the complete event chain before returning session state. */
export function loadDurableWorkSession(sessionID: string) {
  return createWorkSessionStoreInternal({ stateRoot: workSessionStateRootInternal() }).load(sessionID)
}

/** Lists only sessions whose complete durable state verifies successfully. */
export function listDurableWorkSessions() {
  return createWorkSessionStoreInternal({ stateRoot: workSessionStateRootInternal() }).list()
}

/** Exports canonical projection-only JSON without verbose internal event payloads. */
export function exportDurableWorkSession(sessionID: string) {
  return createWorkSessionStoreInternal({ stateRoot: workSessionStateRootInternal() }).export(sessionID)
}

/** Deletes exactly one digest-bound local session and no other state. */
export function deleteDurableWorkSession(input: DeleteWorkSessionInput) {
  return createWorkSessionStoreInternal({ stateRoot: workSessionStateRootInternal() }).delete(input)
}

export { WorkSessionStoreError } from "./work-session-store-internal"

export type {
  AppendWorkSessionInput,
  AstraDurableWorkSession,
  AstraWorkSessionSummary,
  CreateWorkSessionInput,
  DeleteWorkSessionInput,
} from "./work-session-store-internal"
