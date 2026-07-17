import { lookup } from "node:dns/promises"
import { isIP, type Socket } from "node:net"
import { isAllowedMcpActivationEndpoint } from "@astra/domain/mcp-activation"
import {
  isLiteralProviderTurnLoopback,
  isPublicProviderTurnAddress,
  parseProviderTurnAddress,
  type ProviderTurnResolvedAddress,
} from "./provider-turn-network-policy"

const maximumAddresses = 8
const maximumResponseBytes = 128 * 1024
const requestTimeoutMilliseconds = 5_000

export type McpPinnedResolver = (
  hostname: string,
) => Promise<ReadonlyArray<Readonly<{ address: string; family: number }>>>

export type McpPinnedTransportOptions =
  | Readonly<{ mode: "production_https"; resolver?: McpPinnedResolver; onNetworkDispatch?: () => void }>
  | Readonly<{ mode: "test_https_seam"; resolver: McpPinnedResolver; onNetworkDispatch?: () => void }>
  | Readonly<{ mode: "test_loopback"; onNetworkDispatch?: () => void }>

export type McpPinnedDestination = Readonly<{
  endpoint: string
  protocol: "https:" | "http:"
  hostname: string
  port: number
  path: string
  addresses: ReadonlyArray<ProviderTurnResolvedAddress>
  selectedAddress: ProviderTurnResolvedAddress
  resolvedAt: string
  policy: "public_dns_pinned_peer" | "literal_loopback_fixture"
}>

type WireRequest = Readonly<{
  method: "initialize" | "notifications/initialized" | "tools/list"
  id?: number
  sessionID: string | null
  body: Readonly<Record<string, unknown>>
}>

type WireResponse = Readonly<{
  statusCode: number
  sessionID: string | null
  contentType?: string
  body: unknown
}>

/** Resolves once, rejects every non-public answer, and selects one exact peer. */
export async function resolvePinnedMcpDestination(
  endpoint: string,
  options: McpPinnedTransportOptions,
): Promise<McpPinnedDestination> {
  if (!isAllowedMcpActivationEndpoint(endpoint)) throw new TypeError("The MCP endpoint is not allowed")
  const url = new URL(endpoint)
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("The MCP endpoint port is invalid")

  if (url.protocol === "http:") {
    if (options.mode !== "test_loopback") throw new TypeError("Plain HTTP is restricted to literal loopback fixtures")
    const address = parseProviderTurnAddress(unbracket(url.hostname))
    if (!address || !isLiteralProviderTurnLoopback(address)) throw new TypeError("The MCP fixture is not literal loopback")
    return Object.freeze({
      endpoint: url.href,
      protocol: "http:",
      hostname: url.hostname,
      port,
      path: url.pathname,
      addresses: Object.freeze([address]),
      selectedAddress: address,
      resolvedAt: new Date().toISOString(),
      policy: "literal_loopback_fixture",
    })
  }
  if (url.protocol !== "https:" || options.mode === "test_loopback" || isIP(unbracket(url.hostname)) !== 0) {
    throw new TypeError("Public MCP requires an HTTPS DNS hostname")
  }
  const resolver = options.resolver ?? defaultResolver
  const resolved = await resolver(url.hostname)
  const addresses = resolved
    .map((entry) => parseProviderTurnAddress(entry.address))
    .filter((entry): entry is ProviderTurnResolvedAddress => entry !== null)
    .toSorted((left, right) => left.family - right.family || left.address.localeCompare(right.address))
  if (
    addresses.length < 1 ||
    addresses.length > maximumAddresses ||
    addresses.length !== resolved.length ||
    addresses.some((entry) => !isPublicProviderTurnAddress(entry)) ||
    addresses.some((entry, index) => index > 0 && entry.address === addresses[index - 1]!.address)
  ) {
    throw new TypeError("Every MCP DNS answer must be canonical, unique, and public")
  }
  return Object.freeze({
    endpoint: url.href,
    protocol: "https:",
    hostname: url.hostname,
    port,
    path: url.pathname,
    addresses: Object.freeze(addresses),
    selectedAddress: addresses[0]!,
    resolvedAt: new Date().toISOString(),
    policy: "public_dns_pinned_peer",
  })
}

/**
 * Creates a lazy wire. Construction performs no DNS or network activity; the
 * coordinator must call it only through an adapter after the durable claim.
 */
