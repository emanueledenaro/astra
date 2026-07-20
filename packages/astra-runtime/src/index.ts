export { createControlledWritePlan, demoMarkerName } from "./controlled-write-plan"
export {
  checkWorkspaceActivation,
  defaultWorkspacePreflightLimits,
  revalidateWorkspaceSnapshot,
  scanWorkspace,
} from "./workspace-preflight"

export type { ControlledWritePlan } from "./controlled-write-plan"
export type { WorkspaceActivationCheck, WorkspaceRevalidation } from "./workspace-preflight"
export {
  executeDurableProjectScaffold,
  recoverDurableProjectScaffold,
  verifyDurableProjectScaffold,
} from "./project-creation-coordinator"
export type {
  DurableProjectScaffoldInput,
  DurableProjectScaffoldResult,
} from "./project-creation-coordinator"
export { makeProjectScaffoldOperationFacts } from "./project-creation-operation-facts"
export { expectedTreeDigest, verifyProjectScaffoldTree } from "./project-creation-verifier"
export type { ProjectScaffoldTreeVerification } from "./project-creation-verifier"
export {
  classifyHostCommandObservation,
  executeHostCommand,
  hostExecutionBoundaryLabel,
  proposeHostCommand,
  recoverHostCommand,
} from "./host-command"
export type {
  DurableHostCommandResult,
  ExecuteHostCommandInput,
  HostCommandConsent,
  HostCommandPreview,
  HostCommandProcessObservation,
  HostCommandProposal,
  ProposeHostCommandInput,
} from "./host-command"
