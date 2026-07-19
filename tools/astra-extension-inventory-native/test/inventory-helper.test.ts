import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { closeSync, constants, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createConnection, createServer, type Socket } from "node:net"

const root = join(import.meta.dir, "..")
const binary = process.env.ASTRA_NATIVE_INVENTORY_BINARY ?? join(root, "build", "astra-extension-inventory")
const fixtures: string[] = []

type Record = Readonly<{
  path: string
  device: bigint
  inode: bigint
  mode: bigint
  linkCount: bigint
  size: bigint
  digest: Uint8Array
  content: Uint8Array
}>

beforeAll(() => {
  if (process.env.ASTRA_NATIVE_INVENTORY_BINARY) return
  const build = spawnSync(join(root, "build.sh"), { encoding: "utf8" })
  expect(build.status, build.stderr).toBe(0)
})

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

describe("native extension inventory reader", () => {
  test("inherits only workspace FD 3 from Bun and emits canonical bounded records", async () => {
    const workspace = await fixture()
    mkdirSync(join(workspace, ".opencode", "plugin"), { recursive: true })
    mkdirSync(join(workspace, ".opencode", "plugins"), { recursive: true })
    writeFileSync(join(workspace, "opencode.jsonc"), '{\n  "plugin": ["secret-package"]\n}\n')
    writeFileSync(join(workspace, ".mcp.json"), '{"mcp":{"private-server":{"command":"token"}}}')
    writeFileSync(join(workspace, ".opencode", "plugin", "safe.ts"), "export default {}\n")
    writeFileSync(join(workspace, ".opencode", "plugins", "safe.js"), "export default {}\n")
    writeFileSync(join(workspace, "package.json"), '{"scripts":{"postinstall":"touch escaped"}}')

    const result = run(workspace)
    expect(result.status, result.stderr.toString()).toBe(0)
    const records = decode(result.stdout)
    expect(records.map((record) => record.path)).toEqual([
      ".mcp.json",
      ".opencode/plugin/safe.ts",
      ".opencode/plugins/safe.js",
      "opencode.jsonc",
    ])
    expect(records.map((record) => new TextDecoder().decode(record.content))).not.toContain(
      '{"scripts":{"postinstall":"touch escaped"}}',
    )
    expect(readdirSync(workspace).sort()).toEqual([".mcp.json", ".opencode", "opencode.jsonc", "package.json"])
    expect(records.every((record) => record.linkCount === 1n && record.size === BigInt(record.content.byteLength))).toBe(true)
    expect(records.every((record) => record.digest.byteLength === 32)).toBe(true)
    expect(
      records.every((record) => Buffer.from(record.digest).equals(createHash("sha256").update(record.content).digest())),
    ).toBe(true)
  })

  test("rejects paths, stdin protocols, and a non-directory FD 3", async () => {
    const workspace = await fixture()
    const regular = join(workspace, "regular")
    writeFileSync(regular, "not a directory")
    const descriptor = openSync(regular, constants.O_RDONLY)
    const result = spawnSync(binary, [workspace], {
      input: workspace,
      stdio: ["pipe", "pipe", "pipe", descriptor],
    })
    closeSync(descriptor)
    expect(result.status).not.toBe(0)
    expect(result.stdout.byteLength).toBe(0)
  })

  test("refuses to write its protocol to a filesystem file", async () => {
    const workspace = await fixture()
    writeFileSync(join(workspace, "opencode.json"), "{}")
    const workspaceDescriptor = openSync(workspace, constants.O_RDONLY)
    const outputPath = join(workspace, "forbidden-output")
    const outputDescriptor = openSync(outputPath, constants.O_CREAT | constants.O_WRONLY, 0o600)
    const result = spawnSync(binary, [], { stdio: ["ignore", outputDescriptor, "pipe", workspaceDescriptor] })
    closeSync(outputDescriptor)
    closeSync(workspaceDescriptor)
    expect(result.status).not.toBe(0)
    expect(readFileSync(outputPath).byteLength).toBe(0)
  })

  test("rejects a named FIFO output before reading workspace bytes", async () => {
    const workspace = await fixture()
    writeFileSync(join(workspace, "opencode.json"), "PRIVATE")
    const fifo = join(workspace, "named-fifo")
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0)
    const workspaceDescriptor = openSync(workspace, constants.O_RDONLY)
    const fifoDescriptor = openSync(fifo, constants.O_RDWR)
    const result = spawnSync(binary, [], { stdio: ["ignore", fifoDescriptor, "pipe", workspaceDescriptor] })
    closeSync(fifoDescriptor)
    closeSync(workspaceDescriptor)
    expect(result.status).not.toBe(0)
  })

  test("rejects a connected TCP output before reading workspace bytes", async () => {
    const workspace = await fixture()
    writeFileSync(join(workspace, "opencode.json"), "PRIVATE")
    const server = createServer()
    const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    expect(typeof address).toBe("object")
    if (!address || typeof address === "string") throw new Error("Expected TCP server address")
    const client = createConnection(address.port, "127.0.0.1")
    await new Promise<void>((resolve) => client.once("connect", resolve))
    const peer = await accepted
    const clientDescriptor = (client as unknown as { _handle: { fd: number } })._handle.fd
    const workspaceDescriptor = openSync(workspace, constants.O_RDONLY)
    try {
      const result = spawnSync(binary, [], { stdio: ["ignore", clientDescriptor, "pipe", workspaceDescriptor] })
      expect(result.status).not.toBe(0)
    } finally {
      closeSync(workspaceDescriptor)
      client.destroy()
      peer.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("fails closed on symlinks, hard links, nested directories, and oversized files", async () => {
    const cases = [
      async (workspace: string) => {
        mkdirSync(join(workspace, ".opencode", "plugin"), { recursive: true })
        writeFileSync(join(workspace, "outside"), "outside")
        symlinkSync(join(workspace, "outside"), join(workspace, ".opencode", "plugin", "linked.ts"))
      },
      async (workspace: string) => {
        mkdirSync(join(workspace, ".opencode", "plugin"), { recursive: true })
        writeFileSync(join(workspace, ".opencode", "plugin", "one.ts"), "same inode")
        linkSync(join(workspace, ".opencode", "plugin", "one.ts"), join(workspace, ".opencode", "plugin", "two.ts"))
      },
      async (workspace: string) => {
        mkdirSync(join(workspace, ".opencode", "plugin", "nested"), { recursive: true })
        writeFileSync(join(workspace, ".opencode", "plugin", "nested", "hidden.ts"), "nested")
      },
      async (workspace: string) => {
        writeFileSync(join(workspace, "opencode.json"), Buffer.alloc(256 * 1024 + 1, 0x61))
      },
    ]
    for (const arrange of cases) {
      const workspace = await fixture()
      await arrange(workspace)
      const result = run(workspace)
      expect(result.status).not.toBe(0)
      expect(result.stdout.byteLength).toBe(0)
    }
  })

  test("rejects more than 64 files and more than 1 MiB total input", async () => {
    const tooMany = await fixture()
    mkdirSync(join(tooMany, ".opencode", "plugins"), { recursive: true })
    for (let index = 0; index < 65; index++) {
      writeFileSync(join(tooMany, ".opencode", "plugins", `${index.toString().padStart(2, "0")}.ts`), "x")
    }
    expect(run(tooMany).status).not.toBe(0)

    const tooLarge = await fixture()
    mkdirSync(join(tooLarge, ".opencode", "plugins"), { recursive: true })
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(tooLarge, ".opencode", "plugins", `${index}.ts`), Buffer.alloc(220 * 1024, 0x61))
    }
    expect(run(tooLarge).status).not.toBe(0)
  })

  test("never exposes bytes from a symlink swap race", async () => {
    const workspace = await fixture()
    const directory = join(workspace, ".opencode", "plugin")
    const target = join(directory, "raced.ts")
    const replacement = join(directory, "replacement")
    const outside = join(workspace, "outside-secret")
    mkdirSync(directory, { recursive: true })
    writeFileSync(target, "allowed")
    writeFileSync(replacement, "allowed")
    writeFileSync(outside, "FORBIDDEN_SECRET")

    const flipper = spawn("/bin/sh", ["-c", 'while :; do rm -f raced.ts; ln -s ../../outside-secret raced.ts; rm -f raced.ts; cp replacement raced.ts; done'], {
      cwd: directory,
      stdio: "ignore",
    })
    try {
      for (let index = 0; index < 40; index++) {
        const result = run(workspace)
        expect(result.stdout.includes(Buffer.from("FORBIDDEN_SECRET"))).toBe(false)
        if (result.status === 0) expect(decode(result.stdout)[0]?.content).toEqual(new TextEncoder().encode("allowed"))
      }
    } finally {
      flipper.kill("SIGKILL")
    }
  })

  test("rejects or safely observes a directory identity swap", async () => {
    const workspace = await fixture()
    const opencode = join(workspace, ".opencode")
    const plugin = join(opencode, "plugin")
    const outside = join(workspace, "outside-plugins")
    mkdirSync(plugin, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(plugin, "safe.ts"), "allowed")
    writeFileSync(join(outside, "evil.ts"), "FORBIDDEN_DIRECTORY_SECRET")

    const flipper = spawn(
      "/bin/sh",
      ["-c", "while :; do mv plugin plugin-held 2>/dev/null || true; ln -s ../../outside-plugins plugin 2>/dev/null || true; rm -f plugin; mv plugin-held plugin 2>/dev/null || true; done"],
      { cwd: opencode, stdio: "ignore" },
    )
    try {
      for (let index = 0; index < 40; index++) {
        const result = run(workspace)
        expect(result.stdout.includes(Buffer.from("FORBIDDEN_DIRECTORY_SECRET"))).toBe(false)
        if (result.status === 0) {
          expect(decode(result.stdout).every((record) => new TextDecoder().decode(record.content) === "allowed")).toBe(true)
        }
      }
    } finally {
      flipper.kill("SIGKILL")
    }
  })

  test("never emits a mixed successful snapshot while the workspace root changes", async () => {
    const workspace = await fixture()
    const target = join(workspace, "opencode.json")
    const source = join(workspace, "source")
    writeFileSync(source, "stable")
    const flipper = spawn(
      "/bin/sh",
      ["-c", "while :; do cp source candidate; mv -f candidate opencode.json; rm -f opencode.json; done"],
      { cwd: workspace, stdio: "ignore" },
    )
    try {
      for (let index = 0; index < 40; index++) {
        const result = run(workspace)
        if (result.status === 0) {
          const records = decode(result.stdout)
          expect(records.length === 0 || (records.length === 1 && records[0]?.path === "opencode.json")).toBe(true)
          if (records.length === 1) expect(new TextDecoder().decode(records[0]?.content)).toBe("stable")
        }
      }
    } finally {
      flipper.kill("SIGKILL")
      rmSync(target, { force: true })
    }
  })

  test("imports no process, network, authentication, or path-open symbols", () => {
    const symbols = spawnSync("/usr/bin/nm", ["-u", binary], { encoding: "utf8" })
    expect(symbols.status, symbols.stderr).toBe(0)
    expect(symbols.stdout).not.toMatch(/\b_(exec|posix_spawn|system|popen|socket|connect|send|recv|fopen|open|fprintf)\b/)
    expect(symbols.stdout).toContain("_openat")
    expect(symbols.stdout).toContain("_fdopendir")
    expect(symbols.stdout).toContain("_fstatat")
  })
})

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "astra-extension-inventory-"))
  fixtures.push(path)
  return path
}

