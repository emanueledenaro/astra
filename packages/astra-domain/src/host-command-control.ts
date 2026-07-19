import { parseExactRecord } from "./operation-contract-validation"

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digestPattern = /^sha256:[0-9a-f]{64}$/
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const maximumScriptBytes = 4_096
const maximumDisplayLines = 100
const maximumDisplayLineBytes = 512
const maximumDisplayBytes = 32_768

export const hostCommandBoundaryLabel = "HOST EXECUTION — NO SANDBOX"

export type HostCommandPrepareRequest = Readonly<{
  schemaVersion: 1
  method: "host-command.prepare"
  requestId: string
  sessionID: string
  token: string
  script: string
}>

export type HostCommandDecisionRequest = Readonly<{
  schemaVersion: 1
  method: "host-command.decide"
  requestId: string
  sessionID: string
  token: string
  proposalID: string
  decision: "approve" | "reject"
}>

export type HostCommandControlRequest = HostCommandPrepareRequest | HostCommandDecisionRequest

export type HostCommandControlPreview = Readonly<{
  schemaVersion: 1
  proposalID: string
  operationID: string
  script: string
  scriptBytes: number
  scriptDigest: `sha256:${string}`
  capabilityDigest: `sha256:${string}`
  expiresAt: string
  boundaryLabel: typeof hostCommandBoundaryLabel
  workspaceRoot: string
  executable: "/bin/zsh"
  argvPrefix: readonly ["-f", "-c"]
  environment: ReadonlyArray<Readonly<{ name: "LANG" | "LC_ALL" | "PATH" | "TZ"; value: string }>>
  resources: ReadonlyArray<string>
  filesystem: "host_unrestricted"
  network: "host_unrestricted"
  writes: readonly ["command_defined"]
  verification: "not_verified"
}>

export type HostCommandOutputSummary = Readonly<{
  outputDigest: `sha256:${string}`
  digestScope: "stdout_stderr_exit"
  exitCode: number | null
  stdoutLines: ReadonlyArray<string>
  stderrLines: ReadonlyArray<string>
  truncated: boolean
}>

export type HostCommandPrepareResult =
  | Readonly<{ schemaVersion: 1; requestId: string; status: "prepared"; preview: HostCommandControlPreview }>
  | Readonly<{ schemaVersion: 1; requestId: string; status: "blocked"; reason: string }>

type HostCommandDecisionBinding = Readonly<{
  schemaVersion: 1
  requestId: string
  proposalID: string
  operationID: string
  capabilityDigest: `sha256:${string}`
  verification: "not_verified"
}>

export type HostCommandDecisionResult =
  | (HostCommandDecisionBinding & Readonly<{ status: "denied_without_effect" }>)
  | (HostCommandDecisionBinding &
      Readonly<{
        status: "completed_observed_not_verified"
        receiptID: string
        output: HostCommandOutputSummary
      }>)
  | (HostCommandDecisionBinding & Readonly<{ status: "failed_without_effect"; reason: string }>)
  | (HostCommandDecisionBinding &
      Readonly<{
        status: "reconciliation_required"
        reason: string
        receiptID: string | null
        output: HostCommandOutputSummary | null
      }>)
  | Readonly<{
      schemaVersion: 1
      requestId: string
      proposalID: string
      status: "blocked"
      reason: string
    }>

export type HostCommandProgress = HostCommandDecisionBinding &
  (
    | Readonly<{ status: "recording_authority" | "executing_host" }>
    | Readonly<{
        status: "effect_observed_not_verified"
        receiptID: string
        outputDigest: `sha256:${string}`
        digestScope: "stdout_stderr_exit"
      }>
  )

export type HostCommandControlParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; reason: string }>

