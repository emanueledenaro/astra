import type { Stats } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import type { ProjectParentAuthority } from "@astra/domain/project-creation-control"
import {
  captureProjectParentAuthorityInternal,
  revalidateProjectParentAuthorityInternal,
} from "./project-parent-authority-internal"

export type ProjectParentAuthorityBlockReason =
  | "parent_path_not_absolute"
  | "target_name_invalid"
  | "observed_at_invalid"
  | "parent_unreadable"
  | "parent_is_symlink"
  | "parent_not_directory"
  | "parent_not_canonical"
  | "parent_identity_changed"
  | "target_already_exists"
  | "target_unreadable"
  | "target_appeared"
  | "target_mismatch"
  | "authority_invalid"

export type ProjectParentAuthorityCaptureResult =
  | Readonly<{ status: "complete"; authority: ProjectParentAuthority }>
  | Readonly<{ status: "blocked"; reason: ProjectParentAuthorityBlockReason }>

export type ProjectParentAuthorityRevalidationResult =
  | Readonly<{ status: "current"; authority: ProjectParentAuthority }>
  | Readonly<{ status: "blocked"; reason: ProjectParentAuthorityBlockReason }>

const filesystem = Object.freeze({
  lstat: (path: string): Promise<Stats> => lstat(path),
  realpath: (path: string): Promise<string> => realpath(path),
})

/** Captures one parent authority with the permanently bound read-only filesystem observer. */
export async function captureProjectParentAuthority(
  parentPath: string,
  targetName: string,
  observedAt = new Date().toISOString(),
): Promise<ProjectParentAuthorityCaptureResult> {
  return captureProjectParentAuthorityInternal(parentPath, targetName, observedAt, filesystem)
}

/** Revalidates one parent authority with the permanently bound read-only filesystem observer. */
export async function revalidateProjectParentAuthority(
  input: unknown,
): Promise<ProjectParentAuthorityRevalidationResult> {
  return revalidateProjectParentAuthorityInternal(input, filesystem)
}
