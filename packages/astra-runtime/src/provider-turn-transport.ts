import { createHash } from "node:crypto"
import {
  executeProviderTurn,
  untrustedProviderTurnAdapterDescriptor,
  type DurableProviderTurnResult,
  type ExecuteProviderTurnInput,
  type UntrustedProviderTurnAdapter,
  type UntrustedProviderTurnAdapterFinishEvent,
} from "./provider-turn-coordinator"
import {
  isProviderTurnLiteralLoopbackHostname,
  providerTurnMaximumRequestBytes,
  type ProviderTurnPreview,
  type UntrustedProviderTurnAdapterRequest,
} from "./provider-turn-operation-facts"

const maximumHeaderValueBytes = 8_192
const maximumHeaderBlockBytes = 32_768

/**
 * This boundary does not resolve, pin, or verify the connected peer address.
 * HTTPS production use is therefore rejected even though request construction
 * and response handling are owned here.
 */
export const trustedProviderTurnTransportDescriptor = Object.freeze({
  ownership: "astra",
  productionCapable: false,
  allowedMode: "dormant_test_only",
  peerEnforcement: "not_implemented",
  terminalState: "effect_unknown_only",
} as const)

/**
 * In-memory wire values for one provider call. Header values and body bytes are
 * deliberately absent from the durable provider-turn facts.
 */
export type TrustedProviderWireValues = Readonly<{
  credential: Readonly<{
    handle: string
    accountFingerprint: string
    value: string
  }>
  headers: ReadonlyArray<readonly [name: string, value: string]>
  body: Uint8Array
}>

export type TrustedProviderTurnDependencies = Readonly<{
  mode: "dormant_test_only" | "production"
  requestApproval: (preview: ProviderTurnPreview) => Promise<"approve" | "reject">
  now?: () => number
}>

/**
 * Dormant integration boundary. The durable coordinator owns consent and the
 * one-shot claim; this module owns the single HTTP request made afterward.
 * It remains unexported from @astra/runtime until connected-peer enforcement
 * and provider-specific response parsing are connected without weakening these
 * transport rules.
 */
export function executeProviderTurnWithTrustedTransport(
  source: ExecuteProviderTurnInput,
  wireValues: TrustedProviderWireValues,
  dependencies: TrustedProviderTurnDependencies,
): Promise<DurableProviderTurnResult> {
  if (dependencies.mode !== trustedProviderTurnTransportDescriptor.allowedMode) {
    throw new TypeError("Provider transport production mode requires DNS and connected-peer enforcement")
  }
  if (source.plan.transportPolicy !== "test_only_loopback_http") {
    throw new TypeError("The dormant provider transport is limited to literal loopback fixtures")
  }
  const wire = snapshotWireValues(source, wireValues)
  const transport = trustedTransportAdapter(wire, dependencies.now ?? Date.now)
  return executeProviderTurn(source, {
    requestApproval: dependencies.requestApproval,
    untrustedAdapter: transport,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  })
}

function trustedTransportAdapter(
  wire: ReturnType<typeof snapshotWireValues>,
  now: () => number,
): UntrustedProviderTurnAdapter {
  return {
    descriptor: untrustedProviderTurnAdapterDescriptor,
    async execute(request) {
      assertRequestBinding(request, wire)
      if (now() >= Date.parse(request.capability.authorizationExpiresAt)) {
        throw new Error("Provider transport authority expired")
      }
      const response = await executeOnce(request, wire)
      return {
        type: "provider.finish",
        requestBinding: {
          operationID: request.operationID,
          attemptID: request.capability.attemptID,
          capabilityGrantID: request.capability.capabilityGrantID,
          capabilityDigest: request.capability.capabilityDigest,
          expectedOrigin: request.expectedOrigin,
          logicalPayloadDigest: request.logicalPayload.digest,
          logicalPayloadBytes: request.logicalPayload.bytes,
        },
        finalOrigin: request.expectedOrigin,
        finishReason: "other",
        response,
      } satisfies UntrustedProviderTurnAdapterFinishEvent
    },
  }
}

async function executeOnce(request: UntrustedProviderTurnAdapterRequest, wire: ReturnType<typeof snapshotWireValues>) {
  const url = `${request.expectedOrigin}${request.wireRequest.path}`
  assertTransportUrl(url, request)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.wireRequest.timeoutMilliseconds)
  timeout.unref?.()
  try {
    const response = await fetch(url, {
      method: request.wireRequest.method,
      headers: Object.fromEntries(wire.headers),
      body: wire.body,
      redirect: "manual",
      signal: controller.signal,
    })
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("Provider transport redirect blocked")
    }
    if (!response.url || new URL(response.url).origin !== request.expectedOrigin || response.url !== url) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("Provider transport origin mismatch")
    }
    return readBoundedResponse(response, request.wireRequest.maximumResponseBytes)
  } catch {
    throw new Error("Provider transport request failed")
  } finally {
    clearTimeout(timeout)
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number) {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("Provider response limit exceeded")
    }
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.byteLength > maximumBytes - total) {
        await reader.cancel().catch(() => undefined)
        throw new Error("Provider response limit exceeded")
      }
      chunks.push(Uint8Array.from(next.value))
      total += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  const responseBytes = new Uint8Array(total)
  chunks.reduce((offset, chunk) => {
    responseBytes.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return responseBytes
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

  const headers = input.headers.map((entry) => {
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
  })
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
  if (
    /[^\t\u0020-\u007e]/u.test(credentialValue) ||
    new TextEncoder().encode(credentialValue).byteLength > maximumHeaderValueBytes
  ) {
    throw new TypeError("Provider credential value is invalid")
  }
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

function assertRequestBinding(
  request: UntrustedProviderTurnAdapterRequest,
  wire: ReturnType<typeof snapshotWireValues>,
) {
  if (
    request.logicalPayload.digest !== wire.bodyDigest ||
    request.logicalPayload.bytes !== wire.body.byteLength ||
    request.credential.handle !== wire.credential.handle ||
    request.credential.accountFingerprint !== wire.credential.accountFingerprint ||
    request.wireRequest.headerNames.length !== wire.headers.length ||
    request.wireRequest.headerNames.some((name, index) => name !== wire.headers[index]?.[0])
  ) {
    throw new Error("Provider transport binding mismatch")
  }
}

function assertTransportUrl(url: string, request: UntrustedProviderTurnAdapterRequest) {
  const parsed = new URL(url)
  if (
    parsed.origin !== request.expectedOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Provider transport URL rejected")
  }
  if (
    request.provider.transportPolicy === "test_only_loopback_http" &&
    parsed.protocol === "http:" &&
    isProviderTurnLiteralLoopbackHostname(parsed.hostname)
  ) {
    return
  }
  throw new Error("Provider transport policy rejected")
}

function requireString(input: unknown, label: string) {
  if (typeof input !== "string" || input.length < 1) throw new TypeError(`Provider request ${label} is invalid`)
  return input
}
