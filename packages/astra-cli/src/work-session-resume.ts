import { randomUUID } from "node:crypto"
import type { WorkspaceIdentity } from "@astra/domain/workspace-trust"
import type { AstraDurableWorkSession, AstraWorkSessionSummary } from "@astra/runtime/work-session-store"

type WorkSessionStore = Readonly<{
  list: () => Promise<ReadonlyArray<AstraWorkSessionSummary>>
  load: (sessionID: string) => Promise<AstraDurableWorkSession>
  create: (input: {
    sessionID: string
    workspaceRoot: string
    workspaceIdentity: WorkspaceIdentity
    objective: null
    intent: Readonly<{ summary: string; next: string }>
    observedAt: string
    actor: Readonly<{ kind: "system"; actorID: string }>
  }) => Promise<AstraDurableWorkSession>
}>

/** Resumes the newest verified session bound to this exact workspace, or creates one. */
export async function resumeOrCreateAstraWorkSession(
  workspace: Readonly<{ root: string; identity: WorkspaceIdentity }>,
  store: WorkSessionStore,
  dependencies: Readonly<{ createSessionID: () => string; now: () => Date }> = {
    createSessionID: randomUUID,
    now: () => new Date(),
  },
) {
  const candidates = (await store.list()).filter((session) => session.workspaceRoot === workspace.root)
  for (const candidate of candidates) {
    const record = await store.load(candidate.sessionID)
    if (sameWorkspaceIdentity(record.projection.workspaceIdentity, workspace.identity)) return candidate.sessionID
  }

  const sessionID = dependencies.createSessionID()
  await store.create({
    sessionID,
    workspaceRoot: workspace.root,
    workspaceIdentity: workspace.identity,
    objective: null,
    intent: { summary: "Workspace opened", next: "Awaiting an objective" },
    observedAt: dependencies.now().toISOString(),
    actor: { kind: "system", actorID: "astra-parent" },
  })
  return sessionID
}

function sameWorkspaceIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity) {
  return left.device === right.device && left.inode === right.inode
}
