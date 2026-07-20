export {
  ReceiptSpoolConflictError,
  ReceiptSpoolCorruptionError,
  ReceiptSpoolInjectedFault,
  ReceiptSpoolReadLimitError,
  ReceiptSpoolStorageError,
  ReceiptSpoolValidationError,
} from "./error"

export { makeReceiptSpool } from "./spool"

export type { ReceiptSpoolError, ReceiptSpoolFaultPoint } from "./error"
export type {
  PutReceiptResult,
  ReceiptAcknowledgement,
  ReceiptSpool,
  ReceiptSpoolClock,
  ReceiptSpoolDurability,
  SpoolEntry,
} from "./spool"
