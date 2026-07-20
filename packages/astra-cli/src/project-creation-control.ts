import { randomBytes } from "node:crypto"
import { join } from "node:path"
import {
  makeProjectCreationPreview,
  parseProjectCreationDraft,
  type ProjectCreationDraft,
  type ProjectCreationPreview,
  type ProjectParentAuthority,
} from "@astra/domain/project-creation-control"
import {
  parseAstraProjectCreationDetailsDecision,
  parseAstraProjectCreationResultDecision,
  parseAstraProjectCreationReviewDecision,
  type AstraProjectCreationProposal,
  type AstraProjectCreationRequest,
  type AstraProjectCreationResult,
} from "@astra/domain/project-creation-ui"
import {
  executeDurableProjectScaffold,
  verifyDurableProjectScaffold,
  type DurableProjectScaffoldInput,
} from "@astra/runtime"
import {
  captureProjectParentAuthority,
  type ProjectParentAuthorityCaptureResult,
} from "@astra/runtime/project-parent-authority"

const previewLifetimeMilliseconds = 10 * 60 * 1_000

type ProjectCreationKernelResult = Readonly<{
  operationID: string
  status: "denied_without_effect" | "effect_observed" | "failed_without_effect" | "reconciliation_required" | "verified"
  receiptID: string | null
  evidence: Readonly<{ evidenceID: string }> | null
}>

export type GuidedProjectCreationOutcome =
  | Readonly<{ kind: "launchpad" }>
  | Readonly<{ kind: "open-workspace"; path: string }>
  | Readonly<{ kind: "exit"; exitCode: 0 | 1 }>
  | Readonly<{ kind: "failed"; exitCode: 1 }>

type GuidedProjectCreationDependencies = Readonly<{
  collectDetails: () => Promise<unknown>
  captureAuthority: (
    parentPath: string,
    targetName: string,
    observedAt: string,
  ) => Promise<ProjectParentAuthorityCaptureResult>
  reviewProposal: (proposal: AstraProjectCreationProposal) => Promise<unknown>
  withProgress: <Value>(proposal: AstraProjectCreationProposal, operation: () => Promise<Value>) => Promise<Value>
  execute: (input: DurableProjectScaffoldInput) => Promise<ProjectCreationKernelResult>
  verify: (input: DurableProjectScaffoldInput) => Promise<ProjectCreationKernelResult>
  showResult: (result: AstraProjectCreationResult) => Promise<unknown>
  now: () => string
  nonce: () => string
}>

/** Internal constructor keeps test seams outside the package export map. */
export function createGuidedProjectCreationControlInternal(dependencies: GuidedProjectCreationDependencies) {
  return Object.freeze({
    run: async (): Promise<GuidedProjectCreationOutcome> => {
      const details = parseAstraProjectCreationDetailsDecision(await dependencies.collectDetails())
      if (!details.ok) return { kind: "failed", exitCode: 1 }
      if (details.value.kind === "cancel") return { kind: "launchpad" }

      const request = details.value.request
      const captured = await dependencies.captureAuthority(request.parentPath, request.name, dependencies.now())
      if (captured.status === "blocked") {
        return presentResult(dependencies, {
          schemaVersion: 1,
          status: "failed_without_effect",
          targetPath: join(request.parentPath, request.name),
          operationID: null,
          receiptID: null,
          evidenceID: null,
          detail: `Project creation blocked before dispatch: ${captured.reason.replaceAll("_", " ")}.`,
        })
      }

      const draft = createTypeScriptBunProjectDraft(request)
      const createdAt = dependencies.now()
      const preview = makeProjectCreationPreview(
        captured.authority,
        draft,
        createdAt,
        dependencies.nonce(),
        new Date(Date.parse(createdAt) + previewLifetimeMilliseconds).toISOString(),
      )
      const proposal = projectProjectCreationProposal(captured.authority, draft, preview)
      const reviewed = parseAstraProjectCreationReviewDecision(await dependencies.reviewProposal(proposal))
      if (!reviewed.ok) return { kind: "failed", exitCode: 1 }
      if (reviewed.value.kind === "cancel") return { kind: "launchpad" }
      if (reviewed.value.proposalDigest !== proposal.proposalDigest) return { kind: "failed", exitCode: 1 }

      const decidedAt = dependencies.now()
      const input: DurableProjectScaffoldInput = {
        authority: captured.authority,
        draft,
        preview,
        decision: {
          proposalDigest: preview.proposalDigest,
          nonce: preview.nonce,
          decision: reviewed.value.kind === "approve" ? "approved" : "rejected",
          decidedAt,
        },
        recordingStartedAt: dependencies.now(),
      }
      if (reviewed.value.kind === "reject") {
        try {
          return presentResult(dependencies, projectCreationResult(await dependencies.execute(input), preview.targetPath))
        } catch {
          return presentResult(dependencies, failureResult(preview.targetPath, "failed_without_effect", null))
        }
      }

      let observed: ProjectCreationKernelResult | null = null
      try {
        const result = await dependencies.withProgress(proposal, async () => {
          observed = await dependencies.execute(input)
          if (observed.status !== "effect_observed") return observed
          return dependencies.verify(input)
        })
        return presentResult(dependencies, projectCreationResult(result, preview.targetPath))
      } catch (cause) {
        const status = observed || !isKnownNoEffectFailure(cause) ? "reconciliation_required" : "failed_without_effect"
        return presentResult(dependencies, failureResult(preview.targetPath, status, observed))
      }
    },
  })
}

