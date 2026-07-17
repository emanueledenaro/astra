import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { MessageID, SessionID } from "../../src/session/schema"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const context = (calls: { ask: number; metadata: number }) => ({
  sessionID: SessionID.make("ses_astra-safe-start-file-mutation"),
  messageID: MessageID.make("msg_astra-safe-start-file-mutation"),
  callID: "call_astra-safe-start-file-mutation",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  ask: () =>
    Effect.sync(() => {
      calls.ask++
    }),
  metadata: () =>
    Effect.sync(() => {
      calls.metadata++
    }),
})

function expectBlocked(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  expect(Cause.squash(exit.cause)).toMatchObject({
    message: expect.stringContaining("Astra Operation Kernel"),
  })
}

function observeMethod<T extends object, K extends keyof T>(target: T, key: K, onCall: () => void) {
  const original = target[key]
  if (typeof original !== "function") throw new TypeError(`Expected ${String(key)} to be a function`)
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  const method = original as (...args: unknown[]) => unknown
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      onCall()
      return method.apply(target, args)
    },
  })
  return () => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  }
}

describe("Astra Safe Start file mutation boundary", () => {
  it.instance(
    "blocks write, edit, and apply_patch before permission or workspace effects",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const format = yield* Format.Service
        const lsp = yield* LSP.Service
        const events = yield* EventV2Bridge.Service
        const existing = path.join(test.directory, "existing.txt")
        const createdByWrite = path.join(test.directory, "write.txt")
        const createdByPatch = path.join(test.directory, "patch.txt")
        const formatterSentinel = `${existing}.formatter-ran`
        const original = "original\n"
        yield* fs.writeFileString(existing, original)
        const calls = { ask: 0, metadata: 0 }
        const serviceCalls = { filesystem: 0, formatter: 0, lsp: 0, events: 0 }

        const exits = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = process.env.ASTRA_SAFE_START
            const restores = [
              observeMethod(fs, "existsSafe", () => serviceCalls.filesystem++),
              observeMethod(fs, "stat", () => serviceCalls.filesystem++),
              observeMethod(fs, "readFile", () => serviceCalls.filesystem++),
              observeMethod(fs, "readFileString", () => serviceCalls.filesystem++),
              observeMethod(fs, "writeWithDirs", () => serviceCalls.filesystem++),
              observeMethod(fs, "remove", () => serviceCalls.filesystem++),
              observeMethod(format, "file", () => serviceCalls.formatter++),
              observeMethod(lsp, "touchFile", () => serviceCalls.lsp++),
              observeMethod(lsp, "diagnostics", () => serviceCalls.lsp++),
              observeMethod(events, "publish", () => serviceCalls.events++),
            ]
            process.env.ASTRA_SAFE_START = "1"
            return { previous, restores }
          }),
          () =>
            Effect.gen(function* () {
              const writeDefinition = yield* WriteTool
              const editDefinition = yield* EditTool
              const applyPatchDefinition = yield* ApplyPatchTool
              const write = yield* writeDefinition.init()
              const edit = yield* editDefinition.init()
              const applyPatch = yield* applyPatchDefinition.init()
              const ctx = context(calls)
              return yield* Effect.all([
                write.execute({ filePath: createdByWrite, content: "write\n" }, ctx).pipe(Effect.exit),
                edit.execute({ filePath: existing, oldString: "original", newString: "edited" }, ctx).pipe(Effect.exit),
                applyPatch
                  .execute(
                    {
                      patchText: "*** Begin Patch\n*** Add File: patch.txt\n+patch\n*** End Patch",
                    },
                    ctx,
                  )
                  .pipe(Effect.exit),
              ])
            }),
          ({ previous, restores }) =>
            Effect.sync(() => {
              try {
                restores.reverse().forEach((restore) => restore())
              } finally {
                if (previous === undefined) delete process.env.ASTRA_SAFE_START
                else process.env.ASTRA_SAFE_START = previous
              }
            }),
        )

        exits.forEach(expectBlocked)
        expect(calls).toEqual({ ask: 0, metadata: 0 })
        expect(serviceCalls).toEqual({ filesystem: 0, formatter: 0, lsp: 0, events: 0 })
        expect(yield* fs.readFileString(existing)).toBe(original)
        expect(yield* fs.existsSafe(createdByWrite)).toBe(false)
        expect(yield* fs.existsSafe(createdByPatch)).toBe(false)
        expect(yield* fs.existsSafe(formatterSentinel)).toBe(false)
      }),
    {
      config: {
        formatter: {
          astra_safe_start_sentinel: {
            extensions: [".txt"],
            command: [
              process.execPath,
              "-e",
              'require("fs").writeFileSync(`${process.argv[1]}.formatter-ran`, "ran")',
              "$FILE",
            ],
          },
        },
      },
    },
  )
})
