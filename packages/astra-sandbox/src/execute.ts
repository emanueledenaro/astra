import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { parseExecutionCapability } from "@astra/domain/execution-capability"
import type { ContentDigest } from "@astra/domain/operation-contract"
import { buildSeatbeltInvocation } from "./profile"
import { probeDarwinSeatbelt } from "./probe"
import { openApprovedSource, preparePrivateRuntime, type ApprovedSource, type PrivateRuntimePreparation } from "./seal"
import type {
  ApprovedDarwinCreateOnlyInput,
  SandboxExecutionResult,
  SandboxUnknownReason,
  SeatbeltProbeResult,
  SealedExecutableIdentity,
} from "./types"

type StopReason = Extract<SandboxUnknownReason, "timeout" | "stdout_limit_exceeded" | "stderr_limit_exceeded">
type WithoutCleanup<T> = T extends unknown ? Omit<T, "cleanupSucceeded"> : never
type ProcessExecution = WithoutCleanup<Exclude<SandboxExecutionResult, { status: "blocked" }>>
type ProcessRunResult = Readonly<{ started: false }> | Readonly<{ started: true; execution: ProcessExecution }>
type ExecutorDependencies = Readonly<{
  probeDarwinSeatbelt: () => Promise<SeatbeltProbeResult>
  openApprovedSource: typeof openApprovedSource
  preparePrivateRuntime: (source: ApprovedSource, scratchPath: string) => Promise<PrivateRuntimePreparation>
}>

const defaultDependencies: ExecutorDependencies = {
  probeDarwinSeatbelt,
  openApprovedSource,
  preparePrivateRuntime,
}

/**
 * Executes one capability-bound create-only worker. Callers must invoke this only after explicit approval.
 * Every setup failure is fail-closed; this function has no unsandboxed fallback.
 */
export async function executeApprovedDarwinCreateOnly(
  input: ApprovedDarwinCreateOnlyInput,
): Promise<SandboxExecutionResult> {
  return executeApprovedDarwinCreateOnlyWithDependencies(input, {})
}

