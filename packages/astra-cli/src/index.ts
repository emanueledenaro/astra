#!/usr/bin/env -S bun --config=/dev/null --no-env-file --no-install

import { fileURLToPath } from "node:url"
import {
  runWorkspaceGate,
  type DurableDenial,
  type DurableExecution,
  type DurableVerification,
  type EffectApproval,
  type GitInspection,
  type WorkspaceDecision,
} from "./workspace-gate"
import { operationLedgerPath, receiptSpoolPath } from "./app-state"
import { createTerminalIO } from "./terminal-io"
import { openAstraWorkspaceSession } from "./workspace-session"
import { parseAstraArguments } from "./arguments"
import { routeAstraLaunchpadDecision } from "./launchpad-routing"
import { runAstraSystemControl } from "./system-control"
import { parseAstraLaunchpadDecision } from "@astra/domain/launchpad"
import type { GuidedProjectCreationOutcome } from "./project-creation-control"

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
      repositoryBaseline?: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["recordDeniedOperation"]>
      >[0]["repositoryBaseline"]
      capabilityProposal: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["recordDeniedOperation"]>
      >[0]["capabilityProposal"]
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
      repositoryBaseline?: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["executeApprovedOperation"]>
      >[0]["repositoryBaseline"]
      capabilityProposal: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["executeApprovedOperation"]>
      >[0]["capabilityProposal"]
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
      repositoryBaseline?: Parameters<
        NonNullable<import("./workspace-gate").WorkspaceGateDependencies["verifyApprovedOperation"]>
      >[0]["repositoryBaseline"]
    }>,
  ) => Promise<DurableVerification>
}>

type GitInspectionModule = Readonly<{
  inspectGitWorkspace: (workspaceRoot: string) => Promise<GitInspection>
  captureGitRepositoryBaseline: NonNullable<
    import("./workspace-gate").WorkspaceGateDependencies["captureGitRepositoryBaseline"]
  >
  revalidateGitRepositoryBaseline: NonNullable<
    import("./workspace-gate").WorkspaceGateDependencies["revalidateGitRepositoryBaseline"]
  >
}>

type Arguments =
  | Readonly<{ experience: "no-workspace" }>
  | Readonly<{ experience: "system" }>
  | Readonly<{
      workspace: string
      experience: "product" | "demo"
      decision?: WorkspaceDecision
      approval?: EffectApproval
    }>

const rawArguments = Bun.argv.slice(2)
const commandArguments = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments
const parsed = parseArguments(commandArguments)
if (!parsed.ok) {
  if (parsed.message) console.error(parsed.message)
  printUsage()
  process.exitCode = parsed.help ? 0 : 1
} else {
  if (parsed.arguments.experience === "no-workspace") {
    process.exitCode =
      process.env.ASTRA_BROWSER_RUNTIME === "1" ? await runNoWorkspaceMode() : await relaunchProductWithBrowserRuntime([])
  } else if (parsed.arguments.experience === "system") {
    process.exitCode =
      process.env.ASTRA_BROWSER_RUNTIME === "1"
        ? await runSystemMode()
        : await relaunchProductWithBrowserRuntime(["system"])
  } else if (parsed.arguments.experience === "product") {
    process.exitCode =
      process.env.ASTRA_BROWSER_RUNTIME === "1"
        ? await runProduct(parsed.arguments.workspace)
        : await relaunchProductWithBrowserRuntime(Bun.argv.slice(2))
  } else {
    const terminal = createTerminalIO(parsed.arguments)
    try {
      process.exitCode = (
        await runWorkspaceGate(parsed.arguments.workspace, terminal.io, {
          async inspectGitWorkspace(workspaceRoot) {
            return (await loadGitModule()).inspectGitWorkspace(workspaceRoot)
          },
          async captureGitRepositoryBaseline(workspaceRoot) {
            return (await loadGitModule()).captureGitRepositoryBaseline(workspaceRoot)
          },
          async revalidateGitRepositoryBaseline(workspaceRoot, snapshot) {
            return (await loadGitModule()).revalidateGitRepositoryBaseline(workspaceRoot, snapshot)
          },
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
}

async function runSystemMode() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Astra System Mode requires an interactive terminal.")
    return 1
  }
  return runAstraSystemControl()
}

async function runNoWorkspaceMode() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printUsage()
    return 0
  }
  const moduleName = ["@opencode-ai/tui", "astra/no-workspace-mode"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isNoWorkspaceModeModule(loaded)) throw new Error("The Astra No Workspace interface is unavailable")
  while (true) {
    const parsedDecision = parseAstraLaunchpadDecision(await loaded.runAstraNoWorkspaceMode())
    if (!parsedDecision.ok) return 1
    const decision = parsedDecision.value
    if (decision.kind === "create-project") {
      const outcome = await runLaunchpadProjectCreation()
      if (outcome.kind === "launchpad") continue
      if (outcome.kind === "open-workspace") return openLaunchpadWorkspace(outcome.path)
      return outcome.exitCode
    }
    return routeAstraLaunchpadDecision(decision, {
      createProject: async () => 1,
      openWorkspace: openLaunchpadWorkspace,
      openSystem: runSystemMode,
    })
  }
}

async function runLaunchpadProjectCreation() {
  const loaded: unknown = await import("./project-creation-control")
  if (!isGuidedProjectCreationModule(loaded)) return { kind: "failed", exitCode: 1 } as const
  return loaded.runGuidedProjectCreation()
}

async function openLaunchpadWorkspace(workspace: string) {
  return process.env.ASTRA_BROWSER_RUNTIME === "1"
    ? runProduct(workspace)
    : relaunchProductWithBrowserRuntime([workspace])
}

async function relaunchProductWithBrowserRuntime(arguments_: ReadonlyArray<string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--config=/dev/null",
      "--no-env-file",
      "--no-install",
      "--conditions=browser",
      fileURLToPath(import.meta.url),
      ...arguments_.filter((value) => value !== "--"),
    ],
    {
      env: { ...process.env, ASTRA_BROWSER_RUNTIME: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  return await child.exited
}

async function runProduct(workspace: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("The Astra workspace interface requires an interactive terminal.")
    return 1
  }
  const workspaceGate = await loadWorkspaceGateModule()
  const result = await openAstraWorkspaceSession(workspace, {
    async present(view) {
      return workspaceGate.chooseAstraWorkspaceMode(view)
    },
    async withProgress(view, operation) {
      return workspaceGate.withAstraWorkspaceProgress(view, operation)
    },
    async inspectGitWorkspace(workspaceRoot) {
      return (await loadGitModule()).inspectGitWorkspace(workspaceRoot)
    },
    async captureGitRepositoryBaseline(workspaceRoot) {
      return (await loadGitModule()).captureGitRepositoryBaseline(workspaceRoot)
    },
    async revalidateGitRepositoryBaseline(workspaceRoot, snapshot) {
      return (await loadGitModule()).revalidateGitRepositoryBaseline(workspaceRoot, snapshot)
    },
  })
  if (result.status === "exited") return 0
  const launcher = await import("./tui-launcher")
  return launcher.launchAstraTui(result)
}

async function loadWorkspaceGateModule() {
  const moduleName = ["@opencode-ai/tui", "astra/workspace-gate"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isWorkspaceGateModule(loaded)) throw new Error("The Astra visual workspace gate is unavailable")
  return loaded
}

async function loadGitModule() {
  const moduleName = ["@astra", "git"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isGitInspectionModule(loaded)) throw new Error("Astra Git adapter is unavailable")
  return loaded
}

type WorkspaceGateModule = Readonly<{
  chooseAstraWorkspaceMode: NonNullable<import("./workspace-session").AstraWorkspaceSessionDependencies["present"]>
  withAstraWorkspaceProgress: NonNullable<
    import("./workspace-session").AstraWorkspaceSessionDependencies["withProgress"]
  >
}>

function isWorkspaceGateModule(value: unknown): value is WorkspaceGateModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "chooseAstraWorkspaceMode" in value &&
    typeof value.chooseAstraWorkspaceMode === "function" &&
    "withAstraWorkspaceProgress" in value &&
    typeof value.withAstraWorkspaceProgress === "function"
  )
}