/** Builds trusted product data only; providers, extensions, workspaces, and environment cannot alter it. */
export function createTypeScriptBunProjectDraft(requestInput: unknown): ProjectCreationDraft {
  const details = parseAstraProjectCreationDetailsDecision({ kind: "submit", request: requestInput })
  if (!details.ok || details.value.kind !== "submit") throw new TypeError("Invalid TypeScript Bun project request")
  const request = details.value.request
  const draft = parseProjectCreationDraft({
    name: request.name,
    parentPath: request.parentPath,
    objective: request.objective,
    stack: request.stack,
    files: [
      {
        path: "README.md",
        content: `# ${request.name}\n\n${request.objective}\n\nBuilt with Astra using the typescript-bun template.\n`,
      },
      { path: ".gitignore", content: "node_modules/\n.env\n" },
      {
        path: "package.json",
        content: `${JSON.stringify({ name: request.name, private: true, type: "module" }, null, 2)}\n`,
      },
      {
        path: "tsconfig.json",
        content: `${JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: "ESNext",
              module: "Preserve",
              moduleResolution: "bundler",
              noEmit: true,
            },
            include: ["src"],
          },
          null,
          2,
        )}\n`,
      },
      { path: "src/index.ts", content: `export const projectName = ${JSON.stringify(request.name)}\n` },
    ],
    initializeGit: false,
  })
  if (!draft.ok) throw new TypeError(`Trusted project template is invalid: ${draft.reason}`)
  return draft.value
}

/** Projects only a cryptographically rebound preview; raw file contents never cross into the renderer. */
export function projectProjectCreationProposal(
  authority: ProjectParentAuthority,
  draft: ProjectCreationDraft,
  preview: ProjectCreationPreview,
): AstraProjectCreationProposal {
  const rebound = makeProjectCreationPreview(authority, draft, preview.createdAt, preview.nonce, preview.expiresAt)
  if (rebound.proposalDigest !== preview.proposalDigest) {
    throw new TypeError("The project preview is not bound to the trusted draft")
  }
  return {
    schemaVersion: 1,
    boundary: rebound.boundary,
    targetPath: rebound.targetPath,
    targetName: rebound.targetName,
    objective: draft.objective,
    stack: "typescript-bun",
    files: rebound.files,
    totalBytes: rebound.totalBytes,
    initializeGit: false,
    installsDependencies: false,
    usesNetwork: false,
    proposalDigest: rebound.proposalDigest,
  }
}

