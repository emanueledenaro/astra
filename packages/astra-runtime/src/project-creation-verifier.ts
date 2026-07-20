import type { ProjectCreationPreview, ProjectParentAuthority } from "@astra/domain/project-creation-control"
import type { ContentDigest } from "@astra/domain/operation-contract"
import {
  expectedProjectScaffoldTreeDigest,
  verifyProjectScaffoldTreeInternal,
} from "./project-creation-verifier-internal"

export type ProjectScaffoldTreeVerification = Readonly<{
  status: "verified" | "failed" | "unknown"
  snapshotDigest: ContentDigest
  reason: string | null
}>

/** Traverses the final project from no-follow directory descriptors and proves exact bounded post-state. */
export async function verifyProjectScaffoldTree(
  authority: ProjectParentAuthority,
  preview: ProjectCreationPreview,
  targetIdentity: Readonly<{ device: string; inode: string }>,
): Promise<ProjectScaffoldTreeVerification> {
  return verifyProjectScaffoldTreeInternal(authority, preview, targetIdentity)
}

export function expectedTreeDigest(preview: ProjectCreationPreview): ContentDigest {
  return expectedProjectScaffoldTreeDigest(preview)
}
