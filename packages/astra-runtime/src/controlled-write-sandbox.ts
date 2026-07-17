import { createHash } from "node:crypto"
import type { WorkspaceIdentity } from "@astra/domain/workspace-trust"
import { executeApprovedDarwinCreateOnly, type SandboxExecutionResult } from "@astra/sandbox"
import {
  verifyControlledWrite,
  type ControlledWriteExecutionEvidence,
  type ControlledWriteResult,
} from "./controlled-write"
import type { ControlledWriteCapabilityProposal } from "./controlled-write-capability"
import type { ControlledWritePlan } from "./controlled-write-plan"

/** Runs the exact approved worker with no unsandboxed fallback. */
export async function executeSandboxedControlledWrite(
  proposal: ControlledWriteCapabilityProposal,
  plan: ControlledWritePlan,
  target: string,
  expectedWorkspaceIdentity: WorkspaceIdentity,
): Promise<ControlledWriteResult> {
  const result = await executeApprovedDarwinCreateOnly({
    capability: proposal.capability,
    program: proposal.program,
    stdin: Buffer.from(proposal.stdin, "utf8"),
  })
  const evidence = executionEvidence(result, proposal.capability.capabilityDigest)
  if (result.status === "blocked") {
    return { status: "failed_without_effect", reason: `sandbox_blocked:${result.reason}`, execution: evidence }
  }

  const receipt = await verifyControlledWrite(plan, target, expectedWorkspaceIdentity)
  if (result.status === "effect_unknown") {
    return { status: "effect_unknown", reason: `sandbox_${result.reason}`, receipt, execution: evidence }
  }
  if (result.termination.exitCode !== 0) {
    return receipt.targetIdentity === null
      ? {
          status: "failed_without_effect",
          reason: `sandbox_exit_${result.termination.exitCode}`,
          execution: evidence,
        }
      : {
          status: "effect_observed_unverified",
          reason: `sandbox_exit_${result.termination.exitCode}`,
          receipt,
          execution: evidence,
        }
  }
  if (!exactReceipt(plan, receipt)) {
    return { status: "effect_observed_unverified", reason: "sandbox_readback_mismatch", receipt, execution: evidence }
  }
  return { status: "effect_observed", receipt, execution: evidence }
}

function exactReceipt(plan: ControlledWritePlan, receipt: Awaited<ReturnType<typeof verifyControlledWrite>>) {
  return (
    receipt.workspaceIdentityMatched &&
    receipt.targetIdentityMatched &&
    receipt.observedDigest === receipt.expectedDigest &&
    receipt.bytes === Buffer.byteLength(plan.content)
  )
}

function executionEvidence(result: SandboxExecutionResult, capabilityDigest: string): ControlledWriteExecutionEvidence {
  if (result.status === "blocked") {
    return {
      backend: "darwin-seatbelt",
      capabilityDigest,
      executionImage: null,
      termination: { kind: "not_started" },
      cleanupSucceeded: null,
      stdoutDigest: null,
      stderrDigest: null,
    }
  }
  return {
    backend: result.backend,
    capabilityDigest: result.capabilityDigest,
    executionImage: result.sealedExecutable ?? null,
    termination: result.termination,
    cleanupSucceeded: result.cleanupSucceeded,
    stdoutDigest: sha256(result.stdout),
    stderrDigest: sha256(result.stderr),
  }
}

function sha256(input: Uint8Array) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
