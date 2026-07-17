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
  const lines = [
    `WORKSPACE  ${sanitizeTerminalText(report.root)}`,
    `STATE      ${report.state === "awaiting_decision" ? "AWAITING_DECISION" : "PREFLIGHT_BLOCKED"}`,
    `SNAPSHOT   ${report.securityDigest ?? "UNAVAILABLE"}`,
    `IDENTITY   ${report.identity ? `${report.identity.device}:${report.identity.inode}` : "UNAVAILABLE"}`,
    `BOUNDS     ${report.scannedEntries}/${report.limits.maxEntries} entries • ${report.scannedBytes}/${report.limits.maxTotalBytes} bytes`,
  ]

  if (report.surfaces.length === 0) lines.push("SURFACES   none detected in bounded root inventory")
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