/** Production entry binds only sealed Task 3A and public Task 3B APIs. */
export async function runGuidedProjectCreation(): Promise<GuidedProjectCreationOutcome> {
  const moduleName = ["@opencode-ai/tui", "astra/project-creation-mode"].join("/")
  const loaded: unknown = await import(moduleName)
  if (!isProjectCreationTuiModule(loaded)) return { kind: "failed", exitCode: 1 }
  return createGuidedProjectCreationControlInternal({
    collectDetails: loaded.runAstraProjectCreationDetailsMode,
    captureAuthority: captureProjectParentAuthority,
    reviewProposal: loaded.runAstraProjectCreationReviewMode,
    withProgress: loaded.withAstraProjectCreationProgress,
    execute: executeDurableProjectScaffold,
    verify: verifyDurableProjectScaffold,
    showResult: loaded.runAstraProjectCreationResultMode,
    now: () => new Date().toISOString(),
    nonce: () => randomBytes(16).toString("hex"),
  }).run()
}

async function presentResult(
  dependencies: GuidedProjectCreationDependencies,
  result: AstraProjectCreationResult,
): Promise<GuidedProjectCreationOutcome> {
  const decision = parseAstraProjectCreationResultDecision(await dependencies.showResult(result), result)
  if (!decision.ok) return { kind: "failed", exitCode: 1 }
  if (decision.value.kind === "open-project") return { kind: "open-workspace", path: decision.value.targetPath }
  if (decision.value.kind === "launchpad") return { kind: "launchpad" }
  return result.status === "verified" || result.status === "denied_without_effect"
    ? { kind: "exit", exitCode: 0 }
    : { kind: "exit", exitCode: 1 }
}

function projectCreationResult(result: ProjectCreationKernelResult, targetPath: string): AstraProjectCreationResult {
  return {
    schemaVersion: 1,
    status: result.status,
    targetPath,
    operationID: result.operationID,
    receiptID: result.receiptID,
    evidenceID: result.evidence?.evidenceID ?? null,
    detail: resultDetail(result.status),
  }
}

function failureResult(
  targetPath: string,
  status: "failed_without_effect" | "reconciliation_required",
  observed: ProjectCreationKernelResult | null,
): AstraProjectCreationResult {
  return {
    schemaVersion: 1,
    status,
    targetPath,
    operationID: observed?.operationID ?? null,
    receiptID: observed?.receiptID ?? null,
    evidenceID: null,
    detail: resultDetail(status),
  }
}

function resultDetail(status: AstraProjectCreationResult["status"]) {
  if (status === "verified") return "The independent verifier matched the exact project tree."
  if (status === "effect_observed") return "The scaffold effect was observed but is not independently verified."
  if (status === "denied_without_effect") return "The exact proposal was rejected and no host effect was dispatched."
  if (status === "failed_without_effect") return "Project creation stopped before any host effect was observed."
  return "The result is uncertain and requires reconciliation before Astra can continue."
}

function isKnownNoEffectFailure(cause: unknown) {
  if (typeof cause !== "object" || cause === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(cause, "code")
  return Boolean(descriptor && "value" in descriptor && descriptor.value === "invalid_input")
}

type ProjectCreationTuiModule = Readonly<{
  runAstraProjectCreationDetailsMode: GuidedProjectCreationDependencies["collectDetails"]
  runAstraProjectCreationReviewMode: GuidedProjectCreationDependencies["reviewProposal"]
  withAstraProjectCreationProgress: GuidedProjectCreationDependencies["withProgress"]
  runAstraProjectCreationResultMode: GuidedProjectCreationDependencies["showResult"]
}>

function isProjectCreationTuiModule(input: unknown): input is ProjectCreationTuiModule {
  return (
    typeof input === "object" &&
    input !== null &&
    "runAstraProjectCreationDetailsMode" in input &&
    typeof input.runAstraProjectCreationDetailsMode === "function" &&
    "runAstraProjectCreationReviewMode" in input &&
    typeof input.runAstraProjectCreationReviewMode === "function" &&
    "withAstraProjectCreationProgress" in input &&
    typeof input.withAstraProjectCreationProgress === "function" &&
    "runAstraProjectCreationResultMode" in input &&
    typeof input.runAstraProjectCreationResultMode === "function"
  )
}
