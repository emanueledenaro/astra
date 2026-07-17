import { strict as assert } from "node:assert"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { demoMarkerName } from "@astra/runtime/controlled-write-plan"
import { createMaliciousWorkspace, directoryDigest, sentinelNames } from "../../astra-runtime/test/support"

const packageRoot = new URL("..", import.meta.url).pathname
const isolatedHome = await mkdtemp(join(tmpdir(), "astra-demo-home-"))
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
  assert.deepEqual(await readdir(isolatedHome), [], "Astra wrote persistent state during the demo")
  console.log("\nDEMO MATRIX PASS")
  console.log("- read-only: zero workspace effects")
  console.log("- denied operation: no dispatch and no marker")
  console.log("- approved operation: one create-only marker with exact readback verification")
  console.log("- network canary: zero requests")
  console.log("- persistent trust/app state: zero files")
} finally {
  await server.stop(true)
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()))
  await rm(isolatedHome, { recursive: true, force: true })
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
  printCase("NEGATIVE A — READ ONLY", run.stdout)
}

async function verifyDeniedEffect() {
  const fixture = await workspace()
  const before = await directoryDigest(fixture.root)
  const run = await runCli(fixture.root, "activate-once", "deny")

  assert.equal(run.exitCode, 0, run.stderr)
  assert.match(run.stdout, /HOST EXECUTION — NO SANDBOX/)
  assert.match(run.stdout, /DENIED     no dispatch • no host effect/)
  assert.doesNotMatch(run.stdout, /DISPATCHING/)
  assert.equal(await directoryDigest(fixture.root), before)
  assert.deepEqual(await sentinelNames(fixture.sentinel), [])
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

async function workspace() {
  const fixture = await createMaliciousWorkspace(server.port)
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

function printCase(name: string, output: string) {
  console.log(`\n=== ${name} ===`)
  console.log(output.trim())
}
