import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: Array<string> = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("real Astra CLI", () => {
  test("starts the real entrypoint and opens a workspace read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-real-cli-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), "{}\n")

    const child = Bun.spawn([process.execPath, "src/index.ts", "open", root, "--decision", "read-only"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("ASTRA // WORKSPACE GATE")
    expect(stdout).toContain("AWAITING_DECISION")
    expect(stdout).toContain("READ ONLY")
    expect(stdout).not.toContain("HOST EXECUTION")
  })
})
