const maximumCatalogTools = 64
const maximumCatalogBytes = 64 * 1024
const maximumToolNameBytes = 128
const maximumDescriptionBytes = 1_024

export type AstraMcpWireRequest = Readonly<{
  method: "initialize" | "notifications/initialized" | "tools/list"
  id?: number
  sessionID: string | null
  body: Readonly<Record<string, unknown>>
}>

export type AstraMcpWireResponse = Readonly<{
  statusCode: number
  sessionID: string | null
  contentType?: string
  body: unknown
}>

export type AstraControlledRemoteWire = Readonly<{
  send: (request: AstraMcpWireRequest, signal?: AbortSignal) => Promise<AstraMcpWireResponse>
  close: (sessionID: string | null) => Promise<void>
}>

export type AstraObservedMcpTool = Readonly<{
  name: string
  description: string | null
  inputSchemaDigest: string
}>

export type AstraControlledRemoteActivation = Readonly<{
  status: "active_observed_not_verified"
  protocolVersion: string
  server: Readonly<{ name: string; version: string }>
  sessionID: string | null
  catalog: ReadonlyArray<AstraObservedMcpTool>
  instructionsWithheld: true
  toolsInvocable: false
  promptsLoaded: false
  resourcesLoaded: false
  stop: () => Promise<void>
}>

/**
 * Performs the only MCP exchange Astra permits in the first controlled slice.
 * It deliberately does not use the SDK transport because SDK recovery may
 * reconnect or replay a request after a session failure.
 */
export async function activateAstraControlledRemote(
  wire: AstraControlledRemoteWire,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<AstraControlledRemoteActivation> {
  let sessionID: string | null = null
  let stopped = false
  const closeOnce = async () => {
    if (stopped) return
    stopped = true
    await wire.close(sessionID)
  }
  try {
    const initialized = requireResponse(
      await wire.send({
        method: "initialize",
        id: 1,
        sessionID: null,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "astra", version: "1" },
          },
        },
      }, options.signal),
      1,
    )
    sessionID = requireSessionID(initialized.sessionID)
    const initialization = parseInitialization(initialized.body)

    requireNotificationResponse(
      await wire.send({
        method: "notifications/initialized",
        sessionID,
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }, options.signal),
      sessionID,
    )

    const listed = requireResponse(
      await wire.send({
        method: "tools/list",
        id: 2,
        sessionID,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      }, options.signal),
      2,
      sessionID,
    )
    const catalog = parseCatalog(listed.body)
    return Object.freeze({
      status: "active_observed_not_verified",
      protocolVersion: initialization.protocolVersion,
      server: initialization.server,
      sessionID,
      catalog,
      instructionsWithheld: true,
      toolsInvocable: false,
      promptsLoaded: false,
      resourcesLoaded: false,
      stop: closeOnce,
    })
  } catch (cause) {
    await closeOnce().catch(() => undefined)
    throw sanitizeFailure(cause)
  }
}

function requireResponse(response: AstraMcpWireResponse, id: number, expectedSession?: string | null) {
  requireTransportResponse(response, expectedSession)
  const body = exactRecord(response.body)
  if (body.jsonrpc !== "2.0" || body.id !== id || !("result" in body) || "error" in body) {
    throw new TypeError("The controlled MCP response is malformed")
  }
  return { ...response, body: body.result }
}

function requireNotificationResponse(response: AstraMcpWireResponse, expectedSession: string | null) {
  requireTransportResponse(response, expectedSession, true)
  if (response.body !== null && response.body !== undefined && response.body !== "") {
    throw new TypeError("The controlled MCP notification response is malformed")
  }
}

function requireTransportResponse(
  response: AstraMcpWireResponse,
  expectedSession?: string | null,
  notification = false,
) {
  if (response.statusCode >= 300 && response.statusCode < 400) throw new TypeError("MCP redirects are forbidden")
  if (response.statusCode < 200 || response.statusCode >= 300) throw new TypeError("The MCP server rejected the request")
  if (response.contentType?.toLowerCase().split(";", 1)[0]?.trim() === "text/event-stream") {
    throw new TypeError("MCP SSE is forbidden")
  }
  if (!notification && response.contentType && !/^application\/json(?:\s*;|$)/i.test(response.contentType)) {
    throw new TypeError("The MCP response content type is unsupported")
  }
  if (expectedSession !== undefined && response.sessionID !== expectedSession) {
    throw new TypeError("The MCP session binding changed")
  }
}

function parseInitialization(input: unknown) {
  const result = exactRecord(input)
  const server = exactRecord(result.serverInfo)
  if (
    typeof result.protocolVersion !== "string" ||
    !safeText(result.protocolVersion, 64) ||
    !isRecord(result.capabilities) ||
    !safeText(server.name, 128) ||
    !safeText(server.version, 128)
  ) {
    throw new TypeError("The controlled MCP initialization response is malformed")
  }
  return Object.freeze({
    protocolVersion: result.protocolVersion,
    server: Object.freeze({ name: server.name, version: server.version }),
  })
}

function parseCatalog(input: unknown): ReadonlyArray<AstraObservedMcpTool> {
  const result = exactRecord(input)
  if (!Array.isArray(result.tools) || result.tools.length > maximumCatalogTools || "nextCursor" in result) {
    throw new TypeError("The controlled MCP catalog is outside its fixed budget")
  }
  if (Buffer.byteLength(JSON.stringify(result.tools)) > maximumCatalogBytes) {
    throw new TypeError("The controlled MCP catalog is outside its fixed budget")
  }
  const names = new Set<string>()
  return Object.freeze(
    result.tools.map((input) => {
      const tool = exactRecord(input)
      const allowed = new Set(["name", "description", "inputSchema", "annotations", "outputSchema", "title"])
      if (Object.keys(tool).some((key) => !allowed.has(key))) throw new TypeError("The controlled MCP catalog is malformed")
      if (
        !safeText(tool.name, maximumToolNameBytes) ||
        names.has(tool.name) ||
        (tool.description !== undefined && !safeText(tool.description, maximumDescriptionBytes)) ||
        !isRecord(tool.inputSchema)
      ) {
        throw new TypeError("The controlled MCP catalog is malformed")
      }
      names.add(tool.name)
      return Object.freeze({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : null,
        inputSchemaDigest: digest(JSON.stringify(canonical(tool.inputSchema))),
      })
    }),
  )
}

function requireSessionID(input: string | null) {
  if (input === null) return null
  if (!safeText(input, 256)) throw new TypeError("The MCP session identifier is invalid")
  return input
}

function safeText(input: unknown, maximumBytes: number): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    Buffer.byteLength(input) <= maximumBytes &&
    !/[\p{Cc}\p{Cf}]/u.test(input)
  )
}

function exactRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("The controlled MCP response is malformed")
  }
  return input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical)
  if (!isRecord(input)) return input
  return Object.fromEntries(Object.keys(input).toSorted().map((key) => [key, canonical(input[key])]))
}

function digest(input: string) {
  return `sha256:${new Bun.CryptoHasher("sha256").update(input).digest("hex")}`
}

function sanitizeFailure(cause: unknown) {
  if (cause instanceof TypeError) return cause
  if (cause instanceof Error && /^The (?:controlled )?MCP /.test(cause.message)) return new Error(cause.message)
  return new Error("The controlled MCP exchange failed")
}

export * as AstraControlledRemoteMcp from "./astra-controlled-remote"
