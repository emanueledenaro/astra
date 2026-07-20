import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import type { Socket } from "node:net"
import { checkServerIdentity as verifyServerIdentity, connect, type PeerCertificate } from "node:tls"
import {
  executeProviderTurn,
  trustedObservedProviderTurnAdapterDescriptor,
  untrustedProviderTurnAdapterDescriptor,
  type DurableProviderTurnResult,
  type ExecuteProviderTurnInput,
  type ProviderTurnAdapterExecutionAuthority,
  type ProviderTurnHttpResponseEvidence,
  type TrustedObservedProviderTurnAdapter,
  type TrustedObservedProviderTurnAdapterFinishEvent,
  type UntrustedProviderTurnAdapter,
  type UntrustedProviderTurnAdapterFinishEvent,
} from "./provider-turn-coordinator"
import {
  isLiteralProviderTurnLoopbackHostname,
  isPublicProviderTurnAddress,
  parseProviderTurnAddress,
  validateProviderTurnResolutionEvidence,
  type ProviderTurnNetworkPolicy,
  type ProviderTurnNetworkResolutionEvidence,
  type ProviderTurnResolvedAddress,
} from "./provider-turn-network-policy"
import {
  asProviderResponseTransportFailure,
  asProviderTransportFailure,
  ProviderTransportFailure,
  type ProviderTransportFailureCode,
} from "./provider-turn-transport-failure"
import {
  providerTurnMaximumRequestBytes,
  type ProviderTurnPreview,
  type UntrustedProviderTurnAdapterRequest,
} from "./provider-turn-operation-facts"

const maximumHeaderValueBytes = 8_192
const maximumHeaderBlockBytes = 32_768
const maximumResponseHeaderBytes = 65_536

/**
 * The HTTPS primitive is production-capable at the network layer. Product
 * integration remains disabled because provider protocol parsing and the
 * credential broker are separate unfinished boundaries.
 */
export const trustedProviderTurnTransportDescriptor = Object.freeze({
  ownership: "astra",
  networkTransportProductionCapable: true,
  productIntegrationCapable: false,
  peerEnforcement: "dns_resolved_ip_pinned_and_verified",
  tlsEnforcement: "original_hostname_sni_and_certificate",
  proxyEnvironment: "unused",
  completionAuthority: "none",
  terminalState: "effect_unknown_only",
} as const)

export type TrustedProviderWireValues = Readonly<{
  credential: Readonly<{
    handle: string
    accountFingerprint: string
    value: string
  }>
  headers: ReadonlyArray<readonly [name: string, value: string]>
  body: Uint8Array
}>

export type TrustedObservedProviderRawResponse = Readonly<{
  statusCode: number
  headers: ReadonlyArray<readonly [name: string, value: string]>
  body: Uint8Array
}>

export type TrustedObservedProviderCompletion = TrustedObservedProviderTurnAdapterFinishEvent["completion"]

type TrustedProviderHttpResponse = Readonly<{
  body: Uint8Array
  evidence: ProviderTurnHttpResponseEvidence
}>

type TrustedProviderTurnBaseDependencies = Readonly<{
  requestApproval: (preview: ProviderTurnPreview) => Promise<"approve" | "reject">
  onNetworkDispatch?: () => void
  now?: () => number
}>

type Resolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<ReadonlyArray<Readonly<{ address: string; family: number }>>>

type TrustedTransportTestHooks = Readonly<{
  beforeCredentialWrite?: () => Promise<void>
  onConnectAttempt?: () => void
  onNetworkDispatch?: () => void
}>

export type TrustedProviderTurnDependencies =
  | (TrustedProviderTurnBaseDependencies & Readonly<{ mode: "production_https" }>)
  | (TrustedProviderTurnBaseDependencies & TrustedTransportTestHooks & Readonly<{ mode: "test_only_loopback" }>)
  | (TrustedProviderTurnBaseDependencies &
      TrustedTransportTestHooks &
      Readonly<{ mode: "test_only_https_seam"; resolver: Resolver }>)

