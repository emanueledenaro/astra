import { describe, expect, test } from "bun:test"
import {
  defaultHostCommandPolicy,
  evaluateHostCommandPolicy,
  hostCommandLimitCeilings,
  type HostCommandPolicy,
  type HostCommandPolicyDenialReason,
  type ProposedHostCommand,
} from "../src/host-command-policy"

const workspacePolicy: HostCommandPolicy = {
  programs: [
    { path: "/bin/echo", maxArguments: 4 },
    {
      path: "/bin/rulecheck",
      maxArguments: 4,
      validateArgument: (argument) => /^[a-z0-9-]+$/u.test(argument),
    },
  ],
  workspaceRoot: "/ws",
  environmentAllowlist: ["LANG", "LC_ALL", "TZ"],
  limits: { timeoutMs: 2_000, maxStdoutBytes: 4_096, maxStderrBytes: 4_096 },
}

function proposal(overrides: Partial<ProposedHostCommand> = {}): ProposedHostCommand {
  return {
    program: "/bin/echo",
    arguments: ["hello"],
    workingDirectory: "/ws",
    ...overrides,
  }
}

describe("evaluateHostCommandPolicy grants", () => {
  test("grants an allowlisted program with valid arguments, cwd, and environment", () => {
    const decision = evaluateHostCommandPolicy(
      proposal({
        arguments: ["hello", "world"],
        workingDirectory: "/ws/nested",
        environment: [
          { name: "TZ", value: "UTC" },
          { name: "LANG", value: "C" },
        ],
      }),
      workspacePolicy,
    )
    expect(decision.outcome).toBe("granted")
    if (decision.outcome !== "granted") throw new Error("expected grant")
    expect(decision.command).toMatchObject({
      label: "echo",
      program: "/bin/echo",
      arguments: ["hello", "world"],
      workingDirectory: "/ws/nested",
      limits: { timeoutMs: 2_000, maxStdoutBytes: 4_096, maxStderrBytes: 4_096 },
    })
    // Environment is canonicalized: sorted by name.
    expect(decision.command.environment).toEqual([
      { name: "LANG", value: "C" },
      { name: "TZ", value: "UTC" },
    ])
  })

  test("preserves shell metacharacters verbatim as literal arguments", () => {
    const decision = evaluateHostCommandPolicy(
      proposal({ arguments: ["hello; touch /tmp/x && rm -rf /"] }),
      workspacePolicy,
    )
    expect(decision.outcome).toBe("granted")
    if (decision.outcome !== "granted") throw new Error("expected grant")
    expect(decision.command.arguments).toEqual(["hello; touch /tmp/x && rm -rf /"])
  })

  test("normalizes the working directory and defaults an absent environment to empty", () => {
    const decision = evaluateHostCommandPolicy(proposal({ workingDirectory: "/ws" }), workspacePolicy)
    expect(decision.outcome).toBe("granted")
    if (decision.outcome !== "granted") throw new Error("expected grant")
    expect(decision.command.workingDirectory).toBe("/ws")
    expect(decision.command.environment).toEqual([])
  })

  test("expresses the default policy's /bin/pwd command", () => {
    const decision = evaluateHostCommandPolicy(
      { program: "/bin/pwd", arguments: [], workingDirectory: "/" },
      defaultHostCommandPolicy,
    )
    expect(decision.outcome).toBe("granted")
    if (decision.outcome !== "granted") throw new Error("expected grant")
    expect(decision.command).toMatchObject({ label: "pwd", program: "/bin/pwd", workingDirectory: "/" })
  })

  test("is deterministic for digest-relevant fields", () => {
    const input = proposal({
      arguments: ["a", "b"],
      environment: [
        { name: "TZ", value: "UTC" },
        { name: "LANG", value: "C" },
      ],
    })
    const first = evaluateHostCommandPolicy(input, workspacePolicy)
    const second = evaluateHostCommandPolicy(input, workspacePolicy)
    if (first.outcome !== "granted" || second.outcome !== "granted") throw new Error("expected grants")
    expect(JSON.stringify(first.command)).toBe(JSON.stringify(second.command))
  })
})

describe("evaluateHostCommandPolicy denies", () => {
  const denials: ReadonlyArray<readonly [HostCommandPolicyDenialReason, ProposedHostCommand]> = [
    ["program_not_absolute", proposal({ program: "bin/echo" })],
    ["program_path_not_normalized", proposal({ program: "/bin/../bin/echo" })],
    ["program_not_allowlisted", proposal({ program: "/bin/cat" })],
    ["argument_count_exceeds_limit", proposal({ arguments: ["1", "2", "3", "4", "5"] })],
    ["argument_empty", proposal({ arguments: [""] })],
    ["argument_contains_nul", proposal({ arguments: ["hello\0world"] })],
    ["working_directory_not_absolute", proposal({ workingDirectory: "ws/rel" })],
    ["working_directory_not_normalized", proposal({ workingDirectory: "/ws/../ws" })],
    ["working_directory_escapes_workspace", proposal({ workingDirectory: "/etc" })],
    // Sibling-prefix trap: /ws-evil must not count as inside /ws.
    ["working_directory_escapes_workspace", proposal({ workingDirectory: "/ws-evil" })],
    ["environment_name_not_allowlisted", proposal({ environment: [{ name: "PATH", value: "/x" }] })],
    ["environment_name_invalid", proposal({ environment: [{ name: "1BAD", value: "x" }] })],
    [
      "environment_name_duplicated",
      proposal({
        environment: [
          { name: "LANG", value: "C" },
          { name: "LANG", value: "en" },
        ],
      }),
    ],
    ["environment_value_empty", proposal({ environment: [{ name: "LANG", value: "" }] })],
    ["environment_value_contains_nul", proposal({ environment: [{ name: "LANG", value: "C\0" }] })],
  ]

  for (const [reason, input] of denials) {
    test(`denies with ${reason}`, () => {
      expect(evaluateHostCommandPolicy(input, workspacePolicy)).toEqual({ outcome: "denied", reason })
    })
  }

  test("denies an argument rejected by the rule validator", () => {
    const decision = evaluateHostCommandPolicy(
      { program: "/bin/rulecheck", arguments: ["Not Valid!"], workingDirectory: "/ws" },
      workspacePolicy,
    )
    expect(decision).toEqual({ outcome: "denied", reason: "argument_rejected_by_rule" })
  })

  test("denies a limit above the hard ceiling", () => {
    const decision = evaluateHostCommandPolicy(proposal(), {
      ...workspacePolicy,
      limits: { ...workspacePolicy.limits, timeoutMs: hostCommandLimitCeilings.timeoutMs + 1 },
    })
    expect(decision).toEqual({ outcome: "denied", reason: "limit_exceeds_ceiling" })
  })
})