function run(workspace: string) {
  const descriptor = openSync(workspace, constants.O_RDONLY)
  const result = spawnSync(binary, [], { stdio: ["ignore", "pipe", "pipe", descriptor] })
  closeSync(descriptor)
  return result
}

function decode(bytes: Buffer): Record[] {
  expect(bytes.subarray(0, 8).toString()).toBe("ASTRXI01")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(8)
  const records: Record[] = []
  let offset = 12
  for (let index = 0; index < count; index++) {
    const pathLength = view.getUint16(offset)
    offset += 2
    const path = bytes.subarray(offset, offset + pathLength).toString("utf8")
    offset += pathLength
    const device = view.getBigUint64(offset)
    offset += 8
    const inode = view.getBigUint64(offset)
    offset += 8
    const mode = view.getBigUint64(offset)
    offset += 8
    const linkCount = view.getBigUint64(offset)
    offset += 8
    const size = view.getBigUint64(offset)
    offset += 8
    const digest = bytes.subarray(offset, offset + 32)
    offset += 32
    const contentLength = view.getUint32(offset)
    offset += 4
    const content = bytes.subarray(offset, offset + contentLength)
    offset += contentLength
    records.push({ path, device, inode, mode, linkCount, size, digest, content })
  }
  expect(offset).toBe(bytes.byteLength)
  return records
}