/** Governs one request without resolving or connecting before durable consent. */
export function executeProviderTurnWithTrustedTransport(
  source: ExecuteProviderTurnInput,
  wireValues: TrustedProviderWireValues,
  dependencies: TrustedProviderTurnDependencies,
): Promise<DurableProviderTurnResult> {
  assertExecutionMode(source, dependencies.mode)
  const wire = snapshotWireValues(source, wireValues)
  const transport = trustedTransportAdapter(
    wire,
    dependencies.now ?? Date.now,
    dependencies.mode === "production_https"
      ? defaultResolver
      : dependencies.mode === "test_only_https_seam"
        ? dependencies.resolver
        : undefined,
    dependencies.mode === "production_https"
      ? dependencies.onNetworkDispatch
        ? { onNetworkDispatch: dependencies.onNetworkDispatch }
        : {}
      : dependencies,
  )
  return executeProviderTurn(source, {
    requestApproval: dependencies.requestApproval,
    untrustedAdapter: transport,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  })
}

/**
 * Defers parent credential consumption until the coordinator has persisted
 * explicit approval and claimed the one-shot dispatch. The trusted parser must
 * return bounded provider-neutral evidence; the coordinator validates it again
 * before recording observed completion.
 */
export function executeProviderTurnWithTrustedObservedTransport(
  source: ExecuteProviderTurnInput,
  resolveWireValues: () => Promise<TrustedProviderWireValues>,
  parseResponse: (response: TrustedObservedProviderRawResponse) => TrustedObservedProviderCompletion,
  dependencies: TrustedProviderTurnDependencies,
): Promise<DurableProviderTurnResult> {
  assertExecutionMode(source, dependencies.mode)
  const transport = trustedObservedTransportAdapter(
    source,
    resolveWireValues,
    parseResponse,
    dependencies.now ?? Date.now,
    dependencies.mode === "production_https"
      ? defaultResolver
      : dependencies.mode === "test_only_https_seam"
        ? dependencies.resolver
        : undefined,
    dependencies.mode === "production_https"
      ? dependencies.onNetworkDispatch
        ? { onNetworkDispatch: dependencies.onNetworkDispatch }
        : {}
      : dependencies,
  )
  return executeProviderTurn(source, {
    requestApproval: dependencies.requestApproval,
    trustedAdapter: transport,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  })
}

function trustedTransportAdapter(
  wire: ReturnType<typeof snapshotWireValues>,
  now: () => number,
  resolver: Resolver | undefined,
  testHooks: TrustedTransportTestHooks,
): UntrustedProviderTurnAdapter {
  return {
    descriptor: untrustedProviderTurnAdapterDescriptor,
    async execute(adapterRequest, authority) {
      assertRequestBinding(adapterRequest, wire)
      validateExecutionAuthority(adapterRequest, authority, now())
      const evidence =
        adapterRequest.provider.transportPolicy === "https_only"
          ? await resolveProviderNetwork(
              adapterRequest.networkPolicy,
              now,
              resolver,
              Date.parse(authority.transportDeadlineAt),
            )
          : loopbackEvidence(adapterRequest.networkPolicy, now())
      assertBeforeDeadline(authority, now())
      const response =
        adapterRequest.provider.transportPolicy === "https_only"
          ? await executePinnedHttps(adapterRequest, wire, evidence, authority, now, testHooks)
          : await executeLiteralLoopbackHttp(adapterRequest, wire, evidence, authority, now, testHooks)
      return finishEvent(adapterRequest, response, evidence)
    },
  }
}

function trustedObservedTransportAdapter(
  source: ExecuteProviderTurnInput,
  resolveWireValues: () => Promise<TrustedProviderWireValues>,
  parseResponse: (response: TrustedObservedProviderRawResponse) => TrustedObservedProviderCompletion,
  now: () => number,
  resolver: Resolver | undefined,
  testHooks: TrustedTransportTestHooks,
): TrustedObservedProviderTurnAdapter {
  return {
    descriptor: trustedObservedProviderTurnAdapterDescriptor,
    async execute(adapterRequest, authority) {
      validateExecutionAuthority(adapterRequest, authority, now())
      const wire = await resolveWireValues()
        .then((values) => snapshotWireValues(source, values))
        .catch((cause) => {
          throw asProviderTransportFailure(cause, "credential_material_rejected")
        })
      assertRequestBinding(adapterRequest, wire)
      const evidence = await Promise.resolve()
        .then(() =>
          adapterRequest.provider.transportPolicy === "https_only"
            ? resolveProviderNetwork(
                adapterRequest.networkPolicy,
                now,
                resolver,
                Date.parse(authority.transportDeadlineAt),
              )
            : loopbackEvidence(adapterRequest.networkPolicy, now()),
        )
        .catch((cause) => {
          throw asProviderTransportFailure(cause, "dns_resolution_failed")
        })
      assertBeforeDeadline(authority, now())
      const response = await (adapterRequest.provider.transportPolicy === "https_only"
        ? executePinnedHttps(adapterRequest, wire, evidence, authority, now, testHooks)
        : executeLiteralLoopbackHttp(adapterRequest, wire, evidence, authority, now, testHooks)
      ).catch((cause) => {
        throw asProviderTransportFailure(cause, "tls_or_connection_failed")
      })
      let completion: TrustedObservedProviderCompletion
      try {
        completion = parseResponse({
          statusCode: response.evidence.statusCode,
          headers: response.evidence.contentType ? [["content-type", response.evidence.contentType]] : [],
          body: Uint8Array.from(response.body),
        })
      } catch (cause) {
        throw asProviderResponseTransportFailure(cause)
      }
      return observedFinishEvent(adapterRequest, response, evidence, completion)
    },
  }
}

