import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { registerAstraGitControlPlane } from "../feature-plugins/system/astra-git-control"

/** Registers built-in Astra surfaces from the authority validated at process admission. */
export function registerAstraAppFeatures(api: TuiPluginApi, authority: AstraSessionAuthority) {
  registerAstraGitControlPlane(api, authority)
}
