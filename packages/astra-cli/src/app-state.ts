import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const ledgerFilename = "operations.sqlite"
const receiptSpoolFilename = "receipts.sqlite"

/** Resolves Astra's local Operation ledger without creating any filesystem state. */
export function operationLedgerPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const override = environment.ASTRA_DATA_DIR?.trim()
  if (override) return join(isAbsolute(override) ? override : resolve(override), ledgerFilename)
  if (platform === "darwin") return join(home, "Library", "Application Support", "Astra", ledgerFilename)
  if (platform === "win32")
    return join(environment.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "Astra", ledgerFilename)
  return join(environment.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "astra", ledgerFilename)
}

/** Resolves the executor receipt spool beside, but never inside, a workspace. */
export function receiptSpoolPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
) {
  const override = environment.ASTRA_DATA_DIR?.trim()
  if (override) return join(isAbsolute(override) ? override : resolve(override), receiptSpoolFilename)
  if (platform === "darwin") return join(home, "Library", "Application Support", "Astra", receiptSpoolFilename)
  if (platform === "win32")
    return join(environment.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "Astra", receiptSpoolFilename)
  return join(environment.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "astra", receiptSpoolFilename)
}
