import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deflateSync } from "node:zlib"

const root = join(import.meta.dir, "..")
const binary = process.env.ASTRA_GIT_COMMIT_NATIVE_BINARY ?? join(root, "build", "astra-git-commit")
const fixtures: string[] = []

beforeAll(() => {
  if (process.env.ASTRA_GIT_COMMIT_NATIVE_BINARY) return
  const result = spawnSync(join(root, "build.sh"), { encoding: "utf8" })
  expect(result.status, result.stderr).toBe(0)
})

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

describe("native Git commit publisher", () => {
  for (const algorithm of ["sha1", "sha256"] as const) {
    test(`installs an exact ${algorithm} object and CAS updates an existing ref`, async () => {
      const state = await fixture()
      const raw = Buffer.from("commit 5\0hello")
      const next = createHash(algorithm).update(raw).digest()
      const old = Buffer.alloc(next.length, 1)
      writeFileSync(join(state.refs, "main"), `${old.toString("hex")}\n`)
      putLoose(state.quarantine, next, deflateSync(raw))
      const request = frame({ algorithm, old, next, objects: [next] })
      const result = run(state, request)
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(decode(result.stdout)).toEqual({ status: 2, detail: 0, format: algorithm === "sha1" ? 1 : 2, oid: next.toString("hex") })
      expect(readFileSync(join(state.refs, "main"), "utf8")).toBe(`${next.toString("hex")}\n`)
      expect(readFileSync(join(state.objects, next.toString("hex", 0, 1), next.toString("hex").slice(2)))).toEqual(deflateSync(raw))
    })
  }

  test("rejects a corrupt quarantined object without changing the ref", async () => {
    const state = await fixture()
    const next = createHash("sha1").update("expected").digest()
    putLoose(state.quarantine, next, deflateSync(Buffer.from("wrong")))
    const result = run(state, frame({ algorithm: "sha1", old: state.old, next, objects: [next] }))
    expect(decode(result.stdout).status).toBe(0)
    expect(decode(result.stdout).detail).toBe(4)
    expect(readFileSync(join(state.refs, "main"), "utf8")).toBe(`${state.old.toString("hex")}\n`)
  })

  test("reports installed objects when the ref CAS loses a race", async () => {
    const state = await fixture()
    const raw = Buffer.from("blob 1\0x")
    const next = createHash("sha1").update(raw).digest()
    putLoose(state.quarantine, next, deflateSync(raw))
    writeFileSync(join(state.refs, "main"), `${"22".repeat(20)}\n`)
    const decoded = decode(run(state, frame({ algorithm: "sha1", old: state.old, next, objects: [next] })).stdout)
    expect(decoded.status).toBe(1)
    expect(decoded.detail).toBe(9)
  })

  test("fails with no effect on a ref lock collision or symlink ancestry", async () => {
    const locked = await fixture()
    const lockedCommit = commitObject(locked, "sha1", "locked")
    copyLoose(locked, lockedCommit)
    writeFileSync(join(locked.refs, "main.lock"), "owned")
    const lockResult = decode(run(locked, frame({ algorithm: "sha1", old: locked.old, next: lockedCommit, objects: [lockedCommit] })).stdout)
    expect(lockResult).toMatchObject({ status: 0, detail: 6 })

    const unsafe = await fixture()
    const unsafeCommit = commitObject(unsafe, "sha1", "unsafe")
    copyLoose(unsafe, unsafeCommit)
    const outside = join(unsafe.root, "outside")
    mkdirSync(outside)
    Bun.spawnSync(["/bin/ln", "-s", outside, join(unsafe.refs, "team")])
    const unsafeResult = decode(run(unsafe, frame({ algorithm: "sha1", old: unsafe.old, next: unsafeCommit, branch: "team/main", objects: [unsafeCommit] })).stdout)
    expect(unsafeResult).toMatchObject({ status: 0, detail: 7 })
  })

  test("never publishes an absent or non-commit target", async () => {
    const absent = await fixture()
    const missing = Buffer.alloc(20, 9)
    expect(decode(run(absent, frame({ algorithm: "sha1", old: absent.old, next: missing, objects: [] })).stdout)).toMatchObject({ status: 0, detail: 4 })
    expect(readFileSync(join(absent.refs, "main"), "utf8")).toBe(`${absent.old.toString("hex")}\n`)

    const blob = await fixture()
    const raw = Buffer.from("blob 1\0x")
    const oid = createHash("sha1").update(raw).digest()
    putLoose(blob.quarantine, oid, deflateSync(raw))
    expect(decode(run(blob, frame({ algorithm: "sha1", old: blob.old, next: oid, objects: [oid] })).stdout)).toMatchObject({ status: 1, detail: 9 })
    expect(readFileSync(join(blob.refs, "main"), "utf8")).toBe(`${blob.old.toString("hex")}\n`)
  })

  test("rejects authority descriptors mixed from another repository", async () => {
    const state = await fixture()
    const foreign = await fixture()
    const next = commitObject(state, "sha1", "mixed")
    const result = run(state, frame({ algorithm: "sha1", old: state.old, next, objects: [next] }), { objects: foreign.objects })
    expect(decode(result.stdout)).toMatchObject({ status: 0, detail: 2 })
    expect(readFileSync(join(state.refs, "main"), "utf8")).toBe(`${state.old.toString("hex")}\n`)
  })

  test("rejects an object whose canonical declared size differs from inflated bytes", async () => {
    const state = await fixture()
    const raw = Buffer.from("commit 999999999\0tiny")
    const oid = createHash("sha1").update(raw).digest()
    putLoose(state.quarantine, oid, deflateSync(raw))
    expect(decode(run(state, frame({ algorithm: "sha1", old: state.old, next: oid, objects: [oid] })).stdout)).toMatchObject({ status: 0, detail: 4 })
  })

  test("bounds inflated object bytes before installation", async () => {
    const state = await fixture()
    const payload = Buffer.alloc(64 * 1024 * 1024 + 1)
    const header = Buffer.from(`blob ${payload.length}\0`)
    const raw = Buffer.concat([header, payload])
    const oid = createHash("sha1").update(raw).digest()
    putLoose(state.quarantine, oid, deflateSync(raw))
    expect(decode(run(state, frame({ algorithm: "sha1", old: state.old, next: oid, objects: [oid] })).stdout)).toMatchObject({ status: 0, detail: 4 })
  })

  test("publishes a bounded locked reflog before the ref and removes locks", async () => {
    const state = await fixture()
    const next = commitObject(state, "sha1", "reflog")
    writeFileSync(join(state.logs, "main"), "previous\n")
    const result = run(state, frame({ algorithm: "sha1", old: state.old, next, objects: [next], actor: "A <a@example.test> 1 +0000", message: "commit" }))
    expect(decode(result.stdout)).toMatchObject({ status: 2, detail: 0 })
    expect(readFileSync(join(state.logs, "main"), "utf8")).toContain(`${state.old.toString("hex")} ${next.toString("hex")} A <a@example.test> 1 +0000\tcommit\n`)
    expect(Bun.file(join(state.logs, "main.lock")).size).toBe(0)
  })

  test("rejects FIFO object and ref leaves without blocking", async () => {
    const objectState = await fixture()
    const fifoOID = Buffer.alloc(20, 0x44)
    const fifoHex = fifoOID.toString("hex")
    mkdirSync(join(objectState.quarantine, fifoHex.slice(0, 2)))
    expect(spawnSync("/usr/bin/mkfifo", [join(objectState.quarantine, fifoHex.slice(0, 2), fifoHex.slice(2))]).status).toBe(0)
    const objectResult = run(objectState, frame({ algorithm: "sha1", old: objectState.old, next: fifoOID, objects: [fifoOID] }))
    expect(objectResult.signal).toBeNull()
    expect(decode(objectResult.stdout)).toMatchObject({ status: 0, detail: 4 })

    const refState = await fixture()
    const target = commitObject(refState, "sha1", "fifo-ref")
    copyLoose(refState, target)
    rmSync(join(refState.refs, "main"))
    expect(spawnSync("/usr/bin/mkfifo", [join(refState.refs, "main")]).status).toBe(0)
    const refResult = run(refState, frame({ algorithm: "sha1", old: refState.old, next: target, objects: [target] }))
    expect(refResult.signal).toBeNull()
    expect(decode(refResult.stdout)).toMatchObject({ status: 0, detail: 5 })
  })

  test("fails closed while a reflog grows concurrently beyond its captured size", async () => {
    const state = await fixture()
    const target = commitObject(state, "sha1", "growing-log")
    copyLoose(state, target)
    writeFileSync(join(state.logs, "main"), Buffer.alloc(1024 * 1024, 0x61))
    const writer = spawn("/bin/sh", ["-c", "while :; do printf x >> main; done"], { cwd: state.logs, stdio: "ignore" })
    await Bun.sleep(20)
    try {
      const result = run(state, frame({ algorithm: "sha1", old: state.old, next: target, objects: [target], actor: "A <a@example.test> 1 +0000", message: "commit" }))
      expect(result.signal).toBeNull()
      expect(decode(result.stdout).status).not.toBe(2)
      expect(readFileSync(join(state.refs, "main"), "utf8")).toBe(`${state.old.toString("hex")}\n`)
    } finally {
      writer.kill("SIGKILL")
    }
  })

  test("rejects malformed and trailing protocol bytes before effects", async () => {
    const state = await fixture()
    const next = Buffer.alloc(20, 7)
    const malformed = Buffer.concat([frame({ algorithm: "sha1", old: state.old, next, objects: [] }), Buffer.from([0])])
    expect(decode(run(state, malformed).stdout)).toMatchObject({ status: 0, detail: 1 })
    expect(readFileSync(join(state.refs, "main"), "utf8")).toBe(`${state.old.toString("hex")}\n`)
  })
})

