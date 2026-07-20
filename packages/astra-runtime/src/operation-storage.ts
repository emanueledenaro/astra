import { lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import type { OperationLedger } from "@astra/ledger"
import { makeOperationLedger } from "@astra/ledger"
import type { ReceiptSpool } from "@astra/executor"
import { makeReceiptSpool } from "@astra/executor"
import { createCoordinatorReceiptSpoolFactory } from "../../astra-executor/src/spool"
import { createCoordinatorLedgerFactory, createVerificationLedgerFactory } from "../../astra-ledger/src/ledger"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"

export class UnsafeOperationStateError extends Error {
  readonly _tag = "UnsafeOperationStateError"

  constructor(
    readonly code: "state_inside_workspace" | "unsafe_state_path" | "state_files_overlap",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

const makeCoordinatorLedger = createCoordinatorLedgerFactory()
const makeVerificationLedger = createVerificationLedgerFactory()
const makeCoordinatorReceiptSpool = createCoordinatorReceiptSpoolFactory()

export async function prepareOperationStateFiles(workspace: string, ledgerFilename: string, spoolFilename: string) {
  await assertSeparateSqliteFamilies(ledgerFilename, spoolFilename)
  await assertSafeStateFile(workspace, ledgerFilename)
  await assertSafeStateFile(workspace, spoolFilename)
  await mkdir(dirname(resolve(ledgerFilename)), { recursive: true })
  await mkdir(dirname(resolve(spoolFilename)), { recursive: true })
  await assertSeparateSqliteFamilies(ledgerFilename, spoolFilename)
  await assertSafeStateFile(workspace, ledgerFilename)
  await assertSafeStateFile(workspace, spoolFilename)
}

export async function assertSafeStateFile(workspace: string, filename: string) {
  const workspacePath = await realpath(workspace).catch((cause) => {
    throw new UnsafeOperationStateError("unsafe_state_path", "The workspace path cannot be canonicalized", cause)
  })
  const parentPath = await resolveUncreatedPath(dirname(resolve(filename)))
  if (isInside(workspacePath, parentPath)) {
    throw new UnsafeOperationStateError(
      "state_inside_workspace",
      "Durable Operation state resolves inside the workspace",
    )
  }

  for (const candidate of [filename, `${filename}-journal`, `${filename}-shm`, `${filename}-wal`]) {
    const facts = await optionalLstat(candidate)
    if (!facts) continue
    if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1) {
      throw new UnsafeOperationStateError(
        "unsafe_state_path",
        "A durable Operation state file or SQLite sidecar has an unsafe filesystem identity",
      )
    }
    if (isInside(workspacePath, await realpath(candidate))) {
      throw new UnsafeOperationStateError(
        "state_inside_workspace",
        "Durable Operation state resolves inside the workspace",
      )
    }
  }
}

export function runWithLedger<A, E>(filename: string, use: (ledger: OperationLedger) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* makeOperationLedger()
      return yield* use(ledger)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

export function runWithCoordinatorLedger<A, E>(
  filename: string,
  use: (ledger: Effect.Success<ReturnType<typeof makeCoordinatorLedger>>) => Effect.Effect<A, E>,
  clock: () => string = () => new Date().toISOString(),
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* makeCoordinatorLedger(clock)
      return yield* use(ledger)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

export function runWithVerificationLedger<A, E>(
  filename: string,
  use: (ledger: Effect.Success<ReturnType<typeof makeVerificationLedger>>) => Effect.Effect<A, E>,
  clock: () => string = () => new Date().toISOString(),
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* makeVerificationLedger(() => Effect.void, clock)
      return yield* use(ledger)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

export function runWithReceiptSpool<A, E>(filename: string, use: (spool: ReceiptSpool) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const spool = yield* makeReceiptSpool()
      return yield* use(spool)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

export function runWithCoordinatorReceiptSpool<A, E>(
  filename: string,
  use: (spool: Effect.Success<ReturnType<typeof makeCoordinatorReceiptSpool>>) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const spool = yield* makeCoordinatorReceiptSpool()
      return yield* use(spool)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
}

function isInside(root: string, candidatePath: string) {
  const candidate = relative(resolve(root), resolve(candidatePath))
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
}

async function resolveUncreatedPath(input: string) {
  let current = resolve(input)
  const missing: Array<string> = []
  while (true) {
    try {
      return resolve(await realpath(current), ...missing)
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT")) {
        throw new UnsafeOperationStateError("unsafe_state_path", "State parent cannot be canonicalized", cause)
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new UnsafeOperationStateError("unsafe_state_path", "No canonical state parent is available")
      }
      missing.unshift(basename(current))
      current = parent
    }
  }
}

async function assertSeparateSqliteFamilies(ledgerFilename: string, spoolFilename: string) {
  const ledgerFamily = await Promise.all(sqliteFamily(ledgerFilename).map(resolveUncreatedPath))
  const spoolFamily = new Set(await Promise.all(sqliteFamily(spoolFilename).map(resolveUncreatedPath)))
  if (ledgerFamily.some((candidate) => spoolFamily.has(candidate))) {
    throw new UnsafeOperationStateError(
      "state_files_overlap",
      "The ledger and receipt spool SQLite file families overlap",
    )
  }
}

function sqliteFamily(filename: string) {
  const base = resolve(filename)
  return [base, `${base}-journal`, `${base}-shm`, `${base}-wal`]
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return null
    throw new UnsafeOperationStateError("unsafe_state_path", "A durable Operation state path is unreadable", cause)
  }
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code
}
