/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import {
  createAstraWorkSessionEvent,
  makeAstraWorkSessionEvent,
  projectAstraWorkSessionEvent,
  type AstraWorkSessionEventDraft,
  type AstraWorkSessionProjection,
} from "@astra/domain/work-session"
import { cursorForAstraWorkSessionProjection } from "@astra/domain/work-session-control"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, ErrorBoundary, type JSX } from "solid-js"
import type { AstraProviderClient } from "../../../src/astra/provider-client"
import type { AstraWorkSessionClient, AstraWorkSessionView } from "../../../src/astra/work-session-client"
import { AstraCockpit, type AstraCandidatePatchDetails } from "../../../src/component/astra-cockpit"
import { validateAstraCandidatePatchDetails } from "../../../src/component/astra-review-mode"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider } from "../../../src/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("renders the parent-owned wide cockpit at 140x34", async () => {
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection: workingProjection(),
  })
  try {
    const frame = await app.render.waitForFrame((value) => value.includes("WORK TREE"))
    const context = lineWith(frame, "ASTRA")
    expect(context).toContain("astra-cockpit")
    expect(context).toContain("Anthropic/claude-sonnet")
    expect(context).toContain("REVIEW MANUAL")
    expect(lineWith(frame, "CONVERSATION")).toContain("CONTROL")
    expect(frame).toContain("INTENT")
    expect(frame).toContain("Implement the governed change")
    expect(frame).toContain("Lynx coordinator")
    expect(frame).toContain("└─ TUI worker")
    expect(frame).toContain("FAILED")
    expect(frame).toContain("LOST")
    expect(frame).toContain("effect authority: none")
    expect(frame).toContain("PROOF")
    expect(frame).toContain("tests · 12 passed")
    expect(frame).toContain("OBSERVED · NOT VERIFIED")
    expect(lastContentLine(frame)).toContain("HOST EXECUTION — NO SANDBOX")
  } finally {
    app.render.renderer.destroy()
  }
})

test("keeps a 34-column rail beside chat at 100x26", async () => {
  const app = await renderCockpit({
    width: 100,
    height: 26,
    projection: decisionProjection(),
  })
  try {
    const frame = await app.render.waitForFrame((value) => value.includes("DECISION"))
    expect(lineWith(frame, "CONVERSATION")).toContain("CONTROL")
    expect(frame).toContain("Write src/index.ts")
    expect(frame).toContain("BOUNDARY host/filesystem")
    expect(frame).toContain("workspace:file:src/index.ts")
    expect(frame).toContain("1 OTHER PENDING")
    expect(frame).toContain("A APPROVE · D REJECT")
    expect(lastContentLine(frame)).toContain("HOST EXECUTION — NO SANDBOX")

    app.dispatch("astra.work.reject")
    expect(app.decisions).toEqual([{ decisionID: "decision-write", outcome: "rejected" }])
  } finally {
    app.render.renderer.destroy()
  }
})

test("uses chat-only and a full-screen control alternate at 80x24", async () => {
  const app = await renderCockpit({
    width: 80,
    height: 24,
    projection: decisionProjection(),
  })
  try {
    const chat = await app.render.waitForFrame((value) => value.includes("CONVERSATION"))
    expect(chat).not.toContain("DECISION")
    expect(chat).not.toContain("│ CONTROL")
    expect(lastContentLine(chat)).toContain("HOST EXECUTION — NO SANDBOX")

    app.dispatch("astra.control.toggle")
    const rail = await app.render.waitForFrame((value) => value.includes("Write src/index.ts"))
    expect(rail).toContain("CONTROL")
    expect(rail).not.toContain("CONVERSATION")
    expect(lastContentLine(rail)).toContain("HOST EXECUTION — NO SANDBOX")
  } finally {
    app.render.renderer.destroy()
  }
})

