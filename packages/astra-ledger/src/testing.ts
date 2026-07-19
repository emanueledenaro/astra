import { Effect } from "effect"
import { LedgerInjectedFault, type LedgerFaultPoint } from "./error"
import { createVerificationLedgerFactory, makeOperationLedgerInternal } from "./ledger"

const fixedTestClock = () => "2026-07-17T10:00:04.000Z"
const makeVerificationLedger = createVerificationLedgerFactory()

export function makeOperationLedgerWithFault(point: LedgerFaultPoint) {
  return makeOperationLedgerInternal(
    (candidate) => (candidate === point ? Effect.fail(new LedgerInjectedFault(candidate)) : Effect.void),
    fixedTestClock,
  )
}

export function makeOperationLedgerWithDeferredFault(point: LedgerFaultPoint, skipMatches: number) {
  let matches = 0
  return makeOperationLedgerInternal((candidate) => {
    if (candidate !== point) return Effect.void
    if (matches++ < skipMatches) return Effect.void
    return Effect.fail(new LedgerInjectedFault(candidate))
  }, fixedTestClock)
}

export function makeOperationLedgerWithClock(clock: () => string) {
  return makeOperationLedgerInternal(() => Effect.void, clock)
}

export function makeVerificationLedgerWithFault(point: LedgerFaultPoint) {
  return makeVerificationLedger(
    (candidate) => (candidate === point ? Effect.fail(new LedgerInjectedFault(candidate)) : Effect.void),
    fixedTestClock,
  )
}

export function makeVerificationLedgerWithClock(clock: () => string) {
  return makeVerificationLedger(() => Effect.void, clock)
}
