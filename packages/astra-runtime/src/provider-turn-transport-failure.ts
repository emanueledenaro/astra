export const providerTransportFailureCodes = [
  "authority_or_request_rejected",
  "connection_closed_before_complete_response",
  "credential_material_rejected",
  "dns_resolution_failed",
  "provider_response_rejected",
  "response_framing_rejected",
  "response_limit_exceeded",
  "response_timeout",
  "tls_or_connection_failed",
] as const

export type ProviderTransportFailureCode = (typeof providerTransportFailureCodes)[number]

/** Carries only an allowlisted, non-secret transport failure classification. */
export class ProviderTransportFailure extends Error {
  readonly _tag = "ProviderTransportFailure"

  constructor(readonly code: ProviderTransportFailureCode) {
    super(`Provider transport failed: ${code}`)
    this.name = this._tag
  }
}

export function asProviderTransportFailure(
  cause: unknown,
  fallback: ProviderTransportFailureCode,
): ProviderTransportFailure {
  return cause instanceof ProviderTransportFailure ? cause : new ProviderTransportFailure(fallback)
}

export function providerTransportFailureCode(cause: unknown): ProviderTransportFailureCode | null {
  return cause instanceof ProviderTransportFailure ? cause.code : null
}
