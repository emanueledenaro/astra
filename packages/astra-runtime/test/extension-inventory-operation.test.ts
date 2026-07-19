import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { parseReceiptID } from "../../astra-domain/src/operation-contract"
import { Effect } from "effect"
import {
  executeExtensionInventory,
  inspectTrustedExtensionInventoryHelper,
  parseAndRedactExtensionInventoryWire,
  proposeExtensionInventory,
  recoverExtensionInventory,
  type ExecuteExtensionInventoryInput,
} from "../src/extension-inventory-operation"
import { scanWorkspace } from "../src/workspace-preflight"
import { runWithReceiptSpool } from "../src/operation-storage"

const helperRoot = resolve(import.meta.dir, "../../../tools/astra-extension-inventory-native")
const helperPath = join(helperRoot, "build", "astra-extension-inventory")
const fixtures: string[] = []

beforeAll(() => {
  const build = Bun.spawnSync([join(helperRoot, "build.sh")], { stdout: "pipe", stderr: "pipe" })
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0)
})

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

describe("parent extension inventory Operation", () => {
  test("claims before root open and returns only redacted inactive candidates", async () => {
    const workspace = await temp("workspace")
    const state = await temp("state")
    mkdirSync(join(workspace, ".opencode", "plugin"), { recursive: true })
    writeFileSync(
      join(workspace, "opencode.jsonc"),
      `{
        // None of these values may cross the private pipe.
        "plugin": ["https://user:password@example.test/plugin?token=PRIVATE_TOKEN#fragment", "safe-package"],
        "mcp": {
          "PRIVATE_TOKEN_AS_NAME": {
            "url": "https://admin:secret@example.test/mcp?api_key=PRIVATE_TOKEN",
            "headers": { "Authorization": "Bearer PRIVATE_TOKEN" }
          },
          "local": {
            "command": "/bin/tool",
            "args": ["--token", "PRIVATE_TOKEN"],
            "env": { "API_TOKEN": "PRIVATE_TOKEN" }
          }
        }
      }`,
    )
    writeFileSync(join(workspace, ".opencode", "plugin", "safe.ts"), "export default {}\n")
    const fixture = await operationFixture(workspace, state)
    let claimed = false
    let stateValidated = false
    let rootOpened = 0
    let processes = 0
    const result = await executeExtensionInventory(fixture.input, {
      injectFault: async (point) => {
        if (point === "after_claim_before_effect") claimed = true
      },
      onPostClaimWorkspaceValidation: () => {
        expect(claimed).toBe(true)
        stateValidated = true
      },
      beforeEffectBoundary: async () => {
        claimed = true
        expect(stateValidated).toBe(true)
      },
      onWorkspaceRootOpened: () => {
        expect(claimed).toBe(true)
        rootOpened++
      },
      onProcessEntered: () => {
        expect(claimed).toBe(true)
        processes++
      },
      now: fixture.now,
    })

    expect(result.status).toBe("completed_observed_not_verified")
    expect(result.inventory).toMatchObject({
      status: "complete",
      state: "inactive",
      verification: "not_verified",
      candidateCounts: { plugins: 3, mcp: 2 },
    })
    expect(result.inventory?.candidates.every((candidate) => candidate.state === "inactive")).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|password|Authorization|api_key|admin:secret/)
    expect(rootOpened).toBe(1)
    expect(processes).toBe(1)
    expect(readFileSync(fixture.input.ledgerFilename)).not.toContain("PRIVATE_TOKEN")
    expect(readFileSync(fixture.input.spoolFilename)).not.toContain("PRIVATE_TOKEN")
  })

  test("records rejection with zero inventory root open and zero child", async () => {
    const workspace = await temp("reject-workspace")
    const state = await temp("reject-state")
    writeFileSync(join(workspace, "opencode.json"), '{"plugin":["must-not-be-read"]}')
    const fixture = await operationFixture(workspace, state, "rejected")
    const held = `${workspace}-held`
    renameSync(workspace, held)
    let rootOpened = 0
    let processes = 0
    const result = await executeExtensionInventory(fixture.input, {
      onWorkspaceRootOpened: () => rootOpened++,
      onProcessEntered: () => processes++,
      now: fixture.now,
    })
    expect(result).toMatchObject({ state: "denied", status: "denied_without_effect", inventory: null })
    expect(rootOpened).toBe(0)
    expect(processes).toBe(0)
    renameSync(held, workspace)
  })

  test("refuses a workspace-controlled helper before creating authority", async () => {
    const workspace = await temp("workspace-helper")
    const executable = join(workspace, "astra-extension-inventory")
    await Bun.write(executable, Bun.file(helperPath))
    chmodSync(executable, 0o700)
    const report = await scanWorkspace(workspace)
    if (report.completeness !== "complete") throw new Error(report.blockers.join(","))
    const helper = await inspectTrustedExtensionInventoryHelper(executable)
    expect(() =>
      proposeExtensionInventory({
        operationID: randomUUID(),
        policyAskedAt: new Date().toISOString(),
        session: { mode: "activate-once", report },
        helper,
      }),
    ).toThrow("must remain outside the workspace")
  })

  test("rejects root replacement after claim without spawning the helper", async () => {
    const workspace = await temp("root-swap-workspace")
    const state = await temp("root-swap-state")
    writeFileSync(join(workspace, "opencode.json"), "{}")
    const fixture = await operationFixture(workspace, state)
    const held = `${workspace}-held`
    let processes = 0
    const result = await executeExtensionInventory(fixture.input, {
      beforeEffectBoundary: async () => {
        renameSync(workspace, held)
        mkdirSync(workspace)
        writeFileSync(join(workspace, "opencode.json"), '{"plugin":["replacement"]}')
      },
      onProcessEntered: () => processes++,
      now: fixture.now,
    })
    expect(result.status).toBe("failed_without_effect")
    expect(result.inventory).toBeNull()
    expect(processes).toBe(0)
    rmSync(workspace, { recursive: true, force: true })
    renameSync(held, workspace)
  })

  test("detects helper drift after claim before any process starts", async () => {
    const workspace = await temp("helper-drift-workspace")
    const state = await temp("helper-drift-state")
    const helperDirectory = await temp("helper-drift-binary")
    const copy = join(helperDirectory, "astra-extension-inventory")
    await Bun.write(copy, Bun.file(helperPath))
    chmodSync(copy, 0o700)
    writeFileSync(join(workspace, "opencode.json"), "{}")
    const fixture = await operationFixture(workspace, state, "approved", copy)
    let processes = 0
    const result = await executeExtensionInventory(fixture.input, {
      beforeEffectBoundary: async () => {
        writeFileSync(copy, "#!/bin/sh\nexit 0\n")
        chmodSync(copy, 0o700)
      },
      onProcessEntered: () => processes++,
      now: fixture.now,
    })
    expect(result.status).toBe("failed_without_effect")
    expect(processes).toBe(0)
  })

  test("executes an independent helper snapshot when the public inode is mutated in place", async () => {
    const workspace = await temp("helper-race-workspace")
    const state = await temp("helper-race-state")
    const helperDirectory = await temp("helper-race-binary")
    const copy = join(helperDirectory, "astra-extension-inventory")
    await Bun.write(copy, Bun.file(helperPath))
    chmodSync(copy, 0o700)
    writeFileSync(join(workspace, "opencode.json"), "{}")
    const fixture = await operationFixture(workspace, state, "approved", copy)
    const result = await executeExtensionInventory(fixture.input, {
      beforePinnedHelperSpawn: async () => {
        writeFileSync(copy, "#!/bin/sh\nexit 91\n")
        chmodSync(copy, 0o700)
      },
      now: fixture.now,
    })
    expect(result.status).toBe("completed_observed_not_verified")
    expect(lstatSync(copy).nlink).toBe(1)
  })

  test("times out and terminates the helper process group", async () => {
    const workspace = await temp("timeout-workspace")
    const state = await temp("timeout-state")
    const helperDirectory = await temp("timeout-helper")
    const pidFile = join(state, "descendant.pid")
    const executable = join(helperDirectory, "astra-extension-inventory")
    writeFileSync(
      executable,
      `#!/bin/sh
trap '' TERM
/bin/sleep 30 &
echo $! > ${JSON.stringify(pidFile)}
wait
`,
    )
    chmodSync(executable, 0o700)
    writeFileSync(join(workspace, "opencode.json"), "{}")
    const fixture = await operationFixture(workspace, state, "approved", executable)
    const result = await executeExtensionInventory(fixture.input, {
      now: () => Math.max(Date.now(), fixture.now()),
    })
    expect(result.status).toBe("effect_unknown")
    const descendant = Number(readFileSync(pidFile, "utf8").trim())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(processExists(descendant)).toBe(false)
  })

  test("treats helper rejection of symlinks and hardlinks as effect unknown", async () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const workspace = await temp(`${kind}-workspace`)
      const state = await temp(`${kind}-state`)
      const directory = join(workspace, ".opencode", "plugin")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(workspace, "outside"), "secret")
      if (kind === "symlink") symlinkSync(join(workspace, "outside"), join(directory, "candidate.ts"))
      if (kind === "hardlink") linkSync(join(workspace, "outside"), join(directory, "candidate.ts"))
      const fixture = await operationFixture(workspace, state)
      const result = await executeExtensionInventory(fixture.input, { now: fixture.now })
      expect(result.status).toBe("effect_unknown")
      expect(result.inventory).toBeNull()
    }
  })

  test("rejects malformed ASTRXI01 and redacts URL, token, headers, env, and command arguments", () => {
    expect(() =>
      parseAndRedactExtensionInventoryWire(
        Uint8Array.from([...new TextEncoder().encode("ASTRXI01"), 0, 0, 0, 1]),
      ),
    ).toThrow(
      "protocol was rejected",
    )
    const secret = "DO_NOT_EXPOSE_PRIVATE_TOKEN"
    const content = new TextEncoder().encode(
      JSON.stringify({
        plugin: [`https://user:${secret}@example.test/x?token=${secret}`, `\${env:${secret}}`],
        mcp: {
          [secret]: {
            command: "/bin/tool",
            args: ["--token", secret],
            env: { TOKEN: secret },
            headers: { Authorization: secret },
          },
        },
      }),
    )
    const report = parseAndRedactExtensionInventoryWire(encodeWire([{ path: "opencode.json", content }]))
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(report).toMatchObject({ state: "inactive", verification: "not_verified" })
  })

  test("rejects prototype-mutating JSONC keys instead of discovering inherited extensions", () => {
    for (const content of [
      '{"__proto__":{"plugin":["inherited"]}}',
      '{"mcp":{"candidate":{"constructor":{"command":"unsafe"}}}}',
      '{"prototype":{"mcp":{"unsafe":{"url":"https://example.test"}}}}',
    ]) {
      expect(() =>
        parseAndRedactExtensionInventoryWire(
          encodeWire([{ path: "opencode.jsonc", content: new TextEncoder().encode(content) }]),
        ),
      ).toThrow("protocol was rejected")
    }
  })

  test("persists no digest oracle for different same-length secrets", async () => {
    const digests: string[] = []
    for (const [index, secret] of ["SECRET_ALPHA_01", "SECRET_BRAVO_02"].entries()) {
      const workspace = await temp(`secret-${index}-workspace`)
      const state = await temp(`secret-${index}-state`)
      writeFileSync(join(workspace, "opencode.json"), JSON.stringify({ plugin: [`https://example.test/?token=${secret}`] }))
      const fixture = await operationFixture(workspace, state)
      const result = await executeExtensionInventory(fixture.input, { now: fixture.now })
      if (!result.receiptID) throw new Error("Missing receipt")
      const receiptID = parseReceiptID(result.receiptID)
      if (!receiptID.ok) throw new Error("Invalid receipt ID")
      const entry = await runWithReceiptSpool(fixture.input.spoolFilename, (spool) =>
        Effect.gen(function* () {
          yield* spool.initialize()
          return yield* spool.get(receiptID.value)
        }),
      )
      if (!entry) throw new Error("Missing receipt entry")
      digests.push(entry.receipt.output.digest)
    }
    expect(digests[0]).toBe(digests[1])
  })

  test("recovers an expired claimed operation as effect unknown without retrying", async () => {
    const workspace = await temp("recovery-workspace")
    const state = await temp("recovery-state")
    writeFileSync(join(workspace, "opencode.json"), "{}")
    const fixture = await operationFixture(workspace, state)
    let roots = 0
    let processes = 0
    const failure = await executeExtensionInventory(fixture.input, {
      injectFault: async (point) => {
        if (point === "after_claim_before_effect") throw new Error("simulated crash")
      },
      onWorkspaceRootOpened: () => roots++,
      onProcessEntered: () => processes++,
      now: fixture.now,
    }).catch((cause: unknown) => cause)
    expect(failure).toMatchObject({ code: "state_unavailable" })
    const staleSnapshot = join(state, `.astra-extension-helper-${fixture.input.operationID}`)
    writeFileSync(staleSnapshot, "stale private helper snapshot")
    chmodSync(staleSnapshot, 0o500)
    const held = `${workspace}-held`
    renameSync(workspace, held)
    const recovered = await recoverExtensionInventory(fixture.input, {
      now: () => fixture.now() + 61_000,
    })
    expect(recovered.status).toBe("effect_unknown")
    expect(roots).toBe(0)
    expect(processes).toBe(0)
    expect(existsSync(staleSnapshot)).toBe(false)
    renameSync(held, workspace)
  })
})

