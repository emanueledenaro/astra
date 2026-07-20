import {
  parseAstraSystemDecision,
  parseAstraSystemSnapshot,
  type AstraSystemDecision,
  type AstraSystemSnapshot,
} from "@astra/domain/system-control"
import { operationLedgerPath } from "./app-state"
import { loadParentAnthropicAuthReader } from "./provider-auth-reader"
import { readAstraProviderCatalog, type ProviderCatalogResult } from "./provider-catalog"
import { connectParentAnthropicCredential } from "./provider-connect"

const astraSystemVersion = "1.18.3"

type GlobalExtension = Readonly<{ kind: "skill" | "plugin" | "mcp"; id: string; state: string }>
type OperationProjection = Readonly<{
  operations: ReadonlyArray<Readonly<{ operationID: string; state: string; updatedAt: string }>>
}>

export type AstraSystemControlDependencies = Readonly<{
  readCatalog: () => ProviderCatalogResult
  readCredential: () => Promise<unknown | undefined>
  listGlobalExtensions: () => Promise<ReadonlyArray<GlobalExtension>>
  listOperations: (ledgerFilename: string) => Promise<OperationProjection>
}>

export type AstraSystemRouteResult =
  | Readonly<{ kind: "continue"; reviewMode: "manual" | "auto-session" }>
  | Readonly<{ kind: "blocked"; reviewMode: "manual" | "auto-session" }>
  | Readonly<{ kind: "exit" }>

/**
 * Builds a display-only Control Center snapshot from global parent-owned
 * sources. Workspace bootstrap, project configuration, Git, shell, and
 * workspace Operation controls have no path through this function.
 */
export async function buildAstraSystemSnapshot(
  reviewMode: "manual" | "auto-session",
  dependencies: AstraSystemControlDependencies = defaultDependencies,
): Promise<AstraSystemSnapshot> {
  const catalog = readCatalog(dependencies.readCatalog)
  const [extensions, receipts] = await Promise.all([
    readExtensions(dependencies.listGlobalExtensions),
    readReceipts(dependencies.listOperations),
  ])
  const providers = catalog.ok
    ? [
        {
          id: catalog.catalog.providerID,
          name: catalog.catalog.providerName,
          credential: await credentialPresence(dependencies.readCredential),
        },
      ]
    : []
  const parsed = parseAstraSystemSnapshot({
    version: astraSystemVersion,
    executionBackend: "host-no-sandbox",
    reviewMode,
    providers,
    extensions,
    recentSessions: [],
    recentReceipts: receipts,
  })
  if (parsed.ok) return parsed.value
  return Object.freeze({
    version: astraSystemVersion,
    executionBackend: "host-no-sandbox" as const,
    reviewMode,
    providers: Object.freeze([]),
    extensions: Object.freeze([]),
    recentSessions: Object.freeze([]),
    recentReceipts: Object.freeze([]),
  })
}

/** Routes only validated System intent; credential setup remains an explicit parent-owned prompt. */
export async function routeAstraSystemDecision(
  snapshotInput: unknown,
  decisionInput: unknown,
  connectAnthropic: () => Promise<unknown>,
): Promise<AstraSystemRouteResult> {
  const snapshot = parseAstraSystemSnapshot(snapshotInput)
  const decision = parseAstraSystemDecision(decisionInput)
  if (!snapshot.ok || !decision.ok) return { kind: "blocked", reviewMode: "manual" }
  const intent = decision.value
  if (intent.kind === "exit") return { kind: "exit" }
  if (intent.kind === "set-review-mode") return { kind: "continue", reviewMode: intent.mode }
  if (
    intent.providerID !== "anthropic" ||
    !snapshot.value.providers.some(
      (provider) => provider.id === intent.providerID && provider.credential === "missing",
    )
  ) {
    return { kind: "blocked", reviewMode: snapshot.value.reviewMode }
  }
  try {
    await connectAnthropic()
    return { kind: "continue", reviewMode: snapshot.value.reviewMode }
  } catch {
    return { kind: "blocked", reviewMode: snapshot.value.reviewMode }
  }
}

/** Runs one global-only Control Center session; Auto Review never leaves this process. */
export async function runAstraSystemControl(): Promise<number> {
  let reviewMode: AstraSystemSnapshot["reviewMode"] = "manual"
  while (true) {
    const snapshot = await buildAstraSystemSnapshot(reviewMode)
    const tui = await loadSystemModeModule()
    const result = await routeAstraSystemDecision(snapshot, await tui.runAstraSystemMode(snapshot), connectParentAnthropicCredential)
    if (result.kind === "exit") return 0
    if (result.kind === "blocked") return 1
    reviewMode = result.reviewMode
  }
}

