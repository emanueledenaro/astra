import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import { astraProviderConnectExitCode } from "@astra/domain/tui-handoff"
import type { GitRepositoryBaselineRevalidationResult } from "@astra/domain/git-repository-baseline"
import type { WorkspaceRevalidation } from "@astra/runtime/preflight"
import { startAstraTuiControlServer, type AstraTuiControlServer } from "./tui-control-server"
import type { AstraWorkspaceSessionResult } from "./workspace-session"
import { createAstraControlledWriteControl } from "./controlled-write-control"
import { operationLedgerPath, receiptSpoolPath } from "./app-state"
import { loadParentAnthropicAuthReader, type ParentAnthropicAuthReaderHandle } from "./provider-auth-reader"
import { readAstraProviderCatalog } from "./provider-catalog"
import { createAstraProviderControl } from "./provider-control"
import { startAstraProviderControlServer, type AstraProviderControlServer } from "./provider-control-server"
import { createParentProviderCredentialBroker, type ParentProviderCredentialBroker } from "./provider-credential-broker"
import { createAstraSkillActivationControl, type AstraSkillActivationControl } from "./skill-activation-control"
import { createAstraGitUnstageControl } from "./git-unstage-control"
import { createAstraGitStageControl } from "./git-stage-control"
import { createAstraGitCommitControl } from "./git-commit-control"
import { createAstraGitSessionAuthority } from "./git-session-authority"
import { createAstraOperationViewControl } from "./operation-view-control"
import { createAstraGovernedWorkspaceSearchControl } from "./governed-workspace-search-control"
import { createAstraHostCommandControl } from "./host-command-control"
import { createAstraExtensionInventoryControl } from "./extension-inventory-control"
import {
  createParentPrivateMcpRegistry,
  inspectTrustedExtensionInventoryHelper,
} from "@astra/runtime/extension-inventory-operation"
import { createAstraMcpActivationControl } from "./mcp-activation-control"
import { createAstraMcpActivationAdapter } from "./mcp-activation-adapter"
import { connectParentAnthropicCredential } from "./provider-connect"

export type AstraTuiMode = "read-only" | "activate-once"

export type AstraTuiLaunchSpec = Readonly<{
  command: ReadonlyArray<string>
  cwd: string
  env: Readonly<Record<string, string>>
}>

export type AstraAuthorityFile = Readonly<{
  directory: string
  path: string
  digest: string
  authority: AstraSessionAuthority
}>

export type AstraTuiControlReference = Pick<AstraTuiControlServer, "socketPath" | "token">
export type AstraProviderControlReference = Pick<AstraProviderControlServer, "socketPath" | "token">

type OpenedWorkspace = Extract<AstraWorkspaceSessionResult, { status: "opened" }>

/** Wires the parent provider to the exact skill authority owned by this TUI session. */
export function makeAstraProviderSessionDependencies(
  credentialBroker: ParentProviderCredentialBroker,
  skillBundleSource: Pick<AstraSkillActivationControl, "takePromptBundle">,
) {
  return Object.freeze({ readCatalog: readAstraProviderCatalog, credentialBroker, skillBundleSource })
}

export function makeAstraTuiLaunchSpec(
  workspace: string,
  mode: AstraTuiMode,
  authority: Pick<AstraAuthorityFile, "path" | "digest">,
  control: AstraTuiControlReference,
  provider?: AstraProviderControlReference,
): AstraTuiLaunchSpec {
  const opencodePackage = fileURLToPath(new URL("../../opencode", import.meta.url))
  const opencodeEntrypoint = fileURLToPath(new URL("../../opencode/src/index.ts", import.meta.url))
  const permission = { "*": "deny" }
  const environment = astraChildEnvironment(process.env)
  const config = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    lsp: false,
    formatter: false,
    permission,
  })

  return {
    command: [process.execPath, "--conditions=browser", opencodeEntrypoint, "--pure", workspace],
    cwd: opencodePackage,
    env: {
      ...environment,
      ASTRA_SAFE_START: "1",
      ASTRA_WORKSPACE_MODE: mode,
      ASTRA_SESSION_AUTHORITY_FILE: authority.path,
      ASTRA_SESSION_AUTHORITY_DIGEST: authority.digest,
      ASTRA_CONTROL_SOCKET: control.socketPath,
      ASTRA_CONTROL_TOKEN: control.token,
      ...(provider ? { ASTRA_PROVIDER_SOCKET: provider.socketPath, ASTRA_PROVIDER_TOKEN: provider.token } : {}),
      OPENCODE_CLIENT: "astra",
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_PERMISSION: JSON.stringify(permission),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_PURE: "1",
    },
  }
}