async function operationFixture(
  workspace: string,
  state: string,
  decision: "approved" | "rejected" = "approved",
  executable = helperPath,
) {
  const report = await scanWorkspace(workspace)
  if (report.completeness !== "complete") throw new Error(report.blockers.join(","))
  const helper = await inspectTrustedExtensionInventoryHelper(executable)
  const operationID = randomUUID()
  const base = Date.now()
  const policyAskedAt = new Date(base).toISOString()
  const proposal = proposeExtensionInventory({
    operationID,
    policyAskedAt,
    session: { mode: "activate-once", report },
    helper,
  })
  const input: ExecuteExtensionInventoryInput = {
    operationID,
    policyAskedAt,
    session: { mode: "activate-once", report },
    helper,
    proposal,
    consent:
      decision === "approved"
        ? { decision, decidedAt: new Date(base + 1).toISOString() }
        : { decision, decidedAt: new Date(base + 1).toISOString(), reason: "user_rejected" },
    recordingStartedAt: new Date(base + 2).toISOString(),
    ledgerFilename: join(state, "operation.sqlite"),
    spoolFilename: join(state, "receipt.sqlite"),
  }
  return { input, now: () => base + 3 }
}

async function temp(name: string) {
  const path = await mkdtemp(join(tmpdir(), `astra-extension-${name}-`))
  fixtures.push(path)
  return resolve(path)
}

function encodeWire(records: ReadonlyArray<Readonly<{ path: string; content: Uint8Array }>>) {
  const chunks: Buffer[] = [Buffer.from("ASTRXI01"), u32(records.length)]
  for (const record of records) {
    const path = Buffer.from(record.path)
    const content = Buffer.from(record.content)
    chunks.push(
      u16(path.byteLength),
      path,
      u64(1n),
      u64(2n),
      u64(0o100600n),
      u64(1n),
      u64(BigInt(content.byteLength)),
      new Bun.CryptoHasher("sha256").update(content).digest(),
      u32(content.byteLength),
      content,
    )
  }
  return Buffer.concat(chunks)
}

function u16(value: number) {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}

function u32(value: number) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function u64(value: bigint) {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(value)
  return bytes
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