export function createPinnedMcpWire(endpoint: string, options: McpPinnedTransportOptions) {
  let destination: Promise<McpPinnedDestination> | undefined
  let closed = false
  let requests = 0
  const allowed = ["initialize", "notifications/initialized", "tools/list"] as const
  return Object.freeze({
    async send(request: WireRequest, signal?: AbortSignal): Promise<WireResponse> {
      if (closed) throw new Error("The controlled MCP wire is closed")
      if (requests >= allowed.length || request.method !== allowed[requests]) {
        throw new Error("The controlled MCP request budget was exceeded")
      }
      requests++
      destination ??= resolvePinnedMcpDestination(endpoint, options)
      return executeRequest(await destination, "POST", request.body, request.sessionID, options.onNetworkDispatch, signal)
    },
    async close(sessionID: string | null) {
      if (closed) return
      closed = true
      if (!sessionID || !destination) return
      const response = await executeRequest(await destination, "DELETE", null, sessionID, options.onNetworkDispatch)
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error("The controlled MCP session close was not observed")
      }
    },
  })
}

async function executeRequest(
  destination: McpPinnedDestination,
  method: "POST" | "DELETE",
  body: Readonly<Record<string, unknown>> | null,
  sessionID: string | null,
  onNetworkDispatch: (() => void) | undefined,
  signal?: AbortSignal,
): Promise<WireResponse> {
  const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const host =
    destination.port === (destination.protocol === "https:" ? 443 : 80)
      ? destination.hostname
      : `${destination.hostname}:${destination.port}`
  const requestBytes = Buffer.concat([
    Buffer.from(
      [
        `${method} ${destination.path} HTTP/1.1`,
        `host: ${host}`,
        "accept: application/json",
        ...(method === "POST"
          ? [
              "content-type: application/json",
              `content-length: ${payload.byteLength}`,
              "mcp-protocol-version: 2025-03-26",
            ]
          : ["content-length: 0"]),
        ...(sessionID ? [`mcp-session-id: ${sessionID}`] : []),
        "connection: close",
        "",
        "",
      ].join("\r\n"),
    ),
    payload,
  ])
  return new Promise<WireResponse>((resolve, reject) => {
    let socket: Socket | undefined
    let settled = false
    const chunks: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => fail(), requestTimeoutMilliseconds)
    timer.unref?.()
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", fail)
      socket?.destroy()
    }
    const fail = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error("The controlled MCP network request failed"))
    }
    if (signal?.aborted) return fail()
    signal?.addEventListener("abort", fail, { once: true })
    const ready = (connected: Socket) => {
      try {
        if (settled || signal?.aborted) return fail()
        requirePinnedPeer(connected, destination.selectedAddress)
        if (settled || signal?.aborted) return fail()
        connected.setNoDelay(true)
        connected.write(requestBytes)
      } catch {
        fail()
      }
    }
    const start = async () => {
      onNetworkDispatch?.()
      if (settled || signal?.aborted) return fail()
      if (destination.protocol === "https:") {
        const tls = await import("node:tls")
        if (settled || signal?.aborted) return fail()
        const secure = tls.connect(
          {
            host: destination.selectedAddress.address,
            port: destination.port,
            family: destination.selectedAddress.family,
            servername: destination.hostname,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            ALPNProtocols: ["http/1.1"],
          },
          () => {
            if (!secure.authorized || secure.authorizationError) return fail()
            ready(secure)
          },
        )
        socket = secure
      } else {
        const network = await import("node:net")
        if (settled || signal?.aborted) return fail()
        const plain = network.connect(
          {
            host: destination.selectedAddress.address,
            port: destination.port,
            family: destination.selectedAddress.family,
          },
          () => ready(plain),
        )
        socket = plain
      }
      const activeSocket = socket
      if (!activeSocket) throw new Error("The controlled MCP socket was not created")
      activeSocket.on("data", (chunk: Buffer) => {
        if (settled || chunk.byteLength > maximumResponseBytes * 2 + 65_536 - bytes) return fail()
        chunks.push(Buffer.from(chunk))
        bytes += chunk.byteLength
      })
      activeSocket.once("error", fail)
      activeSocket.once("end", () => {
        if (settled) return
        try {
          const response = parseRawResponse(Buffer.concat(chunks, bytes))
          settled = true
          cleanup()
          resolve(response)
        } catch {
          fail()
        }
      })
      activeSocket.once("close", () => {
        if (!settled) fail()
      })
    }
    void start().catch(fail)
  })
}

