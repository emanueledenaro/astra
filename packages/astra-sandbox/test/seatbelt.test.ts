import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  computeExecutionCapabilityDigest,
  type ExecutionCapability,
  type ExecutionCapabilityManifest,
} from "@astra/domain/execution-capability"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseOperationID,
  type ContentDigest,
} from "@astra/domain/operation-contract"
import { executeApprovedDarwinCreateOnly, probeDarwinSeatbelt, type SandboxExecutionResult } from "../src"
import { probeDarwinSeatbeltWithDependencies } from "../src/probe"
import { executeApprovedDarwinCreateOnlyWithDependencies } from "../src/execute"

const roots: Array<string> = []
const executable = executableIdentity()

const workerProgram = String.raw`
const input = JSON.parse(await Bun.stdin.text())
if (input.action === "create") {
  const { constants } = await import("node:fs")
  const { open } = await import("node:fs/promises")
  const handle = await open(input.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(input.content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
} else if (input.action === "outside-write") {
  await Bun.write(input.path, "outside")
} else if (input.action === "network") {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  server.stop(true)
} else if (input.action === "environment") {
  console.log(process.env.ASTRA_SANDBOX_CANARY ?? "absent")
} else if (input.action === "timeout") {
  await Bun.sleep(60_000)
} else if (input.action === "output") {
  console.log("x".repeat(input.bytes))
} else if (input.action === "stderr-output") {
  console.error("x".repeat(input.bytes))
}
`

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("Darwin Seatbelt create-only executor", () => {
  test("fails closed before probing on a non-Darwin platform", async () => {
    let invoked = false
    const result = await probeDarwinSeatbeltWithDependencies({
      platform: "linux",
      async verifySystemExecutable() {
        invoked = true
        return true
      },
      async verifyAppleSignature() {
        invoked = true
        return true
      },
      async runProfileProbe() {
        invoked = true
        return true
      },
    })

    expect(result).toEqual({ available: false, reason: "unsupported_platform" })
    expect(invoked).toBeFalse()
  })

  test("accepts the Apple-signed system Seatbelt binary", async () => {
    if (process.platform !== "darwin") return
    expect(await probeDarwinSeatbelt()).toMatchObject({
      available: true,
      sandboxPath: "/usr/bin/sandbox-exec",
    })
  })

  test("fails closed when the Apple signature cannot be established", async () => {
    let profileProbeInvoked = false
    const result = await probeDarwinSeatbeltWithDependencies({
      platform: "darwin",
      async verifySystemExecutable() {
        return true
      },
      async verifyAppleSignature() {
        return false
      },
      async runProfileProbe() {
        profileProbeInvoked = true
        return true
      },
    })

    expect(result).toEqual({ available: false, reason: "apple_signature_invalid" })
    expect(profileProbeInvoked).toBeFalse()
  })

  test("performs one bounded create-only write and removes private runtime state", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const input = await executionInput(fixture, { action: "create", path: fixture.target, content: "astra\n" })

    const result = await executeApprovedDarwinCreateOnly(input)

    expect(result).toMatchObject({ status: "observed", termination: { kind: "exited", exitCode: 0 } })
    if (result.status !== "observed") throw new Error("expected observed execution")
    expect(result.sealedExecutable.digest).toBe(input.capability.manifest.process.executable.digest)
    expect(result.sealedExecutable.canonicalPath).not.toBe(input.capability.manifest.process.executable.canonicalPath)
    expect(await exists(result.sealedExecutable.canonicalPath)).toBeFalse()
    expect(await readFile(fixture.target, "utf8")).toBe("astra\n")
    await expectPrivateStateRemoved(fixture, result)
  }, 20_000)

  test("creates a missing private Sandbox parent after approval", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture({ missingSandboxParent: true })
    expect(await exists(dirname(fixture.scratch))).toBeFalse()
    const input = await executionInput(fixture, { action: "create", path: fixture.target, content: "astra\n" })

    const result = await executeApprovedDarwinCreateOnly(input)

    expect(result).toMatchObject({ status: "observed", termination: { kind: "exited", exitCode: 0 } })
    const parentFacts = await lstat(dirname(fixture.scratch))
    expect(parentFacts.uid).toBe(process.getuid!())
    expect(parentFacts.mode & 0o777).toBe(0o700)
    expect(await readdir(dirname(fixture.scratch))).toEqual([])
    await expectPrivateStateRemoved(fixture, result)
  }, 20_000)

  test("denies writes outside the approved target", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const outside = join(fixture.state, "outside.txt")
    const input = await executionInput(fixture, { action: "outside-write", path: outside })

    const result = await executeApprovedDarwinCreateOnly(input)

    expect(result).toMatchObject({ status: "observed", termination: { kind: "exited" } })
    if (result.status !== "observed" || result.termination.kind !== "exited") throw new Error("expected exited process")
    expect(result.termination.exitCode).not.toBe(0)
    expect(await exists(outside)).toBeFalse()
    expect(await exists(fixture.target)).toBeFalse()
    await expectPrivateStateRemoved(fixture, result)
  }, 20_000)

  test("denies local network access", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const input = await executionInput(fixture, { action: "network" })

    const result = await executeApprovedDarwinCreateOnly(input)

    expect(result).toMatchObject({ status: "observed", termination: { kind: "exited" } })
    if (result.status !== "observed" || result.termination.kind !== "exited") throw new Error("expected exited process")
    expect(result.termination.exitCode).not.toBe(0)
    expect(await exists(fixture.target)).toBeFalse()
    await expectPrivateStateRemoved(fixture, result)
  }, 20_000)

  test("does not inherit an environment canary", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const input = await executionInput(fixture, { action: "environment" })
    process.env.ASTRA_SANDBOX_CANARY = "must-not-cross"
    try {
      const result = await executeApprovedDarwinCreateOnly(input)
      expect(result).toMatchObject({ status: "observed", termination: { kind: "exited", exitCode: 0 } })
      expect(result.status === "observed" ? new TextDecoder().decode(result.stdout).trim() : "").toBe("absent")
      await expectPrivateStateRemoved(fixture, result)
    } finally {
      delete process.env.ASTRA_SANDBOX_CANARY
    }
  }, 20_000)

  test("blocks a symlink target before spawning", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const outside = join(fixture.state, "outside.txt")
    await Bun.write(outside, "unchanged")
    await symlink(outside, fixture.target)
    const input = await executionInput(fixture, { action: "create", path: fixture.target, content: "changed" })

    const result = await executeApprovedDarwinCreateOnly(input)

    expect(result).toEqual({ status: "blocked", reason: "create_target_not_absent" })
    expect(await readFile(outside, "utf8")).toBe("unchanged")
    expect(await exists(fixture.scratch)).toBeFalse()
  }, 20_000)

  test("rejects program drift before creating private runtime state", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const input = await executionInput(fixture, { action: "create", path: fixture.target, content: "changed" })

    const result = await executeApprovedDarwinCreateOnly({ ...input, program: `${input.program}\n` })

    expect(result).toEqual({ status: "blocked", reason: "program_binding_mismatch" })
    expect(await exists(fixture.scratch)).toBeFalse()
    expect(await exists(fixture.target)).toBeFalse()
  }, 20_000)

  test("reports unknown effect when setup state cannot be cleaned", async () => {
    if (process.platform !== "darwin") return
    const fixture = await makeFixture()
    const input = await executionInput(fixture, { action: "create", path: fixture.target, content: "astra" })

    const result = await executeApprovedDarwinCreateOnlyWithDependencies(input, {
      async preparePrivateRuntime(_source, scratchPath) {
        await mkdir(scratchPath, { mode: 0o700 })
        return { ok: false, reason: "cleanup_failed", cleanupSucceeded: false }
      },
    })

    expect(result).toMatchObject({
      status: "effect_unknown",
      reason: "cleanup_failed",
      cleanupSucceeded: false,
      termination: { kind: "unconfirmed" },
    })
    expect(await exists(fixture.scratch)).toBeTrue()
    await rm(fixture.scratch, { recursive: true })
  }, 20_000)

  test("bounds timeout and stdout without claiming no effect", async () => {
    if (process.platform !== "darwin") return
    const timeoutFixture = await makeFixture()
    const timeoutInput = await executionInput(timeoutFixture, { action: "timeout" }, { timeoutMs: 50 })
    const timedOut = await executeApprovedDarwinCreateOnly(timeoutInput)
    expect(timedOut).toMatchObject({ status: "effect_unknown", reason: "timeout" })
    await expectPrivateStateRemoved(timeoutFixture, timedOut)

    const outputFixture = await makeFixture()
    const outputInput = await executionInput(outputFixture, { action: "output", bytes: 16_384 }, { maxStdoutBytes: 32 })
    const overflow = await executeApprovedDarwinCreateOnly(outputInput)
    expect(overflow).toMatchObject({ status: "effect_unknown", reason: "stdout_limit_exceeded" })
    await expectPrivateStateRemoved(outputFixture, overflow)

    const stderrFixture = await makeFixture()
    const stderrInput = await executionInput(
      stderrFixture,
      { action: "stderr-output", bytes: 16_384 },
      { maxStderrBytes: 32 },
    )
    const stderrOverflow = await executeApprovedDarwinCreateOnly(stderrInput)
    expect(stderrOverflow).toMatchObject({ status: "effect_unknown", reason: "stderr_limit_exceeded" })
    await expectPrivateStateRemoved(stderrFixture, stderrOverflow)
  }, 20_000)
})

