export type OperationContractIssue = Readonly<{
  path: string
  reason: string
}>

export type OperationContractParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; issue: OperationContractIssue }>

export type NormalizedJson = string | number | boolean | null | NormalizedJsonObject | NormalizedJsonArray

export interface NormalizedJsonObject {
  readonly [key: string]: NormalizedJson
}

export interface NormalizedJsonArray extends ReadonlyArray<NormalizedJson> {}

const maximumJsonDepth = 24
const maximumJsonNodes = 10_000
const maximumJsonStringLength = 65_536

export function parsed<Value>(value: Value): OperationContractParseResult<Value> {
  return { ok: true, value }
}

export function rejected(path: string, reason: string): OperationContractParseResult<never> {
  return { ok: false, issue: { path, reason } }
}

export function parseExactRecord(
  input: unknown,
  fields: ReadonlyArray<string>,
  path = "$",
): OperationContractParseResult<Readonly<Record<string, unknown>>> {
  if (!isPlainRecord(input)) return rejected(path, "expected_object")

  const allowed = new Set(fields)
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") return rejected(path, "unexpected_symbol_field")
    if (!allowed.has(key)) return rejected(`${path}.${key}`, "unexpected_field")

    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return rejected(`${path}.${key}`, "accessor_field_not_allowed")
    record[key] = descriptor.value
  }

  return parsed(record)
}

export function parseBoundedString(
  input: unknown,
  path: string,
  maximumLength = 256,
): OperationContractParseResult<string> {
  if (typeof input !== "string") return rejected(path, "expected_string")
  if (input.length === 0 || input.length > maximumLength || input !== input.trim()) {
    return rejected(path, "expected_bounded_non_empty_string")
  }
  if (/\p{C}/u.test(input)) return rejected(path, "control_character_not_allowed")
  return parsed(input)
}

export function parsePositiveInteger(
  input: unknown,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): OperationContractParseResult<number> {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > maximum) {
    return rejected(path, "expected_bounded_positive_integer")
  }
  return parsed(input)
}

export function parseNonNegativeInteger(input: unknown, path: string): OperationContractParseResult<number> {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return rejected(path, "expected_non_negative_integer")
  }
  return parsed(input)
}

export function parseCanonicalTimestamp(input: unknown, path: string): OperationContractParseResult<string> {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    return rejected(path, "expected_canonical_timestamp")
  }

  const milliseconds = Date.parse(input)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input) {
    return rejected(path, "expected_canonical_timestamp")
  }
  return parsed(input)
}

export function parseNormalizedJsonObject(
  input: unknown,
  path: string,
): OperationContractParseResult<NormalizedJsonObject> {
  if (!isPlainRecord(input)) return rejected(path, "expected_json_object")

  const budget = { remaining: maximumJsonNodes }
  const normalized = parseNormalizedJson(input, path, 0, budget)
  if (!normalized.ok) return normalized
  if (!isNormalizedJsonObject(normalized.value)) {
    return rejected(path, "expected_json_object")
  }
  return parsed(normalized.value)
}

export function parseNormalizedJsonArray(
  input: unknown,
  path: string,
): OperationContractParseResult<NormalizedJsonArray> {
  if (!Array.isArray(input)) return rejected(path, "expected_json_array")
  const budget = { remaining: maximumJsonNodes }
  const normalized = parseNormalizedJson(input, path, 0, budget)
  if (!normalized.ok) return normalized
  if (!isNormalizedJsonArray(normalized.value)) return rejected(path, "expected_json_array")
  return parsed(normalized.value)
}

export function parseDistinctStringArray(
  input: unknown,
  path: string,
  allowedValues?: ReadonlySet<string>,
  requireValue = false,
): OperationContractParseResult<ReadonlyArray<string>> {
  if (!Array.isArray(input)) return rejected(path, "expected_array")
  if (requireValue && input.length === 0) return rejected(path, "expected_non_empty_array")
  if (input.length > 256) return rejected(path, "array_limit_exceeded")

  const values: Array<string> = []
  const seen = new Set<string>()
  for (const [index, item] of input.entries()) {
    const value = parseBoundedString(item, `${path}[${index}]`, 1_024)
    if (!value.ok) return value
    if (allowedValues && !allowedValues.has(value.value)) return rejected(`${path}[${index}]`, "unsupported_value")
    if (seen.has(value.value)) return rejected(`${path}[${index}]`, "duplicate_value")
    seen.add(value.value)
    values.push(value.value)
  }
  return parsed(values)
}

function parseNormalizedJson(
  input: unknown,
  path: string,
  depth: number,
  budget: { remaining: number },
): OperationContractParseResult<NormalizedJson> {
  if (depth > maximumJsonDepth) return rejected(path, "json_depth_limit_exceeded")
  budget.remaining -= 1
  if (budget.remaining < 0) return rejected(path, "json_node_limit_exceeded")

  if (input === null || typeof input === "boolean") return parsed(input)
  if (typeof input === "string") {
    if (input.length > maximumJsonStringLength) return rejected(path, "json_string_limit_exceeded")
    return parsed(input)
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return rejected(path, "non_finite_number_not_allowed")
    return parsed(input)
  }
  if (Array.isArray(input)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length")
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value)
    ) {
      return rejected(path, "invalid_array_length")
    }
    const length = lengthDescriptor.value
    if (length > 1_024) return rejected(path, "array_limit_exceeded")
    for (const key of Reflect.ownKeys(input)) {
      if (key === "length") continue
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
        return rejected(path, "unexpected_array_field")
      }
    }
    const values: Array<NormalizedJson> = []
    for (let index = 0; index < length; index += 1) {
      const itemPath = `${path}[${index}]`
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
      if (!descriptor) return rejected(itemPath, "sparse_array_not_allowed")
      if (!("value" in descriptor)) return rejected(itemPath, "accessor_field_not_allowed")
      const value = parseNormalizedJson(descriptor.value, itemPath, depth + 1, budget)
      if (!value.ok) return value
      values.push(value.value)
    }
    return parsed(values)
  }
  if (!isPlainRecord(input)) return rejected(path, "expected_json_value")

  const keys = Reflect.ownKeys(input)
  if (keys.length > 1_024) return rejected(path, "object_field_limit_exceeded")
  const record: Record<string, NormalizedJson> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== "string") return rejected(path, "symbol_key_not_allowed")
    if (key.length === 0 || key.length > 256 || /\p{C}/u.test(key)) return rejected(path, "json_key_limit_exceeded")

    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !("value" in descriptor)) return rejected(`${path}.${key}`, "accessor_field_not_allowed")
    const value = parseNormalizedJson(descriptor.value, `${path}.${key}`, depth + 1, budget)
    if (!value.ok) return value
    record[key] = value.value
  }
  return parsed(
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
  )
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function isNormalizedJsonObject(input: NormalizedJson): input is NormalizedJsonObject {
  return input !== null && typeof input === "object" && !Array.isArray(input)
}

function isNormalizedJsonArray(input: NormalizedJson): input is NormalizedJsonArray {
  return Array.isArray(input)
}
