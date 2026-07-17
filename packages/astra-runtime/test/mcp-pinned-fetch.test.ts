import { afterEach, describe, expect, test } from "bun:test"
import { activateAstraControlledRemote } from "../../opencode/src/mcp/astra-controlled-remote"
import {
  createPinnedMcpWire,
  resolvePinnedMcpDestination,
} from "../src/mcp-pinned-fetch"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("pinned MCP Streamable HTTP transport", () => {
  test("does nothing until the first post-claim request", async () => {
    let resolutions = 0
    const wire = createPinnedMcpWire("https://mcp.example.test/rpc", {
      mode: "test_https_seam",
      resolver: async () => {
        resolutions++
        return [{ address: "93.184.216.34", family: 4 }]
      },
    })
    expect(resolutions).toBe(0)
    expect(wire).toBeDefined()
  })

  test.each([
    ["HTTP non-loopback", "http://192.0.2.1/rpc"],
    ["userinfo", "https://user:secret@example.test/rpc"],
    ["query", "https://example.test/rpc?token=secret"],
  ])("rejects %s before resolution", async (_label, endpoint) => {
    let resolutions = 0
    await expect(
      resolvePinnedMcpDestination(endpoint, {
        mode: "test_https_seam",
        resolver: async () => {
          resolutions++
          return [{ address: "93.184.216.34", family: 4 }]
        },
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(resolutions).toBe(0)
  })

  test.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "224.0.0.1", "2001:db8::1"])(
    "rejects non-public DNS answer %s",
    async (address) => {
      await expect(
        resolvePinnedMcpDestination("https://example.test/rpc", {
          mode: "test_https_seam",
          resolver: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        }),
      ).rejects.toThrow("public")
    },
  )

  test("runs the exact three-message exchange against literal loopback and closes once", async () => {
    const seen: Array<{ method: string; session: string | null }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "DELETE") {
          seen.push({ method: "DELETE", session: request.headers.get("mcp-session-id") })
          return new Response(null, { status: 204 })
        }
        const body = (await request.json()) as { id?: number; method: string }
        seen.push({ method: body.method, session: request.headers.get("mcp-session-id") })
        if (body.method === "initialize") {
          return Response.json(
            {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
              instructions: "malicious instructions must stay withheld",
            },
            },
            { headers: { "mcp-session-id": "fixture-session" } },
          )
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202, headers: { "mcp-session-id": "fixture-session" } })
        }
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "fixture_tool", description: "Observed only", inputSchema: { type: "object" } }] },
          },
          { headers: { "mcp-session-id": "fixture-session" } },
        )
      }
    })
    servers.push(server)

    const active = await activateAstraControlledRemote(
      createPinnedMcpWire(`http://127.0.0.1:${server.port}/rpc`, { mode: "test_loopback" }),
    )
    expect(active.catalog).toHaveLength(1)
    expect(JSON.stringify(active)).not.toContain("malicious instructions")
    await active.stop()
    await active.stop()
    expect(seen).toEqual([
      { method: "initialize", session: null },
      { method: "notifications/initialized", session: "fixture-session" },
      { method: "tools/list", session: "fixture-session" },
      { method: "DELETE", session: "fixture-session" },
    ])
  })

  test("does not follow a loopback redirect", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:1/steal" } })
      },
    })
    servers.push(server)
    await expect(
      activateAstraControlledRemote(
        createPinnedMcpWire(`http://127.0.0.1:${server.port}/rpc`, { mode: "test_loopback" }),
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(requests).toBe(1)
  })

  test("an abort inside the dispatch hook prevents socket creation and request bytes", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return new Response(null, { status: 500 })
      },
    })
    servers.push(server)
    const controller = new AbortController()
    await expect(
      activateAstraControlledRemote(
        createPinnedMcpWire(`http://127.0.0.1:${server.port}/rpc`, {
          mode: "test_loopback",
          onNetworkDispatch: () => controller.abort(),
        }),
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(Error)
    await Bun.sleep(20)
    expect(requests).toBe(0)
  })
})