async function executePinnedHttps(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  wire: ReturnType<typeof snapshotWireValues>,
  evidence: ProviderTurnNetworkResolutionEvidence,
  authority: ProviderTurnAdapterExecutionAuthority,
  now: () => number,
  testHooks: TrustedTransportTestHooks,
) {
  const options = tlsConnectionOptions(evidence)
  return executeRawHttpRequest(
    adapterRequest,
    wire,
    (onReady) => {
      testHooks.onConnectAttempt?.()
      const socket = connect(options, () => {
        if (!socket.authorized || socket.authorizationError) {
          socket.destroy(new Error("Provider TLS authorization failed"))
          return
        }
        void onReady(socket)
      })
      return socket
    },
    evidence.selectedAddress,
    authority,
    now,
    testHooks,
  )
}

async function executeLiteralLoopbackHttp(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  wire: ReturnType<typeof snapshotWireValues>,
  evidence: ProviderTurnNetworkResolutionEvidence,
  authority: ProviderTurnAdapterExecutionAuthority,
  now: () => number,
  testHooks: TrustedTransportTestHooks,
) {
  const network = await import("node:net")
  return executeRawHttpRequest(
    adapterRequest,
    wire,
    (onReady) => {
      testHooks.onConnectAttempt?.()
      const socket = network.connect(
        { host: evidence.selectedAddress.address, port: evidence.port, family: evidence.selectedAddress.family },
        () => void onReady(socket),
      )
      return socket
    },
    evidence.selectedAddress,
    authority,
    now,
    testHooks,
  )
}

function executeRawHttpRequest(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  wire: ReturnType<typeof snapshotWireValues>,
  start: (onReady: (socket: Socket) => Promise<void>) => Socket,
  expectedPeer: ProviderTurnResolvedAddress,
  authority: ProviderTurnAdapterExecutionAuthority,
  now: () => number,
  testHooks: TrustedTransportTestHooks,
) {
  return new Promise<TrustedProviderHttpResponse>((resolve, reject) => {
    let settled = false
    let socket: Socket | undefined
    const chunks: Array<Buffer> = []
    let total = 0
    const maximumWireBytes = adapterRequest.wireRequest.maximumResponseBytes * 2 + maximumResponseHeaderBytes
    const timeout = setTimeout(() => fail("response_timeout"), remainingDeadlineMilliseconds(authority, now()))
    timeout.unref?.()

    const cleanup = () => {
      clearTimeout(timeout)
      socket?.destroy()
    }
    const fail = (code: ProviderTransportFailureCode) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new ProviderTransportFailure(code))
    }
    const succeed = (response: TrustedProviderHttpResponse) => {
      if (settled) return
      try {
        assertBeforeDeadline(authority, now())
      } catch {
        return fail("response_timeout")
      }
      settled = true
      cleanup()
      resolve(response)
    }

    try {
      socket = start(async (connected) => {
        try {
          if (settled) return
          assertConnectedPeer(expectedPeer, connected.remoteAddress)
          await testHooks.beforeCredentialWrite?.()
          if (settled) return
          assertBeforeDeadline(authority, now())
          if (!(await authority.revalidateBeforeWrite())) throw new Error("Provider transport authority was revoked")
          if (settled) return
          assertBeforeDeadline(authority, now())
          testHooks.onNetworkDispatch?.()
          connected.setNoDelay(true)
          connected.write(makeRawRequest(adapterRequest, wire))
        } catch {
          fail("authority_or_request_rejected")
        }
      })
      socket.on("data", (chunk: Buffer) => {
        if (settled) return
        try {
          assertBeforeDeadline(authority, now())
          if (chunk.byteLength > maximumWireBytes - total) return fail("response_limit_exceeded")
          chunks.push(Buffer.from(chunk))
          total += chunk.byteLength
          const response = tryParseCompleteRawResponse(
            Buffer.concat(chunks, total),
            adapterRequest.wireRequest.maximumResponseBytes,
          )
          if (response) succeed(response)
        } catch {
          fail("response_framing_rejected")
        }
      })
      socket.once("error", () => fail("tls_or_connection_failed"))
      socket.once("end", () => {
        try {
          assertBeforeDeadline(authority, now())
          succeed(parseRawResponse(Buffer.concat(chunks, total), adapterRequest.wireRequest.maximumResponseBytes))
        } catch {
          fail("connection_closed_before_complete_response")
        }
      })
      socket.once("close", () => {
        if (!settled) fail("connection_closed_before_complete_response")
      })
    } catch {
      fail("tls_or_connection_failed")
    }
  })
}

