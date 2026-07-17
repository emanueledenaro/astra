import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { SeatbeltProbeResult } from "./types"

const sandboxPath = "/usr/bin/sandbox-exec" as const
const codesignPath = "/usr/bin/codesign"
const truePath = "/usr/bin/true"
const signatureRequirement = '=anchor apple and identifier "com.apple.sandbox-exec"'

export type SeatbeltProbeDependencies = Readonly<{
  platform: string
  verifySystemExecutable: (path: string) => Promise<boolean>
  verifyAppleSignature: (codesign: string, sandbox: string) => Promise<boolean>
  runProfileProbe: (sandbox: string, executable: string) => Promise<boolean>
}>

/** Verifies that the deprecated macOS Seatbelt entrypoint is still trustworthy and operational. */
export async function probeDarwinSeatbelt(): Promise<SeatbeltProbeResult> {
  return probeDarwinSeatbeltWithDependencies({
    platform: process.platform,
    verifySystemExecutable: trustedRootOwnedExecutable,
    verifyAppleSignature,
    runProfileProbe,
  })
}

export async function probeDarwinSeatbeltWithDependencies(
  dependencies: SeatbeltProbeDependencies,
): Promise<SeatbeltProbeResult> {
  if (dependencies.platform !== "darwin") return { available: false, reason: "unsupported_platform" }
  const trusted = await Promise.all(
    [sandboxPath, codesignPath, truePath].map((path) => dependencies.verifySystemExecutable(path).catch(() => false)),
  )
  if (trusted.some((value) => !value)) return { available: false, reason: "system_executable_untrusted" }
  if (!(await dependencies.verifyAppleSignature(codesignPath, sandboxPath).catch(() => false))) {
    return { available: false, reason: "apple_signature_invalid" }
  }
  if (!(await dependencies.runProfileProbe(sandboxPath, truePath).catch(() => false))) {
    return { available: false, reason: "profile_probe_failed" }
  }
  return { available: true, sandboxPath }
}

async function trustedRootOwnedExecutable(candidate: string) {
  if ((await realpath(candidate).catch(() => null)) !== candidate) return false
  const root = await lstat("/").catch(() => null)
  if (!root?.isDirectory() || !trustedOwnerAndMode(root.uid, root.mode)) return false
  const parts = candidate.split("/").filter(Boolean)
  let current = "/"
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const facts = await lstat(current).catch(() => null)
    if (!facts || facts.isSymbolicLink() || !trustedOwnerAndMode(facts.uid, facts.mode)) return false
    if (index < parts.length - 1 && !facts.isDirectory()) return false
    if (index === parts.length - 1 && (!facts.isFile() || (facts.mode & 0o111) === 0)) return false
  }
  return true
}

async function verifyAppleSignature(codesign: string, sandbox: string) {
  return runProbeCommand([codesign, "--verify", "--strict", "--verbose=2", "-R", signatureRequirement, sandbox])
}

async function runProfileProbe(sandbox: string, executable: string) {
  return runProbeCommand([sandbox, "-p", "(version 1) (allow default) (deny network*) (deny file-write*)", executable])
}

async function runProbeCommand(arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn([...arguments_], {
    cwd: "/",
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 2_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readProbeOutput(child.stdout, 16 * 1024),
      readProbeOutput(child.stderr, 16 * 1024),
    ])
    return !timedOut && stdout && stderr && exitCode === 0
  } finally {
    clearTimeout(timer)
  }
}

async function readProbeOutput(stream: ReadableStream<Uint8Array>, limit: number) {
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > limit) return false
  }
  return true
}

function trustedOwnerAndMode(uid: number, mode: number) {
  return uid === 0 && (mode & 0o022) === 0
}
