export class ReceiptSpoolStorageError extends Error {
  readonly _tag = "ReceiptSpoolStorageError"

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

export class ReceiptSpoolCorruptionError extends Error {
  readonly _tag = "ReceiptSpoolCorruptionError"

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

export class ReceiptSpoolValidationError extends Error {
  readonly _tag = "ReceiptSpoolValidationError"

  constructor(
    message: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = this._tag
  }
}

export class ReceiptSpoolConflictError extends Error {
  readonly _tag = "ReceiptSpoolConflictError"

  constructor(readonly receiptID: string) {
    super(`Receipt ${receiptID} conflicts with durable spool facts`)
    this.name = this._tag
  }
}

export class ReceiptSpoolReadLimitError extends Error {
  readonly _tag = "ReceiptSpoolReadLimitError"

  constructor(readonly limit: number) {
    super(`Receipt spool read limit must be between 1 and 256, received ${limit}`)
    this.name = this._tag
  }
}

export class ReceiptSpoolInjectedFault extends Error {
  readonly _tag = "ReceiptSpoolInjectedFault"

  constructor(readonly point: ReceiptSpoolFaultPoint) {
    super(`Injected receipt spool fault at ${point}`)
    this.name = this._tag
  }
}

export type ReceiptSpoolFaultPoint = "after_receipt_insert" | "after_acknowledgement_insert"

export type ReceiptSpoolError =
  | ReceiptSpoolStorageError
  | ReceiptSpoolCorruptionError
  | ReceiptSpoolValidationError
  | ReceiptSpoolConflictError
  | ReceiptSpoolReadLimitError
  | ReceiptSpoolInjectedFault

export function mapSpoolStorageError(message: string) {
  return (cause: unknown): ReceiptSpoolError =>
    isReceiptSpoolError(cause) ? cause : new ReceiptSpoolStorageError(message, cause)
}

function isReceiptSpoolError(cause: unknown): cause is ReceiptSpoolError {
  return (
    cause instanceof ReceiptSpoolStorageError ||
    cause instanceof ReceiptSpoolCorruptionError ||
    cause instanceof ReceiptSpoolValidationError ||
    cause instanceof ReceiptSpoolConflictError ||
    cause instanceof ReceiptSpoolReadLimitError ||
    cause instanceof ReceiptSpoolInjectedFault
  )
}
