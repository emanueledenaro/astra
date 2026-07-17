import { mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { createAstraSessionAuthorityFile } from "../../../astra-cli/src/tui-launcher"
import { scanWorkspace } from "../../../astra-runtime/src/workspace-preflight"

export function withAstraSafeStart<A, E, R>(
  root: string,
  use: (environment: Readonly<Record<string, string>>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const stateRoot = path.join(root, ".astra-safe-state")
      await Promise.all([
        mkdir(path.join(stateRoot, "cache", "opencode", "bin"), { recursive: true }),
        mkdir(path.join(stateRoot, "config", "opencode"), { recursive: true }),
        mkdir(path.join(stateRoot, "data", "opencode", "log"), { recursive: true }),
        mkdir(path.join(stateRoot, "data", "opencode", "repos"), { recursive: true }),
        mkdir(path.join(stateRoot, "state", "opencode"), { recursive: true }),
      ])
      const report = await scanWorkspace(await realpath(root))
      if (report.completeness !== "complete") throw new Error("Safe-start test workspace preflight failed")
      return createAstraSessionAuthorityFile({ status: "opened", mode: "read-only", report })
    }),
    (authority) =>
      use({
        ASTRA_SAFE_START: "1",
        ASTRA_WORKSPACE_MODE: "read-only",
        ASTRA_SESSION_AUTHORITY_FILE: authority.path,
        ASTRA_SESSION_AUTHORITY_DIGEST: authority.digest,
        OPENCODE_CLIENT: "astra",
        XDG_CACHE_HOME: path.join(root, ".astra-safe-state", "cache"),
        XDG_CONFIG_HOME: path.join(root, ".astra-safe-state", "config"),
        XDG_DATA_HOME: path.join(root, ".astra-safe-state", "data"),
        XDG_STATE_HOME: path.join(root, ".astra-safe-state", "state"),
      }),
    (authority) => Effect.promise(() => rm(authority.directory, { recursive: true, force: true })),
  )
}
