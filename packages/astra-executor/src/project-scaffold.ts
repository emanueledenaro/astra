import type {
  ProjectCreationDraft,
  ProjectCreationPreview,
  ProjectParentAuthority,
} from "@astra/domain/project-creation-control"
import { executeProjectScaffoldInternal } from "./project-scaffold-internal"

export type ProjectScaffoldInput = Readonly<{
  authority: ProjectParentAuthority
  draft: ProjectCreationDraft
  preview: ProjectCreationPreview
}>

export type ProjectScaffoldDurableClaim = Readonly<{
  proposalDigest: string
  authorityDigest: string
  targetPath: string
}>

export type ProjectScaffoldClaimResult = "claimed" | "already_claimed" | "unavailable"

export type ProjectScaffoldExecutionResult =
  | Readonly<{
      status: "effect_observed"
      observationDigest: `sha256:${string}`
      targetIdentity: Readonly<{ device: string; inode: string }>
    }>
  | Readonly<{
      status: "failed_without_effect"
      reason: string
      proofDigest: `sha256:${string}`
    }>
  | Readonly<{
      status: "effect_unknown"
      reason: string
      observationDigest: `sha256:${string}`
    }>

export type ProjectScaffoldClaimProposal = (
  claim: ProjectScaffoldDurableClaim,
) => Promise<ProjectScaffoldClaimResult>

/** Executes one sealed create-only scaffold. No process, shell, or network adapter is available here. */
export async function executeProjectScaffold(
  input: ProjectScaffoldInput,
  claimProposal: ProjectScaffoldClaimProposal,
): Promise<ProjectScaffoldExecutionResult> {
  return executeProjectScaffoldInternal(input, claimProposal)
}
