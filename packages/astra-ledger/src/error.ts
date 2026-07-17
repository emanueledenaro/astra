import type { OperationEvent, OperationState } from "@astra/domain/operation"

export class LedgerStorageError extends Error {
  readonly _tag = "LedgerStorageError"

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

export class LedgerCorruptionError extends Error {
  readonly _tag = "LedgerCorruptionError"

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = this._tag
  }
}

export class OperationEventValidationError extends Error {
  readonly _tag = "OperationEventValidationError"

  constructor(
    message: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = this._tag
  }
}

export class OperationTransitionError extends Error {
  readonly _tag = "OperationTransitionError"

  constructor(
    readonly state: OperationState | null,
    readonly event: OperationEvent,
    readonly code: "illegal_transition" | "terminal_state",
  ) {
    super(`Cannot apply ${event} from ${state ?? "no state"}: ${code}`)
    this.name = this._tag
  }
}

export class OperationConcurrencyError extends Error {
  readonly _tag = "OperationConcurrencyError"

  constructor(
    readonly expectedState: OperationState | null,
    readonly expectedSequence: number,
    readonly actualState: OperationState | null,
    readonly actualSequence: number,
  ) {
    super(
      `Operation compare-and-swap failed: expected ${expectedState ?? "no state"}@${expectedSequence}, received ${actualState ?? "no state"}@${actualSequence}`,
    )
    this.name = this._tag
  }
}

export class EventConflictError extends Error {
  readonly _tag = "EventConflictError"

  constructor(readonly eventID: string) {
    super(`Event ${eventID} already exists with different facts`)
    this.name = this._tag
  }
}

export class AdmissionConflictError extends Error {
  readonly _tag = "AdmissionConflictError"

  constructor(readonly admissionKey: string) {
    super(`Admission key ${admissionKey} already belongs to another operation`)
    this.name = this._tag
  }
}

export class LedgerReadLimitError extends Error {
  readonly _tag = "LedgerReadLimitError"

  constructor(readonly limit: number) {
    super(`Ledger read limit must be between 1 and 256, received ${limit}`)
    this.name = this._tag
  }
}

export class LedgerNotInitializedError extends Error {
  readonly _tag = "LedgerNotInitializedError"

  constructor() {
    super("Operation ledger is not initialized")
    this.name = this._tag
  }
}

export class LedgerInjectedFault extends Error {
  readonly _tag = "LedgerInjectedFault"

  constructor(readonly point: LedgerFaultPoint) {
    super(`Injected ledger fault at ${point}`)
    this.name = this._tag
  }
}

export class DispatchClaimError extends Error {
  readonly _tag = "DispatchClaimError"

  constructor(
    readonly dispatchRequestID: string,
    readonly code:
      | "not_found"
      | "request_mismatch"
      | "already_claimed"
      | "authorization_expired"
      | "specialized_claim_required",
  ) {
    super(`Cannot claim dispatch ${dispatchRequestID}: ${code}`)
    this.name = this._tag
  }
}

export class CapabilityConflictError extends Error {
  readonly _tag = "CapabilityConflictError"

  constructor(readonly capabilityGrantID: string) {
    super(`Capability grant ${capabilityGrantID} is already reserved or consumed`)
    this.name = this._tag
  }
}

export type LedgerFaultPoint =
  | "after_event_insert"
  | "after_projection_update"
  | "after_dispatch_event_insert"
  | "after_outbox_insert"
  | "after_claim_insert"
  | "after_claim_event_insert"
  | "after_capability_consumption"

export type OperationLedgerError =
  | LedgerStorageError
  | LedgerCorruptionError
  | OperationEventValidationError
  | OperationTransitionError
  | OperationConcurrencyError
  | EventConflictError
  | AdmissionConflictError
  | LedgerReadLimitError
  | LedgerNotInitializedError
  | LedgerInjectedFault
  | DispatchClaimError
  | CapabilityConflictError

export function mapStorageError(message: string) {
  return (cause: unknown): OperationLedgerError =>
    isOperationLedgerError(cause) ? cause : new LedgerStorageError(message, cause)
}

function isOperationLedgerError(cause: unknown): cause is OperationLedgerError {
  return (
    cause instanceof LedgerStorageError ||
    cause instanceof LedgerCorruptionError ||
    cause instanceof OperationEventValidationError ||
    cause instanceof OperationTransitionError ||
    cause instanceof OperationConcurrencyError ||
    cause instanceof EventConflictError ||
    cause instanceof AdmissionConflictError ||
    cause instanceof LedgerReadLimitError ||
    cause instanceof LedgerNotInitializedError ||
    cause instanceof LedgerInjectedFault ||
    cause instanceof DispatchClaimError ||
    cause instanceof CapabilityConflictError
  )
}
