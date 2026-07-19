import { describe, expect, test } from "bun:test"

describe("Git capability boundary", () => {
  test("exports only bounded inspection, baseline, stage, unstage, and commit surfaces", async () => {
    const api = await import("../src")

    expect(Object.keys(api).sort()).toEqual([
      "GitEphemeralCleanupError",
      "buildGitUnstageAllInvocation",
      "captureGitRepositoryBaseline",
      "captureGitStageInventory",
      "defaultGitInspectionLimits",
      "defaultGitRepositoryBaselineLimits",
      "executeClaimedGitStageSelected",
      "executeClaimedGitUnstageAll",
      "executeGitCommitLocal",
      "executeGitStageSelected",
      "executeGitUnstageAll",
      "inspectGitWorkspace",
      "prepareGitCommitLocal",
      "prepareGitStageSelected",
      "prepareGitUnstageAll",
      "revalidateGitRepositoryBaseline",
      "verifyGitCommitLocal",
      "verifyGitStageSelected",
      "verifyGitUnstageAll",
    ])
  })

  test("bundles without OpenCode or write-capable Astra runtimes", async () => {
    const build = await Bun.build({
      entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
      target: "bun",
      minify: false,
    })

    expect(build.success).toBeTrue()
    const output = await build.outputs[0]!.text()
    expect(output).not.toContain("@opencode")
    expect(output).not.toContain("@astra/runtime")
    expect(output).not.toContain("@astra/executor")
    expect(output).not.toContain("@astra/ledger")
  })
})
