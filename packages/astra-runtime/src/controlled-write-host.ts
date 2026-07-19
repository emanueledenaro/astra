import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname } from "node:path"
import type { WorkspaceIdentity } from "@astra/domain/workspace-trust"
import {
  verifyControlledWrite,
  type ControlledWriteExecutionEvidence,
  type ControlledWriteResult,
} from "./controlled-write"
import { makeControlledWriteHostArguments, type ControlledWriteCapabilityProposal } from "./controlled-write-capability"
import type { ControlledWritePlan } from "./controlled-write-plan"

type HostStopReason = "timeout" | "stdout_limit_exceeded" | "stderr_limit_exceeded"

type HostProcessResult = Readonly<{
  status: "observed" | "effect_unknown"
  started: boolean
  reason?: HostStopReason | "process_observation_failed"
  termination: Readonly<{ kind: "exited"; exitCode: number }> | Readonly<{ kind: "unconfirmed" }>
  stdout: Uint8Array
  stderr: Uint8Array
}>

/** Executes the approved worker directly on the host. There is deliberately no sandbox claim. */
export async function executeHostControlledWrite(
  proposal: ControlledWriteCapabilityProposal,
  plan: ControlledWritePlan,
  target: string,
  expectedWorkspaceIdentity: WorkspaceIdentity,
): Promise<ControlledWriteResult> {
  const manifest = proposal.capability.manifest
  const expectedArguments = makeControlledWriteHostArguments(proposal.program)
  if (
    manifest.isolation.backend !== "host" ||
    manifest.process.arguments.length !== expectedArguments.length ||
    !manifest.process.arguments.every((argument, index) => argument === expectedArguments[index]) ||
    manifest.process.programDigest !== sha256(Buffer.from(proposal.program, "utf8")) ||
    manifest.process.stdinDigest !== sha256(Buffer.from(proposal.stdin, "utf8")) ||
    Date.parse(manifest.grant.expiresAt) <= Date.now()
  ) {
    return { status: "failed_without_effect", reason: "host_capability_invalid", execution: notStarted(proposal) }
  }
  const executable = await revalidateExecutable(manifest.process.executable)
  if (!executable) {
    return { status: "failed_without_effect", reason: "host_executable_changed", execution: notStarted(proposal) }
  }
  if (!(await targetStillAbsent(target, expectedWorkspaceIdentity))) {
    return { status: "failed_without_effect", reason: "target_state_changed", execution: notStarted(proposal) }
  }

  const processResult = await runBoundedHostProcess({
    executable: executable.canonicalPath,
    arguments: manifest.process.arguments,
    cwd: manifest.process.workingDirectory,
    environment: Object.fromEntries(manifest.environment.variables.map(({ name, value }) => [name, value])),
    stdin: Buffer.from(proposal.stdin, "utf8"),
    timeoutMs: manifest.limits.timeoutMs,
    maxStdoutBytes: manifest.limits.maxStdoutBytes,
    maxStderrBytes: manifest.limits.maxStderrBytes,
  })
  const evidence = hostEvidence(proposal, executable, processResult)
  const receipt = await verifyControlledWrite(plan, target, expectedWorkspaceIdentity)
  if (processResult.status === "effect_unknown") {
    return {
      status: "effect_unknown",
      reason: `host_${processResult.reason ?? "process_observation_failed"}`,
      receipt,
      execution: evidence,
    }
  }
  if (processResult.termination.kind !== "exited") {
    return { status: "effect_unknown", reason: "host_process_observation_failed", receipt, execution: evidence }
  }
  if (processResult.termination.exitCode !== 0) {
    if (receipt.targetIdentity !== null) {
      return {
        status: "effect_observed_unverified",
        reason: `host_exit_${processResult.termination.exitCode}`,
        receipt,
        execution: evidence,
      }
    }
    if (!processResult.started) {
      return {
        status: "failed_without_effect",
        reason: `host_exit_${processResult.termination.exitCode}`,
        execution: evidence,
      }
    }
    return {
      status: "effect_unknown",
      reason: `host_exit_${processResult.termination.exitCode}`,
      receipt,
      execution: evidence,
    }
  }
  if (!exactReceipt(plan, receipt)) {
    return { status: "effect_observed_unverified", reason: "host_readback_mismatch", receipt, execution: evidence }
  }
  return { status: "effect_observed", receipt, execution: evidence }
}