function tlsConnectionOptions(evidence: ProviderTurnNetworkResolutionEvidence) {
  return {
    host: evidence.selectedAddress.address,
    port: evidence.port,
    family: evidence.selectedAddress.family,
    servername: evidence.hostname,
    rejectUnauthorized: true as const,
    checkServerIdentity: (_hostname: string, certificate: PeerCertificate) =>
      verifyServerIdentity(evidence.hostname, certificate),
    minVersion: "TLSv1.2" as const,
    ALPNProtocols: ["http/1.1"],
  }
}

function makeRawRequest(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  wire: ReturnType<typeof snapshotWireValues>,
) {
  const policy = adapterRequest.networkPolicy
  const defaultPort = adapterRequest.provider.transportPolicy === "https_only" ? 443 : 80
  const host = policy.port === defaultPort ? policy.hostname : `${policy.hostname}:${policy.port}`
  const head = Buffer.from(
    [
      `${adapterRequest.wireRequest.method} ${adapterRequest.wireRequest.path} HTTP/1.1`,
      `host: ${host}`,
      ...wire.headers.map(([name, value]) => `${name}: ${value}`),
      `content-length: ${wire.body.byteLength}`,
      "connection: close",
      "",
      "",
    ].join("\r\n"),
  )
  return Buffer.concat([head, Buffer.from(wire.body)], head.byteLength + wire.body.byteLength)
}

function parseRawResponse(input: Buffer, maximumBodyBytes: number) {
  const head = parseRawResponseHead(input)
  const body = input.subarray(head.headerBytes)
  let decodedBody: Uint8Array
  if (head.transferEncoding) {
    decodedBody = decodeChunkedBody(body, maximumBodyBytes)
  } else if (head.contentLength !== undefined) {
    const expected = parseContentLength(head.contentLength, maximumBodyBytes)
    if (body.byteLength !== expected) throw new Error("Provider response length rejected")
    decodedBody = Uint8Array.from(body)
  } else {
    if (body.byteLength > maximumBodyBytes) throw new Error("Provider response limit exceeded")
    decodedBody = Uint8Array.from(body)
  }
  return Object.freeze({
    body: decodedBody,
    evidence: Object.freeze({
      statusCode: head.statusCode,
      contentType: normalizeContentType(singleHeader(head.headers, "content-type")),
      headerBytes: head.headerBytes,
    }),
  })
}

function tryParseCompleteRawResponse(input: Buffer, maximumBodyBytes: number) {
  const separator = input.indexOf("\r\n\r\n")
  if (separator < 0) {
    if (input.byteLength > maximumResponseHeaderBytes) throw new Error("Provider response headers invalid")
    return undefined
  }
  const head = parseRawResponseHead(input)
  const body = input.subarray(head.headerBytes)
  if (head.transferEncoding) {
    const encodedBytes = completeChunkedBodyBytes(body, maximumBodyBytes)
    if (encodedBytes === undefined) return undefined
    if (body.byteLength !== encodedBytes) throw new Error("Provider response contains trailing bytes")
    return parseRawResponse(input, maximumBodyBytes)
  }
  if (head.contentLength !== undefined) {
    const expected = parseContentLength(head.contentLength, maximumBodyBytes)
    if (body.byteLength < expected) return undefined
    if (body.byteLength > expected) throw new Error("Provider response length rejected")
    return parseRawResponse(input, maximumBodyBytes)
  }
  return undefined
}

