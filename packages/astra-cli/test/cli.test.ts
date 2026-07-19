import { afterAll, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const roots: Array<string> = []
const packageRoot = new URL("..", import.meta.url).pathname

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("Astra CLI durable state", () => {
  test("System Mode rejects a non-interactive terminal before creating any local state", async () => {
    const root = await hostileSystemDirectory()
    const dataDirectory = join(await temporaryDirectory("astra-system-data-parent-"), "not-created")
    const before = await directorySnapshot(root)
    const run = await runCliCommandFrom(root, dataDirectory, "system")

    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe("Astra System Mode requires an interactive terminal.\n")
    expect(await directorySnapshot(root)).toEqual(before)
    expect(await exists(dataDirectory)).toBeFalse()
  })

  test("System Mode rejects extra arguments instead of treating them as a workspace", async () => {
    const dataDirectory = join(await temporaryDirectory("astra-system-invalid-data-parent-"), "not-created")
    const runs = await Promise.all([
      runCliCommand(dataDirectory, "system", "."),
      runCliCommand(dataDirectory, "system", "--"),
    ])

    for (const run of runs) {
      expect(run.exitCode).toBe(1)
      expect(run.stderr).toContain("The `system` command does not accept arguments or flags.")
      expect(run.stdout).toContain("astra system")
    }
    expect(await exists(dataDirectory)).toBeFalse()
  })

  test("the no-argument compatibility surface still exits successfully with help", async () => {
    const dataDirectory = join(await temporaryDirectory("astra-help-data-parent-"), "not-created")
    const run = await runCliCommand(dataDirectory)

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.stdout).toContain("Usage: astra")
    expect(run.stdout).toContain("astra system")
    expect(await exists(dataDirectory)).toBeFalse()
  })

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

  test("an approval uses the durable executor and independent verifier before printing VERIFIED", async () => {
    const root = await workspace()
    const dataDirectory = join(await temporaryDirectory("astra-cli-data-parent-"), "state")
    const run = await runCli(root, dataDirectory, "activate-once", "approve")
    const operationID = run.stdout.match(/OPERATION ([0-9a-f-]{36})/)?.[1]

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe("")
    expect(operationID).toBeDefined()
    expect(await readFile(join(root, ".astra-demo-marker"), "utf8")).toContain(`operation_id=${operationID}`)
    expect(run.stdout).toContain("EFFECT OBSERVED — NOT VERIFIED")
    expect(run.stdout).toContain("VERIFIED   independent verifier matched")
    expect(run.stdout.indexOf("EFFECT OBSERVED — NOT VERIFIED")).toBeLessThan(
      run.stdout.indexOf("VERIFIED   independent verifier matched"),
    )
    expect(await readOperation(join(dataDirectory, "operations.sqlite"), operationID!)).toMatchObject({
      operationID,
      state: "succeeded",
      sequence: 8,
      lastCursor: 8,
    })
    expect(await exists(join(dataDirectory, "receipts.sqlite"))).toBeTrue()
  })

  test("a command-line decision override cannot activate a Git workspace", async () => {
    const root = await workspace()
    await mkdir(join(root, ".git"))
    const dataDirectory = join(await temporaryDirectory("astra-cli-data-parent-"), "not-created")
    const run = await runCli(root, dataDirectory, "activate-once", "approve")

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toContain("GIT META   directory • .git")
    expect(run.stdout).toContain("GIT BASELINE NOT INSPECTED")
    expect(run.stdout).toContain("READ ONLY  bounded static report remains available")
    expect(run.stdout).not.toContain("HOST EXECUTION")
    expect(await exists(join(root, ".astra-demo-marker"))).toBeFalse()
    expect(await exists(dataDirectory)).toBeFalse()
  })

  test("inspect-git explicitly runs the bounded adapter without creating app state or trust", async () => {
    const root = await gitWorkspace()
    await writeFile(join(root, "tracked.txt"), "changed\n")
    const dataDirectory = join(await temporaryDirectory("astra-cli-git-data-parent-"), "not-created")
    const run = await runCliCommand(dataDirectory, "inspect-git", root)

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.stdout).toContain("GIT MODE   bounded read-only")
    expect(run.stdout).toContain("GIT DIFF   metadata only • ephemeral • not verified")
    expect(run.stdout).toContain("DIFF BIND  sha256:")
    expect(run.stdout).toContain("UNSTAGED   tracked.txt")
    expect(run.stdout).toContain("GIT BASELINE  CAPTURING • BOUNDED READ ONLY • NOT VERIFIED")
    expect(run.stdout).toContain("GIT BASELINE  CURRENT")
    expect(run.stdout).toContain("WORKSPACE STATE  UNTRUSTED")
    expect(run.stdout).toContain("activation remains unavailable")
    expect(run.stdout).not.toContain("HOST EXECUTION")
    expect(run.stdout).not.toContain("VERIFIED   independent verifier matched")
    expect(await exists(dataDirectory)).toBeFalse()
  })

  test("a Git denial follows G then A and records no host effect", async () => {
    const root = await gitWorkspace()
    const dataDirectory = join(await temporaryDirectory("astra-cli-git-denial-data-"), "state")
    const run = await runInteractiveCli(root, dataDirectory, "DENY")

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.stdout).toContain("GIT BASELINE  CURRENT")
    expect(run.stdout).toContain("AWAITING_DECISION • Git baseline current")
    expect(run.stdout).toContain("DENIED     no dispatch • no host effect")
    expect(await exists(join(root, ".astra-demo-marker"))).toBeFalse()
  })

  test("a Git approval follows G then A through observed and independently verified state", async () => {
    const root = await gitWorkspace()
    const dataDirectory = join(await temporaryDirectory("astra-cli-git-approval-data-"), "state")
    const run = await runInteractiveCli(root, dataDirectory, "APPROVE")

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.stdout).toContain("GIT BASELINE  CURRENT")
    expect(run.stdout).toContain("HOST EXECUTION — NO SANDBOX")
    expect(run.stdout).toContain("EFFECT OBSERVED — NOT VERIFIED")
    expect(run.stdout).toContain("VERIFIED   independent verifier matched")
    expect(await readFile(join(root, ".astra-demo-marker"), "utf8")).toContain("Astra controlled host write")
  }, 20_000)
})

