import { describe, expect, test } from "bun:test"
import {
  makeProjectCreationPreview,
  projectCreationLimits,
  sealProjectParentAuthority,
  type ProjectParentAuthority,
} from "@astra/domain/project-creation-control"
import { makeProjectScaffoldOperationFacts, type DurableProjectScaffoldInput } from "@astra/runtime"
import type { ProjectParentAuthorityCaptureResult } from "@astra/runtime/project-parent-authority"
import {
  createGuidedProjectCreationControlInternal,
  createTypeScriptBunProjectDraft,
  projectProjectCreationProposal,
} from "../src/project-creation-control"

const request = {
  name: "alpha-tool",
  parentPath: "/Users/developer/Projects",
  objective: "Create a predictable local TypeScript tool.",
  stack: "typescript-bun",
} as const

const authority = makeAuthority()

describe("guided project creation parent control", () => {
  test("builds one useful dependency-free trusted Bun template", () => {
    const draft = createTypeScriptBunProjectDraft(request)

    expect(draft).toEqual({
      name: "alpha-tool",
      parentPath: request.parentPath,
      objective: request.objective,
      stack: "typescript-bun",
      files: [
        {
          path: "README.md",
          content: "# alpha-tool\n\nCreate a predictable local TypeScript tool.\n\nBuilt with Astra using the typescript-bun template.\n",
        },
        { path: ".gitignore", content: "node_modules/\n.env\n" },
        {
          path: "package.json",
          content: '{\n  "name": "alpha-tool",\n  "private": true,\n  "type": "module"\n}\n',
        },
        {
          path: "tsconfig.json",
          content: '{\n  "compilerOptions": {\n    "strict": true,\n    "target": "ESNext",\n    "module": "Preserve",\n    "moduleResolution": "bundler",\n    "noEmit": true\n  },\n  "include": [\n    "src"\n  ]\n}\n',
        },
        { path: "src/index.ts", content: 'export const projectName = "alpha-tool"\n' },
      ],
      initializeGit: false,
    })
    expect(JSON.parse(draft.files.find((file) => file.path === "package.json")!.content)).toEqual({
      name: "alpha-tool",
      private: true,
      type: "module",
    })
  })

  test("projects only a preview cryptographically bound to the exact trusted draft", () => {
    const draft = createTypeScriptBunProjectDraft(request)
    const preview = makeProjectCreationPreview(
      authority,
      draft,
      "2026-07-20T10:16:00.000Z",
      "0123456789abcdef0123456789abcdef",
      "2026-07-20T10:26:00.000Z",
    )

    expect(projectProjectCreationProposal(authority, draft, preview)).toMatchObject({
      targetPath: authority.targetPath,
      targetName: request.name,
      stack: "typescript-bun",
      files: preview.files,
      initializeGit: false,
      installsDependencies: false,
      usesNetwork: false,
      proposalDigest: preview.proposalDigest,
    })
    expect(() =>
      projectProjectCreationProposal(authority, { ...draft, objective: "changed" }, preview),
    ).toThrow("not bound")
  })

  test("cancels before authority capture with no coordinator, progress, or result effect", async () => {
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, { details: { kind: "cancel" } }),
    )

    expect(await control.run()).toEqual({ kind: "launchpad" })
    expect(calls).toEqual(["details"])
  })

  test("rejects accessor-backed details without observing the accessor", async () => {
    let reads = 0
    const hostile = Object.defineProperty({ kind: "submit" }, "request", {
      enumerable: true,
      get() {
        reads += 1
        return request
      },
    })
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(dependencies(calls, { details: hostile }))

    expect(await control.run()).toEqual({ kind: "failed", exitCode: 1 })
    expect(reads).toBe(0)
    expect(calls).toEqual(["details"])
  })

  test("blocks an existing or stale target before preview, dispatch, and progress", async () => {
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, { capture: { status: "blocked", reason: "target_already_exists" } }),
    )

    expect(await control.run()).toEqual({ kind: "launchpad" })
    expect(calls).toEqual(["details", "capture", "result"])
  })

  test("routes rejection exactly once through the coordinator and reports no effect", async () => {
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, { review: (proposal) => ({ kind: "reject", proposalDigest: proposal.proposalDigest }) }),
    )

    expect(await control.run()).toEqual({ kind: "launchpad" })
    expect(calls).toEqual(["details", "capture", "review", "execute:rejected", "result"])
  })

  test("approves once, verifies exact evidence, accepts real v8 IDs, and opens only the existing Gate path", async () => {
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, {
        review: (proposal) => ({ kind: "approve", proposalDigest: proposal.proposalDigest }),
        result: (result) => ({ kind: "open-project", targetPath: result.targetPath }),
      }),
    )

    expect(await control.run()).toEqual({ kind: "open-workspace", path: authority.targetPath })
    expect(calls).toEqual([
      "details",
      "capture",
      "review",
      "progress:open",
      "execute:approved",
      "progress:effect_observed",
      "progress:verifying",
      "verify",
      "progress:close",
      "result",
    ])
  })

  test("keeps dispatch and verification authority in the CLI parent and sends only typed snapshots to the TUI", async () => {
    const calls: Array<string> = []
    const snapshots: Array<unknown> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, {
        review: (proposal) => ({ kind: "approve", proposalDigest: proposal.proposalDigest }),
        progress: (snapshot) => snapshots.push(snapshot),
      }),
    )

    expect(await control.run()).toEqual({ kind: "launchpad" })
    expect(calls.indexOf("execute:approved")).toBeGreaterThan(calls.indexOf("progress:open"))
    expect(calls.indexOf("verify")).toBeGreaterThan(calls.indexOf("progress:verifying"))
    expect(snapshots.map((snapshot) => (snapshot as { state: string }).state)).toEqual([
      "dispatching",
      "effect_observed",
      "verifying",
    ])
    expect(snapshots.some(containsFunction)).toBe(false)
  })

  test("preserves deterministic expected IDs when dispatch response is missing", async () => {
    const calls: Array<string> = []
    let dispatched: DurableProjectScaffoldInput | null = null
    let presented: unknown = null
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, {
        review: (proposal) => ({ kind: "approve", proposalDigest: proposal.proposalDigest }),
        executeFailure: new Error("dispatch response missing"),
        input: (value) => { dispatched = value },
        presented: (value) => { presented = value },
      }),
    )

    expect(await control.run()).toEqual({ kind: "launchpad" })
    if (!dispatched) throw new Error("Expected the parent to dispatch")
    const facts = makeProjectScaffoldOperationFacts(dispatched)
    expect(presented).toMatchObject({
      status: "reconciliation_required",
      operationID: facts.operationID,
      expectedReceiptID: facts.receiptID,
      observedReceiptID: null,
      evidenceID: null,
    })
    expect(calls).toEqual([
      "details",
      "capture",
      "review",
      "progress:open",
      "execute:approved",
      "progress:close",
      "result",
    ])
  })

  test("distinguishes an observed receipt from missing verification evidence", async () => {
    const calls: Array<string> = []
    let presented: unknown = null
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, {
        review: (proposal) => ({ kind: "approve", proposalDigest: proposal.proposalDigest }),
        verifyFailure: new Error("verification interrupted"),
        presented: (value) => { presented = value },
      }),
    )

    expect(await control.run()).toEqual({ kind: "launchpad" })
    expect(presented).toMatchObject({
      status: "reconciliation_required",
      evidenceID: null,
    })
    expect((presented as { operationID: unknown }).operationID).toBeString()
    expect((presented as { expectedReceiptID: unknown }).expectedReceiptID).toBeString()
    expect((presented as { observedReceiptID: unknown }).observedReceiptID).toBeString()
    expect((presented as { expectedReceiptID: string }).expectedReceiptID).toBe(
      (presented as { observedReceiptID: string }).observedReceiptID,
    )
  })

  test("does not accept Open when execution is only observed", async () => {
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, {
        review: (proposal) => ({ kind: "approve", proposalDigest: proposal.proposalDigest }),
        verifyStatus: "effect_observed",
        result: (result) => ({ kind: "open-project", targetPath: result.targetPath }),
      }),
    )

    expect(await control.run()).toEqual({ kind: "failed", exitCode: 1 })
    expect(calls).toContain("verify")
  })

  test("preserves the explicit Exit decision after a verified result", async () => {
    const calls: Array<string> = []
    const control = createGuidedProjectCreationControlInternal(
      dependencies(calls, {
        review: (proposal) => ({ kind: "approve", proposalDigest: proposal.proposalDigest }),
        result: () => ({ kind: "exit" }),
      }),
    )

    expect(await control.run()).toEqual({ kind: "exit", exitCode: 0 })
  })
})

