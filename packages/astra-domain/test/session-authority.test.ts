import { expect, test } from "bun:test"
import { parseAstraSessionAuthority } from "../src/session-authority"

const authority = {
  schemaVersion: 1,
  sessionID: "123e4567-e89b-42d3-a456-426614174000",
  issuedAt: "2026-07-17T16:00:00.000Z",
  mode: "read-only",
  effectPolicy: "deny",
  workspace: {
    root: "/work/astra",
    identity: { device: "1", inode: "2" },
    securityDigest: `sha256:${"a".repeat(64)}`,
  },
  repositoryBaseline: null,
} as const

test("parses an exact fail-closed Astra session authority", () => {
  expect(parseAstraSessionAuthority(authority)).toEqual({ ok: true, value: authority })
})

test("rejects unknown fields, malformed identity, and an effect-enabling policy", () => {
  expect(parseAstraSessionAuthority({ ...authority, extra: true })).toMatchObject({ ok: false })
  expect(parseAstraSessionAuthority({ ...authority, workspace: { ...authority.workspace, inode: "0" } })).toMatchObject(
    { ok: false },
  )
  expect(parseAstraSessionAuthority({ ...authority, effectPolicy: "allow" })).toMatchObject({ ok: false })
})