type Fixture = Readonly<{ workspace: string; state: string; scratch: string; target: string }>

async function makeFixture(options: Readonly<{ missingSandboxParent?: boolean }> = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "astra-seatbelt-test-")))
  roots.push(root)
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  await mkdir(workspace, { mode: 0o700 })
  await mkdir(state, { mode: 0o700 })
  const stateRoot = await realpath(state)
  const scratchParent = options.missingSandboxParent ? join(stateRoot, "Sandbox") : stateRoot
  return {
    workspace: await realpath(workspace),
    state: stateRoot,
    scratch: join(scratchParent, "runtime-scratch"),
    target: join(await realpath(workspace), "marker.txt"),
  }
}

async function executionInput(
  fixture: Fixture,
  payload: Readonly<Record<string, unknown>>,
  limitOverrides: Partial<ExecutionCapabilityManifest["limits"]> = {},
) {
  const source = await executable
  const workspaceFacts = await lstat(fixture.workspace)
  const stdin = new TextEncoder().encode(JSON.stringify(payload))
  const manifest = {
    schemaVersion: 1,
    grant: {
      capabilityGrantID: requireParsed(parseCapabilityGrantID("0196e4cb-5d80-7b1d-8fb2-263b81670435")),
      operationID: requireParsed(parseOperationID("0196e4cb-5d80-7b1d-8fb2-263b81670436")),
      attemptID: requireParsed(parseAttemptID("0196e4cb-5d80-7b1d-8fb2-263b81670437")),
      baselineDigest: sha256("baseline"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    isolation: { platform: "darwin", backend: "seatbelt", fallback: "deny" },
    process: {
      executable: source,
      programDigest: sha256(workerProgram),
      arguments: ["--eval", workerProgram],
      workingDirectory: fixture.workspace,
      stdinDigest: sha256(stdin),
    },
    filesystem: {
      mode: "bounded_paths",
      workspace: {
        canonicalPath: fixture.workspace,
        device: String(workspaceFacts.dev),
        inode: String(workspaceFacts.ino),
      },
      runtimeScratch: { canonicalPath: fixture.scratch, lifecycle: "private_ephemeral" },
      readOnlyRoots: [fixture.workspace],
      createOnlyFiles: [fixture.target],
      writableFiles: [],
    },
    network: { mode: "none" },
    environment: {
      variables: [
        { name: "LANG", value: "C" },
        { name: "TMPDIR", value: fixture.scratch },
        { name: "TZ", value: "UTC" },
      ],
    },
    limits: {
      timeoutMs: limitOverrides.timeoutMs ?? 5_000,
      maxStdoutBytes: limitOverrides.maxStdoutBytes ?? 16_384,
      maxStderrBytes: limitOverrides.maxStderrBytes ?? 16_384,
    },
  } as const satisfies ExecutionCapabilityManifest
  const capability = {
    manifest,
    capabilityDigest: computeExecutionCapabilityDigest(manifest),
  } as const satisfies ExecutionCapability
  return { capability, program: workerProgram, stdin }
}

async function executableIdentity(): Promise<ExecutionCapabilityManifest["process"]["executable"]> {
  const canonicalPath = await realpath(process.execPath)
  const facts = await lstat(canonicalPath)
  return {
    canonicalPath,
    device: String(facts.dev),
    inode: String(facts.ino),
    digest: requireParsed(parseContentDigest(`sha256:${await digestFile(canonicalPath)}`)),
  }
}

async function digestFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position)
      if (result.bytesRead === 0) return hash.digest("hex")
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
  } finally {
    await handle.close()
  }
}

function sha256(input: string | Uint8Array): ContentDigest {
  return requireParsed(parseContentDigest(`sha256:${createHash("sha256").update(input).digest("hex")}`))
}

function requireParsed<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error("invalid test fixture identifier")
  return result.value
}

async function expectPrivateStateRemoved(fixture: Fixture, result: SandboxExecutionResult) {
  expect(await exists(fixture.scratch)).toBeFalse()
  const runtimeParent = dirname(fixture.scratch)
  if (await exists(runtimeParent)) {
    expect((await readdir(runtimeParent)).filter((name) => name.startsWith("astra-seatbelt-exec-"))).toEqual([])
  }
  if (result.status !== "blocked") expect(result.cleanupSucceeded).toBeTrue()
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