type State = Awaited<ReturnType<typeof fixture>>

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "astra-git-commit-"))
  fixtures.push(root)
  const git = join(root, ".git")
  const objects = join(git, "objects")
  const refs = join(git, "refs", "heads")
  const logs = join(git, "logs", "refs", "heads")
  const quarantine = join(root, "quarantine")
  for (const path of [objects, refs, logs, quarantine]) mkdirSync(path, { recursive: true })
  const old = Buffer.alloc(20, 1)
  writeFileSync(join(refs, "main"), `${old.toString("hex")}\n`)
  return { root, git, objects, refs, logs, quarantine, old }
}

function run(state: State, input: Buffer, override: Partial<Pick<State, "objects" | "refs" | "logs" | "quarantine">> = {}) {
  const descriptors = [state.git, override.objects ?? state.objects, override.refs ?? state.refs, override.logs ?? state.logs, override.quarantine ?? state.quarantine].map((path) => openSync(path, constants.O_RDONLY))
  try {
    return spawnSync(binary, [], { input, timeout: 3000, stdio: ["pipe", "pipe", "pipe", ...descriptors] })
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor)
  }
}

function frame(input: { algorithm: "sha1" | "sha256"; old: Buffer; next: Buffer; branch?: string; objects: Buffer[]; actor?: string; message?: string }) {
  const branch = Buffer.from(input.branch ?? "main")
  const actor = Buffer.from(input.actor ?? "")
  const message = Buffer.from(input.message ?? "")
  const header = Buffer.alloc(22)
  header.write("ASTRGC01"); header.writeUInt16BE(1, 8); header.writeUInt16BE(input.actor ? 1 : 0, 10)
  header[12] = input.algorithm === "sha1" ? 1 : 2
  header.writeUInt16BE(input.objects.length, 14); header.writeUInt16BE(branch.length, 16); header.writeUInt16BE(actor.length, 18); header.writeUInt16BE(message.length, 20)
  return Buffer.concat([header, input.old, input.next, branch, actor, message, ...input.objects])
}

function commitObject(state: State, algorithm: "sha1" | "sha256", payload: string) {
  const body = Buffer.from(payload)
  const raw = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body])
  const oid = createHash(algorithm).update(raw).digest()
  putLoose(state.quarantine, oid, deflateSync(raw))
  return oid
}

function putLoose(root: string, oid: Buffer, content: Buffer) {
  const hex = oid.toString("hex")
  mkdirSync(join(root, hex.slice(0, 2)), { recursive: true })
  writeFileSync(join(root, hex.slice(0, 2), hex.slice(2)), content)
}

function copyLoose(state: State, oid: Buffer) {
  const hex = oid.toString("hex")
  putLoose(state.objects, oid, readFileSync(join(state.quarantine, hex.slice(0, 2), hex.slice(2))))
}

function decode(output: Buffer) {
  expect(output.subarray(0, 8).toString()).toBe("ASTRGR01")
  const length = output[13] ?? 0
  return { status: output[10], detail: output[11], format: output[12], oid: output.subarray(14, 14 + length).toString("hex") }
}
