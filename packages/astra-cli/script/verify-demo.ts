import { strict as assert } from "node:assert"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { demoMarkerName } from "@astra/runtime/controlled-write-plan"
import { createMaliciousWorkspace, directoryDigest, sentinelNames } from "../../astra-runtime/test/support"

const packageRoot = new URL("..", import.meta.url).pathname
const isolatedHome = await mkdtemp(join(tmpdir(), "astra-demo-home-"))
const stateParent = await mkdtemp(join(tmpdir(), "astra-demo-state-parent-"))
const appState = join(stateParent, "state")
const fixtures: Array<Awaited<ReturnType<typeof createMaliciousWorkspace>>> = []
let networkRequests = 0
const server = Bun.serve({
  port: 0,
  fetch() {
    networkRequests += 1
    return new Response("unexpected")
  },
})

try {
  await verifyReadOnly()
  await verifyDeniedEffect()
  await verifyApprovedEffect()
  assert.equal(networkRequests, 0, "workspace open contacted the configured network canary")
  console.log("\nDEMO MATRIX PASS")
  console.log("- read-only: zero workspace effects")
  console.log("- denied operation: durable state, no dispatch, and no marker")
  console.log("- approved operation: one create-only marker with exact readback verification")
  console.log("- network canary: zero requests")
  console.log("- persistent trust: none; app state: one denied Operation ledger")
} finally {
  await server.stop(true)
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()))
  await rm(isolatedHome, { recursive: true, force: true })
  await rm(stateParent, { recursive: true, force: true })
}

async function verifyReadOnly() {
  const fixture = await workspace()
  const before = await directoryDigest(fixture.root)
  const run = await runCli(fixture.root, "read-only")

  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.stdout, /READ ONLY/)
  assert.doesNotMatch(run.stdout, /HOST EXECUTION/)
  assert.equal(await directoryDigest(fixture.root), before)
  assert.deepEqual(await sentinelNames(fixture.sentinel), [])
  assert.equal(await exists(appState), false, "read-only created the app-state directory")
  printCase("NEGATIVE A — READ ONLY", run.stdout)
}

async function verifyDeniedEffect() {
  const fixture = await workspace(false)
  const before = await directoryDigest(fixture.root)
  const run = await runCli(fixture.root, "activate-once", "deny")

  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.stdout, /HOST EXECUTION — NO SANDBOX/)
  assert.match(run.stdout, /DENIED     no dispatch • no host effect/)
  assert.match(run.stdout, /LEDGER     durable • sequence 3 • cursor 3/)
  assert.doesNotMatch(run.stdout, /DISPATCHING/)
  assert.equal(await directoryDigest(fixture.root), before)
  assert.deepEqual(await sentinelNames(fixture.sentinel), [])
  const operationID = run.stdout.match(/OPERATION ([0-9a-f-]{36})/)?.[1]
  assert.ok(operationID, "denied Operation ID was not rendered")
  const durable = await readOperation(join(appState, "operations.sqlite"), operationID)
  assert.deepEqual(
    durable && {
      operationID: durable.operationID,
      state: durable.state,
      sequence: durable.sequence,
      lastCursor: durable.lastCursor,
    },
    { operationID, state: "denied", sequence: 3, lastCursor: 3 },
  )
  printCase("NEGATIVE B — DENIED EFFECT", run.stdout)
}

async function verifyApprovedEffect() {
  const fixture = await workspace()
  const run = await runCli(fixture.root, "activate-once", "approve")
  const marker = await readFile(join(fixture.root, demoMarkerName), "utf8")

  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.stdout, /EFFECT OBSERVED — NOT VERIFIED/)
  assert.match(run.stdout, /VERIFIED   demo marker matches the exact expected bytes and SHA-256/)
  assert.match(marker, /^Astra controlled host write\noperation_id=/)
  assert.deepEqual(await sentinelNames(fixture.sentinel), [])
  printCase("POSITIVE — APPROVED CONTROLLED WRITE", run.stdout)
}

async function workspace(includeGit = true) {
  const fixture = await createMaliciousWorkspace(server.port)
  if (!includeGit) await rm(join(fixture.root, ".git"), { recursive: true, force: true })
  fixtures.push(fixture)
  return fixture
}

async function runCli(root: string, decision: string, approval?: string) {
  const command = [process.execPath, "src/index.ts", "open", root, "--decision", decision]
  if (approval) command.push("--approval", approval)
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env: {
      HOME: isolatedHome,
      ASTRA_DATA_DIR: appState,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      NO_COLOR: "1",
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

function printCase(name: string, output: string) {
  console.log(`\n=== ${name} ===`)
  console.log(output.trim())
}