function parseRawResponseHead(input: Buffer) {
  const separator = input.indexOf("\r\n\r\n")
  const headerBytes = separator + 4
  if (separator < 0 || headerBytes > maximumResponseHeaderBytes) {
    throw new Error("Provider response headers invalid")
  }
  const headerText = input.subarray(0, separator).toString("latin1")
  const lines = headerText.split("\r\n")
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [\u0020-\u007e]*)?$/u.exec(lines[0] ?? "")
  if (!status) throw new Error("Provider response status invalid")
  const statusCode = Number(status[1])
  if (statusCode < 200 || statusCode > 599) throw new Error("Provider response status unsupported")
  if (statusCode >= 300 && statusCode < 400) throw new Error("Provider redirect blocked")
  if (lines.length > 129) throw new Error("Provider response header count exceeded")
  const headers = new Map<string, Array<string>>()
  lines.slice(1).forEach((line) => {
    const index = line.indexOf(":")
    const rawName = line.slice(0, index)
    const rawValue = line.slice(index + 1)
    if (
      index < 1 ||
      line.length > maximumHeaderValueBytes ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(rawName) ||
      /[^\t\u0020-\u007e]/u.test(rawValue)
    ) {
      throw new Error("Provider response header invalid")
    }
    const name = rawName.toLowerCase()
    const value = rawValue.trim()
    headers.set(name, [...(headers.get(name) ?? []), value])
  })
  const contentEncoding = singleHeader(headers, "content-encoding")
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new Error("Provider response encoding unsupported")
  }
  const transferEncoding = singleHeader(headers, "transfer-encoding")
  const contentLength = singleHeader(headers, "content-length")
  if (transferEncoding && contentLength) throw new Error("Provider response framing ambiguous")
  if (transferEncoding) {
    if (transferEncoding.toLowerCase() !== "chunked") throw new Error("Provider response framing unsupported")
  }
  return Object.freeze({
    contentLength,
    headerBytes,
    headers,
    statusCode,
    transferEncoding,
  })
}

function parseContentLength(input: string, maximumBodyBytes: number) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(input)) throw new Error("Provider response length invalid")
  const expected = Number(input)
  if (!Number.isSafeInteger(expected) || expected > maximumBodyBytes) {
    throw new Error("Provider response length rejected")
  }
  return expected
}

function normalizeContentType(input: string | undefined) {
  if (input === undefined) return null
  const [mediaType, ...parameters] = input.split(";")
  const normalized = mediaType?.trim().toLowerCase() ?? ""
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
  if (!new RegExp(`^${token}/${token}$`, "u").test(normalized)) {
    throw new Error("Provider content type is invalid")
  }
  const parameter = new RegExp(`^\\s*${token}\\s*=\\s*(?:${token}|"(?:[\\t !#-\\[\\]-~]|\\\\[\\t !-~])*")\\s*$`, "u")
  if (parameters.some((entry) => !parameter.test(entry))) throw new Error("Provider content type is invalid")
  return normalized
}

function decodeChunkedBody(input: Buffer, maximumBodyBytes: number) {
  const chunks: Array<Buffer> = []
  let offset = 0
  let total = 0
  while (true) {
    const lineEnd = input.indexOf("\r\n", offset)
    if (lineEnd < 0 || lineEnd - offset > 128) throw new Error("Provider chunk header invalid")
    const line = input.subarray(offset, lineEnd).toString("ascii")
    const sizeText = line.split(";", 1)[0] ?? ""
    if (!/^[0-9a-fA-F]+$/u.test(sizeText)) throw new Error("Provider chunk size invalid")
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isSafeInteger(size) || size > maximumBodyBytes - total) {
      throw new Error("Provider chunk exceeds response limit")
    }
    offset = lineEnd + 2
    if (size === 0) {
      const trailer = input.subarray(offset)
      if (!trailer.equals(Buffer.from("\r\n")) && !trailer.equals(Buffer.from(""))) {
        throw new Error("Provider response trailers are unsupported")
      }
      return Uint8Array.from(Buffer.concat(chunks, total))
    }
    const end = offset + size
    if (end + 2 > input.byteLength || input[end] !== 13 || input[end + 1] !== 10) {
      throw new Error("Provider chunk body is truncated")
    }
    chunks.push(input.subarray(offset, end))
    total += size
    offset = end + 2
  }
}

