export type AstraProviderOperationView = Readonly<{
  state:
    | "awaiting_decision"
    | "approving"
    | "rejecting"
    | "in_progress"
    | "denied_without_effect"
    | "response_observed_not_verified"
    | "reconciliation_required"
  statusLabel: string
  operationID: string
  providerID: string
  providerName: string
  modelID: string
  credentialProfile: string
  destination: string
  payloadBytes: number
  priorTurns: number
  historyBytes: number
  retention: string
  hostBoundary: string
  networkBoundary: string
  capabilityDigest: string
  headerNames: ReadonlyArray<string>
  accountFingerprint: string
  assurance: "NOT VERIFIED"
  decisionRequired: boolean
}>