test("uses the same alternate-view contract when 120x18 is too short", async () => {
  const app = await renderCockpit({
    width: 120,
    height: 18,
    projection: workingProjection(),
  })
  try {
    const frame = await app.render.waitForFrame((value) => value.includes("CONVERSATION"))
    expect(frame).not.toContain("WORK TREE")
    app.dispatch("astra.control.toggle")
    const rail = await app.render.waitForFrame((value) => value.includes("WORK TREE"))
    expect(rail).not.toContain("CONVERSATION")
  } finally {
    app.render.renderer.destroy()
  }
})

test("replaces stale control state with STATE UNAVAILABLE after stream loss", async () => {
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection: workingProjection(),
    streamView: { status: "state_unavailable", reason: "transport_failed" },
  })
  try {
    const frame = await app.render.waitForFrame((value) => value.includes("STATE UNAVAILABLE"))
    expect(frame).toContain("PARENT STREAM LOST")
    expect(frame).not.toContain("WORK TREE")
    expect(frame).not.toContain("Implement the governed change")
    expect(frame).not.toContain("12 passed")
  } finally {
    app.render.renderer.destroy()
  }
})

test("shows reconciliation and exact failed/lost worker state without a success claim", async () => {
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection: reconciliationProjection(),
  })
  try {
    const frame = await app.render.waitForFrame((value) => value.includes("RECONCILIATION REQUIRED"))
    expect(frame).toContain("FAILED")
    expect(frame).toContain("LOST")
    expect(frame).toContain("EFFECT OUTCOME UNKNOWN")
    expect(frame).not.toContain("VERIFIED")
    expect(frame).not.toContain("SUCCESS")
  } finally {
    app.render.renderer.destroy()
  }
})

test("never opens review automatically and refuses incomplete or mismatched candidate metadata", async () => {
  const projection = reviewProjection()
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection,
    candidatePatchDetails: {
      schemaVersion: 1,
      candidatePatchID: "candidate-01",
      candidateDigest: `sha256:${"d".repeat(64)}`,
      projectionDigest: projection.projectionDigest,
      baselineDigest,
      summary: "Candidate patch",
      files: [{ path: "src/index.ts", change: "modify" }],
    },
  })
  try {
    const chat = await app.render.waitForFrame((value) => value.includes("REVIEW READY"))
    expect(chat).toContain("CANDIDATE DETAILS UNAVAILABLE")
    expect(chat).toContain("CONVERSATION")
    expect(chat).not.toContain("CANDIDATE METADATA")

    app.dispatch("astra.review.toggle")
    await app.render.renderOnce()
    expect(app.render.captureCharFrame()).toContain("CONVERSATION")
    expect(app.render.captureCharFrame()).not.toContain("CANDIDATE METADATA")
  } finally {
    app.render.renderer.destroy()
  }
})

test("refuses old or ambiguous parent candidate evidence", () => {
  const projection = reviewProjection()
  const details = {
    schemaVersion: 1,
    candidatePatchID: "candidate-01",
    candidateDigest,
    projectionDigest: projection.projectionDigest,
    baselineDigest,
    summary: "Candidate patch",
    files: [{ path: "src/index.ts", change: "modify" }],
  } as const satisfies AstraCandidatePatchDetails
  const oldEvidence = {
    ...projection,
    evidence: projection.evidence.map((evidence) => ({
      ...evidence,
      label: "candidate-patch:candidate-old",
    })),
  }
  const ambiguousEvidence = {
    ...projection,
    evidence: [
      ...projection.evidence,
      {
        ...projection.evidence.at(-1)!,
        evidenceID: "candidate-evidence-duplicate",
      },
    ],
  }

  expect(validateAstraCandidatePatchDetails(details, oldEvidence, authority)).toBeUndefined()
  expect(validateAstraCandidatePatchDetails(details, ambiguousEvidence, authority)).toBeUndefined()
})

