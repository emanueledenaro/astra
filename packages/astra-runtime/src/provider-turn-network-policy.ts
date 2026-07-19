import { BlockList, SocketAddress, isIP } from "node:net"
import { digest } from "./controlled-write-authority"

const maximumResolvedAddresses = 8

export const providerTurnPublicDnsPolicyDigest = digest("astra-policy:provider-public-dns-pinned-peer:v2")
export const providerTurnLoopbackPolicyDigest = digest("astra-policy:provider-literal-loopback-test-only:v1")
export const providerTurnResolverImplementationDigest = digest("astra-runtime:provider-node-dns-lookup-deadline:v2")
export const providerTurnTransportImplementationDigest = digest("astra-runtime:provider-node-tls-http1-pinned-peer:v3")

export type ProviderTurnResolvedAddress = Readonly<{
  address: string
  family: 4 | 6
}>

export type ProviderTurnNetworkPolicy = Readonly<{
  mode: "https_public_pinned" | "test_literal_loopback"
  hostname: string
  port: number
  dnsPolicyDigest: string
  resolverImplementationDigest: string
  transportImplementationDigest: string
}>

export type ProviderTurnNetworkResolutionEvidence = Readonly<{
  hostname: string
  port: number
  addresses: ReadonlyArray<ProviderTurnResolvedAddress>
  selectedAddress: ProviderTurnResolvedAddress
  connectedPeer: ProviderTurnResolvedAddress
  resolvedAt: string
  dnsPolicyDigest: string
  resolverImplementationDigest: string
  transportImplementationDigest: string
}>

const nonPublicIpv4Addresses = new BlockList()
const nonPublicIpv6Addresses = new BlockList()

;[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].forEach(([address, prefix]) => nonPublicIpv4Addresses.addSubnet(String(address), Number(prefix), "ipv4"))
;[
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
].forEach(([address, prefix]) => nonPublicIpv6Addresses.addSubnet(String(address), Number(prefix), "ipv6"))

export function parseProviderTurnAddress(input: string): ProviderTurnResolvedAddress | null {
  if (input.includes("%")) return null
  const family = isIP(input)
  if (family !== 4 && family !== 6) return null
  const parsed = SocketAddress.parse(family === 4 ? `${input}:443` : `[${input}]:443`)
  if (!parsed) return null
  return Object.freeze({ address: parsed.address, family })
}

export function isPublicProviderTurnAddress(input: ProviderTurnResolvedAddress) {
  return input.family === 4
    ? !nonPublicIpv4Addresses.check(input.address, "ipv4")
    : !nonPublicIpv6Addresses.check(input.address, "ipv6")
}

export function isLiteralProviderTurnLoopback(input: ProviderTurnResolvedAddress) {
  return (input.family === 4 && input.address === "127.0.0.1") || (input.family === 6 && input.address === "::1")
}

export function isLiteralProviderTurnLoopbackHostname(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "[::1]"
}

export function snapshotProviderTurnNetworkPolicy(source: ProviderTurnNetworkPolicy): ProviderTurnNetworkPolicy {
  return Object.freeze({
    mode: source.mode,
    hostname: requireString(source.hostname),
    port: source.port,
    dnsPolicyDigest: requireString(source.dnsPolicyDigest),
    resolverImplementationDigest: requireString(source.resolverImplementationDigest),
    transportImplementationDigest: requireString(source.transportImplementationDigest),
  })
}

export function validateProviderTurnNetworkPolicy(
  source: ProviderTurnNetworkPolicy,
  input: Readonly<{
    origin: string
    transportPolicy: "https_only" | "test_only_loopback_http"
  }>,
) {
  const policy = snapshotProviderTurnNetworkPolicy(source)
  const origin = new URL(input.origin)
  const expectedPort = Number(origin.port || (origin.protocol === "https:" ? 443 : 80))
  if (
    policy.hostname !== origin.hostname ||
    policy.port !== expectedPort ||
    !Number.isSafeInteger(policy.port) ||
    policy.port < 1 ||
    policy.port > 65_535 ||
    policy.resolverImplementationDigest !== providerTurnResolverImplementationDigest ||
    policy.transportImplementationDigest !== providerTurnTransportImplementationDigest
  ) {
    throw new TypeError("Provider network policy does not match the admitted origin and transport")
  }
  if (input.transportPolicy === "https_only") {
    if (
      policy.mode !== "https_public_pinned" ||
      policy.dnsPolicyDigest !== providerTurnPublicDnsPolicyDigest ||
      isIP(policy.hostname) !== 0
    ) {
      throw new TypeError("Provider HTTPS policy requires a DNS hostname and public pinned-peer transport")
    }
    return policy
  }
  if (
    policy.mode !== "test_literal_loopback" ||
    policy.dnsPolicyDigest !== providerTurnLoopbackPolicyDigest ||
    !isLiteralProviderTurnLoopbackHostname(policy.hostname)
  ) {
    throw new TypeError("Provider test policy requires a literal loopback origin")
  }
  return policy
}

