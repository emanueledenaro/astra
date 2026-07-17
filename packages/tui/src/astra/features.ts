import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createAstraGitInspectionClient, type AstraGitInspectionClient } from "./control-client"
import { createAstraControlledWriteClient, type AstraControlledWriteClient } from "./controlled-write-client"
import { registerAstraExtensions } from "../feature-plugins/system/astra-extensions"
import { registerAstraControlledWrite } from "../feature-plugins/system/astra-controlled-write"
import { registerAstraGitControlPlane } from "../feature-plugins/system/astra-git-control"
import { registerAstraChat } from "../feature-plugins/system/astra-chat"
import type { AstraProviderClient } from "./provider-client"
import { createAstraSkillActivationClient, type AstraSkillActivationClient } from "./skill-activation-client"
import { registerAstraSkillActivation } from "../feature-plugins/system/astra-skill-activation"
import { createAstraGitUnstageClient, type AstraGitUnstageClient } from "./git-unstage-client"
import { registerAstraGitUnstage } from "../feature-plugins/system/astra-git-unstage"
import { createAstraGitStageClient, type AstraGitStageClient } from "./git-stage-client"
import { registerAstraGitStage } from "../feature-plugins/system/astra-git-stage"
import {
  createAstraGovernedWorkspaceSearchClient,
  type AstraGovernedWorkspaceSearchClient,
} from "./governed-workspace-search-client"
import { registerAstraGovernedWorkspaceSearch } from "../feature-plugins/system/astra-governed-workspace-search"
import { createAstraExtensionInventoryClient, type AstraExtensionInventoryClient } from "./extension-inventory-client"
import { createAstraMcpActivationClient, type AstraMcpActivationClient } from "./mcp-activation-client"

/** Registers built-in Astra surfaces from the authority validated at process admission. */
export function registerAstraAppFeatures(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  gitInspectionClient?: AstraGitInspectionClient,
  controlledWriteClient?: AstraControlledWriteClient,
  providerClient?: AstraProviderClient,
  skillActivationClient?: AstraSkillActivationClient,
  gitUnstageClient?: AstraGitUnstageClient,
  governedWorkspaceSearchClient?: AstraGovernedWorkspaceSearchClient,
  extensionInventoryClient?: AstraExtensionInventoryClient,
  gitStageClient?: AstraGitStageClient,
  mcpActivationClient?: AstraMcpActivationClient,
) {
  registerAstraChat(api, authority, providerClient)
  registerAstraGitControlPlane(
    api,
    authority,
    gitInspectionClient ?? createAstraGitInspectionClient(process.env, authority.sessionID),
  )
  registerAstraControlledWrite(
    api,
    authority,
    controlledWriteClient ?? createAstraControlledWriteClient(process.env, authority.sessionID),
  )
  registerAstraSkillActivation(
    api,
    authority,
    skillActivationClient ?? createAstraSkillActivationClient(process.env, authority.sessionID),
  )
  registerAstraGitUnstage(
    api,
    authority,
    gitUnstageClient ??
      createAstraGitUnstageClient(process.env, authority.sessionID, {
        expectedWorkspaceRoot: authority.workspace.root,
        ...(authority.repositoryBaseline
          ? { expectedBaselineSnapshotDigest: authority.repositoryBaseline.snapshotDigest }
          : {}),
      }),
  )
  registerAstraGitStage(
    api,
    authority,
    gitStageClient ??
      createAstraGitStageClient(process.env, authority.sessionID, {
        expectedWorkspaceRoot: authority.workspace.root,
        ...(authority.repositoryBaseline
          ? { expectedBaselineSnapshotDigest: authority.repositoryBaseline.snapshotDigest }
          : {}),
      }),
  )
  registerAstraGovernedWorkspaceSearch(
    api,
    authority,
    governedWorkspaceSearchClient ??
      createAstraGovernedWorkspaceSearchClient(process.env, authority.sessionID, {
        expectedWorkspaceRoot: authority.workspace.root,
      }),
  )
  registerAstraExtensions(
    api,
    authority,
    extensionInventoryClient ?? createAstraExtensionInventoryClient(process.env, authority.sessionID, authority.mode),
    mcpActivationClient ?? createAstraMcpActivationClient(process.env, authority.sessionID, authority.mode),
  )
}
