import { posix } from "node:path"

/**
 * Deterministic authority gate for governed host commands.
 *
 * The model (or any other untrusted caller) may *propose* a command; this pure
 * policy is the only thing that grants authority. It turns an untrusted
 * `ProposedHostCommand` into either a canonical `GrantedHostCommand` or a typed
 * denial. There is no filesystem, process, network, or clock access here — only
 * lexical checks. Symlink and time-of-check/time-of-use identity are re-checked
 * with file descriptors by the runtime coordinator; this layer never touches
 * the disk and says exactly that where it matters.
 */

export type HostCommandEnvironmentVariable = Readonly<{ name: string; value: string }>

export type HostCommandLimits = Readonly<{
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}>

/** Untrusted, proposed intent. Every field is treated as adversarial. */
export type ProposedHostCommand = Readonly<{
  program: string
  arguments: ReadonlyArray<string>
  workingDirectory: string
  environment?: ReadonlyArray<HostCommandEnvironmentVariable>
}>

/** One allowlisted program plus the bound on how it may be invoked. */
export type HostCommandProgramRule = Readonly<{
  path: string
  maxArguments: number
  /** Optional per-argument acceptance test. Pure and deterministic. */
  validateArgument?: (argument: string, index: number) => boolean
}>

export type HostCommandPolicy = Readonly<{
  programs: ReadonlyArray<HostCommandProgramRule>
  workspaceRoot: string
  environmentAllowlist: ReadonlyArray<string>
  limits: HostCommandLimits
}>

/**
 * A fully canonical, authority-bounded command. Environment is sorted by name
 * and free of duplicate names, the working directory is lexically normalized,
 * and arguments are preserved in order so a downstream capability digest is
 * deterministic. `label` and `rationale` are derived deterministically from the
 * matched rule.
 */
export type GrantedHostCommand = Readonly<{
  label: string
  program: string
  arguments: ReadonlyArray<string>
  workingDirectory: string
  environment: ReadonlyArray<HostCommandEnvironmentVariable>
  limits: HostCommandLimits
  rationale: string
}>

export type HostCommandPolicyDenialReason =
  | "program_not_absolute"
  | "program_path_not_normalized"
  | "program_not_allowlisted"
  | "argument_count_exceeds_limit"
  | "argument_empty"
  | "argument_contains_nul"
  | "argument_rejected_by_rule"
  | "working_directory_not_absolute"
  | "working_directory_not_normalized"
  | "working_directory_escapes_workspace"
  | "environment_name_not_allowlisted"
  | "environment_name_invalid"
  | "environment_name_duplicated"
  | "environment_value_empty"
  | "environment_value_contains_nul"
  | "limit_exceeds_ceiling"

export type HostCommandPolicyDecision =
  | Readonly<{ outcome: "granted"; command: GrantedHostCommand }>
  | Readonly<{ outcome: "denied"; reason: HostCommandPolicyDenialReason }>

/** Hard ceilings no policy may exceed, mirroring the execution-capability bounds. */
export const hostCommandLimitCeilings: HostCommandLimits = Object.freeze({
  timeoutMs: 300_000,
  maxStdoutBytes: 16_777_216,
  maxStderrBytes: 16_777_216,
})

/** The execution-capability manifest caps a process at 128 arguments. */
export const hostCommandMaximumArguments = 128

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Conservative default policy. The allowlist expresses the coordinator's
 * historical `/bin/pwd` command plus `/bin/echo`, both read-only and bounded.
 * The workspace root is `/` because host-backend commands always run with a
 * working directory of `/`.
 */
export const defaultHostCommandPolicy: HostCommandPolicy = Object.freeze({
  programs: Object.freeze([
    Object.freeze({ path: "/bin/pwd", maxArguments: 0 }),
    Object.freeze({ path: "/bin/echo", maxArguments: 8 }),
  ]),
  workspaceRoot: "/",
  environmentAllowlist: Object.freeze(["LANG", "LC_ALL", "TZ"]),
  limits: Object.freeze({ timeoutMs: 3_000, maxStdoutBytes: 4_096, maxStderrBytes: 4_096 }),
})

/**
 * Fail-closed: any doubt is a denial. Returns a granted canonical command only
 * when the program is allowlisted and every argument, working directory,
 * environment variable, and limit passes its deterministic check.
 */