function completeChunkedBodyBytes(input: Buffer, maximumBodyBytes: number) {
  let offset = 0
  let total = 0
  while (true) {
    const lineEnd = input.indexOf("\r\n", offset)
    if (lineEnd < 0) {
      if (input.byteLength - offset > 128) throw new Error("Provider chunk header invalid")
      return undefined
    }
    if (lineEnd - offset > 128) throw new Error("Provider chunk header invalid")
    const line = input.subarray(offset, lineEnd).toString("ascii")
    const sizeText = line.split(";", 1)[0] ?? ""
    if (!/^[0-9a-fA-F]+$/u.test(sizeText)) throw new Error("Provider chunk size invalid")
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isSafeInteger(size) || size > maximumBodyBytes - total) {
      throw new Error("Provider chunk exceeds response limit")
    }
    offset = lineEnd + 2
    if (size === 0) {
      if (input.byteLength < offset + 2) return undefined
      if (input[offset] !== 13 || input[offset + 1] !== 10) {
        throw new Error("Provider response trailers are unsupported")
      }
      return offset + 2
    }
    const end = offset + size
    if (input.byteLength < end + 2) return undefined
    if (input[end] !== 13 || input[end + 1] !== 10) throw new Error("Provider chunk body is truncated")
    total += size
    offset = end + 2
  }
}

function singleHeader(headers: Map<string, Array<string>>, name: string) {
  const values = headers.get(name)
  if (!values) return undefined
  if (values.length !== 1) throw new Error("Provider response header repeated")
  return values[0]
}

function pinnedAddress(evidence: ProviderTurnNetworkResolutionEvidence, hostname: string) {
  if (hostname !== evidence.hostname) throw new Error("Provider DNS hostname mismatch")
  return evidence.selectedAddress
}

function assertConnectedPeer(expected: ProviderTurnResolvedAddress, remoteAddress: string | undefined) {
  const actual = remoteAddress ? parseProviderTurnAddress(remoteAddress) : null
  if (!actual || !equalAddress(actual, expected)) throw new Error("Provider connected peer mismatch")
}