export async function executeApprovedDarwinCreateOnlyWithDependencies(
  input: ApprovedDarwinCreateOnlyInput,
  overrides: Partial<ExecutorDependencies>,
): Promise<SandboxExecutionResult> {
  const dependencies = { ...defaultDependencies, ...overrides }
  if (process.platform !== "darwin") return blocked("unsupported_platform")
  const parsed = parseExecutionCapability(input.capability)
  if (!parsed.ok) return blocked("invalid_capability")
  const capability = parsed.value
  const manifest = capability.manifest
  if (Date.parse(manifest.grant.expiresAt) <= Date.now()) return blocked("authority_expired")
  if (manifest.process.programDigest !== sha256(input.program)) return blocked("program_binding_mismatch")
  if (manifest.process.stdinDigest !== sha256(input.stdin)) return blocked("stdin_binding_mismatch")
  if (!supportedShape(input)) return blocked("unsupported_execution_shape")
  if (!(await validWorkspaceIdentity(manifest.filesystem.workspace))) return blocked("workspace_identity_mismatch")
  const target = manifest.filesystem.createOnlyFiles[0]!
  if (!(await unusedCanonicalChild(target, manifest.filesystem.workspace.canonicalPath))) {
    return blocked("create_target_not_absent")
  }

  const probe = await dependencies.probeDarwinSeatbelt()
  if (!probe.available)
    return blocked(probe.reason === "unsupported_platform" ? "unsupported_platform" : "sandbox_unavailable")
  const source = await dependencies.openApprovedSource(manifest.process.executable)
  if (!source) return blocked("source_executable_untrusted")

  const preparedRuntime = await dependencies.preparePrivateRuntime(
    source,
    manifest.filesystem.runtimeScratch.canonicalPath,
  )
  await source.handle.close().catch(() => undefined)
  if (!preparedRuntime.ok) {
    if (preparedRuntime.reason === "cleanup_failed") {
      return {
        ...unknownExecution(
          "cleanup_failed",
          capability.capabilityDigest,
          undefined,
          new Uint8Array(),
          new Uint8Array(),
          { kind: "unconfirmed" },
        ),
        cleanupSucceeded: false,
      }
    }
    return blocked(preparedRuntime.reason)
  }
  const runtime = preparedRuntime.value

  const runtimeValid = await runtime.validate()
  const targetStillAbsent = await unusedCanonicalChild(target, manifest.filesystem.workspace.canonicalPath)
  if (!runtimeValid || !targetStillAbsent) {
    const cleanupSucceeded = await runtime.cleanup().catch(() => false)
    if (!cleanupSucceeded) {
      return {
        ...unknownExecution(
          "cleanup_failed",
          capability.capabilityDigest,
          runtime.sealedExecutable,
          new Uint8Array(),
          new Uint8Array(),
          { kind: "unconfirmed" },
        ),
        cleanupSucceeded: false,
      }
    }
    return blocked(runtimeValid ? "create_target_not_absent" : "sealed_executable_failed")
  }

  const environment = Object.fromEntries(manifest.environment.variables.map(({ name, value }) => [name, value]))
  const invocation = buildSeatbeltInvocation({
    sandboxPath: probe.sandboxPath,
    sealedExecutable: runtime.sealedExecutable.canonicalPath,
    workspaceRoot: manifest.filesystem.workspace.canonicalPath,
    runtimeScratch: runtime.scratchPath,
    createTarget: target,
    arguments: manifest.process.arguments,
  })

  const processRun = await runBoundedProcess({
    invocation,
    cwd: manifest.process.workingDirectory,
    environment,
    stdin: input.stdin,
    timeoutMs: manifest.limits.timeoutMs,
    maxStdoutBytes: manifest.limits.maxStdoutBytes,
    maxStderrBytes: manifest.limits.maxStderrBytes,
    capabilityDigest: capability.capabilityDigest,
    sealedExecutable: runtime.sealedExecutable,
  })
  if (!processRun.started) {
    const cleanupSucceeded = await runtime.cleanup().catch(() => false)
    if (!cleanupSucceeded) {
      return {
        ...unknownExecution(
          "cleanup_failed",
          capability.capabilityDigest,
          runtime.sealedExecutable,
          new Uint8Array(),
          new Uint8Array(),
          { kind: "unconfirmed" },
        ),
        cleanupSucceeded: false,
      }
    }
    return blocked("process_spawn_failed")
  }
  const execution = processRun.execution

  const cleanupSucceeded = await runtime.cleanup().catch(() => false)
  if (!cleanupSucceeded) {
    return {
      ...unknownExecution(
        "cleanup_failed",
        capability.capabilityDigest,
        runtime.sealedExecutable,
        execution.stdout,
        execution.stderr,
        execution.termination,
      ),
      cleanupSucceeded: false,
    }
  }
  return { ...execution, cleanupSucceeded: true }
}

