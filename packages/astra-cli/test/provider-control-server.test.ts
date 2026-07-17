import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AstraProviderControl } from "../src/provider-control"
import { startAstraProviderControlServer } from "../src/provider-control-server"

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test("dedicated provider socket authenticates, correlates, and streams one strict turn", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "astra-ps-")))
  roots.push(directory)
  const server = await startAstraProviderControlServer({ directory, sessionID, control: fakeControl() })
  expect(server.socketPath).toBe(join(directory, "provider.sock"))
  expect((await lstat(server.socketPath)).mode & 0o077).toBe(0)

  const catalog = await exchange(server.socketPath, {
    schemaVersion: 1,
    method: "provider.catalog",
    requestId: uuid(1),
    sessionID,
    token: server.token,
  })
  expect(catalog).toHaveLength(2)
  expect(catalog[0]).toMatchObject({ type: "accepted", requestId: uuid(1) })
  expect(catalog[1]).toMatchObject({ status: "available", catalog: { providerID: "anthropic" } })

  const prepared = await exchange(server.socketPath, {
    schemaVersion: 1,
    method: "provider.turn.prepare",
    requestId: uuid(2),
    sessionID,
    token: server.token,
    modelID,
    userText: "private prompt",
  })
  expect(prepared[1]).toMatchObject({ status: "prepared", preview: { proposalID, operationID } })

  const decided = await exchange(server.socketPath, {
    schemaVersion: 1,
    method: "provider.turn.decide",
    requestId: uuid(3),
    sessionID,
    token: server.token,
    proposalID,
    decision: "approve",
  })
  expect(decided.slice(1, -1).map((entry) => entry.status)).toEqual([...progressOrder])
  expect(decided.at(-1)).toMatchObject({
    status: "response_observed_not_verified",
    response: { assistantText: "Hello Astra" },
  })
  await server.close()
  expect(await lstat(server.socketPath).catch(() => null)).toBeNull()
})

test("provider socket rejects a wrong token before invoking the parent control", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "astra-pa-")))
  roots.push(directory)
  let calls = 0
  const control = fakeControl(() => calls++)
  const server = await startAstraProviderControlServer({ directory, sessionID, control })
  const result = await exchange(server.socketPath, {
    schemaVersion: 1,
    method: "provider.catalog",
    requestId: uuid(4),
    sessionID,
    token: "z".repeat(43),
  })
  expect(result).toEqual([])
  expect(calls).toBe(0)
  await server.close()
})

test("provider socket accepts a domain-valid prompt at the JSON escaping boundary", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "astra-pe-")))
  roots.push(directory)
  const server = await startAstraProviderControlServer({ directory, sessionID, control: fakeControl() })
  const escapedPrompt = "\u0001".repeat(65_536)
  const result = await exchange(server.socketPath, {
    schemaVersion: 1,
    method: "provider.turn.prepare",
    requestId: uuid(5),
    sessionID,
    token: server.token,
    modelID,
    userText: escapedPrompt,
  })

  expect(Buffer.byteLength(JSON.stringify(escapedPrompt))).toBeGreaterThan(72 * 1024)
  expect(result.at(-1)).toMatchObject({ status: "prepared" })
  await server.close()
})

const sessionID = "10000000-0000-4000-8000-000000000001"
const proposalID = "20000000-0000-4000-8000-000000000002"
const operationID = "30000000-0000-4000-8000-000000000003"
const receiptID = "40000000-0000-4000-8000-000000000004"
const modelID = "claude-sonnet-4-5-20250929"
const progressOrder = [
  "recording_authority",
  "authority_claimed",
  "network_dispatch",
  "response_observed_not_verified",
  "receipt_acknowledged",
] as const

function fakeControl(onCall: () => void = () => {}): AstraProviderControl {
  return {
    catalog() {
      onCall()
      return {
        status: "available",
        catalog: {
          providerID: "anthropic",
          providerName: "Anthropic",
          models: [{ id: modelID, name: "Claude Sonnet", limits: { context: 200_000, output: 8_192 } }],
        },
      }
    },
    async prepare() {
      onCall()
      return {
        status: "prepared",
        preview: {
          proposalID,
          operationID,
          providerID: "anthropic",
          modelID,
          destination: { method: "POST", origin: "https://api.anthropic.com", path: "/v1/messages" },
          logicalPayload: { digest: digest("body"), bytes: 128 },
          headerNames: ["anthropic-version", "content-type", "x-api-key"],
          credential: { accountFingerprint: `sha256:${"2".repeat(64)}`, headerName: "x-api-key" },
          expiresAt: "2026-07-17T16:00:00.000Z",
          hostBoundaryLabel: "HOST EXECUTION — NO SANDBOX",
          networkBoundaryLabel: "NETWORK EGRESS — HOST TRANSPORT — NO NETWORK SANDBOX",
          assurance: "NOT VERIFIED",
        },
      }
    },
    async decide(_proposalID, _decision, onProgress) {
      onCall()
      progressOrder.forEach((status) => onProgress({ proposalID, operationID, status }))
      return {
        proposalID,
        operationID,
        status: "response_observed_not_verified",
        receiptID,
        completionLabel: "COMPLETED — RESPONSE OBSERVED — NOT VERIFIED",
        response: {
          assistantText: "Hello Astra",
          assistantTextDigest: digest("Hello Astra"),
          assistantTextBytes: Buffer.byteLength("Hello Astra"),
          finishReason: "stop",
        },
      }
    },
  }
}

function exchange(socketPath: string, request: unknown) {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const socket = createConnection(socketPath)
    const messages: Record<string, unknown>[] = []
    let buffered = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"))
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      lines.filter(Boolean).forEach((line) => messages.push(JSON.parse(line)))
    })
    socket.once("error", reject)
    socket.once("close", () => resolve(messages))
  })
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

function digest(input: string) {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}
