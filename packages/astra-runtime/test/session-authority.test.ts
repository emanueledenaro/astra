import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import type { WorkspaceTrustReport } from "@astra/domain/workspace-trust"
import { revalidateAstraSessionAuthority } from "../src/session-authority"
import { scanWorkspace } from "../src/workspace-preflight"

test("revalidates the sealed workspace identity and digest in the child process", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-child-authority-workspace-"))
  const report = await scanWorkspace(root)
  const fixture = await authorityFixture(report)
  try {
    expect(await revalidateAstraSessionAuthority(fixture.environment, root, fixture.now)).toMatchObject({
      status: "valid",
      authority: { workspace: { root, identity: report.identity, securityDigest: report.securityDigest } },
      report: { root, identity: report.identity, securityDigest: report.securityDigest },
    })
  } finally {
    await Promise.all([fixture.cleanup(), rm(root, { recursive: true, force: true })])
  }
})

test("rejects a different directory substituted at the approved path", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-replaced-authority-workspace-"))
  await writeFile(join(root, "package.json"), '{"name":"approved"}\n')
  const report = await scanWorkspace(root)
  const fixture = await authorityFixture(report)
  const original = `${root}-approved`
  await rename(root, original)
  await mkdir(root, { mode: 0o700 })
  await writeFile(join(root, "package.json"), '{"name":"replacement"}\n')

  try {
    expect(await revalidateAstraSessionAuthority(fixture.environment, root, fixture.now)).toEqual({
      status: "invalid",
      reason: "authority_workspace_stale",
    })
  } finally {
    await Promise.all([
      fixture.cleanup(),
      rm(root, { recursive: true, force: true }),
      rm(original, { recursive: true, force: true }),
    ])
  }
})

async function authorityFixture(report: WorkspaceTrustReport) {
  if (!report.identity || !report.securityDigest || report.completeness !== "complete") {
    throw new Error("Expected a complete workspace report")
  }
  const directory = await mkdtemp(join(tmpdir(), "astra-child-authority-"))
  const now = Date.now()
  const content = JSON.stringify({
    schemaVersion: 1,
    sessionID: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    mode: "read-only",
    effectPolicy: "deny",
    workspace: { root: report.root, identity: report.identity, securityDigest: report.securityDigest },
    repositoryBaseline: null,
  })
  const path = join(directory, "authority.json")
  await writeFile(path, content, { mode: 0o600 })
  return {
    now,
    environment: {
      ASTRA_SAFE_START: "1",
      OPENCODE_CLIENT: "astra",
      ASTRA_SESSION_AUTHORITY_FILE: path,
      ASTRA_SESSION_AUTHORITY_DIGEST: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
