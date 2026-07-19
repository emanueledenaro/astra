import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  computeExecutionCapabilityDigest,
  parseExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityManifest,
} from "@astra/domain/execution-capability"
import type { GitRepositoryBaselineSnapshot } from "@astra/domain/git-repository-baseline"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseOperationID,
  type AttemptID,
  type CapabilityGrantID,
  type ContentDigest,
  type OperationID,
} from "@astra/domain/operation-contract"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import type { ControlledWritePlan } from "./controlled-write-plan"
import { canonicalJson, deterministicUUID, makeControlledWriteBaselineAuthority } from "./controlled-write-authority"

const authorizationLifetimeMilliseconds = 300_000
const workerTimeoutMilliseconds = 5_000
const workerOutputLimitBytes = 16_384

export const controlledWriteWorkerProgram = String.raw`
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const chunks = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  !input ||
  typeof input !== "object" ||
  Array.isArray(input) ||
  Object.keys(input).sort().join(",") !== "contentBase64,target" ||
  typeof input.target !== "string" ||
  typeof input.contentBase64 !== "string"
) throw new TypeError("Invalid controlled write input");
const content = Buffer.from(input.contentBase64, "base64");
if (content.toString("base64") !== input.contentBase64) throw new TypeError("Invalid controlled write content");
const handle = await open(
  input.target,
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
  0o600,
);
try {
  await handle.writeFile(content);
  await handle.sync();
} finally {
  await handle.close();
}
process.stdout.write(JSON.stringify({ bytes: content.byteLength, status: "effect_observed" }));
`

export function makeControlledWriteHostArguments(program: string) {
  return ["--no-install", "--no-env-file", "--config=/dev/null", "--eval", program] as const
}

export type ControlledWriteCapabilityProposal = Readonly<{
  capability: ExecutionCapability
  program: string
  stdin: string
}>

export type ProposeControlledWriteCapabilityInput = Readonly<{
  plan: ControlledWritePlan
  report: WorkspaceTrustReport
  repositoryBaseline?: GitRepositoryBaselineSnapshot
  policyAskedAt: string
}>

/**
 * Produces the exact immutable authority shown for consent. This performs only
 * bounded reads; executable sealing and every process or write happen later.
 */
export async function proposeControlledWriteCapability(
  input: ProposeControlledWriteCapabilityInput,
): Promise<ControlledWriteCapabilityProposal> {
  if (process.platform !== "darwin") throw new TypeError("Controlled host execution is unavailable on this platform")
  if (input.report.completeness !== "complete" || !input.report.identity || !input.report.securityDigest) {
    throw new TypeError("A complete preflight is required for a controlled write capability")
  }
  if (input.plan.workspaceRoot !== input.report.root) {
    throw new TypeError("The plan and preflight workspace do not match")
  }
  const executable = await inspectExecutableSource(process.execPath)
  const proposal = makeProposalFacts(input, executable)
  const parsed = parseExecutionCapability({
    manifest: proposal.manifest,
    capabilityDigest: computeExecutionCapabilityDigest(proposal.manifest),
  })
  if (!parsed.ok) throw new TypeError("The controlled write capability is invalid")
  return Object.freeze({ capability: parsed.value, program: proposal.program, stdin: proposal.stdin })
}

/** Revalidates that consent, durable authority, and executor input describe one exact effect. */
export function validateControlledWriteCapabilityProposal(
  input: ProposeControlledWriteCapabilityInput,
  proposal: ControlledWriteCapabilityProposal,
): ExecutionCapability {
  const parsed = parseExecutionCapability(proposal.capability)
  if (!parsed.ok) throw new TypeError("The controlled write capability is invalid")
  const expected = makeProposalFacts(input, parsed.value.manifest.process.executable)
  if (
    proposal.program !== expected.program ||
    proposal.stdin !== expected.stdin ||
    canonicalJson(parsed.value.manifest) !== canonicalJson(expected.manifest)
  ) {
    throw new TypeError("The controlled write capability does not match the proposed effect")
  }
  return parsed.value
}

