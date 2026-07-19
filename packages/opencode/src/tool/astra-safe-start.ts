import { Flag } from "@opencode-ai/core/flag/flag"

export const astraSafeStartFileMutationMessage =
  "Generic file mutation is blocked until the Astra Operation Kernel authorizes it"

/** Keeps inherited file tools behind Astra's governed mutation boundary. */
export function assertAstraFileMutationEnabled() {
  if (Flag.ASTRA_SAFE_START) throw new Error(astraSafeStartFileMutationMessage)
}
