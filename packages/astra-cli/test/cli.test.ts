import { afterAll, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const roots: Array<string> = []
const packageRoot = new URL("..", import.meta.url).pathname

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("Astra CLI durable state", () => {
  test("read-only creates neither workspace effects nor an app-state directory", async () => {
    const root = await workspace()
    const dataDirectory = join(await temporaryDirectory("astra-cli-data-parent-"), "not-created")
    const run = await runCli(root, dataDirectory, "read-only")

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain("READ ONLY")
    expect(await exists(dataDirectory)).toBeFalse()
  })

  test("a denial is durable while the workspace remains unchanged", async () => {
    const root = await workspace()
    const dataDirectory = join(await temporaryDirectory("astra-cli-data-parent-"), "state")
    const run = await runCli(root, dataDirectory, "activate-once", "deny")
    const operationID = run.stdout.match(/OPERATION ([0-9a-f-]{36})/)?.[1]

    expect(run.exitCode).toBe(0)
    expect(operationID).toBeDefined()
    expect(run.stdout).toContain("LEDGER     durable • sequence 3 • cursor 3")
    expect(run.stdout).toContain("DENIED     no dispatch • no host effect")
    expect(await exists(join(root, ".astra-demo-marker"))).toBeFalse()
    expect(await readOperation(join(dataDirectory, "operations.sqlite"), operationID!)).toMatchObject({
      operationID,
      state: "denied",
      sequence: 3,
      lastCursor: 3,
    })
  })
})

async function workspace() {
  const root = await temporaryDirectory("astra-cli-process-workspace-")
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "touch must-not-run" } }))
  return root
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function runCli(root: string, dataDirectory: string, decision: string, approval?: string) {
  const command = [process.execPath, "src/index.ts", "open", root, "--decision", decision]
  if (approval) command.push("--approval", approval)
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env: {
      ASTRA_DATA_DIR: dataDirectory,
      HOME: join(root, "isolated-home"),
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function readOperation(filename: string, operationID: string) {
  type ReaderModule = Readonly<{
    readDurableOperation: (
      filename: string,
      operationID: string,
    ) => Promise<Readonly<{ operationID: string; state: string; sequence: number; lastCursor: number }> | null>
  }>
  const moduleName = ["@astra/runtime", "operation-ledger"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isReaderModule(loaded)) throw new Error("Astra Operation ledger reader is unavailable")
  return loaded.readDurableOperation(filename, operationID)

  function isReaderModule(value: unknown): value is ReaderModule {
    return (
      typeof value === "object" &&
      value !== null &&
      "readDurableOperation" in value &&
      typeof value.readDurableOperation === "function"
    )
  }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
