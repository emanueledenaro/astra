import { Effect } from "effect"
import { LedgerInjectedFault, type LedgerFaultPoint } from "./error"
import { makeOperationLedgerInternal } from "./ledger"

const fixedTestClock = () => "2026-07-17T10:00:04.000Z"

export function makeOperationLedgerWithFault(point: LedgerFaultPoint) {
  return makeOperationLedgerInternal(
    (candidate) => (candidate === point ? Effect.fail(new LedgerInjectedFault(candidate)) : Effect.void),
    fixedTestClock,
  )
}

export function makeOperationLedgerWithClock(clock: () => string) {
  return makeOperationLedgerInternal(() => Effect.void, clock)
}