async function runBoundedHostProcess(
  input: Readonly<{
    executable: string
    arguments: ReadonlyArray<string>
    cwd: string
    environment: Readonly<Record<string, string>>
    stdin: Uint8Array
    timeoutMs: number
    maxStdoutBytes: number
    maxStderrBytes: number
  }>,
): Promise<HostProcessResult> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
  let exited = false
  let stopReason: HostStopReason | null = null
  let forceKill: ReturnType<typeof setTimeout> | null = null
  try {
    child = Bun.spawn([input.executable, ...input.arguments], {
      cwd: input.cwd,
      env: { ...input.environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const current = child
    const exitedPromise = current.exited.then((exitCode) => {
      exited = true
      return exitCode
    })
    const requestStop = (reason: HostStopReason) => {
      if (stopReason) return
      stopReason = reason
      killProcessGroup(current, "SIGTERM")
      forceKill = setTimeout(() => {
        if (!exited) killProcessGroup(current, "SIGKILL")
      }, 100)
    }
    const timeout = setTimeout(() => requestStop("timeout"), input.timeoutMs)
    try {
      await current.stdin.write(input.stdin)
      await current.stdin.end()
      const [exitCode, stdout, stderr] = await Promise.all([
        exitedPromise,
        readBounded(current.stdout, input.maxStdoutBytes, () => requestStop("stdout_limit_exceeded")),
        readBounded(current.stderr, input.maxStderrBytes, () => requestStop("stderr_limit_exceeded")),
      ])
      return {
        status: stopReason ? "effect_unknown" : "observed",
        started: true,
        ...(stopReason ? { reason: stopReason } : {}),
        termination: { kind: "exited", exitCode },
        stdout,
        stderr,
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    if (!child) {
      return {
        status: "observed",
        started: false,
        termination: { kind: "exited", exitCode: 127 },
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }
    }
    return {
      status: "effect_unknown",
      started: true,
      reason: "process_observation_failed",
      termination: exited ? { kind: "exited", exitCode: await child.exited } : { kind: "unconfirmed" },
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    }
  } finally {
    if (forceKill) clearTimeout(forceKill)
    if (child && !exited) killProcessGroup(child, "SIGKILL")
  }
}

async function revalidateExecutable(
  expected: ControlledWriteCapabilityProposal["capability"]["manifest"]["process"]["executable"],
) {
  if ((await realpath(expected.canonicalPath).catch(() => null)) !== expected.canonicalPath) return null
  const handle = await open(expected.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return null
  try {
    const before = await handle.stat()
    const pathFacts = await lstat(expected.canonicalPath).catch(() => null)
    if (
      !before.isFile() ||
      !pathFacts?.isFile() ||
      pathFacts.isSymbolicLink() ||
      before.dev !== pathFacts.dev ||
      before.ino !== pathFacts.ino ||
      String(before.dev) !== expected.device ||
      String(before.ino) !== expected.inode ||
      (before.mode & 0o111) === 0 ||
      (before.mode & 0o022) !== 0
    ) {
      return null
    }
    const digest = await digestHandle(handle)
    const after = await handle.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      digest !== expected.digest
    ) {
      return null
    }
    return expected
  } finally {
    await handle.close().catch(() => {})
  }
}

async function targetStillAbsent(target: string, expectedWorkspaceIdentity: WorkspaceIdentity) {
  const targetFacts = await lstat(target).catch((cause) => (isNodeError(cause, "ENOENT") ? null : false))
  if (targetFacts !== null) return false
  const parent = dirname(target)
  const parentFacts = await lstat(parent).catch(() => null)
  return Boolean(
    parentFacts?.isDirectory() &&
      !parentFacts.isSymbolicLink() &&
      String(parentFacts.dev) === expectedWorkspaceIdentity.device &&
      String(parentFacts.ino) === expectedWorkspaceIdentity.inode,
  )
}

async function digestHandle(handle: Awaited<ReturnType<typeof open>>) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, offset)
    if (result.bytesRead === 0) return `sha256:${hash.digest("hex")}`
    hash.update(buffer.subarray(0, result.bytesRead))
    offset += result.bytesRead
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
  const output = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function hostEvidence(
  proposal: ControlledWriteCapabilityProposal,
  executable: ControlledWriteCapabilityProposal["capability"]["manifest"]["process"]["executable"],
  processResult: HostProcessResult,
): ControlledWriteExecutionEvidence {
  return {
    backend: "host",
    capabilityDigest: proposal.capability.capabilityDigest,
    executionImage: executable,
    termination: processResult.termination,
    cleanupSucceeded: null,
    stdoutDigest: sha256(processResult.stdout),
    stderrDigest: sha256(processResult.stderr),
  }
}

function notStarted(proposal: ControlledWriteCapabilityProposal): ControlledWriteExecutionEvidence {
  return {
    backend: "host",
    capabilityDigest: proposal.capability.capabilityDigest,
    executionImage: null,
    termination: { kind: "not_started" },
    cleanupSucceeded: null,
    stdoutDigest: null,
    stderrDigest: null,
  }
}

function exactReceipt(plan: ControlledWritePlan, receipt: Awaited<ReturnType<typeof verifyControlledWrite>>) {
  return (
    receipt.workspaceIdentityMatched &&
    receipt.targetIdentityMatched &&
    receipt.observedDigest === receipt.expectedDigest &&
    receipt.bytes === Buffer.byteLength(plan.content)
  )
}

function killProcessGroup(child: Bun.Subprocess, signal: NodeJS.Signals) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process may already have exited between observation and termination.
    }
  }
}

function sha256(input: Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}
