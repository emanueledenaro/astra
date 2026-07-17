#!/usr/bin/env bun

import {
  runWorkspaceGate,
  type DurableDenial,
  type DurableExecution,
  type DurableVerification,
  type EffectApproval,
  type WorkspaceDecision,
} from "./workspace-gate"
import { operationLedgerPath, receiptSpoolPath } from "./app-state"
import { createTerminalIO } from "./terminal-io"

type DeniedLedgerModule = Readonly<{
  recordDeniedControlledWrite: (
    input: Readonly<{
      filename: string
      plan: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["recordDeniedOperation"]>
      >[0]["plan"]
      report: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["recordDeniedOperation"]>
      >[0]["report"]
    }>,
  ) => Promise<DurableDenial>
}>

type ApprovedCoordinatorModule = Readonly<{
  executeApprovedControlledWrite: (
    input: Readonly<{
      ledgerFilename: string
      spoolFilename: string
      plan: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["executeApprovedOperation"]>
      >[0]["plan"]
      report: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["executeApprovedOperation"]>
      >[0]["report"]
      policyAskedAt: string
      approvalGrantedAt: string
      recordingStartedAt: string
    }>,
  ) => Promise<DurableExecution>
}>

type ApprovedVerifierModule = Readonly<{
  verifyRecordedControlledWrite: (
    input: Readonly<{
      ledgerFilename: string
      plan: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["verifyApprovedOperation"]>
      >[0]["plan"]
      report: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["verifyApprovedOperation"]>
      >[0]["report"]
    }>,
  ) => Promise<DurableVerification>
}>

type Arguments = Readonly<{
  workspace: string
  decision?: WorkspaceDecision
  approval?: EffectApproval
}>

const parsed = parseArguments(Bun.argv.slice(2).filter((value) => value !== "--"))
if (!parsed.ok) {
  if (parsed.message) console.error(parsed.message)
  printUsage()
  process.exitCode = parsed.help ? 0 : 1
} else {
  const terminal = createTerminalIO(parsed.arguments)
  try {
    process.exitCode = (
      await runWorkspaceGate(parsed.arguments.workspace, terminal.io, {
        async recordDeniedOperation(input) {
          const moduleName = ["@astra/runtime", "operation-ledger"].join("/")
          const loaded: unknown = await import(moduleName)
          if (!isOperationLedgerModule(loaded)) throw new Error("Astra Operation ledger adapter is unavailable")
          return loaded.recordDeniedControlledWrite({ filename: operationLedgerPath(), ...input })
        },
        async executeApprovedOperation(input) {
          const moduleName = ["@astra/runtime", "controlled-write-coordinator"].join("/")
          const loaded: unknown = await import(moduleName)
          if (!isApprovedCoordinatorModule(loaded)) throw new Error("Astra durable executor is unavailable")
          return loaded.executeApprovedControlledWrite({
            ledgerFilename: operationLedgerPath(),
            spoolFilename: receiptSpoolPath(),
            ...input,
          })
        },
        async verifyApprovedOperation(input) {
          const moduleName = ["@astra/runtime", "controlled-write-verifier"].join("/")
          const loaded: unknown = await import(moduleName)
          if (!isApprovedVerifierModule(loaded)) throw new Error("Astra independent verifier is unavailable")
          return loaded.verifyRecordedControlledWrite({ ledgerFilename: operationLedgerPath(), ...input })
        },
      })
    ).exitCode
  } finally {
    terminal.close()
  }
}

function parseArguments(
  values: ReadonlyArray<string>,
): Readonly<{ ok: true; arguments: Arguments }> | Readonly<{ ok: false; help: boolean; message?: string }> {
  if (values.length === 0 || values[0] === "--help" || values[0] === "-h") return { ok: false, help: true }
  if (values[0] !== "open") return { ok: false, help: false, message: "Expected the `open` command." }

  const workspace = values[1]
  if (!workspace || workspace.startsWith("--")) {
    return { ok: false, help: false, message: "A workspace path is required." }
  }

  let decision: WorkspaceDecision | undefined
  let approval: EffectApproval | undefined
  for (let index = 2; index < values.length; index += 2) {
    const flag = values[index]
    const value = values[index + 1]
    if (!value) return { ok: false, help: false, message: `Missing value for ${flag}.` }
    if (flag === "--decision" && isWorkspaceDecision(value)) {
      decision = value
      continue
    }
    if (flag === "--approval" && isEffectApproval(value)) {
      approval = value
      continue
    }
    return { ok: false, help: false, message: `Unknown or invalid option: ${flag} ${value}` }
  }

  if (approval && decision !== "activate-once") {
    return { ok: false, help: false, message: "--approval requires --decision activate-once." }
  }
  return {
    ok: true,
    arguments: {
      workspace,
      ...(decision ? { decision } : {}),
      ...(approval ? { approval } : {}),
    },
  }
}

function isOperationLedgerModule(value: unknown): value is DeniedLedgerModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "recordDeniedControlledWrite" in value &&
    typeof value.recordDeniedControlledWrite === "function"
  )
}

function isApprovedCoordinatorModule(value: unknown): value is ApprovedCoordinatorModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "executeApprovedControlledWrite" in value &&
    typeof value.executeApprovedControlledWrite === "function"
  )
}

function isApprovedVerifierModule(value: unknown): value is ApprovedVerifierModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "verifyRecordedControlledWrite" in value &&
    typeof value.verifyRecordedControlledWrite === "function"
  )
}

function isWorkspaceDecision(value: string): value is WorkspaceDecision {
  return value === "read-only" || value === "activate-once" || value === "exit"
}

function isEffectApproval(value: string): value is EffectApproval {
  return value === "approve" || value === "deny"
}

function printUsage() {
  console.log("Usage: astra open <workspace> [--decision read-only|activate-once|exit] [--approval approve|deny]")
}