async function runBoundedProcess(
  input: Readonly<{
    invocation: ReadonlyArray<string>
    cwd: string
    environment: Readonly<Record<string, string>>
    stdin: Uint8Array
    timeoutMs: number
    maxStdoutBytes: number
    maxStderrBytes: number
    capabilityDigest: ContentDigest
    sealedExecutable: SealedExecutableIdentity
  }>,
): Promise<ProcessRunResult> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">
  try {
    child = Bun.spawn([...input.invocation], {
      cwd: input.cwd,
      env: { ...input.environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch {
    return { started: false }
  }
  let exited = false
  let stopReason: StopReason | null = null
  let forceKill: ReturnType<typeof setTimeout> | null = null
  const exitedPromise = child.exited.then((exitCode) => {
    exited = true
    return exitCode
  })
  const requestStop = (reason: StopReason) => {
    if (stopReason) return
    stopReason = reason
    killProcessGroup(child.pid, child, "SIGTERM")
    forceKill = setTimeout(() => {
      if (!exited) killProcessGroup(child.pid, child, "SIGKILL")
    }, 100)
  }
  const timeout = setTimeout(() => requestStop("timeout"), input.timeoutMs)
  const stdoutPromise = readBounded(child.stdout, input.maxStdoutBytes, () => requestStop("stdout_limit_exceeded"))
  const stderrPromise = readBounded(child.stderr, input.maxStderrBytes, () => requestStop("stderr_limit_exceeded"))
  try {
    child.stdin.write(input.stdin)
    child.stdin.end()
    const [exitCode, stdout, stderr] = await Promise.all([exitedPromise, stdoutPromise, stderrPromise])
    const termination = { kind: "exited", exitCode } as const
    if (stopReason) {
      return {
        started: true,
        execution: unknownExecution(
          stopReason,
          input.capabilityDigest,
          input.sealedExecutable,
          stdout.bytes,
          stderr.bytes,
          termination,
        ),
      }
    }
    return {
      started: true,
      execution: {
        status: "observed",
        backend: "darwin-seatbelt",
        capabilityDigest: input.capabilityDigest,
        sealedExecutable: input.sealedExecutable,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        termination,
      },
    }
  } catch {
    killProcessGroup(child.pid, child, "SIGKILL")
    const exitCode = await exitedPromise.catch(() => null)
    const [stdout, stderr] = await Promise.all([
      stdoutPromise.catch(() => ({ bytes: new Uint8Array(), exceeded: false }) as const),
      stderrPromise.catch(() => ({ bytes: new Uint8Array(), exceeded: false }) as const),
    ])
    return {
      started: true,
      execution: unknownExecution(
        exitCode === null ? "process_termination_failed" : "process_io_failed",
        input.capabilityDigest,
        input.sealedExecutable,
        stdout.bytes,
        stderr.bytes,
        exitCode === null ? { kind: "unconfirmed" } : { kind: "exited", exitCode },
      ),
    }
  } finally {
    clearTimeout(timeout)
    if (forceKill) clearTimeout(forceKill)
    if (!exited) killProcessGroup(child.pid, child, "SIGKILL")
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, onExceeded: () => void) {
  const chunks: Array<Uint8Array> = []
  let retained = 0
  let exceeded = false
  for await (const chunk of stream) {
    const remaining = Math.max(0, limit - retained)
    if (remaining > 0) {
      const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
      chunks.push(kept)
      retained += kept.byteLength
    }
    if (!exceeded && chunk.byteLength > remaining) {
      exceeded = true
      onExceeded()
    }
  }
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, exceeded } as const
}

function supportedShape(input: ApprovedDarwinCreateOnlyInput) {
  const manifest = input.capability.manifest
  const scratch = manifest.filesystem.runtimeScratch.canonicalPath
  return (
    manifest.process.arguments.length === 2 &&
    manifest.process.arguments[0] === "--eval" &&
    manifest.process.arguments[1] === input.program &&
    manifest.filesystem.readOnlyRoots.length === 1 &&
    manifest.filesystem.readOnlyRoots[0] === manifest.filesystem.workspace.canonicalPath &&
    manifest.filesystem.createOnlyFiles.length === 1 &&
    manifest.filesystem.writableFiles.length === 0 &&
    manifest.environment.variables.some(({ name, value }) => name === "TMPDIR" && value === scratch)
  )
}

async function validWorkspaceIdentity(expected: Readonly<{ canonicalPath: string; device: string; inode: string }>) {
  const [canonicalPath, facts] = await Promise.all([
    realpath(expected.canonicalPath).catch(() => null),
    lstat(expected.canonicalPath).catch(() => null),
  ])
  return Boolean(
    canonicalPath === expected.canonicalPath &&
      facts?.isDirectory() &&
      !facts.isSymbolicLink() &&
      String(facts.dev) === expected.device &&
      String(facts.ino) === expected.inode,
  )
}

async function unusedCanonicalChild(path: string, workspace: string) {
  if (!isAbsolute(path) || resolve(path) !== path || !within(workspace, path) || path === workspace) return false
  const existing = await lstat(path).catch((error: unknown) => (isNotFound(error) ? null : false))
  if (existing !== null) return false
  const parent = dirname(path)
  if ((await realpath(parent).catch(() => null)) !== parent) return false
  const parentFacts = await lstat(parent).catch(() => null)
  return Boolean(parentFacts?.isDirectory() && !parentFacts.isSymbolicLink())
}

function within(root: string, candidate: string) {
  const path = relative(root, candidate)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function unknownExecution(
  reason: SandboxUnknownReason,
  capabilityDigest: ContentDigest,
  sealedExecutable: SealedExecutableIdentity | undefined,
  stdout: Uint8Array,
  stderr: Uint8Array,
  termination: Readonly<{ kind: "exited"; exitCode: number }> | Readonly<{ kind: "unconfirmed" }>,
): ProcessExecution {
  return {
    status: "effect_unknown",
    reason,
    backend: "darwin-seatbelt",
    capabilityDigest,
    ...(sealedExecutable ? { sealedExecutable } : {}),
    stdout,
    stderr,
    termination,
  } as const
}

function blocked(reason: Extract<SandboxExecutionResult, { status: "blocked" }>["reason"]) {
  return { status: "blocked", reason } as const
}

function killProcessGroup(pid: number, child: Bun.Subprocess, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process may already have exited between observation and termination.
    }
  }
}

function sha256(input: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}` as const
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
