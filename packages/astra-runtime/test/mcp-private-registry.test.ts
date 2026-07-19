import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  createParentPrivateMcpRegistry,
  parseExtensionInventoryWireForParent,
} from "../src/extension-inventory-operation"

describe("parent-private MCP inventory registry", () => {
  test("classifies OpenCode command arrays as local MCP processes", () => {
    const parsed = parseExtensionInventoryWireForParent(
      encodeWire([
        {
          path: "opencode.json",
          content: Buffer.from(JSON.stringify({ mcp: { local: { type: "local", command: ["bun", "server.ts"] } } })),
        },
      ]),
    )
    expect(parsed.report.candidates).toHaveLength(1)
    expect(parsed.report.candidates[0]).toMatchObject({ kind: "mcp", referenceClass: "process" })
    expect(parsed.privateMcpSnapshot.entries).toHaveLength(1)
    expect(JSON.stringify(parsed.report)).not.toContain("server.ts")
  })

  test("keeps exact remote config private and invalidates old candidates after replacement", () => {
    const first = parseExtensionInventoryWireForParent(
      encodeWire([
        {
          path: ".mcp.json",
          content: Buffer.from(
            JSON.stringify({
              safe: { type: "remote", url: "https://mcp.example.test/rpc", oauth: false },
              secret: {
                type: "remote",
                url: "https://mcp.example.test/private",
                headers: { Authorization: "Bearer PRIVATE_TOKEN" },
              },
            }),
          ),
        },
      ]),
    )
    expect(JSON.stringify(first.report)).not.toMatch(/mcp\.example|PRIVATE_TOKEN|Authorization|"safe"|"secret"/)
    const registry = createParentPrivateMcpRegistry()
    registry.replace(first.privateMcpSnapshot)
    const safeID = first.privateMcpSnapshot.entries.find((candidate) => candidate.serverName === "safe")!.candidateID
    expect(registry.resolve(safeID)).toMatchObject({
      status: "resolved",
      candidate: { serverName: "safe", config: { type: "remote", url: "https://mcp.example.test/rpc" } },
    })

    const second = parseExtensionInventoryWireForParent(
      encodeWire([
        {
          path: ".mcp.json",
          content: Buffer.from(JSON.stringify({ safe: { type: "remote", url: "https://mcp.example.test/changed" } })),
        },
      ]),
    )
    registry.replace(second.privateMcpSnapshot)
    expect(registry.resolve(safeID)).toEqual({ status: "candidate_stale" })
  })

  test("never exposes a registry snapshot through JSON serialization", () => {
    const registry = createParentPrivateMcpRegistry()
    expect(JSON.stringify(registry)).toBe("{}")
    expect(Object.keys(registry)).toEqual([])
  })

  test("uses opaque per-inventory MCP candidate IDs and rejects unknown credential fields", () => {
    const wire = encodeWire([
      {
        path: ".mcp.json",
        content: Buffer.from(
          JSON.stringify({ server: { type: "remote", url: "https://mcp.example.test/rpc", apiToken: "PRIVATE" } }),
        ),
      },
    ])
    const first = parseExtensionInventoryWireForParent(wire)
    const second = parseExtensionInventoryWireForParent(wire)
    expect(first.report.candidates[0]?.candidateID).not.toBe(second.report.candidates[0]?.candidateID)
    expect(first.privateMcpSnapshot.entries).toEqual([])
  })
})

function encodeWire(records: ReadonlyArray<Readonly<{ path: string; content: Uint8Array }>>) {
  const chunks: Buffer[] = [Buffer.from("ASTRXI01"), u32(records.length)]
  records.forEach((record, index) => {
    const path = Buffer.from(record.path)
    const content = Buffer.from(record.content)
    chunks.push(
      u16(path.byteLength),
      path,
      u64(index + 1),
      u64(index + 100),
      u64(0o100600),
      u64(1),
      u64(content.byteLength),
      createHash("sha256").update(content).digest(),
      u32(content.byteLength),
      content,
    )
  })
  return Uint8Array.from(Buffer.concat(chunks))
}

function u16(value: number) {
  const output = Buffer.alloc(2)
  output.writeUInt16BE(value)
  return output
}

function u32(value: number) {
  const output = Buffer.alloc(4)
  output.writeUInt32BE(value)
  return output
}

function u64(value: number) {
  const output = Buffer.alloc(8)
  output.writeBigUInt64BE(BigInt(value))
  return output
}