test("opens only validated parent candidate metadata, keeps chat mounted, and Escape returns", async () => {
  const projection = reviewProjection()
  const details = {
    schemaVersion: 1,
    candidatePatchID: "candidate-01",
    candidateDigest,
    projectionDigest: projection.projectionDigest,
    baselineDigest,
    summary: "Candidate patch",
    files: [{ path: "src/index.ts", change: "modify" }],
  } as const satisfies AstraCandidatePatchDetails
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection,
    candidatePatchDetails: details,
  })
  try {
    const chat = await app.render.waitForFrame((value) => value.includes("REVIEW READY"))
    expect(chat).toContain("CONVERSATION")
    expect(app.catalogCalls()).toBe(1)

    app.dispatch("astra.review.toggle")
    const review = await app.render.waitForFrame((value) => value.includes("METADATA ONLY · PATCH CONTENT UNAVAILABLE"))
    expect(review).toContain("candidate-01")
    expect(review).toContain(candidateDigest)
    expect(review).toContain("src/index.ts · MODIFY")
    expect(review).not.toContain("Apply")
    expect(review).not.toContain("Approve patch")

    app.dispatch("astra.chat.reset")
    expect(app.catalogCalls()).toBe(1)
    app.dispatch("astra.review.close")
    const returned = await app.render.waitForFrame((value) => value.includes("CONVERSATION"))
    expect(returned).not.toContain("METADATA ONLY · PATCH CONTENT UNAVAILABLE")
    expect(app.catalogCalls()).toBe(1)
  } finally {
    app.render.renderer.destroy()
  }
})

test("a dialog blocks Review Mode so an in-progress draft is not displaced", async () => {
  const projection = reviewProjection()
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection,
    dialogOpen: true,
    candidatePatchDetails: {
      schemaVersion: 1,
      candidatePatchID: "candidate-01",
      candidateDigest,
      projectionDigest: projection.projectionDigest,
      baselineDigest,
      summary: "Candidate patch",
      files: [{ path: "src/index.ts", change: "modify" }],
    },
  })
  try {
    await app.render.waitForFrame((value) => value.includes("CONVERSATION"))
    app.dispatch("astra.review.toggle")
    await app.render.renderOnce()
    expect(app.render.captureCharFrame()).toContain("CONVERSATION")
    expect(app.render.captureCharFrame()).not.toContain("METADATA ONLY · PATCH CONTENT UNAVAILABLE")
  } finally {
    app.render.renderer.destroy()
  }
})

test("reduced motion keeps the working Lynx pose stable", async () => {
  const app = await renderCockpit({
    width: 140,
    height: 34,
    projection: workingProjection(),
    animations: false,
  })
  try {
    const first = await app.render.waitForFrame((value) => value.includes("Blocked"))
    await Bun.sleep(260)
    await app.render.renderOnce()
    expect(lineWith(app.render.captureCharFrame(), "⌨")).toBe(lineWith(first, "⌨"))
  } finally {
    app.render.renderer.destroy()
  }
})

type RenderOptions = Readonly<{
  width: number
  height: number
  projection: AstraWorkSessionProjection
  streamView?: AstraWorkSessionView
  candidatePatchDetails?: unknown
  dialogOpen?: boolean
  animations?: boolean
}>

