import { Effect } from "effect"
import { LedgerInjectedFault, type LedgerFaultPoint } from "./error"
import { makeOperationLedgerInternal } from "./ledger"

export function makeOperationLedgerWithFault(point: LedgerFaultPoint) {
  return makeOperationLedgerInternal((candidate) =>
    candidate === point ? Effect.fail(new LedgerInjectedFault(candidate)) : Effect.void,
  )
}
