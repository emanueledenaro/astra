import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const packageRoot = new URL("..", import.meta.url).pathname
const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })))
})

describe("preflight negative-capability boundary", () => {
  test("imports only the explicit static-read graph", async () => {
    const source = await Bun.file(new URL("../src/workspace-preflight.ts", import.meta.url)).text()
    const imports = [...source.matchAll(/from "([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined)

    expect(imports.toSorted((left, right) => left.localeCompare(right))).toEqual(
      ["@astra/domain/workspace-trust", "node:crypto", "node:fs/promises", "node:path"].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    )
    for (const token of [
      "import(",
      "Bun.spawn",
      "Bun.$",
      "fetch(",
      "process.env",
      "writeFile(",
      "mkdir(",
      "rm(",
      "unlink(",
      "rename(",
    ]) {
      expect(source).not.toContain(token)
    }
  })

  test("bundles without OpenCode or privileged runtime surfaces", async () => {
    const temporary = await mkdtemp(join(packageRoot, ".preflight-boundary-"))
    temporaryDirectories.push(temporary)
    const metafile = join(temporary, "meta.json")
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        "src/workspace-preflight.ts",
        "--target=bun",
        "--format=esm",
        "--packages=bundle",
        `--metafile=${metafile}`,
        `--outdir=${join(temporary, "out")}`,
      ],
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)

    const metadata: unknown = await Bun.file(metafile).json()
    if (!hasObjectInputs(metadata)) throw new Error("Bun build metafile has no input map")
    const inputs = Object.keys(metadata.inputs).join("\n").toLowerCase()
    for (const forbidden of [
      "/packages/opencode/",
      "/plugin/",
      "/mcp/",
      "/lsp/",
      "/provider/",
      "/format/",
      "child_process",
      "node:net",
      "node:dns",
      "node:http",
      "node:https",
      "node:tls",
      "node:dgram",
      "ffi",
    ]) {
      expect(inputs).not.toContain(forbidden)
    }
    expect(inputs).toContain("workspace-preflight.ts")
    expect(inputs).not.toContain("workspace-trust.ts")
  })
})

function hasObjectInputs(value: unknown): value is { inputs: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || !("inputs" in value)) return false
  return typeof value.inputs === "object" && value.inputs !== null
}