async function renderCockpit(options: RenderOptions) {
  const directory = await tmpdir()
  const stateDirectory = path.join(directory.path, "state")
  await mkdir(stateDirectory, { recursive: true })
  await Bun.write(
    path.join(stateDirectory, "kv.json"),
    JSON.stringify({ animations_enabled: options.animations ?? true }),
  )
  const decisions: Array<Readonly<{ decisionID: string; outcome: "approved" | "rejected" }>> = []
  let dispatch = (_command: string) => undefined
  let catalogCalls = 0
  const providerClient = {
    catalog() {
      catalogCalls += 1
      return Promise.resolve(catalogResult)
    },
    prepare: () => Promise.reject(new Error("No prompt expected")),
    decide: () => Promise.reject(new Error("No provider decision expected")),
    dispose() {},
  } satisfies AstraProviderClient
  const workSessionClient = createWorkSessionClient(options.projection, options.streamView, decisions)

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const base = createTuiPluginApi({ keymap })
    const [dialog] = createSignal<JSX.Element>()
    const api = {
      ...base,
      ui: {
        ...base.ui,
        dialog: { ...base.ui.dialog, open: options.dialogOpen ?? false },
      },
    } satisfies TuiPluginApi
    dispatch = (command) => void keymap.dispatchCommand(command)
    return (
      <TestTuiContexts directory={authority.workspace.root} paths={{ state: stateDirectory }}>
        <TuiConfigProvider
          config={createTuiResolvedConfig({
            keybinds: {
              astra_control_toggle: "none",
              astra_review_toggle: "none",
            },
          })}
        >
          <KVProvider>
            <ThemeProvider mode="dark">
              <OpencodeKeymapProvider keymap={keymap}>
                <ErrorBoundary fallback={(error) => <text>{`TEST ERROR ${String(error)}`}</text>}>
                  <AstraCockpit
                    api={api}
                    authority={authority}
                    providerClient={providerClient}
                    workSessionClient={workSessionClient}
                    candidatePatchDetails={options.candidatePatchDetails}
                  />
                </ErrorBoundary>
                {dialog()}
              </OpencodeKeymapProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    )
  }

  const render = await testRender(() => <Harness />, {
    width: options.width,
    height: options.height,
  })
  await render.renderOnce()
  await Bun.sleep(25)
  await render.renderOnce()
  if (render.captureCharFrame().includes("TEST ERROR")) throw new Error(render.captureCharFrame())
  return {
    render,
    dispatch: (command: string) => dispatch(command),
    decisions,
    catalogCalls: () => catalogCalls,
  }
}

function createWorkSessionClient(
  projection: AstraWorkSessionProjection,
  streamView: AstraWorkSessionView | undefined,
  decisions: Array<Readonly<{ decisionID: string; outcome: "approved" | "rejected" }>>,
): AstraWorkSessionClient {
  const available = {
    status: "available",
    projection,
    cursor: cursorForAstraWorkSessionProjection(projection),
  } as const
  return {
    snapshot: () => Promise.resolve(available),
    subscribe: async (consumer, options) => {
      await consumer(streamView ?? available)
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      )
    },
    decide: async (decisionID, outcome) => {
      decisions.push({ decisionID, outcome })
      return {
        schemaVersion: 1,
        type: "work-session.terminal",
        requestId: "10000000-0000-4000-8000-000000000001",
        status: "request_complete",
      }
    },
    cancel: async () => ({
      schemaVersion: 1,
      type: "work-session.terminal",
      requestId: "10000000-0000-4000-8000-000000000001",
      status: "request_complete",
    }),
    dispose() {},
  }
}

function workingProjection() {
  return advance(
    advance(
      advance(
        advance(
          advance(initialProjection(), {
            type: "phase.changed",
            payload: { phase: "analyzing" },
          }),
          { type: "phase.changed", payload: { phase: "working" } },
        ),
        {
          type: "agent.added",
          payload: {
            agent: agent("parent", null, "Lynx coordinator", "working", "Coordinating the task"),
          },
        },
      ),
      {
        type: "agent.added",
        payload: {
          agent: agent("tui", "parent", "TUI worker", "failed", "Renderer test failed"),
        },
      },
    ),
    {
      type: "agent.added",
      payload: {
        agent: agent("git", "parent", "Git observer", "lost", "Connection lost"),
      },
    },
    {
      type: "evidence.recorded",
      payload: {
        evidence: {
          evidenceID: "tests-12",
          kind: "test",
          label: "tests",
          value: "12 passed",
          assurance: "OBSERVED · NOT VERIFIED",
        },
      },
    },
  )
}

function decisionProjection() {
  return advance(
    advance(workingProjection(), {
      type: "decision.requested",
      payload: {
        decision: {
          decisionID: "decision-write",
          kind: "file-write",
          summary: "Write src/index.ts",
          resources: ["workspace:file:src/index.ts"],
          boundary: "host/filesystem",
        },
      },
    }),
    {
      type: "decision.requested",
      payload: {
        decision: {
          decisionID: "decision-other",
          kind: "provider-egress",
          summary: "Send bounded prompt",
          resources: ["network:https://api.anthropic.com"],
          boundary: "host/network",
        },
      },
    },
  )
}