export function snapshotProviderTurnResolutionEvidence(
  source: ProviderTurnNetworkResolutionEvidence,
): ProviderTurnNetworkResolutionEvidence {
  return deepFreeze({
    hostname: requireString(source.hostname),
    port: source.port,
    addresses: source.addresses.map((entry) => ({ address: requireString(entry.address), family: entry.family })),
    selectedAddress: {
      address: requireString(source.selectedAddress.address),
      family: source.selectedAddress.family,
    },
    connectedPeer: {
      address: requireString(source.connectedPeer.address),
      family: source.connectedPeer.family,
    },
    resolvedAt: requireString(source.resolvedAt),
    dnsPolicyDigest: requireString(source.dnsPolicyDigest),
    resolverImplementationDigest: requireString(source.resolverImplementationDigest),
    transportImplementationDigest: requireString(source.transportImplementationDigest),
  })
}

export function validateProviderTurnResolutionEvidence(source: unknown, policySource: ProviderTurnNetworkPolicy) {
  const evidence = parseProviderTurnResolutionEvidence(source)
  const policy = snapshotProviderTurnNetworkPolicy(policySource)
  if (
    evidence.hostname !== policy.hostname ||
    evidence.port !== policy.port ||
    evidence.dnsPolicyDigest !== policy.dnsPolicyDigest ||
    evidence.resolverImplementationDigest !== policy.resolverImplementationDigest ||
    evidence.transportImplementationDigest !== policy.transportImplementationDigest ||
    !Number.isFinite(Date.parse(evidence.resolvedAt)) ||
    new Date(Date.parse(evidence.resolvedAt)).toISOString() !== evidence.resolvedAt
  ) {
    throw new TypeError("Provider resolution evidence does not match the admitted network policy")
  }
  const addresses = evidence.addresses.map(requireCanonicalAddress)
  if (
    addresses.length < 1 ||
    addresses.length > maximumResolvedAddresses ||
    addresses.some(
      (entry, index) =>
        index > 0 &&
        (entry.family < addresses[index - 1]!.family ||
          (entry.family === addresses[index - 1]!.family && entry.address <= addresses[index - 1]!.address)),
    )
  ) {
    throw new TypeError("Provider resolution addresses must be unique, canonical, and sorted")
  }
  const selected = requireCanonicalAddress(evidence.selectedAddress)
  const connected = requireCanonicalAddress(evidence.connectedPeer)
  if (
    !addresses.some((entry) => equalAddress(entry, selected)) ||
    !equalAddress(selected, connected) ||
    (policy.mode === "https_public_pinned" && addresses.some((entry) => !isPublicProviderTurnAddress(entry))) ||
    (policy.mode === "test_literal_loopback" && (addresses.length !== 1 || !isLiteralProviderTurnLoopback(selected)))
  ) {
    throw new TypeError("Provider resolution evidence failed address or connected-peer policy")
  }
  return evidence
}

function parseProviderTurnResolutionEvidence(source: unknown) {
  const record = exactRecord(source, [
    "hostname",
    "port",
    "addresses",
    "selectedAddress",
    "connectedPeer",
    "resolvedAt",
    "dnsPolicyDigest",
    "resolverImplementationDigest",
    "transportImplementationDigest",
  ])
  if (!Array.isArray(record.addresses)) throw new TypeError("Provider resolution addresses are invalid")
  return snapshotProviderTurnResolutionEvidence({
    hostname: requireString(record.hostname),
    port: requireNumber(record.port),
    addresses: record.addresses.map(parseAddressRecord),
    selectedAddress: parseAddressRecord(record.selectedAddress),
    connectedPeer: parseAddressRecord(record.connectedPeer),
    resolvedAt: requireString(record.resolvedAt),
    dnsPolicyDigest: requireString(record.dnsPolicyDigest),
    resolverImplementationDigest: requireString(record.resolverImplementationDigest),
    transportImplementationDigest: requireString(record.transportImplementationDigest),
  })
}

function parseAddressRecord(source: unknown): ProviderTurnResolvedAddress {
  const record = exactRecord(source, ["address", "family"])
  if (record.family !== 4 && record.family !== 6) throw new TypeError("Provider address family is invalid")
  return { address: requireString(record.address), family: record.family }
}

function exactRecord(source: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TypeError("Provider network evidence record is invalid")
  }
  const keys = Reflect.ownKeys(source)
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string") ||
    fields.some((field) => !Object.hasOwn(source, field))
  ) {
    throw new TypeError("Provider network evidence fields are invalid")
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(source, field)]))
}

function requireCanonicalAddress(input: ProviderTurnResolvedAddress) {
  const parsed = parseProviderTurnAddress(input.address)
  if (!parsed || parsed.family !== input.family || parsed.address !== input.address) {
    throw new TypeError("Provider network address is invalid or non-canonical")
  }
  return parsed
}

function equalAddress(left: ProviderTurnResolvedAddress, right: ProviderTurnResolvedAddress) {
  return left.family === right.family && left.address === right.address
}

function requireString(input: unknown) {
  if (typeof input !== "string" || input.length < 1) throw new TypeError("Provider network value is invalid")
  return input
}

function requireNumber(input: unknown) {
  if (typeof input !== "number") throw new TypeError("Provider network number is invalid")
  return input
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input
  Reflect.ownKeys(input).forEach((key) => deepFreeze(Reflect.get(input, key)))
  return Object.freeze(input)
}
