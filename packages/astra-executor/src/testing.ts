import { Effect } from "effect"
import { ReceiptSpoolInjectedFault, type ReceiptSpoolFaultPoint } from "./error"
import { makeReceiptSpoolInternal } from "./spool"

const fixedClock = () => "2026-07-17T10:00:06.000Z"

export function makeReceiptSpoolWithFault(point: ReceiptSpoolFaultPoint) {
  return makeReceiptSpoolInternal(
    (candidate) => (candidate === point ? Effect.fail(new ReceiptSpoolInjectedFault(candidate)) : Effect.void),
    fixedClock,
  )
}

export function makeReceiptSpoolWithClock(clock: () => string) {
  return makeReceiptSpoolInternal(() => Effect.void, clock)
}