export function parseHostCommandPrepareRequest(
  input: unknown,
): HostCommandControlParseResult<HostCommandPrepareRequest> {
  const record = exactRecord(input, ["schemaVersion", "method", "requestId", "sessionID", "token", "script"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "host-command.prepare" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !script(record.script)
  ) {
    return rejected("invalid_prepare_request")
  }
  return accepted({
    schemaVersion: 1,
    method: "host-command.prepare",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    script: record.script,
  })
}

export function parseHostCommandDecisionRequest(
  input: unknown,
): HostCommandControlParseResult<HostCommandDecisionRequest> {
  const record = exactRecord(input, [
    "schemaVersion",
    "method",
    "requestId",
    "sessionID",
    "token",
    "proposalID",
    "decision",
  ])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.method !== "host-command.decide" ||
    !uuid(record.requestId) ||
    !uuid(record.sessionID) ||
    !token(record.token) ||
    !uuid(record.proposalID) ||
    (record.decision !== "approve" && record.decision !== "reject")
  ) {
    return rejected("invalid_decision_request")
  }
  return accepted({
    schemaVersion: 1,
    method: "host-command.decide",
    requestId: record.requestId,
    sessionID: record.sessionID,
    token: record.token,
    proposalID: record.proposalID,
    decision: record.decision,
  })
}

export function parseHostCommandControlRequest(
  input: unknown,
): HostCommandControlParseResult<HostCommandControlRequest> {
  const method = plainRecord(input)?.method
  if (method === "host-command.prepare") return parseHostCommandPrepareRequest(input)
  if (method === "host-command.decide") return parseHostCommandDecisionRequest(input)
  return rejected("invalid_request_method")
}

export function parseHostCommandControlPreview(
  input: unknown,
): HostCommandControlParseResult<HostCommandControlPreview> {
  const record = exactRecord(input, [
    "schemaVersion",
    "proposalID",
    "operationID",
    "script",
    "scriptBytes",
    "scriptDigest",
    "capabilityDigest",
    "expiresAt",
    "boundaryLabel",
    "workspaceRoot",
    "executable",
    "argvPrefix",
    "environment",
    "resources",
    "filesystem",
    "network",
    "writes",
    "verification",
  ])
  const resources = parseStrings(record?.resources, 8, 1_024)
  const environment = parseEnvironment(record?.environment)
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !uuid(record.proposalID) ||
    !uuid(record.operationID) ||
    !script(record.script) ||
    record.scriptBytes !== Buffer.byteLength(record.script) ||
    !digest(record.scriptDigest) ||
    !digest(record.capabilityDigest) ||
    !timestamp(record.expiresAt) ||
    record.boundaryLabel !== hostCommandBoundaryLabel ||
    !boundedText(record.workspaceRoot, 1_024) ||
    record.executable !== "/bin/zsh" ||
    !exactTuple(record.argvPrefix, ["-f", "-c"]) ||
    !environment ||
    !resources ||
    record.filesystem !== "host_unrestricted" ||
    record.network !== "host_unrestricted" ||
    !exactTuple(record.writes, ["command_defined"]) ||
    record.verification !== "not_verified"
  ) {
    return rejected("invalid_preview")
  }
  return accepted({
    schemaVersion: 1,
    proposalID: record.proposalID,
    operationID: record.operationID,
    script: record.script,
    scriptBytes: record.scriptBytes,
    scriptDigest: record.scriptDigest,
    capabilityDigest: record.capabilityDigest,
    expiresAt: record.expiresAt,
    boundaryLabel: hostCommandBoundaryLabel,
    workspaceRoot: record.workspaceRoot,
    executable: "/bin/zsh",
    argvPrefix: ["-f", "-c"],
    environment,
    resources,
    filesystem: "host_unrestricted",
    network: "host_unrestricted",
    writes: ["command_defined"],
    verification: "not_verified",
  })
}

export function parseHostCommandPrepareResult(input: unknown): HostCommandControlParseResult<HostCommandPrepareResult> {
  const broad = plainRecord(input)
  if (broad?.status === "prepared") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "status", "preview"])
    const preview = parseHostCommandControlPreview(record?.preview)
    if (!record || record.schemaVersion !== 1 || !uuid(record.requestId) || !preview.ok) {
      return rejected("invalid_prepare_result")
    }
    return accepted({ schemaVersion: 1, requestId: record.requestId, status: "prepared", preview: preview.value })
  }
  const record = exactRecord(input, ["schemaVersion", "requestId", "status", "reason"])
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !uuid(record.requestId) ||
    record.status !== "blocked" ||
    !reason(record.reason)
  ) {
    return rejected("invalid_prepare_result")
  }
  return accepted({ schemaVersion: 1, requestId: record.requestId, status: "blocked", reason: record.reason })
}

