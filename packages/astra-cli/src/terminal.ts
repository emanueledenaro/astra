import type { ControlledWritePlan } from "@astra/runtime/controlled-write-plan"
import type { WorkspaceTrustReport, WorkspaceTrustState } from "@astra/domain/workspace-trust"
import type { OperationSemanticKey } from "@astra/domain/operation"

const terminalControl = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

export function sanitizeTerminalText(value: string, maxCharacters = 180) {
  const visible = value.normalize("NFC").replace(terminalControl, (character) => {
    return `\\u{${character.codePointAt(0)?.toString(16).padStart(2, "0")}}`
  })
  const characters = Array.from(graphemeSegmenter.segment(visible), ({ segment }) => segment)
  if (characters.length <= maxCharacters) return visible
  return characters.slice(0, maxCharacters).join("") + "…"
}

export function renderHeader() {
  return [
    "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
    "┃       /\\_/\\     ASTRA // WORKSPACE GATE                  ┃",
    "┃      ( o.o )    LYNX STATUS: WATCHING                       ┃",
    "┃       > ^ <     STATIC PREFLIGHT • NO AUTO EXECUTION        ┃",
    "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
  ]
}

export function renderWorkspaceReport(report: WorkspaceTrustReport) {
  const gitMetadata = report.surfaces.find((surface) => surface.kind === "git_metadata")
  const lines = [
    `WORKSPACE  ${sanitizeTerminalText(report.root)}`,
    `STATE      ${report.state === "awaiting_decision" ? "AWAITING_DECISION" : "PREFLIGHT_BLOCKED"}`,
    `STATIC PREFLIGHT DIGEST  ${report.securityDigest ?? "UNAVAILABLE"}`,
    `IDENTITY   ${report.identity ? `${report.identity.device}:${report.identity.inode}` : "UNAVAILABLE"}`,
    `BOUNDS     ${report.scannedEntries}/${report.limits.maxEntries} entries • ${report.scannedBytes}/${report.limits.maxTotalBytes} bytes`,
    "SCOPE      bounded root metadata, selected regular files, and ancestor .git markers only",
    gitMetadata
      ? `GIT META   ${gitMetadata.entryKind} • ${sanitizeTerminalText(gitMetadata.path)}`
      : "GIT META   none in bounded static inspection",
    gitMetadata
      ? "GIT BASELINE NOT INSPECTED • activation blocked"
      : "GIT BASELINE not required for this non-Git workspace",
  ]

  if (report.surfaces.length === 0) lines.push("SURFACES   none detected in bounded static inspection")
  for (const surface of report.surfaces) {
    lines.push(`SURFACE    ${sanitizeTerminalText(surface.kind)} • ${sanitizeTerminalText(surface.path)}`)
  }
  for (const blocker of report.blockers) lines.push(`BLOCKER    ${sanitizeTerminalText(blocker)}`)
  return lines
}

export function renderWorkspaceState(state: WorkspaceTrustState) {
  return `WORKSPACE STATE  ${state}`
}

export function renderOperationState(operationId: string, semantic: OperationSemanticKey) {
  return `OPERATION ${sanitizeTerminalText(operationId)}  ${semantic}`
}

export function renderControlledWritePreview(plan: ControlledWritePlan) {
  return [
    "HOST EXECUTION — NO SANDBOX",
    `EFFECT     create one new file: ${sanitizeTerminalText(plan.relativePath)}`,
    `BYTES      ${Buffer.byteLength(plan.content)}`,
    `DIGEST     ${plan.contentDigest}`,
    "GUARD      create-only; existing file is never overwritten",
  ]
}