function reconciliationProjection() {
  return advance(workingProjection(), {
    type: "effect.ambiguous",
    payload: {
      operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670431",
      summary: "EFFECT OUTCOME UNKNOWN",
    },
  })
}

function reviewProjection() {
  return advance(workingProjection(), {
    type: "candidate-patch.recorded",
    payload: {
      candidatePatchID: "candidate-01",
      evidence: {
        evidenceID: "candidate-evidence",
        kind: "receipt",
        label: "candidate-patch:candidate-01",
        value: candidateDigest,
        assurance: "CANDIDATE OBSERVED · NOT APPLIED",
      },
    },
  })
}

function initialProjection() {
  const event = createAstraWorkSessionEvent({
    sessionID: authority.sessionID,
    workspaceRoot: authority.workspace.root,
    workspaceIdentity: authority.workspace.identity,
    objective: "Implement the governed change",
    intent: {
      summary: "Implement the governed change",
      next: "Review the parent-owned state",
    },
    observedAt: "2026-07-20T10:00:00.000Z",
    actor,
  })
  if (!event.ok) throw new Error("initial event fixture must be valid")
  const projection = projectAstraWorkSessionEvent(null, event.value)
  if (!projection.ok) throw new Error("initial projection fixture must be valid")
  return projection.value
}

function advance(projection: AstraWorkSessionProjection, ...drafts: ReadonlyArray<AstraWorkSessionEventDraft>) {
  return drafts.reduce((current, draft) => {
    const event = makeAstraWorkSessionEvent(current, {
      observedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
      actor,
      draft,
    })
    if (!event.ok) throw new Error(`event fixture must be valid: ${draft.type}`)
    const next = projectAstraWorkSessionEvent(current, event.value)
    if (!next.ok) throw new Error(`projection fixture must be valid: ${draft.type}`)
    return next.value
  }, projection)
}

function agent(
  agentID: string,
  parentAgentID: string | null,
  label: string,
  state: "working" | "failed" | "lost",
  activity: string,
) {
  return {
    agentID,
    parentAgentID,
    label,
    task: label,
    activity,
    state,
    effectAuthority: "none" as const,
  }
}

function lineWith(frame: string, value: string) {
  return frame.split("\n").find((line) => line.includes(value)) ?? ""
}

function lastContentLine(frame: string) {
  return (
    frame
      .split("\n")
      .filter((line) => line.trim())
      .at(-1) ?? ""
  )
}

const actor = { kind: "system", actorID: "astra-parent" } as const
const digest = `sha256:${"a".repeat(64)}` as const
const baselineDigest = `sha256:${"b".repeat(64)}` as const
const candidateDigest = `sha256:${"c".repeat(64)}` as const
const authority = {
  schemaVersion: 1,
  sessionID: "00000000-0000-4000-8000-000000000001",
  issuedAt: "2026-07-19T18:00:00.000Z",
  mode: "activate-once",
  effectPolicy: "deny",
  workspace: {
    root: "/tmp/astra-cockpit-ui",
    identity: { device: "1", inode: "2" },
    securityDigest: digest,
  },
  repositoryBaseline: {
    head: {
      kind: "symbolic",
      symbolicRef: "refs/heads/astra-cockpit",
      oid: "a".repeat(40),
    },
    snapshotDigest: baselineDigest,
  },
} as unknown as AstraSessionAuthority

const catalogResult = {
  schemaVersion: 1,
  requestId: "10000000-0000-4000-8000-000000000001",
  status: "available",
  catalog: {
    providers: [
      {
        providerID: "anthropic",
        providerName: "Anthropic",
        assurance: "CERTIFIED",
        dispatchable: true,
        credentialProfiles: ["anthropic-api-key"],
        models: [
          {
            id: "claude-sonnet",
            name: "Claude Sonnet",
            limits: { context: 200_000, output: 8_192 },
          },
        ],
      },
    ],
  },
  transcript: {
    turns: [],
    historyDigest: `sha256:${"0".repeat(64)}`,
    totalBytes: 0,
    retention: "PARENT-OWNED DURABLE — VERIFIED ON LOAD",
  },
} as const
