import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAstraSkillActivationClient } from "../../src/astra/skill-activation-client"
import { AstraControlClientError } from "../../src/astra/control-client"

const roots: string[] = []
const sessionID = "10000000-0000-4000-8000-000000000001"
const inventoryID = "20000000-0000-4000-8000-000000000002"
const proposalID = "30000000-0000-4000-8000-000000000003"
const operationID = "40000000-0000-4000-8000-000000000004"
const receiptID = "50000000-0000-4000-8000-000000000005"
const token = "a".repeat(43)
const digest = `sha256:${"b".repeat(64)}` as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("keeps the socket lazy and runs the identifier-only inventory, prepare, and decision flow", async () => {
  const requests: Array<Record<string, unknown>> = []
  const server = await controlServer((socket, request) => {
    requests.push(request)
    accepted(socket, request.requestId)
    if (request.method === "skill.inventory") return terminal(socket, request.requestId, inventoryResult(request.requestId))
    if (request.method === "skill.prepare") return terminal(socket, request.requestId, preparedResult(request.requestId))
    progress(socket, request.requestId, "recording_authority")
    progress(socket, request.requestId, "submitting_approval")
    progress(socket, request.requestId, "effect_observed_not_verified")
    terminal(socket, request.requestId, completedResult(request.requestId))
  })
  const client = createAstraSkillActivationClient({ ASTRA_CONTROL_SOCKET: server.path, ASTRA_CONTROL_TOKEN: token }, sessionID)
  expect(requests).toHaveLength(0)

  const inventory = await client.inventory()
  if (inventory.status !== "complete") throw new Error(inventory.reason)
  const candidate = inventory.candidates[0]
  if (!candidate) throw new Error("Missing test skill")
  const prepared = await client.prepare(inventory.inventoryID, candidate.candidateID)
  if (prepared.status !== "prepared") throw new Error(prepared.reason)
  const phases: string[] = []
  const result = await client.decide(prepared.preview.proposalID, "approve", {
    onProgress(value) { phases.push(value.status) },
  })

  expect(result.status).toBe("completed_observed_not_verified")
  expect(phases).toEqual(["recording_authority", "submitting_approval", "effect_observed_not_verified"])
  expect(requests.map((request) => request.method)).toEqual(["skill.inventory", "skill.prepare", "skill.decide"])
  expect(requests[1]).toEqual({ schemaVersion: 1, method: "skill.prepare", requestId: expect.any(String), sessionID, token, inventoryID, candidateID: digest })
  expect(requests[1]).not.toHaveProperty("path")
  expect(requests[1]).not.toHaveProperty("content")
  expect(requests[1]).not.toHaveProperty("workspaceRoot")
  client.dispose()
  await server.close()
})

test("fails closed on progress reordering and disconnect after approval acceptance", async () => {
  let mode: "normal" | "reordered" | "disconnect" = "normal"
  const server = await controlServer((socket, request) => {
    accepted(socket, request.requestId)
    if (request.method === "skill.inventory") return terminal(socket, request.requestId, inventoryResult(request.requestId))
    if (request.method === "skill.prepare") return terminal(socket, request.requestId, preparedResult(request.requestId))
    if (mode === "disconnect") return socket.destroy()
    progress(socket, request.requestId, mode === "reordered" ? "effect_observed_not_verified" : "recording_authority")
  })
  const environment = { ASTRA_CONTROL_SOCKET: server.path, ASTRA_CONTROL_TOKEN: token }

  for (const failure of ["reordered", "disconnect"] as const) {
    mode = "normal"
    const client = createAstraSkillActivationClient(environment, sessionID, { responseTimeoutMs: 1_000 })
    const inventory = await client.inventory()
    if (inventory.status !== "complete") throw new Error(inventory.reason)
    const prepared = await client.prepare(inventory.inventoryID, digest)
    if (prepared.status !== "prepared") throw new Error(prepared.reason)
    mode = failure
    const result = client.decide(proposalID, "approve")
    if (failure === "reordered") {
      expect(result).rejects.toMatchObject({ code: "protocol_invalid" } satisfies Partial<AstraControlClientError>)
    } else {
      expect(result).rejects.toMatchObject({ code: "transport_failed" } satisfies Partial<AstraControlClientError>)
    }
    client.dispose()
  }
  await server.close()
})

async function controlServer(handle: (socket: Socket, request: Record<string, unknown>) => void) {
  const root = await mkdtemp(join(tmpdir(), "astra-skill-client-"))
  roots.push(root)
  const path = join(root, "control.sock")
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    let input = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      input += chunk
      if (!input.includes("\n")) return
      const parsed: unknown = JSON.parse(input.slice(0, input.indexOf("\n")))
      if (!record(parsed)) {
        socket.destroy()
        return
      }
      const request = parsed
      handle(socket, request)
    })
  })
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject))
  return {
    path,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

function accepted(socket: Socket, requestId: unknown) { socket.write(`${JSON.stringify({ schemaVersion: 1, type: "accepted", requestId })}\n`) }
function terminal(socket: Socket, requestId: unknown, result: unknown) { socket.end(`${JSON.stringify({ schemaVersion: 1, type: "skill.terminal", requestId, result })}\n`) }
function progress(socket: Socket, requestId: unknown, status: string) {
  socket.write(`${JSON.stringify({ schemaVersion: 1, type: "skill.progress", requestId, progress: { schemaVersion: 1, requestId, proposalID, operationID, status, verification: "not_verified" } })}\n`)
}
function inventoryResult(requestId: unknown) { return { schemaVersion: 1, requestId, status: "complete", inventoryID, candidates: [{ candidateID: digest, name: "safe-skill", description: "Untrusted", metadataTrust: "UNTRUSTED WORKSPACE METADATA", provenance: "workspace_opencode", relativePath: ".opencode/skills/safe-skill/SKILL.md", fileDigest: digest, fileBytes: 128, instructionsDigest: digest, instructionsBytes: 64 }], verification: "not_verified" } }
function preparedResult(requestId: unknown) { return { schemaVersion: 1, requestId, status: "prepared", preview: { operationID, proposalID, expiresAt: "2026-07-17T18:00:00.000Z", boundaryLabel: "HOST EXECUTION — NO SANDBOX", capabilityDigest: digest, skill: { candidateID: digest, name: "safe-skill", relativePath: ".opencode/skills/safe-skill/SKILL.md", fileDigest: digest, fileBytes: 128, instructionsDigest: digest, instructionsBytes: 64, provenance: "workspace_opencode", trust: "UNTRUSTED INSTRUCTION DATA" }, effects: { workspaceRead: ".opencode/skills/safe-skill/SKILL.md", workspaceWrite: "none", runtimeWrite: "private_session_skill_bundle", process: "none", network: "none", plugins: "none", mcp: "none", tools: "none" }, verification: "not_verified" } } }
function completedResult(requestId: unknown) { return { schemaVersion: 1, requestId, proposalID, operationID, status: "completed_observed_not_verified", receiptID, verification: "not_verified" } }
function record(input: unknown): input is Record<string, unknown> { return typeof input === "object" && input !== null && !Array.isArray(input) }