const defaultDependencies: AstraSystemControlDependencies = {
  readCatalog: readAstraProviderCatalog,
  readCredential: readParentAnthropicCredential,
  listGlobalExtensions: readGlobalExtensions,
  listOperations: readGlobalOperations,
}

function readCatalog(read: () => ProviderCatalogResult) {
  try {
    return read()
  } catch {
    return { ok: false as const, error: { code: "catalog_unavailable" as const, message: "Embedded OpenCode model catalog is unavailable." as const } }
  }
}

async function credentialPresence(read: () => Promise<unknown | undefined>): Promise<"present" | "missing" | "unknown"> {
  try {
    const credential = await read()
    if (credential === undefined) return "missing"
    const record = plainRecord(credential)
    if (!record || record.type !== "api") return "unknown"
    const key = record.key
    if (typeof key !== "string" || key.length === 0 || key.length > 4_096 || /\p{C}/u.test(key)) return "unknown"
    return "present"
  } catch {
    return "unknown"
  }
}

async function readExtensions(read: () => Promise<ReadonlyArray<GlobalExtension>>) {
  try {
    return await read()
  } catch {
    return []
  }
}

async function readReceipts(read: (ledgerFilename: string) => Promise<OperationProjection>) {
  try {
    const projection = await read(operationLedgerPath())
    return projection.operations.map((operation) => ({
      operationID: operation.operationID,
      state: operation.state,
      observedAt: operation.updatedAt,
    }))
  } catch {
    return []
  }
}

async function readParentAnthropicCredential() {
  let reader: Awaited<ReturnType<typeof loadParentAnthropicAuthReader>> | undefined
  try {
    reader = await loadParentAnthropicAuthReader()
    return await reader.get("anthropic", AbortSignal.timeout(1_000))
  } finally {
    await reader?.close()
  }
}

async function readGlobalExtensions(): Promise<ReadonlyArray<GlobalExtension>> {
  try {
    const moduleURL = new URL("../../opencode/src/plugin/meta.ts", import.meta.url)
    const loaded: unknown = await import(moduleURL.href)
    if (!isGlobalPluginMetadataModule(loaded)) return []
    const inventory = await loaded.PluginMeta.list()
    const record = plainRecord(inventory)
    if (!record) return []
    return Object.values(record)
      .flatMap((entry) => {
        const record = plainRecord(entry)
        if (!record || typeof record.id !== "string" || !safeExtensionID(record.id)) return []
        return [{ kind: "plugin" as const, id: record.id, state: "recorded" as const }]
      })
      .toSorted((left, right) => left.id.localeCompare(right.id))
  } catch {
    return []
  }
}

async function readGlobalOperations(ledgerFilename: string): Promise<OperationProjection> {
  const moduleName = ["@astra/runtime", "operation-view"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isOperationViewModule(loaded)) throw new Error("Astra Operation ledger projection is unavailable")
  return loaded.listOperationViews(ledgerFilename)
}

async function loadSystemModeModule(): Promise<Readonly<{
  runAstraSystemMode: (snapshot: unknown) => Promise<AstraSystemDecision>
}>> {
  const moduleName = ["@opencode-ai/tui", "astra/system-mode"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isSystemModeModule(loaded)) throw new Error("The Astra System Control Center interface is unavailable")
  return loaded
}

function plainRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const output: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return null
    output[key] = descriptor.value
  }
  return output
}

function safeExtensionID(input: string) {
  return input.length > 0 && input.length <= 256 && input === input.trim() && !/\p{C}/u.test(input)
}

function isGlobalPluginMetadataModule(value: unknown): value is Readonly<{
  PluginMeta: Readonly<{ list: () => Promise<unknown> }>
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "PluginMeta" in value &&
    typeof value.PluginMeta === "object" &&
    value.PluginMeta !== null &&
    "list" in value.PluginMeta &&
    typeof value.PluginMeta.list === "function"
  )
}

function isOperationViewModule(value: unknown): value is Readonly<{
  listOperationViews: (ledgerFilename: string) => Promise<OperationProjection>
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "listOperationViews" in value &&
    typeof value.listOperationViews === "function"
  )
}

function isSystemModeModule(value: unknown): value is Readonly<{
  runAstraSystemMode: (snapshot: unknown) => Promise<AstraSystemDecision>
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "runAstraSystemMode" in value &&
    typeof value.runAstraSystemMode === "function"
  )
}
