export const providerTransportFailureCodes = [
  "authority_or_request_rejected",
  "connection_closed_before_complete_response",
  "credential_material_rejected",
  "dns_resolution_failed",
  "provider_response_rejected",
  "provider_response_assistant_text_empty",
  "provider_response_assistant_text_too_large",
  "provider_response_content_type_rejected",
  "provider_response_event_invalid",
  "provider_response_event_limit_exceeded",
  "provider_response_event_sequence_rejected",
  "provider_response_http_status_rejected",
  "provider_response_provider_error",
  "provider_response_response_encoding_rejected",
  "provider_response_response_too_large",
  "provider_response_stream_framing_rejected",
  "provider_response_stream_truncated",
  "provider_response_terminal_stop_rejected",
  "provider_response_tool_use_rejected",
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

const providerResponseParserFailureCodes = new Set([
  "assistant_text_empty",
  "assistant_text_too_large",
  "content_type_rejected",
  "event_invalid",
  "event_limit_exceeded",
  "event_sequence_rejected",
  "http_status_rejected",
  "provider_error",
  "response_encoding_rejected",
  "response_too_large",
  "stream_framing_rejected",
  "stream_truncated",
  "terminal_stop_rejected",
  "tool_use_rejected",
])

/** Preserves only a known parser classification and discards response content. */
export function asProviderResponseTransportFailure(cause: unknown): ProviderTransportFailure {
  if (typeof cause !== "object" || cause === null || !("name" in cause) || !("code" in cause)) {
    return new ProviderTransportFailure("provider_response_rejected")
  }
  const record = cause as Readonly<{ name: unknown; code: unknown }>
  if (
    record.name !== "OpenAIResponsesOneTurnError" ||
    typeof record.code !== "string" ||
    !providerResponseParserFailureCodes.has(record.code)
  ) {
    return new ProviderTransportFailure("provider_response_rejected")
  }
  return new ProviderTransportFailure(
    `provider_response_${record.code}` as ProviderTransportFailureCode,
  )
}

export function providerTransportFailureCode(cause: unknown): ProviderTransportFailureCode | null {
  return cause instanceof ProviderTransportFailure ? cause.code : null
}