export function astraChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const allowed = [
    "COLORTERM",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_COLOR",
    "PATH",
    "SHELL",
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TMPDIR",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ] as const
  return Object.fromEntries(
    allowed.flatMap((name) => (environment[name] === undefined ? [] : [[name, environment[name]] as const])),
  )
}

export async function launchAstraTui(session: OpenedWorkspace) {
  const authority = await createAstraSessionAuthorityFile(session)
  const gitAuthority = createAstraGitSessionAuthority(session)
  let control: AstraTuiControlServer | undefined
  let provider: AstraProviderControlServer | undefined
  let authReader: ParentAnthropicAuthReaderHandle | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  const mcpRegistry = createParentPrivateMcpRegistry()
  const terminate = (signal: NodeJS.Signals) => {
    if (child && child.exitCode === null) child.kill(signal)
  }
  const onHangup = () => terminate("SIGHUP")
  const onTerminate = () => terminate("SIGTERM")
  process.once("SIGHUP", onHangup)
  process.once("SIGTERM", onTerminate)
  try {
    const skillActivationControl = createAstraSkillActivationControl(
      session,
      { sessionID: authority.authority.sessionID },
      {
        ledgerFilename: operationLedgerPath(),
        spoolFilename: receiptSpoolPath(),
        privateRuntimeDirectory: authority.directory,
      },
    )
    const extensionInventoryControl = createAstraExtensionInventoryControl(session, {
      helper: await inspectTrustedExtensionInventoryHelper(
        fileURLToPath(
          new URL("../../../tools/astra-extension-inventory-native/build/astra-extension-inventory", import.meta.url),
        ),
      ),
      ledgerFilename: operationLedgerPath(),
      spoolFilename: receiptSpoolPath(),
      mcpRegistry,
    })
    const mcpActivationControl = createAstraMcpActivationControl(session, {
      registry: mcpRegistry,
      adapter: createAstraMcpActivationAdapter(),
      ledgerFilename: operationLedgerPath(),
      spoolFilename: receiptSpoolPath(),
    })
    control = await startAstraTuiControlServer({
      directory: authority.directory,
      workspaceRoot: authority.authority.workspace.root,
      sessionID: authority.authority.sessionID,
      controlledWriteControl: createAstraControlledWriteControl(session, {
        ledgerFilename: operationLedgerPath(),
        spoolFilename: receiptSpoolPath(),
      }),
      gitStageControl: createAstraGitStageControl(
        session,
        {
          ledgerFilename: operationLedgerPath(),
          spoolFilename: receiptSpoolPath(),
        },
        undefined,
        gitAuthority,
      ),
      gitCommitControl: createAstraGitCommitControl(
        session,
        {
          ledgerFilename: operationLedgerPath(),
          spoolFilename: receiptSpoolPath(),
        },
        undefined,
        gitAuthority,
      ),
      operationViewControl: createAstraOperationViewControl({ ledgerFilename: operationLedgerPath() }),
      gitUnstageControl: createAstraGitUnstageControl(
        session,
        {
          ledgerFilename: operationLedgerPath(),
          spoolFilename: receiptSpoolPath(),
        },
        undefined,
        gitAuthority,
      ),
      governedWorkspaceSearchControl: createAstraGovernedWorkspaceSearchControl(session, {
        ledgerFilename: operationLedgerPath(),
        spoolFilename: receiptSpoolPath(),
      }),
      hostCommandControl: createAstraHostCommandControl(session, {
        ledgerFilename: operationLedgerPath(),
        spoolFilename: receiptSpoolPath(),
      }),
      skillActivationControl,
      extensionInventoryControl,
      mcpActivationControl,
    })
    while (true) {
      authReader = await loadParentAnthropicAuthReader()
      const credentialBroker = createParentProviderCredentialBroker({ auth: authReader })
      provider = await startAstraProviderControlServer({
        directory: authority.directory,
        sessionID: authority.authority.sessionID,
        control: createAstraProviderControl(
          session,
          authority.authority.sessionID,
          { ledgerFilename: operationLedgerPath(), spoolFilename: receiptSpoolPath() },
          makeAstraProviderSessionDependencies(credentialBroker, skillActivationControl),
        ),
      })
      const spec = makeAstraTuiLaunchSpec(session.report.root, session.mode, authority, control, provider)
      child = Bun.spawn([...spec.command], {
        cwd: spec.cwd,
        env: spec.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      const exitCode = await child.exited
      child = undefined
      if (exitCode !== astraProviderConnectExitCode) return exitCode

      await provider.close()
      provider = undefined
      await authReader.close()
      authReader = undefined
      try {
        await connectParentAnthropicCredential()
      } catch {
        process.stderr.write(
          "Provider connection did not complete cleanly; credential state may be uncertain. Returning to Astra.\n",
        )
      }
    }
  } finally {
    process.off("SIGHUP", onHangup)
    process.off("SIGTERM", onTerminate)
    try {
      try {
        try {
          await provider?.close()
        } finally {
          await authReader?.close()
        }
      } finally {
        await control?.close()
      }
    } finally {
      mcpRegistry.clear()
      await rm(authority.directory, { recursive: true, force: true })
    }
  }
}

export async function createAstraSessionAuthorityFile(
  session: OpenedWorkspace,
  dependencies: Readonly<{
    revalidateWorkspacePreflight: (report: OpenedWorkspace["report"]) => Promise<WorkspaceRevalidation>
    revalidateGitRepositoryBaseline: (
      root: string,
      snapshot: NonNullable<OpenedWorkspace["repositoryBaseline"]>,
    ) => Promise<GitRepositoryBaselineRevalidationResult>
    createAuthorityDirectory?: () => Promise<string>
    writeAuthorityFile?: (path: string, content: string) => Promise<void>
  }> = {
    async revalidateWorkspacePreflight(report) {
      const runtime = await import("@astra/runtime/preflight")
      return runtime.revalidateWorkspacePreflight(report)
    },
    async revalidateGitRepositoryBaseline(root, snapshot) {
      const git = await import("@astra/git")
      return git.revalidateGitRepositoryBaseline(root, snapshot)
    },
  },
): Promise<AstraAuthorityFile> {
  const current = await dependencies.revalidateWorkspacePreflight(session.report)
  if (!current.matched || !current.report.identity || !current.report.securityDigest) {
    throw new Error("The Astra workspace authority became stale before TUI launch")
  }
  if (session.repositoryBaseline) {
    const repository = await dependencies.revalidateGitRepositoryBaseline(
      current.report.root,
      session.repositoryBaseline,
    )
    if (
      repository.status !== "current" ||
      repository.expectedSnapshotDigest !== session.repositoryBaseline.snapshotDigest ||
      repository.currentSnapshotDigest !== session.repositoryBaseline.snapshotDigest
    ) {
      throw new Error("The Astra Git authority became stale before TUI launch")
    }
  }

  const value = {
    schemaVersion: 1,
    sessionID: randomUUID(),
    issuedAt: new Date().toISOString(),
    mode: session.mode,
    effectPolicy: "deny",
    workspace: {
      root: current.report.root,
      identity: current.report.identity,
      securityDigest: current.report.securityDigest,
    },
    repositoryBaseline: session.repositoryBaseline ?? null,
  } as const satisfies AstraSessionAuthority
  const content = JSON.stringify(value)
  const directory = dependencies.createAuthorityDirectory
    ? await dependencies.createAuthorityDirectory()
    : await realpath(await mkdtemp(join(tmpdir(), "astra-session-")))
  const path = join(directory, "authority.json")
  try {
    if (dependencies.writeAuthorityFile) await dependencies.writeAuthorityFile(path, content)
    else await writeFile(path, content, { flag: "wx", mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    directory,
    path,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    authority: value,
  }
}
