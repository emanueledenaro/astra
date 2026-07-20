import { expect, test } from "bun:test"
import type { AstraDurableWorkSession, AstraWorkSessionSummary } from "@astra/runtime/work-session-store"
import { resumeOrCreateAstraWorkSession } from "../src/work-session-resume"

test("resumes the newest verified session for the exact workspace identity", async () => {
  const created: unknown[] = []
  const sessionID = await resumeOrCreateAstraWorkSession(
    { root: "/workspace", identity: { device: "10", inode: "20" } },
    {
      async list() {
        return [summary("newest", "/workspace"), summary("older", "/workspace")]
      },
      async load(candidate) {
        return record(candidate, candidate === "newest" ? { device: "10", inode: "20" } : { device: "1", inode: "2" })
      },
      async create(input) {
        created.push(input)
        return record(input.sessionID, input.workspaceIdentity)
      },
    },
  )

  expect(sessionID).toBe("newest")
  expect(created).toEqual([])
})

test("does not resume a session after the workspace path is rebound", async () => {
  const created: unknown[] = []
  const sessionID = await resumeOrCreateAstraWorkSession(
    { root: "/workspace", identity: { device: "10", inode: "99" } },
    {
      async list() {
        return [summary("stale", "/workspace"), summary("other", "/other")]
      },
      async load(candidate) {
        if (candidate === "other") throw new Error("unrelated session must not be loaded")
        return record(candidate, { device: "10", inode: "20" })
      },
      async create(input) {
        created.push(input)
        return record(input.sessionID, input.workspaceIdentity)
      },
    },
    { createSessionID: () => "replacement", now: () => new Date("2026-07-20T18:00:00.000Z") },
  )

  expect(sessionID).toBe("replacement")
  expect(created).toEqual([
    {
      sessionID: "replacement",
      workspaceRoot: "/workspace",
      workspaceIdentity: { device: "10", inode: "99" },
      objective: null,
      intent: { summary: "Workspace opened", next: "Awaiting an objective" },
      observedAt: "2026-07-20T18:00:00.000Z",
      actor: { kind: "system", actorID: "astra-parent" },
    },
  ])
})

function summary(sessionID: string, workspaceRoot: string): AstraWorkSessionSummary {
  return {
    sessionID,
    workspaceRoot,
    phase: "idle",
    sequence: 1,
    projectionDigest: `sha256:${"a".repeat(64)}`,
    updatedAt: "2026-07-20T18:00:00.000Z",
  }
}

function record(sessionID: string, workspaceIdentity: Readonly<{ device: string; inode: string }>) {
  return {
    projection: {
      schemaVersion: 1,
      sessionID,
      workspaceRoot: "/workspace",
      workspaceIdentity,
      sequence: 1,
      lastEventDigest: `sha256:${"b".repeat(64)}`,
      projectionDigest: `sha256:${"a".repeat(64)}`,
      objective: null,
      phase: "idle",
      intent: { summary: "Workspace opened", next: "Awaiting an objective" },
      agents: [],
      decisions: [],
      evidence: [],
      candidatePatchID: null,
      reconciliationPending: false,
      updatedAt: "2026-07-20T18:00:00.000Z",
    },
    events: [],
  } as AstraDurableWorkSession
}
