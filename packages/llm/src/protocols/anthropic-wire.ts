import { Schema } from "effect"

const optionalNull = <const S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

const TextBlock = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
})

/** Strict tool-free shape used by products that intentionally send one private text turn. */
export const OneTurnRequest = Schema.Struct({
  model: Schema.String,
  system: Schema.Tuple([TextBlock]),
  messages: Schema.Tuple([
    Schema.Struct({
      role: Schema.Literal("user"),
      content: Schema.Tuple([TextBlock]),
    }),
  ]),
  stream: Schema.Literal(true),
  max_tokens: Schema.Number,
})
export type OneTurnRequest = Schema.Schema.Type<typeof OneTurnRequest>

export const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: optionalNull(Schema.Number),
  cache_read_input_tokens: optionalNull(Schema.Number),
})
export type Usage = Schema.Schema.Type<typeof Usage>

const StreamBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  tool_use_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
})

const StreamDelta = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  partial_json: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  stop_reason: optionalNull(Schema.String),
  stop_sequence: optionalNull(Schema.String),
})

/** Canonical Anthropic Messages streaming-event codec without route or provider initialization. */
export const StreamEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.Struct({ usage: Schema.optional(Usage) })),
  content_block: Schema.optional(StreamBlock),
  delta: Schema.optional(StreamDelta),
  usage: Schema.optional(Usage),
  error: Schema.optional(
    Schema.Struct({ type: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }),
  ),
})
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>

export * as AnthropicWire from "./anthropic-wire"