function dependencies(
  calls: Array<string>,
  options: Readonly<{
    details?: unknown
    capture?: ProjectParentAuthorityCaptureResult
    review?: (proposal: ReturnType<typeof projectProjectCreationProposal>) => unknown
    result?: (result: Readonly<{ targetPath: string }>) => unknown
    verifyStatus?: "verified" | "effect_observed"
    executeFailure?: Error
    verifyFailure?: Error
    progress?: (snapshot: unknown) => void
    input?: (input: DurableProjectScaffoldInput) => void
    presented?: (result: unknown) => void
  }> = {},
) {
  const times = [
    "2026-07-20T10:15:30.000Z",
    "2026-07-20T10:16:00.000Z",
    "2026-07-20T10:17:00.000Z",
    "2026-07-20T10:17:30.000Z",
  ]
  let time = 0
  return {
    collectDetails: async () => {
      calls.push("details")
      return options.details ?? { kind: "submit", request }
    },
    captureAuthority: async () => {
      calls.push("capture")
      return options.capture ?? { status: "complete", authority }
    },
    reviewProposal: async (proposal: ReturnType<typeof projectProjectCreationProposal>) => {
      calls.push("review")
      return options.review?.(proposal) ?? { kind: "cancel" }
    },
    openProgress: async (progress: unknown) => {
      calls.push("progress:open")
      options.progress?.(progress)
      return {
        update(next: unknown) {
          calls.push(`progress:${(next as { state: string }).state}`)
          options.progress?.(next)
          return true
        },
        close() {
          calls.push("progress:close")
        },
      }
    },
    execute: async (input: DurableProjectScaffoldInput) => {
      calls.push(`execute:${input.decision.decision}`)
      options.input?.(input)
      if (options.executeFailure) throw options.executeFailure
      const facts = makeProjectScaffoldOperationFacts(input)
      return input.decision.decision === "rejected"
        ? {
            operationID: facts.operationID,
            state: "denied" as const,
            status: "denied_without_effect" as const,
            sequence: 0,
            lastCursor: 0,
            receiptID: null,
            evidence: null,
          }
        : {
            operationID: facts.operationID,
            state: "effect_observed" as const,
            status: "effect_observed" as const,
            sequence: 6,
            lastCursor: 6,
            receiptID: facts.receiptID,
            evidence: null,
          }
    },
    verify: async (input: DurableProjectScaffoldInput) => {
      calls.push("verify")
      if (options.verifyFailure) throw options.verifyFailure
      const facts = makeProjectScaffoldOperationFacts(input)
      return options.verifyStatus === "effect_observed"
        ? {
            operationID: facts.operationID,
            state: "effect_observed" as const,
            status: "effect_observed" as const,
            sequence: 6,
            lastCursor: 6,
            receiptID: facts.receiptID,
            evidence: null,
          }
        : {
            operationID: facts.operationID,
            state: "succeeded" as const,
            status: "verified" as const,
            sequence: 8,
            lastCursor: 8,
            receiptID: facts.receiptID,
            evidence: { evidenceID: facts.evidenceID },
          }
    },
    showResult: async (result: Readonly<{ targetPath: string }>) => {
      calls.push("result")
      options.presented?.(result)
      return options.result?.(result) ?? { kind: "launchpad" }
    },
    now: () => times[time++]!,
    nonce: () => "0123456789abcdef0123456789abcdef",
  }
}

function containsFunction(input: unknown): boolean {
  if (typeof input === "function") return true
  if (typeof input !== "object" || input === null) return false
  return Reflect.ownKeys(input).some((key) => containsFunction(Reflect.get(input, key)))
}

function makeAuthority(): ProjectParentAuthority {
  const sealed = sealProjectParentAuthority({
    schemaVersion: 1,
    parentPath: request.parentPath,
    parentIdentity: { device: "1", inode: "2" },
    targetPath: `${request.parentPath}/${request.name}`,
    targetName: request.name,
    targetState: "absent",
    observedAt: "2026-07-20T10:15:30.000Z",
    limits: projectCreationLimits,
  })
  if (!sealed.ok) throw new Error(sealed.reason)
  return sealed.value
}
