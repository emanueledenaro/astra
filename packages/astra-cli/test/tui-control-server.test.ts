import { randomUUID } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { parseGitControlInspectionSummary } from "@astra/domain/git-control-inspection"
import { startAstraTuiControlServer, type AstraTuiControlServer } from "../src/tui-control-server"

test("does not inspect before an authenticated explicit request and excludes raw Git data", async () => {
  const fixture = await makeFixture()
  const hostilePath = "raw-secret-name-\u001b]2;owned\u0007"
  const calls: string[] = []
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace(root) {
      calls.push(root)
      return completeInspection(root, hostilePath)
    },
  })

  try {
    expect((await stat(control.socketPath)).mode & 0o777).toBe(0o600)
    expect(calls).toEqual([])
    const messages = await sendRequest(control, request(control))

    expect(messages.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(messages[0]).toMatchObject({ requestId: messages[1]?.requestId })
    expect(parseGitControlInspectionSummary(messages[1]?.summary)).toMatchObject({
      ok: true,
      value: {
        status: "complete",
        verification: "not_verified",
        counts: { total: 4, staged: 1, unstaged: 1, untracked: 1, conflicts: 1 },
      },
    })
    expect(JSON.stringify(messages)).not.toContain("raw-secret-name")
    expect(JSON.stringify(messages)).not.toContain(fixture.root)
    expect(calls).toEqual([fixture.root])
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("fails closed for a wrong token, wrong session, or caller-supplied root", async () => {
  const fixture = await makeFixture()
  const calls: string[] = []
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace(root) {
      calls.push(root)
      return completeInspection(root)
    },
  })

  try {
    expect(await sendRequest(control, { ...request(control), token: "x".repeat(43) })).toEqual([])
    expect(await sendRequest(control, { ...request(control), sessionID: randomUUID() })).toEqual([])
    expect(await sendRequest(control, { ...request(control), workspaceRoot: "/tmp/attacker-selected" })).toEqual([])
    expect(calls).toEqual([])
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("allows one in-flight inspection and rejects replayed request identifiers", async () => {
  const fixture = await makeFixture()
  let complete!: (value: unknown) => void
  const result = new Promise<unknown>((resolve) => {
    complete = resolve
  })
  let calls = 0
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace() {
      calls++
      return result
    },
  })
  const firstRequest = request(control)
  let accepted!: () => void
  const firstAccepted = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const first = sendRequest(control, firstRequest, (message) => {
      if (message.type === "accepted") accepted()
    })
    await firstAccepted

    const busy = await sendRequest(control, request(control))
    expect(busy.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(busy[1]).toMatchObject({ type: "terminal", summary: { status: "blocked", reason: "control_busy" } })
    expect(calls).toBe(1)

    complete(completeInspection(fixture.root))
    expect(await first).toHaveLength(2)

    const replayed = await sendRequest(control, firstRequest)
    expect(replayed.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(replayed[1]).toMatchObject({
      type: "terminal",
      summary: { status: "blocked", reason: "request_replayed" },
    })
    expect(calls).toBe(1)
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("times out an inspector that never resolves and ignores its late result", async () => {
  const fixture = await makeFixture()
  let finishLate!: (value: unknown) => void
  const late = new Promise<unknown>((resolve) => {
    finishLate = resolve
  })
  let calls = 0
  const control = await startAstraTuiControlServer(fixture.input, {
    inspectionTimeoutMs: 20,
    async inspectGitWorkspace(root) {
      calls++
      if (calls === 1) return late
      return completeInspection(root)
    },
  })

  try {
    const timedOut = await sendRequest(control, request(control))
    expect(timedOut.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(timedOut[1]).toMatchObject({
      summary: { status: "blocked", reason: "inspection_timed_out", verification: "not_verified" },
    })

    finishLate(completeInspection(fixture.root, "late-private-path"))
    await Promise.resolve()
    const next = await sendRequest(control, request(control))
    expect(next.map((message) => message.type)).toEqual(["accepted", "terminal"])
    expect(next[1]).toMatchObject({ summary: { status: "complete", verification: "not_verified" } })
    expect(JSON.stringify(next)).not.toContain("late-private-path")
    expect(calls).toBe(2)
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("closes within a bound even while an authenticated inspector never resolves", async () => {
  const fixture = await makeFixture()
  const control = await startAstraTuiControlServer(fixture.input, {
    inspectionTimeoutMs: 60_000,
    async inspectGitWorkspace() {
      return new Promise(() => {})
    },
  })
  let accepted!: () => void
  const didAccept = new Promise<void>((resolve) => {
    accepted = resolve
  })

  try {
    const requestPromise = sendRequest(control, request(control), (message) => {
      if (message.type === "accepted") accepted()
    })
    await didAccept
    await completeWithin(control.close(), 250)
    expect((await requestPromise).map((message) => message.type)).toEqual(["accepted"])
    expect(stat(control.socketPath)).rejects.toThrow()
  } finally {
    await control.close()
    await fixture.close()
  }
})

test("reports adapter failures without details and removes its socket on close", async () => {
  const fixture = await makeFixture()
  const control = await startAstraTuiControlServer(fixture.input, {
    async inspectGitWorkspace() {
      throw new Error("private adapter detail")
    },
  })

  try {
    const messages = await sendRequest(control, request(control))
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      type: "terminal",
      summary: { status: "blocked", reason: "inspection_failed", verification: "not_verified" },
    })
    expect(JSON.stringify(messages)).not.toContain("private adapter detail")
  } finally {
    await control.close()
    expect(stat(control.socketPath)).rejects.toThrow()
    await fixture.close()
  }
})

async function makeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "astra-control-test-"))
  const root = join(directory, "workspace")
  await Bun.write(join(directory, "keep"), "private directory")
  return {
    root,
    input: { directory, workspaceRoot: root, sessionID: randomUUID() },
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

function request(control: AstraTuiControlServer) {
  return {
    schemaVersion: 1,
    method: "git.inspect",
    requestId: randomUUID(),
    sessionID: control.sessionID,
    token: control.token,
  } as const
}

function sendRequest(
  control: AstraTuiControlServer,
  payload: Readonly<Record<string, unknown>>,
  onMessage?: (message: Record<string, unknown>) => void,
) {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    let buffered = ""
    const socket = createConnection(control.socketPath)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"))
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) throw new Error("The control server returned a non-object message")
        const message = parsed
        messages.push(message)
        onMessage?.(message)
      }
    })
    socket.on("error", reject)
    socket.on("close", () => resolve(messages))
  })
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function completeWithin(operation: Promise<void>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("The control server did not close within the bound")), milliseconds)
  })
  return Promise.race([operation, expired]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function completeInspection(root: string, path = "src/index.ts") {
  const observationDigest = `sha256:${"a".repeat(64)}`
  return {
    status: "complete",
    mode: "bounded_read_only",
    baseline: "not_captured",
    activationAllowed: false,
    verification: "not_verified",
    submodules: "not_inspected",
    workspaceRoot: root,
    branch: {
      oid: null,
      head: null,
      upstream: null,
      ahead: null,
      behind: null,
      stashCount: 0,
      aheadBehindScope: "local_ref_only",
    },
    staged: [{ path, index: "M", worktree: "." }],
    unstaged: [{ path, index: ".", worktree: "M" }],
    untracked: [path],
    conflicts: [{ path, code: "UU" }],
    entryCount: 4,
    outputDigest: observationDigest,
    diff: {
      source: "status_porcelain_v2",
      format: "metadata_only",
      renames: "disabled",
      durability: "ephemeral",
      verification: "not_verified",
      untrackedContent: "not_inspected",
      conflictContent: "not_inspected",
      observationDigest,
      staged: [],
      unstaged: [],
    },
    reportDigest: `sha256:${"b".repeat(64)}`,
  }
}