export function evaluateHostCommandPolicy(
  proposed: ProposedHostCommand,
  policy: HostCommandPolicy,
): HostCommandPolicyDecision {
  const rule = matchProgramRule(proposed.program, policy.programs)
  if (rule.outcome === "denied") return rule

  const argumentDenial = checkArguments(proposed.arguments, rule.value)
  if (argumentDenial) return { outcome: "denied", reason: argumentDenial }

  const workingDirectoryDenial = checkWorkingDirectory(proposed.workingDirectory, policy.workspaceRoot)
  if (workingDirectoryDenial) return { outcome: "denied", reason: workingDirectoryDenial }

  const environment = canonicalEnvironment(proposed.environment ?? [], policy.environmentAllowlist)
  if (environment.outcome === "denied") return environment

  const limitDenial = checkLimits(policy.limits)
  if (limitDenial) return { outcome: "denied", reason: limitDenial }

  const label = posix.basename(rule.value.path)
  return {
    outcome: "granted",
    command: Object.freeze({
      label,
      program: rule.value.path,
      // Arguments are preserved verbatim. Shell metacharacters are *not*
      // rejected: the runtime passes argv straight to the process without a
      // shell, so metacharacters are inert literal bytes, never interpreted.
      arguments: Object.freeze([...proposed.arguments]),
      workingDirectory: posix.normalize(proposed.workingDirectory),
      environment: environment.value,
      limits: Object.freeze({ ...policy.limits }),
      rationale: `direct execution of allowlisted ${label} with bounded output`,
    }),
  }
}

function matchProgramRule(
  program: string,
  rules: ReadonlyArray<HostCommandProgramRule>,
):
  | Readonly<{ outcome: "granted"; value: HostCommandProgramRule }>
  | Extract<HostCommandPolicyDecision, { outcome: "denied" }> {
  if (!program.startsWith("/")) return { outcome: "denied", reason: "program_not_absolute" }
  if (!isNormalizedAbsolutePath(program)) return { outcome: "denied", reason: "program_path_not_normalized" }
  const rule = rules.find((candidate) => candidate.path === program)
  if (!rule) return { outcome: "denied", reason: "program_not_allowlisted" }
  return { outcome: "granted", value: rule }
}

function checkArguments(
  argumentList: ReadonlyArray<string>,
  rule: HostCommandProgramRule,
): HostCommandPolicyDenialReason | null {
  if (argumentList.length > Math.min(rule.maxArguments, hostCommandMaximumArguments)) {
    return "argument_count_exceeds_limit"
  }
  // The execution-capability manifest requires every argument to be a non-empty
  // string, so an empty argument is a clean policy denial, not a "granted"
  // command the coordinator would later reject as invalid input.
  if (argumentList.some((argument) => argument.length === 0)) return "argument_empty"
  if (argumentList.some((argument) => argument.includes("\0"))) return "argument_contains_nul"
  const validateArgument = rule.validateArgument
  if (validateArgument && argumentList.some((argument, index) => !validateArgument(argument, index))) {
    return "argument_rejected_by_rule"
  }
  return null
}

function checkWorkingDirectory(workingDirectory: string, workspaceRoot: string): HostCommandPolicyDenialReason | null {
  if (!workingDirectory.startsWith("/")) return "working_directory_not_absolute"
  if (!isNormalizedAbsolutePath(workingDirectory)) return "working_directory_not_normalized"
  if (!pathWithinOrEqual(workingDirectory, workspaceRoot)) return "working_directory_escapes_workspace"
  return null
}

function canonicalEnvironment(
  variables: ReadonlyArray<HostCommandEnvironmentVariable>,
  allowlist: ReadonlyArray<string>,
):
  | Readonly<{ outcome: "granted"; value: ReadonlyArray<HostCommandEnvironmentVariable> }>
  | Extract<HostCommandPolicyDecision, { outcome: "denied" }> {
  const seen = new Set<string>()
  for (const variable of variables) {
    if (!environmentNamePattern.test(variable.name)) return { outcome: "denied", reason: "environment_name_invalid" }
    if (!allowlist.includes(variable.name)) return { outcome: "denied", reason: "environment_name_not_allowlisted" }
    // The manifest requires non-empty environment values; deny cleanly here.
    if (variable.value.length === 0) return { outcome: "denied", reason: "environment_value_empty" }
    if (variable.value.includes("\0")) return { outcome: "denied", reason: "environment_value_contains_nul" }
    if (seen.has(variable.name)) return { outcome: "denied", reason: "environment_name_duplicated" }
    seen.add(variable.name)
  }
  const sorted = [...variables]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((variable) => Object.freeze({ name: variable.name, value: variable.value }))
  return { outcome: "granted", value: Object.freeze(sorted) }
}

function checkLimits(limits: HostCommandLimits): HostCommandPolicyDenialReason | null {
  if (
    !withinCeiling(limits.timeoutMs, hostCommandLimitCeilings.timeoutMs) ||
    !withinCeiling(limits.maxStdoutBytes, hostCommandLimitCeilings.maxStdoutBytes) ||
    !withinCeiling(limits.maxStderrBytes, hostCommandLimitCeilings.maxStderrBytes)
  ) {
    return "limit_exceeds_ceiling"
  }
  return null
}

function withinCeiling(value: number, ceiling: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling
}

function isNormalizedAbsolutePath(input: string) {
  return input.startsWith("/") && posix.normalize(input) === input && (input === "/" || !input.endsWith("/"))
}

/**
 * Lexical containment on normalized path segments, never a raw string prefix:
 * `/ws-evil` is not inside `/ws`. Symlink escape is a runtime concern handled
 * with file descriptors; this check is purely lexical.
 */
function pathWithinOrEqual(path: string, root: string) {
  if (path === root) return true
  return root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`)
}
