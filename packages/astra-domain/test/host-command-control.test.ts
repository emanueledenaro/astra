import { describe, expect, test } from "bun:test"
import {
  hostCommandBoundaryLabel,
  parseHostCommandControlPreview,
  parseHostCommandControlRequest,
} from "../src/host-command-control"

const requestID = "0196e4cb-5d80-7b1d-8fb2-263b81670435"
const sessionID = "0196e4cb-5d80-7b1d-8fb2-263b81670436"
const token = "a".repeat(43)

describe("host command control contract", () => {
  test("accepts shell metacharacters only as exact script data", () => {
    const script = "printf '%s\\n' '$HOME; $(touch nope)'"
    expect(
      parseHostCommandControlRequest({
        schemaVersion: 1,
        method: "host-command.prepare",
        requestId: requestID,
        sessionID,
        token,
        script,
      }),
    ).toEqual({
      ok: true,
      value: { schemaVersion: 1, method: "host-command.prepare", requestId: requestID, sessionID, token, script },
    })
  })

  test("parses an exact unrestricted-host preview and rejects authority expansion", () => {
    const script = "pwd"
    const preview = {
      schemaVersion: 1,
      proposalID: "0196e4cb-5d80-7b1d-8fb2-263b81670437",
      operationID: "0196e4cb-5d80-7b1d-8fb2-263b81670438",
      script,
      scriptBytes: 3,
      scriptDigest: `sha256:${"a".repeat(64)}`,
      capabilityDigest: `sha256:${"b".repeat(64)}`,
      expiresAt: "2026-07-19T18:00:00.000Z",
      boundaryLabel: hostCommandBoundaryLabel,
      workspaceRoot: "/private/tmp/workspace",
      executable: "/bin/zsh",
      argvPrefix: ["-f", "-c"],
      environment: [
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "TZ", value: "UTC" },
      ],
      resources: ["process:/bin/zsh", "filesystem:host-unrestricted"],
      filesystem: "host_unrestricted",
      network: "host_unrestricted",
      writes: ["command_defined"],
      verification: "not_verified",
    } as const

    expect(parseHostCommandControlPreview(preview)).toEqual({ ok: true, value: preview })
    expect(parseHostCommandControlPreview({ ...preview, verification: "verified" })).toEqual({
      ok: false,
      reason: "invalid_preview",
    })
    expect(parseHostCommandControlPreview({ ...preview, extraAuthority: true })).toEqual({
      ok: false,
      reason: "invalid_preview",
    })
  })
})