function parseArguments(
  values: ReadonlyArray<string>,
): Readonly<{ ok: true; arguments: Arguments }> | Readonly<{ ok: false; help: boolean; message?: string }> {
  if (values[0] === "--help" || values[0] === "-h") return { ok: false, help: true }
  if (values[0] === "inspect-git") {
    if (values.length !== 2 || !values[1] || values[1].startsWith("--")) {
      return { ok: false, help: false, message: "The `inspect-git` command requires exactly one workspace path." }
    }
    return { ok: true, arguments: { workspace: values[1], experience: "demo", decision: "inspect-git" } }
  }
  if (values[0] !== "open") return parseProductTarget(values)

  const workspace = values[1]
  if (!workspace || workspace.startsWith("--")) {
    return { ok: false, help: false, message: "A workspace path is required." }
  }

  if (values.length === 3 && values[2] === "--developer-demo") {
    return { ok: true, arguments: { workspace, experience: "demo" } }
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
      experience: decision || approval ? "demo" : "product",
      ...(decision ? { decision } : {}),
      ...(approval ? { approval } : {}),
    },
  }
}

function parseProductTarget(
  values: ReadonlyArray<string>,
): Readonly<{ ok: true; arguments: Arguments }> | Readonly<{ ok: false; help: false; message: string }> {
  const parsed = parseAstraArguments(values)
  if (!parsed.ok) return { ok: false, help: false, message: parsed.reason }
  if (parsed.target.kind === "no-workspace") return { ok: true, arguments: { experience: "no-workspace" } }
  if (parsed.target.kind === "system") return { ok: true, arguments: { experience: "system" } }
  return { ok: true, arguments: { workspace: parsed.target.path, experience: "product" } }
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

function isGitInspectionModule(value: unknown): value is GitInspectionModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "inspectGitWorkspace" in value &&
    typeof value.inspectGitWorkspace === "function" &&
    "captureGitRepositoryBaseline" in value &&
    typeof value.captureGitRepositoryBaseline === "function" &&
    "revalidateGitRepositoryBaseline" in value &&
    typeof value.revalidateGitRepositoryBaseline === "function"
  )
}

function isNoWorkspaceModeModule(value: unknown): value is Readonly<{
  runAstraNoWorkspaceMode: () => Promise<import("@astra/domain/launchpad").AstraLaunchpadDecision>
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "runAstraNoWorkspaceMode" in value &&
    typeof value.runAstraNoWorkspaceMode === "function"
  )
}

function isGuidedProjectCreationModule(value: unknown): value is Readonly<{
  runGuidedProjectCreation: () => Promise<GuidedProjectCreationOutcome>
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "runGuidedProjectCreation" in value &&
    typeof value.runGuidedProjectCreation === "function"
  )
}

function isWorkspaceDecision(value: string): value is WorkspaceDecision {
  return value === "read-only" || value === "inspect-git" || value === "activate-once" || value === "exit"
}

function isEffectApproval(value: string): value is EffectApproval {
  return value === "approve" || value === "deny"
}

function printUsage() {
  console.log("Usage: astra")
  console.log("       astra .")
  console.log("       astra /path/to/workspace")
  console.log("       astra system")
  console.log("       astra open <workspace>")
  console.log("       astra inspect-git <workspace>  # developer diagnostics")
}