export function parseHostCommandOutputSummary(input: unknown): HostCommandControlParseResult<HostCommandOutputSummary> {
  const record = exactRecord(input, [
    "outputDigest",
    "digestScope",
    "exitCode",
    "stdoutLines",
    "stderrLines",
    "truncated",
  ])
  const stdoutLines = parseStrings(record?.stdoutLines, maximumDisplayLines, maximumDisplayLineBytes)
  const stderrLines = parseStrings(record?.stderrLines, maximumDisplayLines, maximumDisplayLineBytes)
  if (
    !record ||
    !digest(record.outputDigest) ||
    record.digestScope !== "stdout_stderr_exit" ||
    (record.exitCode !== null && !nonNegativeInteger(record.exitCode)) ||
    !stdoutLines ||
    !stderrLines ||
    Buffer.byteLength([...stdoutLines, ...stderrLines].join("\n")) > maximumDisplayBytes ||
    typeof record.truncated !== "boolean"
  ) {
    return rejected("invalid_output_summary")
  }
  return accepted({
    outputDigest: record.outputDigest,
    digestScope: "stdout_stderr_exit",
    exitCode: record.exitCode,
    stdoutLines,
    stderrLines,
    truncated: record.truncated,
  })
}

export function parseHostCommandDecisionResult(
  input: unknown,
): HostCommandControlParseResult<HostCommandDecisionResult> {
  const broad = plainRecord(input)
  if (!broad) return rejected("invalid_decision_result")
  if (broad.status === "blocked") {
    const record = exactRecord(input, ["schemaVersion", "requestId", "proposalID", "status", "reason"])
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !uuid(record.requestId) ||
      !uuid(record.proposalID) ||
      !reason(record.reason)
    ) {
      return rejected("invalid_decision_result")
    }
    return accepted({
      schemaVersion: 1,
      requestId: record.requestId,
      proposalID: record.proposalID,
      status: "blocked",
      reason: record.reason,
    })
  }
  const binding = decisionBinding(broad)
  if (!binding) return rejected("invalid_decision_result")
  if (broad.status === "denied_without_effect") {
    if (!exactRecord(input, [...decisionBindingKeys, "status"])) return rejected("invalid_decision_result")
    return accepted({ ...binding, status: "denied_without_effect" })
  }
  if (broad.status === "completed_observed_not_verified") {
    const output = parseHostCommandOutputSummary(broad.output)
    if (
      !exactRecord(input, [...decisionBindingKeys, "status", "receiptID", "output"]) ||
      !uuid(broad.receiptID) ||
      !output.ok
    ) {
      return rejected("invalid_decision_result")
    }
    return accepted({
      ...binding,
      status: "completed_observed_not_verified",
      receiptID: broad.receiptID,
      output: output.value,
    })
  }
  if (broad.status === "failed_without_effect") {
    if (!exactRecord(input, [...decisionBindingKeys, "status", "reason"]) || !reason(broad.reason)) {
      return rejected("invalid_decision_result")
    }
    return accepted({ ...binding, status: "failed_without_effect", reason: broad.reason })
  }
  if (broad.status !== "reconciliation_required") return rejected("invalid_decision_result")
  const output = broad.output === null ? null : parseHostCommandOutputSummary(broad.output)
  if (
    !exactRecord(input, [...decisionBindingKeys, "status", "reason", "receiptID", "output"]) ||
    !reason(broad.reason) ||
    (broad.receiptID !== null && !uuid(broad.receiptID)) ||
    (output !== null && !output.ok)
  ) {
    return rejected("invalid_decision_result")
  }
  return accepted({
    ...binding,
    status: "reconciliation_required",
    reason: broad.reason,
    receiptID: broad.receiptID,
    output: output?.value ?? null,
  })
}

export function parseHostCommandProgress(input: unknown): HostCommandControlParseResult<HostCommandProgress> {
  const broad = plainRecord(input)
  const binding = broad ? decisionBinding(broad) : null
  if (!binding) return rejected("invalid_progress")
  if (broad?.status === "recording_authority" || broad?.status === "executing_host") {
    if (!exactRecord(input, [...decisionBindingKeys, "status"])) return rejected("invalid_progress")
    return accepted({ ...binding, status: broad.status })
  }
  const record = exactRecord(input, [...decisionBindingKeys, "status", "receiptID", "outputDigest", "digestScope"])
  if (
    !record ||
    record.status !== "effect_observed_not_verified" ||
    !uuid(record.receiptID) ||
    !digest(record.outputDigest) ||
    record.digestScope !== "stdout_stderr_exit"
  ) {
    return rejected("invalid_progress")
  }
  return accepted({
    ...binding,
    status: "effect_observed_not_verified",
    receiptID: record.receiptID,
    outputDigest: record.outputDigest,
    digestScope: "stdout_stderr_exit",
  })
}