async function workspace() {
  const root = await temporaryDirectory("astra-cli-process-workspace-")
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "touch must-not-run" } }))
  return root
}

async function hostileSystemDirectory() {
  const root = await temporaryDirectory("astra-system-hostile-cwd-")
  await writeFile(join(root, ".env"), "ASTRA_SYSTEM_CANARY=must-not-load\n")
  await writeFile(join(root, "bunfig.toml"), 'preload = ["./must-not-run.ts"]\n')
  await writeFile(join(root, "must-not-run.ts"), 'await Bun.write("system-effect", "executed")\n')
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { start: "touch system-effect" } }))
  return root
}

async function directorySnapshot(root: string) {
  const names = (await readdir(root, { recursive: true })).toSorted()
  return Promise.all(names.map(async (name) => [name, await readFile(join(root, name), "utf8")] as const))
}

async function gitWorkspace() {
  const root = await realpath(await temporaryDirectory("astra-cli-git-workspace-"))
  await runGit(root, "init", "-q", "--initial-branch=main")
  await writeFile(join(root, "tracked.txt"), "initial\n")
  await runGit(root, "add", "tracked.txt")
  await runGit(root, "-c", "user.name=Astra", "-c", "user.email=astra@example.invalid", "commit", "-qm", "initial")
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
  return runCliCommand(dataDirectory, ...command.slice(2))
}

async function runCliCommand(dataDirectory: string, ...arguments_: ReadonlyArray<string>) {
  return runCliCommandFrom(packageRoot, dataDirectory, ...arguments_)
}

async function runCliCommandFrom(cwd: string, dataDirectory: string, ...arguments_: ReadonlyArray<string>) {
  const command = [join(packageRoot, "src/index.ts"), ...arguments_]
  const child = Bun.spawn(command, {
    cwd,
    env: {
      ASTRA_DATA_DIR: dataDirectory,
      HOME: join(dataDirectory, "..", "isolated-home"),
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

async function runInteractiveCli(root: string, dataDirectory: string, approval: string) {
  const child = Bun.spawn([process.execPath, "src/index.ts", "open", root, "--developer-demo"], {
    cwd: packageRoot,
    env: {
      ASTRA_DATA_DIR: dataDirectory,
      HOME: join(dataDirectory, "..", "isolated-home"),
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let stdout = ""
  const readUntil = async (expected: string) => {
    while (!stdout.includes(expected)) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`CLI closed before prompt: ${expected}\n${stdout}`)
      stdout += decoder.decode(chunk.value, { stream: true })
    }
  }

  await child.stdin.write("g\n")
  await readUntil("Choose [R] read-only, [A] activate once, [Q] exit:")
  await child.stdin.write("a\n")
  await readUntil("Type APPROVE to create the exact demo marker")
  await child.stdin.write(`${approval}\n`)
  await child.stdin.end()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    stdout += decoder.decode(chunk.value, { stream: true })
  }
  stdout += decoder.decode()
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exitCode, stdout, stderr }
}

async function runGit(root: string, ...arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn(["/Applications/Xcode.app/Contents/Developer/usr/bin/git", "-C", root, ...arguments_], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Git fixture command failed: ${stderr}`)
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
