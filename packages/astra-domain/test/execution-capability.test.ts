import { describe, expect, test } from "bun:test"
import {
  computeExecutionCapabilityDigest,
  parseExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityManifest,
} from "../src/execution-capability"
import {
  parseAttemptID,
  parseCapabilityGrantID,
  parseContentDigest,
  parseOperationID,
  type AttemptID,
  type CapabilityGrantID,
  type ContentDigest,
  type OperationID,
} from "../src/operation-contract"

const sha256 = (character: string) => requireContentDigest(`sha256:${character.repeat(64)}`)

const manifest = {
  schemaVersion: 1,
  grant: {
    capabilityGrantID: requireCapabilityGrantID("0196e4cb-5d80-7b1d-8fb2-263b81670435"),
    operationID: requireOperationID("0196e4cb-5d80-7b1d-8fb2-263b81670436"),
    attemptID: requireAttemptID("0196e4cb-5d80-7b1d-8fb2-263b81670437"),
    baselineDigest: sha256("a"),
    expiresAt: "2026-07-17T18:00:00.000Z",
  },
  isolation: {
    platform: "darwin",
    backend: "seatbelt",
    fallback: "deny",
  },
  process: {
    executable: {
      canonicalPath: "/private/tmp/astra-runtime/bun",
      device: "16777233",
      inode: "12346",
      digest: sha256("b"),
    },
    programDigest: sha256("c"),
    arguments: ["--worker", "controlled-write"],
    workingDirectory: "/private/tmp/astra-workspace",
    stdinDigest: sha256("d"),
  },
  filesystem: {
    workspace: {
      canonicalPath: "/private/tmp/astra-workspace",
      device: "16777233",
      inode: "12345",
    },
    runtimeScratch: {
      canonicalPath: "/private/tmp/astra-runtime/tmp",
      lifecycle: "private_ephemeral",
    },
    readOnlyRoots: ["/private/tmp/astra-workspace"],
    createOnlyFiles: ["/private/tmp/astra-workspace/.astra-demo-marker"],
    writableFiles: [],
  },
  network: { mode: "none" },
  environment: {
    variables: [
      { name: "LANG", value: "C" },
      { name: "TMPDIR", value: "/private/tmp/astra-runtime/tmp" },
      { name: "TZ", value: "UTC" },
    ],
  },
  limits: {
    timeoutMs: 5_000,
    maxStdoutBytes: 16_384,
    maxStderrBytes: 16_384,
  },
} as const satisfies ExecutionCapabilityManifest

const capability = {
  manifest,
  capabilityDigest: computeExecutionCapabilityDigest(manifest),
} as const satisfies ExecutionCapability

describe("Execution capability contracts", () => {
  test("strictly parses and copies a digest-bound manifest", () => {
    const parsed = parseExecutionCapability(capability)

    expect(parsed).toEqual({ ok: true, value: capability })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.value).not.toBe(capability)
    expect(parsed.value.manifest).not.toBe(manifest)
    expect(parsed.value.manifest.filesystem.createOnlyFiles).not.toBe(manifest.filesystem.createOnlyFiles)
    expect(Object.isFrozen(parsed.value)).toBeTrue()
    expect(Object.isFrozen(parsed.value.manifest.process.executable)).toBeTrue()
    expect(Object.isFrozen(parsed.value.manifest.environment.variables)).toBeTrue()
  })

  test("uses one canonical digest for equivalent object key order", () => {
    const reordered = {
      limits: manifest.limits,
      environment: manifest.environment,
      network: manifest.network,
      filesystem: manifest.filesystem,
      process: manifest.process,
      isolation: manifest.isolation,
      grant: manifest.grant,
      schemaVersion: manifest.schemaVersion,
    } satisfies ExecutionCapabilityManifest

    expect(computeExecutionCapabilityDigest(reordered)).toBe(capability.capabilityDigest)
  })

  test("rejects forged, incomplete, expired-shape, or extensible authority", () => {
    expect(parseExecutionCapability({ ...capability, capabilityDigest: sha256("e") })).toEqual({
      ok: false,
      reason: "invalid_capability",
    })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: { ...manifest, isolation: { ...manifest.isolation, fallback: "host" } },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: { ...manifest, grant: { ...manifest.grant, expiresAt: "2026-07-17T18:00:00Z" } },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: { ...manifest, extraAuthority: true },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          isolation: { ...manifest.isolation, backend: "host" },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
  })

  test("rejects traversal, duplicate paths, unsorted environment, and overlapping write modes", () => {
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          filesystem: {
            ...manifest.filesystem,
            createOnlyFiles: ["/private/tmp/astra-workspace/../escape"],
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          filesystem: {
            ...manifest.filesystem,
            readOnlyRoots: [manifest.filesystem.workspace.canonicalPath, manifest.filesystem.workspace.canonicalPath],
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          environment: {
            variables: [
              { name: "TMPDIR", value: "/private/tmp/astra-runtime/tmp" },
              { name: "LANG", value: "C" },
            ],
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          filesystem: {
            ...manifest.filesystem,
            writableFiles: [manifest.filesystem.createOnlyFiles[0]],
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
  })

  test("rejects write scope outside the bound workspace", () => {
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          filesystem: {
            ...manifest.filesystem,
            createOnlyFiles: ["/private/tmp/outside-marker"],
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
  })

  test("rejects scratch inside the workspace or a TMPDIR outside the exact private scratch", () => {
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          filesystem: {
            ...manifest.filesystem,
            runtimeScratch: {
              canonicalPath: "/private/tmp/astra-workspace/.scratch",
              lifecycle: "private_ephemeral",
            },
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          environment: {
            variables: [
              { name: "LANG", value: "C" },
              { name: "TMPDIR", value: "/private/tmp/other" },
              { name: "TZ", value: "UTC" },
            ],
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
  })

  test("rejects unbound execution paths, broad reads, and dangerous environment influence", () => {
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: { ...manifest, process: { ...manifest.process, workingDirectory: "/private/tmp" } },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          filesystem: { ...manifest.filesystem, readOnlyRoots: ["/"] },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          environment: { variables: [{ name: "DYLD_INSERT_LIBRARIES", value: "/tmp/evil.dylib" }] },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
    expect(
      parseExecutionCapability({
        ...capability,
        manifest: {
          ...manifest,
          process: {
            ...manifest.process,
            executable: { ...manifest.process.executable, canonicalPath: "/tmp/../tmp/bun" },
          },
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_capability" })
  })
})

function requireContentDigest(input: string): ContentDigest {
  const parsed = parseContentDigest(input)
  if (!parsed.ok) throw new Error(parsed.issue.reason)
  return parsed.value
}

function requireCapabilityGrantID(input: string): CapabilityGrantID {
  const parsed = parseCapabilityGrantID(input)
  if (!parsed.ok) throw new Error(parsed.issue.reason)
  return parsed.value
}

function requireOperationID(input: string): OperationID {
  const parsed = parseOperationID(input)
  if (!parsed.ok) throw new Error(parsed.issue.reason)
  return parsed.value
}

function requireAttemptID(input: string): AttemptID {
  const parsed = parseAttemptID(input)
  if (!parsed.ok) throw new Error(parsed.issue.reason)
  return parsed.value
}
