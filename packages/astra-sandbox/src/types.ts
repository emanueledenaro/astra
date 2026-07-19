import type { ExecutionCapability } from "@astra/domain/execution-capability"
import type { ContentDigest } from "@astra/domain/operation-contract"

export type SandboxBlockReason =
  | "unsupported_platform"
  | "invalid_capability"
  | "authority_expired"
  | "program_binding_mismatch"
  | "stdin_binding_mismatch"
  | "unsupported_execution_shape"
  | "sandbox_unavailable"
  | "source_executable_untrusted"
  | "workspace_identity_mismatch"
  | "runtime_scratch_unsafe"
  | "create_target_not_absent"
  | "sealed_executable_failed"
  | "process_spawn_failed"

export type SandboxUnknownReason =
  | "timeout"
  | "stdout_limit_exceeded"
  | "stderr_limit_exceeded"
  | "process_io_failed"
  | "process_termination_failed"
  | "cleanup_failed"

export type SealedExecutableIdentity = Readonly<{
  canonicalPath: string
  device: string
  inode: string
  digest: ContentDigest
}>

type ExecutionEvidence = Readonly<{
  backend: "darwin-seatbelt"
  capabilityDigest: ContentDigest
  stdout: Uint8Array
  stderr: Uint8Array
  cleanupSucceeded: boolean
}>

export type SandboxExecutionResult =
  | Readonly<{ status: "blocked"; reason: SandboxBlockReason }>
  | (ExecutionEvidence &
      Readonly<{
        status: "observed"
        sealedExecutable: SealedExecutableIdentity
        termination: Readonly<{ kind: "exited"; exitCode: number }>
      }>)
  | (ExecutionEvidence &
      Readonly<{
        status: "effect_unknown"
        reason: SandboxUnknownReason
        sealedExecutable?: SealedExecutableIdentity
        termination: Readonly<{ kind: "exited"; exitCode: number }> | Readonly<{ kind: "unconfirmed" }>
      }>)

export type ApprovedDarwinCreateOnlyInput = Readonly<{
  capability: ExecutionCapability
  program: string
  stdin: Uint8Array
}>

export type SeatbeltProbeResult =
  | Readonly<{ available: true; sandboxPath: "/usr/bin/sandbox-exec" }>
  | Readonly<{
      available: false
      reason:
        | "unsupported_platform"
        | "system_executable_untrusted"
        | "apple_signature_invalid"
        | "profile_probe_failed"
    }>
