import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseExecutionCapability } from "@astra/domain/execution-capability"
import { createControlledWritePlan, demoMarkerName } from "../src/controlled-write-plan"
import { proposeControlledWriteCapability } from "../src/controlled-write-capability"
import { scanWorkspace } from "../src/workspace-preflight"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("controlled write capability proposal", () => {
  test("binds the exact source executable, worker, input, workspace, target, and limits without effects", async () => {
    const root = await temporaryDirectory("astra-capability-workspace-")
    await writeFile(join(root, "package.json"), "{}\n")
    const report = await scanWorkspace(root)
    const plan = createControlledWritePlan(root, "0196e4cb-5d80-7b1d-8fb2-263b81670431", "2026-07-17T17:00:00.000Z")
    const before = await readdir(root)

    const proposal = await proposeControlledWriteCapability({
      plan,
      report,
      policyAskedAt: "2026-07-17T17:00:01.000Z",
    })

    expect(parseExecutionCapability(proposal.capability)).toEqual({ ok: true, value: proposal.capability })
    expect(proposal.capability.manifest).toMatchObject({
      grant: {
        operationID: plan.operationId,
        baselineDigest: report.securityDigest,
        expiresAt: "2026-07-17T17:05:01.000Z",
      },
      isolation: { platform: "darwin", backend: "host", fallback: "deny" },
      process: {
        arguments: ["--no-install", "--no-env-file", "--config=/dev/null", "--eval", proposal.program],
        workingDirectory: "/",
        stdinDigest: proposal.capability.manifest.process.stdinDigest,
      },
      filesystem: {
        workspace: { canonicalPath: root, ...report.identity },
        runtimeScratch: {
          canonicalPath: join(
            homedir(),
            "Library",
            "Application Support",
            "Astra",
            "Runtime",
            proposal.capability.manifest.grant.capabilityGrantID,
          ),
          lifecycle: "private_ephemeral",
        },
        readOnlyRoots: [root],
        createOnlyFiles: [join(root, demoMarkerName)],
        writableFiles: [],
      },
      network: { mode: "host_unrestricted" },
      environment: {
        variables: [
          { name: "LANG", value: "C" },
          { name: "LC_ALL", value: "C" },
          { name: "TZ", value: "UTC" },
        ],
      },
      limits: { timeoutMs: 5_000, maxStdoutBytes: 16_384, maxStderrBytes: 16_384 },
    })
    expect(proposal.stdin).toContain(Buffer.from(plan.content).toString("base64"))
    expect(proposal.capability.manifest.process.executable.canonicalPath).toBe(await realpath(process.execPath))
    expect(await readdir(root)).toEqual(before)
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{}\n")
  })

  test("changes the capability digest when any effect-bearing input changes", async () => {
    const root = await temporaryDirectory("astra-capability-binding-")
    await writeFile(join(root, "package.json"), "{}\n")
    const report = await scanWorkspace(root)
    const first = await proposeControlledWriteCapability({
      plan: createControlledWritePlan(root, "0196e4cb-5d80-7b1d-8fb2-263b81670431", "2026-07-17T17:00:00.000Z"),
      report,
      policyAskedAt: "2026-07-17T17:00:01.000Z",
    })
    const second = await proposeControlledWriteCapability({
      plan: createControlledWritePlan(root, "0196e4cb-5d80-7b1d-8fb2-263b81670432", "2026-07-17T17:00:00.000Z"),
      report,
      policyAskedAt: "2026-07-17T17:00:01.000Z",
    })

    expect(second.capability.capabilityDigest).not.toBe(first.capability.capabilityDigest)
    expect(second.capability.manifest.process.stdinDigest).not.toBe(first.capability.manifest.process.stdinDigest)
  })
})

async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}