function parseRawResponse(input: Buffer): WireResponse {
  const separator = input.indexOf("\r\n\r\n")
  if (separator < 0 || separator + 4 > 65_536) throw new TypeError("The MCP response headers are malformed")
  const lines = input.subarray(0, separator).toString("latin1").split("\r\n")
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [\x20-\x7e]*)?$/.exec(lines[0] ?? "")
  if (!status) throw new TypeError("The MCP response status is malformed")
  const statusCode = Number(status[1])
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":")
    if (index < 1 || line.length > 8_192) throw new TypeError("The MCP response header is malformed")
    const name = line.slice(0, index).toLowerCase()
    const value = line.slice(index + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[^\t\x20-\x7e]/.test(value) || headers.has(name)) {
      throw new TypeError("The MCP response header is malformed")
    }
    headers.set(name, value)
  }
  const framed = input.subarray(separator + 4)
  const transferEncoding = headers.get("transfer-encoding")
  const contentLength = headers.get("content-length")
  if (transferEncoding && contentLength) throw new TypeError("The MCP response framing is ambiguous")
  const body = transferEncoding
    ? transferEncoding.toLowerCase() === "chunked"
      ? decodeChunked(framed)
      : (() => {
          throw new TypeError("The MCP response framing is unsupported")
        })()
    : contentLength !== undefined
      ? requireContentLength(framed, contentLength)
      : Uint8Array.from(framed)
  if (body.byteLength > maximumResponseBytes) throw new TypeError("The MCP response exceeded its fixed budget")
  const contentType = headers.get("content-type")
  return Object.freeze({
    statusCode,
    sessionID: headers.get("mcp-session-id") ?? null,
    ...(contentType ? { contentType } : {}),
    body: body.byteLength === 0 ? null : parseJson(Buffer.from(body)),
  })
}

function requireContentLength(body: Buffer, rawLength: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawLength)) throw new TypeError("The MCP response length is malformed")
  const length = Number(rawLength)
  if (!Number.isSafeInteger(length) || length !== body.byteLength || length > maximumResponseBytes) {
    throw new TypeError("The MCP response length is invalid")
  }
  return Uint8Array.from(body)
}

function decodeChunked(input: Buffer) {
  const chunks: Buffer[] = []
  let offset = 0
  let total = 0
  while (true) {
    const lineEnd = input.indexOf("\r\n", offset)
    if (lineEnd < 0 || lineEnd - offset > 128) throw new TypeError("The MCP chunk header is malformed")
    const sizeText = input.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0] ?? ""
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new TypeError("The MCP chunk size is malformed")
    const size = Number.parseInt(sizeText, 16)
    offset = lineEnd + 2
    if (size === 0) {
      const trailer = input.subarray(offset)
      if (!trailer.equals(Buffer.from("\r\n")) && trailer.byteLength !== 0) {
        throw new TypeError("MCP response trailers are unsupported")
      }
      return Uint8Array.from(Buffer.concat(chunks, total))
    }
    if (!Number.isSafeInteger(size) || size > maximumResponseBytes - total || offset + size + 2 > input.byteLength) {
      throw new TypeError("The MCP chunk exceeds its fixed budget")
    }
    const end = offset + size
    if (input[end] !== 13 || input[end + 1] !== 10) throw new TypeError("The MCP chunk is truncated")
    chunks.push(input.subarray(offset, end))
    total += size
    offset = end + 2
  }
}

function requirePinnedPeer(socket: Socket, expected: ProviderTurnResolvedAddress) {
  const remoteAddress = socket.remoteAddress?.startsWith("::ffff:")
    ? socket.remoteAddress.slice("::ffff:".length)
    : socket.remoteAddress
  const peer = remoteAddress ? parseProviderTurnAddress(remoteAddress) : null
  if (!peer || peer.address !== expected.address || peer.family !== expected.family) {
    throw new Error("The MCP connected peer did not match the pinned address")
  }
}

async function defaultResolver(hostname: string) {
  const result = await lookup(hostname, { all: true, verbatim: true })
  return result.map((entry) => ({ address: entry.address, family: entry.family }))
}

function parseJson(input: Buffer) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as unknown
  } catch {
    throw new TypeError("The MCP response body is malformed")
  }
}

function unbracket(input: string) {
  return input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input
}
