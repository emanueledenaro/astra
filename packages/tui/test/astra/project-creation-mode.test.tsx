/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { readFile } from "node:fs/promises"
import {
  AstraProjectCreationDetailsMode,
  AstraProjectCreationOperationMode,
  AstraProjectCreationResultMode,
  AstraProjectCreationReviewMode,
} from "../../src/astra/project-creation-mode"

const proposal = {
  schemaVersion: 1,
  boundary: "HOST EXECUTION — NO SANDBOX",
  targetPath: "/Users/developer/Projects/alpha-tool",
  targetName: "alpha-tool",
  objective: "Create a predictable tool.",
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

const observed = {
  schemaVersion: 1,
  status: "effect_observed",
  targetPath: proposal.targetPath,
  operationID: "6c7535da-29a5-4c29-a5f7-52f1de9d8771",
  receiptID: "8d36420e-5417-4adb-8ed2-bc445a8f0974",
  evidenceID: null,
  detail: "The effect was observed and has not been independently verified.",
} as const

test("collects name, absolute parent, and objective as one typed intent", async () => {
  const decisions: Array<unknown> = []
  const app = await testRender(
    () => <AstraProjectCreationDetailsMode onDecision={(decision) => decisions.push(decision)} />,
    { width: 88, height: 24 },
  )
  try {
    await app.renderOnce()
    const initial = app.captureCharFrame().replace(/\s+/g, " ")
    expect(initial).toContain("DETAILS > PROPOSAL > APPROVAL > OPERATION >")
    expect(initial).toContain("RESULT")
    expect(app.captureCharFrame()).toContain("Project name")

    for (const key of "alpha-tool") app.mockInput.pressKey(key)
    app.mockInput.pressKey("\r")
    for (const key of "/Users/developer/Projects") app.mockInput.pressKey(key)
    app.mockInput.pressKey("\r")
    for (const key of "Create a predictable tool.") app.mockInput.pressKey(key)
    app.mockInput.pressKey("\r")

    expect(decisions).toEqual([
      {
        kind: "submit",
        request: {
          name: "alpha-tool",
          parentPath: "/Users/developer/Projects",
          objective: "Create a predictable tool.",
          stack: "typescript-bun",
        },
      },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("keeps invalid details local and cancellation pure", async () => {
  const decisions: Array<unknown> = []
  const app = await testRender(
    () => <AstraProjectCreationDetailsMode onDecision={(decision) => decisions.push(decision)} />,
    { width: 72, height: 18 },
  )
  try {
    for (const key of "../bad") app.mockInput.pressKey(key)
    app.mockInput.pressKey("\r")
    expect(decisions).toEqual([])
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Use lowercase letters")
    app.mockInput.pressKey("Q")
    expect(decisions).toEqual([{ kind: "cancel" }])
  } finally {
    app.renderer.destroy()
  }
})

test("accepts lowercase q as project input while uppercase Q remains cancel", async () => {
  const decisions: Array<unknown> = []
  const app = await testRender(
    () => <AstraProjectCreationDetailsMode onDecision={(decision) => decisions.push(decision)} />,
  )
  try {
    app.mockInput.pressKey("q")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("q")
    expect(decisions).toEqual([])
    app.mockInput.pressKey("Q")
    expect(decisions).toEqual([{ kind: "cancel" }])
  } finally {
    app.renderer.destroy()
  }
})

test("renders exact proposal resources and excluded effects in wide and compact terminals", async () => {
  for (const dimensions of [{ width: 100, height: 28 }, { width: 48, height: 16 }]) {
    const app = await testRender(
      () => <AstraProjectCreationReviewMode proposal={proposal} onDecision={() => {}} />,
      dimensions,
    )
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame().replace(/\s+/g, " ")
      expect(frame).toContain("PROPOSAL > APPROVAL")
      expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
      expect(frame).toContain("README.md")
      expect(frame).toContain("21 bytes")
      expect(frame).toContain("No install · No network")
      expect(frame).toContain("Git: separate")
      expect(frame).toContain("step")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("returns review decisions bound to the rendered proposal", async () => {
  const decisions: Array<unknown> = []
  const app = await testRender(
    () => <AstraProjectCreationReviewMode proposal={proposal} onDecision={(decision) => decisions.push(decision)} />,
  )
  try {
    app.mockInput.pressKey("a")
    app.mockInput.pressKey("r")
    expect(decisions).toEqual([
      { kind: "approve", proposalDigest: proposal.proposalDigest },
      { kind: "reject", proposalDigest: proposal.proposalDigest },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("keeps operation state visible without offering input", async () => {
  const app = await testRender(() => <AstraProjectCreationOperationMode proposal={proposal} />, {
    width: 72,
    height: 18,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("OPERATION")
    expect(frame).toContain("RUNNING")
    expect(frame).toContain("HOST EXECUTION — NO SANDBOX")
    expect(frame).toContain("/Users/developer/Projects/")
    expect(frame).toContain("alpha-tool")
  } finally {
    app.renderer.destroy()
  }
})

test("never offers Open for observed-only results and offers it for exact verification", async () => {
  const observedDecisions: Array<unknown> = []
  const observedApp = await testRender(
    () => <AstraProjectCreationResultMode result={observed} onDecision={(decision) => observedDecisions.push(decision)} />,
  )
  try {
    await observedApp.renderOnce()
    expect(observedApp.captureCharFrame()).toContain("OBSERVED — NOT VERIFIED")
    expect(observedApp.captureCharFrame()).not.toContain("Open project")
    observedApp.mockInput.pressKey("o")
    expect(observedDecisions).toEqual([])
  } finally {
    observedApp.renderer.destroy()
  }

  const verified = {
    ...observed,
    status: "verified",
    evidenceID: "6c4b0a1a-231a-4a17-b366-b0a2358c090d",
    detail: "The exact project tree matched independent evidence.",
  } as const
  const verifiedDecisions: Array<unknown> = []
  const verifiedApp = await testRender(
    () => <AstraProjectCreationResultMode result={verified} onDecision={(decision) => verifiedDecisions.push(decision)} />,
  )
  try {
    await verifiedApp.renderOnce()
    expect(verifiedApp.captureCharFrame()).toContain("VERIFIED")
    expect(verifiedApp.captureCharFrame()).toContain("Open project")
    verifiedApp.mockInput.pressKey("o")
    expect(verifiedDecisions).toEqual([{ kind: "open-project", targetPath: proposal.targetPath }])
  } finally {
    verifiedApp.renderer.destroy()
  }
})

test("keeps every project creation renderer import graph inert", async () => {
  const source = await readFile(new URL("../../src/astra/project-creation-mode.tsx", import.meta.url), "utf8")
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])

  expect(imports).toEqual([
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "@astra/domain/project-creation-ui",
    "../component/lynx-model",
  ])
  expect(source).not.toMatch(/process\.|Bun\.|node:|@astra\/runtime|ledger|fetch\(|spawn\(|cwd\(|env\b/)
})

test("fails closed instead of rendering hostile terminal controls or raw content", async () => {
  const hostile = {
    ...proposal,
    files: [{ ...proposal.files[0], content: "SAFE\u009b31mSPOOF" }],
  }
  const app = await testRender(() => <AstraProjectCreationReviewMode proposal={hostile} onDecision={() => {}} />)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Project creation data unavailable")
    expect(frame).not.toContain("SPOOF")
  } finally {
    app.renderer.destroy()
  }
})
