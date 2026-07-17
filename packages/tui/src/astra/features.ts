import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createAstraGitInspectionClient, type AstraGitInspectionClient } from "./control-client"
import {
  createAstraControlledWriteClient,
  type AstraControlledWriteClient,
} from "./controlled-write-client"
import { registerAstraExtensions } from "../feature-plugins/system/astra-extensions"
import { registerAstraControlledWrite } from "../feature-plugins/system/astra-controlled-write"
import { registerAstraGitControlPlane } from "../feature-plugins/system/astra-git-control"

/** Registers built-in Astra surfaces from the authority validated at process admission. */
export function registerAstraAppFeatures(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  gitInspectionClient?: AstraGitInspectionClient,
  controlledWriteClient?: AstraControlledWriteClient,
) {
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
  registerAstraExtensions(api, authority)
}
