import { createHash } from "node:crypto"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { inspectAstraSessionAuthority } from "../../src/astra/session-authority"

test("loads a private authority bound to its exact workspace and digest", async () => {
  const fixture = await authorityFixture()
  try {
    expect(inspectAstraSessionAuthority(fixture.environment, fixture.root, fixture.now)).toMatchObject({
      status: "valid",
      authority: {
        mode: "read-only",
        effectPolicy: "deny",
        workspace: { root: fixture.root },
      },
    })
  } finally {
    await fixture.cleanup()
  }
})

test("does not accept Astra status from mode environment variables alone", () => {
  expect(
    inspectAstraSessionAuthority(
      {
        ASTRA_SAFE_START: "1",
        OPENCODE_CLIENT: "astra",
        ASTRA_WORKSPACE_MODE: "read-only",
      },
      "/workspace",
    ),
  ).toEqual({ status: "invalid", reason: "authority_reference_invalid" })
})

test("rejects a digest mismatch and a workspace mismatch", async () => {
  const fixture = await authorityFixture()
  try {
    expect(
      inspectAstraSessionAuthority(
        { ...fixture.environment, ASTRA_SESSION_AUTHORITY_DIGEST: `sha256:${"f".repeat(64)}` },
        fixture.root,
        fixture.now,
      ),
    ).toEqual({ status: "invalid", reason: "authority_digest_mismatch" })
    expect(inspectAstraSessionAuthority(fixture.environment, join(fixture.root, "other"), fixture.now)).toEqual({
      status: "invalid",
      reason: "authority_workspace_mismatch",
    })
  } finally {
    await fixture.cleanup()
  }
})

test("rejects a symlink authority even when its bytes and digest match", async () => {
  const fixture = await authorityFixture()
  const linked = join(fixture.directory, "linked-authority.json")
  await symlink(fixture.path, linked)
  try {
    expect(
      inspectAstraSessionAuthority(
        { ...fixture.environment, ASTRA_SESSION_AUTHORITY_FILE: linked },
        fixture.root,
        fixture.now,
      ),
    ).toEqual({ status: "invalid", reason: "authority_unreadable" })
  } finally {
    await fixture.cleanup()
  }
})

async function authorityFixture() {
  const directory = await mkdtemp(join(tmpdir(), "astra-tui-authority-"))
  const root = await mkdtemp(join(tmpdir(), "astra-tui-workspace-"))
  const now = Date.parse("2026-07-17T16:00:00.000Z")
  const content = JSON.stringify({
    schemaVersion: 1,
    sessionID: "32a18f14-58c7-4d67-92a0-29f0dcf8977c",
    issuedAt: new Date(now).toISOString(),
    mode: "read-only",
    effectPolicy: "deny",
    workspace: {
      root,
      identity: { device: "1", inode: "2" },
      securityDigest: `sha256:${"a".repeat(64)}`,
    },
    repositoryBaseline: null,
  })
  const path = join(directory, "authority.json")
  await writeFile(path, content, { mode: 0o600 })
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`
  return {
    directory,
    root,
    path,
    now,
    environment: {
      ASTRA_SAFE_START: "1",
      OPENCODE_CLIENT: "astra",
      ASTRA_SESSION_AUTHORITY_FILE: path,
      ASTRA_SESSION_AUTHORITY_DIGEST: digest,
    },
    async cleanup() {
      await Promise.all([rm(directory, { recursive: true, force: true }), rm(root, { recursive: true, force: true })])
    },
  }
}
