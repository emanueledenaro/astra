import { afterAll, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { demoMarkerName } from "@astra/runtime/controlled-write-plan"
import {
  runWorkspaceGate,
  type EffectApproval,
  type WorkspaceDecision,
  type WorkspaceGateIO,
} from "../src/workspace-gate"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "astra-cli-workspace-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "touch must-not-run" } }))
  return root
}

function scriptedIO(decision: WorkspaceDecision, approval: EffectApproval = "deny", onDecision?: () => Promise<void>) {
  const lines: Array<string> = []
  const io: WorkspaceGateIO = {
    write: (line) => lines.push(line),
    async chooseWorkspaceDecision() {
      await onDecision?.()
      return decision
    },
    async approveControlledWrite() {
      return approval
    },
  }
  return { io, lines }
}

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

describe("workspace gate", () => {
  test("opens read-only without trust persistence or workspace effects", async () => {
    const root = await workspace()
    const before = await readdir(root)
    const terminal = scriptedIO("read-only")
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: null })
    expect(await readdir(root)).toEqual(before)
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("READ ONLY")
    expect(terminal.lines.join("\n")).not.toContain("HOST EXECUTION")
  })

  test("exits without creating trust or proposing an effect", async () => {
    const root = await workspace()
    const terminal = scriptedIO("exit")
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: null })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("no trust stored • no effect dispatched")
  })

  test("denies the controlled effect before dispatch and produces no marker", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "deny")
    const recorded: Array<string> = []
    const result = await runWorkspaceGate(root, terminal.io, {
      async recordDeniedOperation({ plan }) {
        recorded.push(plan.operationId)
        return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 9 }
      },
    })
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: "denied" })
    expect(recorded).toHaveLength(1)
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(output).toContain("HOST EXECUTION — NO SANDBOX")
    expect(output).toContain("PLANNING")
    expect(output).toContain("AWAITING_APPROVAL")
    expect(output).toContain("DENIED     no dispatch • no host effect")
    expect(output).toContain("LEDGER     durable • sequence 3 • cursor 9")
    expect(output).not.toContain("DISPATCHING")
    expect(output).not.toContain("EFFECT OBSERVED")
    expect(output).not.toContain("VERIFIED   demo marker")
  })

  test("fails closed when a denial cannot be recorded durably", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "deny")
    const result = await runWorkspaceGate(root, terminal.io, {
      async recordDeniedOperation() {
        throw new Error("Git baseline unavailable")
      },
    })

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: "denied" })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain(
      "LEDGER     DENIAL NOT CONFIRMED DURABLE • durable Operation state is unavailable",
    )
    expect(terminal.lines.join("\n")).not.toContain("DISPATCHING")
  })

  test("rejects a durable projection for another Operation", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "deny")
    const result = await runWorkspaceGate(root, terminal.io, {
      async recordDeniedOperation() {
        return {
          operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670499",
          state: "denied",
          sequence: 3,
          lastCursor: 3,
        }
      },
    })

    expect(result).toMatchObject({ exitCode: 2, operationState: "denied" })
    expect(terminal.lines.join("\n")).toContain("LEDGER     DENIAL NOT CONFIRMED DURABLE")
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
  })

  test("does not request denial recording for read-only, exit, or approval", async () => {
    for (const [decision, approval] of [
      ["read-only", "deny"],
      ["exit", "deny"],
      ["activate-once", "approve"],
    ] as const) {
      const root = await workspace()
      const terminal = scriptedIO(decision, approval)
      let calls = 0
      await runWorkspaceGate(root, terminal.io, {
        async recordDeniedOperation({ plan }) {
          calls += 1
          return { operationID: plan.operationId, state: "denied", sequence: 3, lastCursor: 3 }
        },
      })
      expect(calls).toBe(0)
    }
  })

  test("runs one approved create-only effect through observed and verified states", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "approve")
    const result = await runWorkspaceGate(root, terminal.io)
    const output = terminal.lines.join("\n")

    expect(result).toMatchObject({ exitCode: 0, workspaceState: "UNTRUSTED", operationState: "succeeded" })
    expect(await readFile(join(root, demoMarkerName), "utf8")).toContain("Astra controlled host write")
    for (const state of [
      "PLANNING",
      "AWAITING_APPROVAL",
      "READY",
      "DISPATCHING",
      "RUNNING",
      "EFFECT_OBSERVED",
      "VERIFYING",
      "VERIFIED",
    ]) {
      expect(output).toContain(state)
    }
    expect(output.indexOf("EFFECT OBSERVED — NOT VERIFIED")).toBeLessThan(
      output.indexOf("VERIFIED   demo marker matches"),
    )
    expect(output).toContain("HOST EXECUTION — NO SANDBOX")
    expect(output).toContain("demo marker matches the exact expected bytes and SHA-256")
  })

  test("invalidates activate-once when the snapshot changes after preview", async () => {
    const root = await workspace()
    const terminal = scriptedIO("activate-once", "approve", () =>
      writeFile(join(root, "AGENTS.md"), "changed after report\n"),
    )
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "STALE", operationState: null })
    expect(await exists(join(root, demoMarkerName))).toBeFalse()
    expect(terminal.lines.join("\n")).toContain("run a new preflight")
  })

  test("cancels without overwriting an existing marker or inventing stale trust", async () => {
    const root = await workspace()
    const marker = join(root, demoMarkerName)
    await writeFile(marker, "user-owned\n")
    const terminal = scriptedIO("activate-once", "approve")
    const result = await runWorkspaceGate(root, terminal.io)

    expect(result).toMatchObject({ exitCode: 2, workspaceState: "UNTRUSTED", operationState: "cancelled" })
    expect(await readFile(marker, "utf8")).toBe("user-owned\n")
    expect(terminal.lines.join("\n")).toContain("target_already_exists • no host effect")
  })

  test("loads the effect adapter dynamically only after explicit approval", async () => {
    const source = await Bun.file(new URL("../src/workspace-gate.ts", import.meta.url)).text()

    expect(source).not.toContain('from "@astra/runtime/controlled-write"')
    expect(source).toContain('await import("@astra/runtime/controlled-write")')
    expect(source.indexOf('if (approval === "deny")')).toBeLessThan(
      source.indexOf('await import("@astra/runtime/controlled-write")'),
    )
  })
})