function makeProposalFacts(
  input: ProposeControlledWriteCapabilityInput,
  executable: ExecutionCapabilityManifest["process"]["executable"],
) {
  if (process.platform !== "darwin") throw new TypeError("Controlled host execution is unavailable on this platform")
  if (input.report.completeness !== "complete" || !input.report.identity || !input.report.securityDigest) {
    throw new TypeError("A complete preflight is required for a controlled write capability")
  }
  if (input.plan.workspaceRoot !== input.report.root) {
    throw new TypeError("The plan and preflight workspace do not match")
  }
  const askedAt = requireCanonicalTimestamp(input.policyAskedAt)
  const operationID = requireOperationID(input.plan.operationId)
  const attemptID = requireAttemptID(deterministicUUID(operationID, "attempt:1"))
  const capabilityGrantID = requireCapabilityGrantID(deterministicUUID(operationID, "capability:1"))
  const baseline = makeControlledWriteBaselineAuthority(input.report, input.repositoryBaseline)
  const program = controlledWriteWorkerProgram
  const target = join(input.report.root, input.plan.relativePath)
  const stdin = JSON.stringify({ contentBase64: Buffer.from(input.plan.content).toString("base64"), target })
  const runtimeScratch = join(homedir(), "Library", "Application Support", "Astra", "Runtime", capabilityGrantID)
  const manifest = {
    schemaVersion: 1,
    grant: {
      capabilityGrantID,
      operationID,
      attemptID,
      baselineDigest: requireContentDigest(baseline.baselineDigest),
      expiresAt: new Date(Date.parse(askedAt) + authorizationLifetimeMilliseconds).toISOString(),
    },
    isolation: { platform: "darwin", backend: "host", fallback: "deny" },
    process: {
      executable,
      programDigest: sha256(Buffer.from(program, "utf8")),
      arguments: makeControlledWriteHostArguments(program),
      workingDirectory: "/",
      stdinDigest: sha256(Buffer.from(stdin, "utf8")),
    },
    filesystem: {
      mode: "bounded_paths",
      workspace: { canonicalPath: input.report.root, ...input.report.identity },
      runtimeScratch: { canonicalPath: runtimeScratch, lifecycle: "private_ephemeral" },
      readOnlyRoots: [input.report.root],
      createOnlyFiles: [target],
      writableFiles: [],
    },
    network: { mode: "host_unrestricted" },
    environment: {
      variables: [
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TZ", value: "UTC" },
      ],
    },
    limits: {
      timeoutMs: workerTimeoutMilliseconds,
      maxStdoutBytes: workerOutputLimitBytes,
      maxStderrBytes: workerOutputLimitBytes,
    },
  } as const satisfies ExecutionCapabilityManifest
  return { manifest, program, stdin } as const
}

async function inspectExecutableSource(path: string): Promise<ExecutionCapabilityManifest["process"]["executable"]> {
  const canonicalPath = await realpath(path)
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    const currentUser = process.getuid?.()
    if (
      !before.isFile() ||
      (before.mode & 0o111) === 0 ||
      (before.mode & 0o022) !== 0 ||
      (currentUser !== undefined && before.uid !== 0 && before.uid !== currentUser)
    ) {
      throw new TypeError("The Bun executable source is not trusted")
    }
    const digest = await digestHandle(handle)
    const after = await handle.stat()
    if (!sameFile(before, after)) throw new TypeError("The Bun executable changed during capability preparation")
    return Object.freeze({
      canonicalPath,
      device: String(after.dev),
      inode: String(after.ino),
      digest,
    })
  } finally {
    await handle.close().catch(() => {})
  }
}

async function digestHandle(handle: Awaited<ReturnType<typeof open>>): Promise<ContentDigest> {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, offset)
    if (result.bytesRead === 0) break
    hash.update(buffer.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
  return requireContentDigest(`sha256:${hash.digest("hex")}`)
}

function sameFile(left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, right: typeof left) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sha256(input: Uint8Array): ContentDigest {
  return requireContentDigest(`sha256:${createHash("sha256").update(input).digest("hex")}`)
}

function requireCanonicalTimestamp(input: string) {
  const milliseconds = Date.parse(input)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    throw new TypeError("The capability proposal time must be a canonical UTC timestamp")
  }
  return input
}

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new TypeError("The capability digest is invalid")
  return parsed.value
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new TypeError("The capability Operation ID is invalid")
  return parsed.value
}

function requireAttemptID(input: string): AttemptID {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new TypeError("The capability attempt ID is invalid")
  return parsed.value
}

function requireCapabilityGrantID(input: string): CapabilityGrantID {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new TypeError("The capability grant ID is invalid")
  return parsed.value
}
