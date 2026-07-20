import { describe, expect, test } from "bun:test"
import {
  parseAstraProjectCreationDetailsDecision,
  parseAstraProjectCreationProposal,
  parseAstraProjectCreationProgress,
  parseAstraProjectCreationResult,
  parseAstraProjectCreationResultDecision,
  parseAstraProjectCreationReviewDecision,
} from "../src/project-creation-ui"

const request = {
  name: "alpha-tool",
  parentPath: "/Users/developer/Projects",
  objective: "Create a predictable local TypeScript tool.",
  stack: "typescript-bun",
} as const

const proposal = {
  schemaVersion: 1,
  boundary: "HOST EXECUTION — NO SANDBOX",
  targetPath: "/Users/developer/Projects/alpha-tool",
  targetName: "alpha-tool",
  objective: request.objective,
  stack: "typescript-bun",
  files: [
    {
      path: "README.md",
      bytes: 21,
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  ],
  totalBytes: 21,
  initializeGit: false,
  installsDependencies: false,
  usesNetwork: false,
  proposalDigest: `sha256:${"b".repeat(64)}`,
} as const

describe("Astra guided project creation UI protocol", () => {
  test("accepts one exact built-in request or a pure cancellation", () => {
    expect(parseAstraProjectCreationDetailsDecision({ kind: "submit", request })).toEqual({
      ok: true,
      value: { kind: "submit", request },
    })
    expect(parseAstraProjectCreationDetailsDecision({ kind: "cancel" })).toEqual({
      ok: true,
      value: { kind: "cancel" },
    })
  })

  test("rejects relative paths, unsafe names, controls, unsupported stacks, and extra fields", () => {
    for (const invalid of [
      { ...request, parentPath: "relative" },
      { ...request, name: "../alpha" },
      { ...request, name: "Alpha Tool" },
      { ...request, objective: "one\ntwo" },
      { ...request, stack: "shell" },
      { ...request, command: "curl example.invalid" },
    ]) {
      expect(parseAstraProjectCreationDetailsDecision({ kind: "submit", request: invalid }).ok).toBeFalse()
    }
  })

  test("does not invoke accessors while rejecting hostile UI input", () => {
    let reads = 0
    const hostile = Object.defineProperty({ kind: "submit" }, "request", {
      enumerable: true,
      get() {
        reads += 1
        return request
      },
    })

    expect(parseAstraProjectCreationDetailsDecision(hostile).ok).toBeFalse()
    expect(reads).toBe(0)
  })

  test("accepts exact file identities and excludes implicit effects", () => {
    expect(parseAstraProjectCreationProposal(proposal)).toEqual({ ok: true, value: proposal })
    expect(parseAstraProjectCreationProposal({ ...proposal, initializeGit: true }).ok).toBeFalse()
    expect(parseAstraProjectCreationProposal({ ...proposal, installsDependencies: true }).ok).toBeFalse()
    expect(parseAstraProjectCreationProposal({ ...proposal, usesNetwork: true }).ok).toBeFalse()
    expect(parseAstraProjectCreationProposal({ ...proposal, totalBytes: 20 }).ok).toBeFalse()
    expect(parseAstraProjectCreationProposal({ ...proposal, files: [{ ...proposal.files[0], content: "hidden" }] }).ok).toBeFalse()
  })

  test("binds review decisions to the exact proposal digest", () => {
    expect(
      parseAstraProjectCreationReviewDecision({ kind: "approve", proposalDigest: proposal.proposalDigest }),
    ).toEqual({ ok: true, value: { kind: "approve", proposalDigest: proposal.proposalDigest } })
    expect(
      parseAstraProjectCreationReviewDecision({ kind: "reject", proposalDigest: proposal.proposalDigest }),
    ).toEqual({ ok: true, value: { kind: "reject", proposalDigest: proposal.proposalDigest } })
    expect(parseAstraProjectCreationReviewDecision({ kind: "cancel" })).toEqual({
      ok: true,
      value: { kind: "cancel" },
    })
    expect(parseAstraProjectCreationReviewDecision({ kind: "approve", proposalDigest: "nope" }).ok).toBeFalse()
  })

  test("offers Open only for an exact independently verified result", () => {
    const observed = {
      schemaVersion: 1,
      status: "effect_observed",
      targetPath: proposal.targetPath,
      operationID: "6c7535da-29a5-4c29-a5f7-52f1de9d8771",
      expectedReceiptID: "8d36420e-5417-4adb-8ed2-bc445a8f0974",
      observedReceiptID: "8d36420e-5417-4adb-8ed2-bc445a8f0974",
      evidenceID: null,
      detail: "The effect was observed and has not been independently verified.",
    } as const
    const verified = {
      ...observed,
      status: "verified",
      evidenceID: "6c4b0a1a-231a-4a17-b366-b0a2358c090d",
      detail: "The exact project tree matched independent evidence.",
    } as const

    expect(parseAstraProjectCreationResult(observed)).toEqual({ ok: true, value: observed })
    expect(parseAstraProjectCreationResult(verified)).toEqual({ ok: true, value: verified })
    expect(
      parseAstraProjectCreationResultDecision(
        { kind: "open-project", targetPath: proposal.targetPath },
        observed,
      ).ok,
    ).toBeFalse()
    expect(
      parseAstraProjectCreationResultDecision(
        { kind: "open-project", targetPath: proposal.targetPath },
        verified,
      ),
    ).toEqual({ ok: true, value: { kind: "open-project", targetPath: proposal.targetPath } })
    expect(parseAstraProjectCreationResultDecision({ kind: "launchpad" }, observed)).toEqual({
      ok: true,
      value: { kind: "launchpad" },
    })
  })

  test("accepts the deterministic version-8 identifiers emitted by the Operation Kernel", () => {
    const result = {
      schemaVersion: 1,
      status: "verified",
      targetPath: proposal.targetPath,
      operationID: "6c7535da-29a5-8c29-a5f7-52f1de9d8771",
      expectedReceiptID: "8d36420e-5417-8adb-8ed2-bc445a8f0974",
      observedReceiptID: "8d36420e-5417-8adb-8ed2-bc445a8f0974",
      evidenceID: "6c4b0a1a-231a-8a17-b366-b0a2358c090d",
      detail: "The exact project tree matched independent evidence.",
    } as const

    expect(parseAstraProjectCreationResult(result)).toEqual({ ok: true, value: result })
  })

  test("parses parent-owned progress snapshots without carrying an effect callback", () => {
    const dispatching = {
      schemaVersion: 1,
      state: "dispatching",
      boundary: "HOST EXECUTION — NO SANDBOX",
      targetPath: proposal.targetPath,
      operationID: "6c7535da-29a5-8c29-a5f7-52f1de9d8771",
      expectedReceiptID: "8d36420e-5417-8adb-8ed2-bc445a8f0974",
      observedReceiptID: null,
    } as const
    const verifying = {
      ...dispatching,
      state: "verifying",
      observedReceiptID: dispatching.expectedReceiptID,
    } as const

    expect(parseAstraProjectCreationProgress(dispatching)).toEqual({ ok: true, value: dispatching })
    expect(parseAstraProjectCreationProgress(verifying)).toEqual({ ok: true, value: verifying })
    expect(parseAstraProjectCreationProgress({ ...dispatching, operation: () => "effect" }).ok).toBeFalse()
    expect(parseAstraProjectCreationProgress({ ...verifying, observedReceiptID: null }).ok).toBeFalse()
  })
})