const decisionBindingKeys = [
  "schemaVersion",
  "requestId",
  "proposalID",
  "operationID",
  "capabilityDigest",
  "verification",
] as const

function decisionBinding(input: Readonly<Record<string, unknown>>): HostCommandDecisionBinding | null {
  if (
    input.schemaVersion !== 1 ||
    !uuid(input.requestId) ||
    !uuid(input.proposalID) ||
    !uuid(input.operationID) ||
    !digest(input.capabilityDigest) ||
    input.verification !== "not_verified"
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    proposalID: input.proposalID,
    operationID: input.operationID,
    capabilityDigest: input.capabilityDigest,
    verification: "not_verified",
  }
}

function parseEnvironment(input: unknown): HostCommandControlPreview["environment"] | null {
  if (!Array.isArray(input) || input.length !== 4) return null
  const expected = ["LANG", "LC_ALL", "PATH", "TZ"] as const
  const values: Array<{ name: (typeof expected)[number]; value: string }> = []
  for (let index = 0; index < expected.length; index++) {
    const record = exactRecord(input[index], ["name", "value"])
    if (!record || record.name !== expected[index] || !boundedText(record.value, 4_096)) return null
    values.push({ name: expected[index]!, value: record.value })
  }
  return Object.freeze(values)
}

function exactTuple(input: unknown, expected: readonly string[]) {
  const parsed = parseStrings(input, expected.length, 64)
  return (
    parsed !== null && parsed.length === expected.length && parsed.every((value, index) => value === expected[index])
  )
}

function exactRecord(input: unknown, keys: ReadonlyArray<string>) {
  const parsed = parseExactRecord(input, keys)
  return parsed.ok && Object.keys(parsed.value).length === keys.length ? parsed.value : null
}

function plainRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const parsed = parseExactRecord(
    input,
    Reflect.ownKeys(input).filter((key): key is string => typeof key === "string"),
  )
  return parsed.ok ? parsed.value : null
}

function parseStrings(input: unknown, maximumItems: number, maximumBytes: number): ReadonlyArray<string> | null {
  if (!Array.isArray(input) || input.length > maximumItems) return null
  const values: string[] = []
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !("value" in descriptor) || !boundedDisplayText(descriptor.value, maximumBytes)) return null
    values.push(descriptor.value)
  }
  return Object.freeze(values)
}

function script(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    Buffer.byteLength(input) <= maximumScriptBytes &&
    !input.includes("\0") &&
    !/[\p{Cc}&&[^\n\t]]/v.test(input)
  )
}

function boundedText(input: unknown, maximumBytes: number): input is string {
  return (
    typeof input === "string" && input.length > 0 && Buffer.byteLength(input) <= maximumBytes && !/\p{C}/u.test(input)
  )
}

function boundedDisplayText(input: unknown, maximumBytes: number): input is string {
  return (
    typeof input === "string" &&
    Buffer.byteLength(input) <= maximumBytes &&
    !input.includes("\0") &&
    !/\p{C}/u.test(input)
  )
}

function uuid(input: unknown): input is string {
  return typeof input === "string" && uuidPattern.test(input)
}

function token(input: unknown): input is string {
  return typeof input === "string" && tokenPattern.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}

function timestamp(input: unknown): input is string {
  if (typeof input !== "string" || !timestampPattern.test(input)) return false
  const milliseconds = Date.parse(input)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
}

function reason(input: unknown): input is string {
  return typeof input === "string" && reasonPattern.test(input)
}

function nonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
}

function accepted<Value>(value: Value): HostCommandControlParseResult<Value> {
  return { ok: true, value: Object.freeze(value) }
}

function rejected(reason: string): HostCommandControlParseResult<never> {
  return { ok: false, reason }
}
