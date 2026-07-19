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

export class ReceiptIngestionError extends Error {
  readonly _tag = "ReceiptIngestionError"

  constructor(
    readonly receiptID: string,
    readonly code:
      | "dispatch_not_found"
      | "claim_not_accepted"
      | "binding_mismatch"
      | "stale_claim"
      | "specialized_ingestion_required",
  ) {
    super(`Cannot ingest receipt ${receiptID}: ${code}`)
    this.name = this._tag
  }
}

export class ReceiptConflictError extends Error {
  readonly _tag = "ReceiptConflictError"

  constructor(readonly receiptID: string) {
    super(`Receipt ${receiptID} conflicts with immutable ledger facts`)
    this.name = this._tag
  }
}

export class ClaimUncertaintyError extends Error {
  readonly _tag = "ClaimUncertaintyError"

  constructor(
    readonly uncertaintyID: string,
    readonly code:
      | "dispatch_not_found"
      | "claim_not_accepted"
      | "receipt_already_ingested"
      | "binding_mismatch"
      | "claim_still_active"
      | "specialized_recording_required",
  ) {
    super(`Cannot record claim uncertainty ${uncertaintyID}: ${code}`)
    this.name = this._tag
  }
}

export class ClaimUncertaintyConflictError extends Error {
  readonly _tag = "ClaimUncertaintyConflictError"

  constructor(readonly uncertaintyID: string) {
    super(`Claim uncertainty ${uncertaintyID} conflicts with immutable ledger facts`)
    this.name = this._tag
  }
}

export class EvidenceIngestionError extends Error {
  readonly _tag = "EvidenceIngestionError"

  constructor(
    readonly evidenceID: string,
    readonly code:
      | "receipt_not_found"
      | "effect_not_observed"
      | "binding_mismatch"
      | "criteria_mismatch"
      | "future_observation"
      | "specialized_ingestion_required",
  ) {
    super(`Cannot ingest verification evidence ${evidenceID}: ${code}`)
    this.name = this._tag
  }
}

export class EvidenceConflictError extends Error {
  readonly _tag = "EvidenceConflictError"

  constructor(readonly evidenceID: string) {
    super(`Verification evidence ${evidenceID} conflicts with immutable ledger facts`)
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
  | "after_receipt_event_insert"
  | "after_receipt_insert"
  | "after_uncertainty_event_insert"
  | "after_uncertainty_insert"
  | "after_verification_started_insert"
  | "after_verification_terminal_insert"
  | "after_evidence_insert"

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
  | ReceiptIngestionError
  | ReceiptConflictError
  | ClaimUncertaintyError
  | ClaimUncertaintyConflictError
  | EvidenceIngestionError
  | EvidenceConflictError

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
    cause instanceof CapabilityConflictError ||
    cause instanceof ReceiptIngestionError ||
    cause instanceof ReceiptConflictError ||
    cause instanceof ClaimUncertaintyError ||
    cause instanceof ClaimUncertaintyConflictError ||
    cause instanceof EvidenceIngestionError ||
    cause instanceof EvidenceConflictError
  )
}