function snapshotWireValues(source: ExecuteProviderTurnInput, input: TrustedProviderWireValues) {
  if (!(input.body instanceof Uint8Array)) throw new TypeError("Provider request body must use bytes")
  if (input.body.byteLength > providerTurnMaximumRequestBytes) {
    throw new TypeError("Provider request body exceeds the bounded transport policy")
  }
  const body = Uint8Array.from(input.body)
  const bodyDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`
  if (body.byteLength !== source.plan.logicalPayload.bytes || bodyDigest !== source.plan.logicalPayload.digest) {
    throw new TypeError("Provider request body does not match the admitted logical payload")
  }

  const headers = input.headers.map(validateHeader)
  const credentialHandle = requireString(input.credential.handle, "credential handle")
  const accountFingerprint = requireString(input.credential.accountFingerprint, "credential account fingerprint")
  const credentialValue = requireString(input.credential.value, "credential value")
  if (
    credentialHandle !== source.plan.credential.handle ||
    accountFingerprint !== source.plan.credential.accountFingerprint
  ) {
    throw new TypeError("Provider credential material does not match the admitted credential binding")
  }
  if (headers.some(([name]) => name === source.plan.credential.headerName)) {
    throw new TypeError("Provider credential material must use its dedicated header binding")
  }
  validateHeader([source.plan.credential.headerName, credentialValue])
  headers.push(Object.freeze([source.plan.credential.headerName, credentialValue] as const))
  headers.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const names = headers.map(([name]) => name)
  if (
    names.length !== source.plan.wireRequest.headerNames.length ||
    names.some((name, index) => name !== source.plan.wireRequest.headerNames[index])
  ) {
    throw new TypeError("Provider request headers do not match the admitted header names")
  }
  const headerBytes = headers.reduce(
    (total, [name, value]) => total + new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength,
    0,
  )
  if (headerBytes > maximumHeaderBlockBytes) throw new TypeError("Provider request headers exceed the transport limit")
  return Object.freeze({
    body,
    bodyDigest,
    credential: Object.freeze({ handle: credentialHandle, accountFingerprint }),
    headers: Object.freeze(headers),
  })
}

function validateHeader(entry: readonly [name: string, value: string]) {
  if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("Provider request header entry is invalid")
  const name = requireString(entry[0], "header name")
  const value = requireString(entry[1], "header value")
  if (name !== name.toLowerCase() || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) {
    throw new TypeError("Provider request header names must be lowercase HTTP tokens")
  }
  if (/[^\t\u0020-\u007e]/u.test(value) || new TextEncoder().encode(value).byteLength > maximumHeaderValueBytes) {
    throw new TypeError("Provider request header value is invalid")
  }
  return Object.freeze([name, value] as const)
}

function assertExecutionMode(source: ExecuteProviderTurnInput, mode: TrustedProviderTurnDependencies["mode"]) {
  if (mode === "test_only_loopback") {
    if (source.plan.transportPolicy !== "test_only_loopback_http") {
      throw new TypeError("Provider loopback mode accepts only literal test fixtures")
    }
    return
  }
  if (source.plan.transportPolicy !== "https_only") {
    throw new TypeError("Provider HTTPS mode requires the admitted public pinned-peer policy")
  }
}

function assertRequestBinding(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  wire: ReturnType<typeof snapshotWireValues>,
) {
  if (
    adapterRequest.logicalPayload.digest !== wire.bodyDigest ||
    adapterRequest.logicalPayload.bytes !== wire.body.byteLength ||
    adapterRequest.credential.handle !== wire.credential.handle ||
    adapterRequest.credential.accountFingerprint !== wire.credential.accountFingerprint ||
    adapterRequest.wireRequest.headerNames.length !== wire.headers.length ||
    adapterRequest.wireRequest.headerNames.some((name, index) => name !== wire.headers[index]?.[0])
  ) {
    throw new Error("Provider transport binding mismatch")
  }
}

function validateExecutionAuthority(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  authority: ProviderTurnAdapterExecutionAuthority,
  currentTime: number,
) {
  const started = canonicalTimestampMilliseconds(authority.transportStartedAt)
  const claimExpires = canonicalTimestampMilliseconds(authority.claimExpiresAt)
  const consentExpires = canonicalTimestampMilliseconds(adapterRequest.capability.authorizationExpiresAt)
  const deadline = canonicalTimestampMilliseconds(authority.transportDeadlineAt)
  const expectedDeadline = Math.min(
    claimExpires,
    consentExpires,
    started + adapterRequest.wireRequest.timeoutMilliseconds,
  )
  if (
    deadline !== expectedDeadline ||
    currentTime < started ||
    currentTime >= deadline ||
    typeof authority.revalidateBeforeWrite !== "function"
  ) {
    throw new Error("Provider transport execution authority is invalid or expired")
  }
}

function canonicalTimestampMilliseconds(input: string) {
  const value = Date.parse(input)
  if (!Number.isFinite(value) || new Date(value).toISOString() !== input) {
    throw new Error("Provider transport authority timestamp is invalid")
  }
  return value
}

function assertBeforeDeadline(authority: ProviderTurnAdapterExecutionAuthority, currentTime: number) {
  if (!Number.isFinite(currentTime) || currentTime >= Date.parse(authority.transportDeadlineAt)) {
    throw new Error("Provider transport deadline expired")
  }
}

function remainingDeadlineMilliseconds(authority: ProviderTurnAdapterExecutionAuthority, currentTime: number) {
  assertBeforeDeadline(authority, currentTime)
  const remaining = Date.parse(authority.transportDeadlineAt) - currentTime
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new Error("Provider transport deadline is invalid")
  return remaining
}

function finishEvent(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  response: TrustedProviderHttpResponse,
  networkEvidence: ProviderTurnNetworkResolutionEvidence,
): UntrustedProviderTurnAdapterFinishEvent {
  return {
    type: "provider.finish",
    requestBinding: {
      operationID: adapterRequest.operationID,
      attemptID: adapterRequest.capability.attemptID,
      capabilityGrantID: adapterRequest.capability.capabilityGrantID,
      capabilityDigest: adapterRequest.capability.capabilityDigest,
      expectedOrigin: adapterRequest.expectedOrigin,
      logicalPayloadDigest: adapterRequest.logicalPayload.digest,
      logicalPayloadBytes: adapterRequest.logicalPayload.bytes,
    },
    finalOrigin: adapterRequest.expectedOrigin,
    networkEvidence,
    httpEvidence: response.evidence,
    finishReason: "other",
    response: response.body,
  }
}

function observedFinishEvent(
  adapterRequest: UntrustedProviderTurnAdapterRequest,
  response: TrustedProviderHttpResponse,
  networkEvidence: ProviderTurnNetworkResolutionEvidence,
  completion: TrustedObservedProviderCompletion,
): TrustedObservedProviderTurnAdapterFinishEvent {
  return {
    type: "provider.observed-completion",
    requestBinding: {
      operationID: adapterRequest.operationID,
      attemptID: adapterRequest.capability.attemptID,
      capabilityGrantID: adapterRequest.capability.capabilityGrantID,
      capabilityDigest: adapterRequest.capability.capabilityDigest,
      expectedOrigin: adapterRequest.expectedOrigin,
      logicalPayloadDigest: adapterRequest.logicalPayload.digest,
      logicalPayloadBytes: adapterRequest.logicalPayload.bytes,
    },
    finalOrigin: adapterRequest.expectedOrigin,
    networkEvidence,
    httpEvidence: response.evidence,
    completion,
  }
}

async function defaultResolver(hostname: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error("Provider DNS resolution expired")
  const result = await lookup(hostname, { all: true, verbatim: true })
  if (signal.aborted) throw new Error("Provider DNS resolution expired")
  return result
}

async function resolveProviderNetwork(
  policy: ProviderTurnNetworkPolicy,
  now: () => number,
  resolver: Resolver | undefined,
  deadline = now() + 30_000,
) {
  if (!resolver) throw new Error("Provider resolver is unavailable")
  const resolved = await resolveBeforeDeadline(policy.hostname, resolver, deadline, now)
  if (now() >= deadline) throw new Error("Provider DNS resolution exceeded its authority deadline")
  const addresses = resolved
    .map((entry) => parseProviderTurnAddress(entry.address))
    .filter((entry): entry is ProviderTurnResolvedAddress => entry !== null)
    .sort(compareAddresses)
  if (
    addresses.length !== resolved.length ||
    addresses.length < 1 ||
    addresses.length > 8 ||
    addresses.some((entry, index) => (index === 0 ? false : equalAddress(entry, addresses[index - 1]!))) ||
    addresses.some((entry) => !isPublicProviderTurnAddress(entry))
  ) {
    throw new Error("Provider DNS resolution contains an ineligible address")
  }
  return validateProviderTurnResolutionEvidence(
    {
      hostname: policy.hostname,
      port: policy.port,
      addresses,
      selectedAddress: addresses[0]!,
      connectedPeer: addresses[0]!,
      resolvedAt: new Date(now()).toISOString(),
      dnsPolicyDigest: policy.dnsPolicyDigest,
      resolverImplementationDigest: policy.resolverImplementationDigest,
      transportImplementationDigest: policy.transportImplementationDigest,
    },
    policy,
  )
}

function resolveBeforeDeadline(hostname: string, resolver: Resolver, deadline: number, now: () => number) {
  return new Promise<ReadonlyArray<Readonly<{ address: string; family: number }>>>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      controller.abort()
      reject(new Error("Provider DNS resolution failed or expired"))
    }
    const remaining = deadline - now()
    if (!Number.isSafeInteger(remaining) || remaining <= 0) return fail()
    const timeout = setTimeout(fail, remaining)
    timeout.unref?.()
    const complete = (result: ReadonlyArray<Readonly<{ address: string; family: number }>>) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    void Promise.resolve()
      .then(() => resolver(hostname, controller.signal))
      .then(complete, fail)
  })
}

function loopbackEvidence(policy: ProviderTurnNetworkPolicy, now: number) {
  const address = parseProviderTurnAddress(policy.hostname === "[::1]" ? "::1" : policy.hostname)
  if (!address || !isLiteralProviderTurnLoopbackHostname(policy.hostname)) {
    throw new Error("Provider loopback evidence is invalid")
  }
  return validateProviderTurnResolutionEvidence(
    {
      hostname: policy.hostname,
      port: policy.port,
      addresses: [address],
      selectedAddress: address,
      connectedPeer: address,
      resolvedAt: new Date(now).toISOString(),
      dnsPolicyDigest: policy.dnsPolicyDigest,
      resolverImplementationDigest: policy.resolverImplementationDigest,
      transportImplementationDigest: policy.transportImplementationDigest,
    },
    policy,
  )
}

function compareAddresses(left: ProviderTurnResolvedAddress, right: ProviderTurnResolvedAddress) {
  if (left.family !== right.family) return left.family - right.family
  return left.address < right.address ? -1 : left.address > right.address ? 1 : 0
}

function equalAddress(left: ProviderTurnResolvedAddress, right: ProviderTurnResolvedAddress) {
  return left.family === right.family && left.address === right.address
}

function requireString(input: unknown, label: string) {
  if (typeof input !== "string" || input.length < 1) throw new TypeError(`Provider request ${label} is invalid`)
  return input
}

export const providerTurnTransportTestOnly = Object.freeze({
  assertConnectedPeer,
  parseRawResponse,
  tryParseCompleteRawResponse,
  pinnedAddress,
  resolveProviderNetwork,
  tlsConnectionOptions,
})
