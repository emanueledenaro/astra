/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import { candidatePatchEvidenceLabel, type AstraWorkSessionProjection } from "@astra/domain/work-session"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { For } from "solid-js"

export type AstraCandidatePatchDetails = Readonly<{
  schemaVersion: 1
  candidatePatchID: string
  candidateDigest: `sha256:${string}`
  projectionDigest: `sha256:${string}`
  baselineDigest: `sha256:${string}`
  summary: string
  files: ReadonlyArray<Readonly<{ path: string; change: "add" | "modify" | "delete" }>>
}>

/** Metadata-only review boundary. Patch transport and apply authority arrive in later tasks. */
export function AstraReviewMode(props: { api: TuiPluginApi; details: AstraCandidatePatchDetails }) {
  return (
    <box width="100%" height="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={props.api.theme.current.primary}>CANDIDATE METADATA</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>ESC BACK TO CHAT</text>
      </box>
      <box height={1} />
      <Row label="CANDIDATE" value={props.details.candidatePatchID} api={props.api} />
      <Row label="DIGEST" value={props.details.candidateDigest} api={props.api} />
      <Row label="BASELINE" value={props.details.baselineDigest} api={props.api} />
      <Row label="SUMMARY" value={props.details.summary} api={props.api} />
      <box height={1} />
      <text fg={props.api.theme.current.primary}>FILES</text>
      <For each={props.details.files}>
        {(file) => <text fg={props.api.theme.current.text}>{`${file.path} · ${file.change.toUpperCase()}`}</text>}
      </For>
      <box flexGrow={1} />
      <text fg={props.api.theme.current.warning}>METADATA ONLY · PATCH CONTENT UNAVAILABLE · NO APPLY AUTHORITY</text>
    </box>
  )
}

export function validateAstraCandidatePatchDetails(
  input: unknown,
  projection: AstraWorkSessionProjection | undefined,
  authority: AstraSessionAuthority,
): AstraCandidatePatchDetails | undefined {
  if (!projection || projection.phase !== "review-ready" || !projection.candidatePatchID) return
  const candidatePatchID = projection.candidatePatchID
  if (!plainRecord(input, ["schemaVersion", "candidatePatchID", "candidateDigest", "projectionDigest", "baselineDigest", "summary", "files"])) return
  if (
    input.schemaVersion !== 1 ||
    input.candidatePatchID !== candidatePatchID ||
    input.projectionDigest !== projection.projectionDigest ||
    input.baselineDigest !== authority.repositoryBaseline?.snapshotDigest ||
    !safeID(input.candidatePatchID) ||
    !digest(input.candidateDigest) ||
    !digest(input.projectionDigest) ||
    !digest(input.baselineDigest) ||
    !safeText(input.summary, 2_048) ||
    !Array.isArray(input.files) ||
    input.files.length === 0 ||
    input.files.length > 512
  ) return
  const candidateEvidence = projection.evidence.filter(
    (evidence) => evidence.kind === "receipt" && evidence.label === candidatePatchEvidenceLabel(candidatePatchID),
  )
  if (candidateEvidence.length !== 1 || candidateEvidence[0]?.value !== input.candidateDigest) return
  const files = input.files.flatMap((value) => {
    if (!plainRecord(value, ["path", "change"])) return []
    if (!safeRelativePath(value.path) || (value.change !== "add" && value.change !== "modify" && value.change !== "delete")) return []
    return [{ path: value.path, change: value.change as "add" | "modify" | "delete" }]
  })
  if (files.length !== input.files.length || new Set(files.map((file) => file.path)).size !== files.length) return
  return {
    schemaVersion: 1,
    candidatePatchID: input.candidatePatchID,
    candidateDigest: input.candidateDigest,
    projectionDigest: input.projectionDigest,
    baselineDigest: input.baselineDigest,
    summary: input.summary,
    files,
  }
}

function Row(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row">
      <text width={12} fg={props.api.theme.current.textMuted}>{props.label}</text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

function plainRecord(input: unknown, keys: ReadonlyArray<string>): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return false
  const record = input as Record<string, unknown>
  return Object.keys(record).length === keys.length && keys.every((key) => key in record)
}

function safeID(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && Buffer.byteLength(input) <= 256 && !/\p{C}/u.test(input)
}

function safeText(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.length > 0 && Buffer.byteLength(input) <= maximum && !/\p{C}/u.test(input)
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input)
}

function safeRelativePath(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0 || Buffer.byteLength(input) > 1_024 || /\p{C}/u.test(input)) return false
  if (input.startsWith("/") || input.startsWith("\\") || input.includes("\\")) return false
  const segments = input.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}
