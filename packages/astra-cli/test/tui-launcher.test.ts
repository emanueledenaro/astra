import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { parseAstraSessionAuthority } from "@astra/domain/session-authority"
import { scanWorkspace } from "@astra/runtime/preflight"
import { astraChildEnvironment, createAstraSessionAuthorityFile, makeAstraTuiLaunchSpec } from "../src/tui-launcher"

test("builds a fail-closed read-only TUI launch", () => {
  const spec = makeAstraTuiLaunchSpec("/workspace", "read-only", authority, control, provider)
  const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!)
  const permission = JSON.parse(spec.env.OPENCODE_PERMISSION!)

  expect(spec.command.at(-1)).toBe("/workspace")
  expect(spec.command).toContain("--pure")
  expect(spec.cwd).toEndWith("/packages/opencode")
  expect(spec.env).toMatchObject({
    ASTRA_SAFE_START: "1",
    ASTRA_WORKSPACE_MODE: "read-only",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PURE: "1",
    ASTRA_SESSION_AUTHORITY_FILE: authority.path,
    ASTRA_SESSION_AUTHORITY_DIGEST: authority.digest,
    ASTRA_CONTROL_SOCKET: control.socketPath,
    ASTRA_CONTROL_TOKEN: control.token,
    ASTRA_PROVIDER_SOCKET: provider.socketPath,
    ASTRA_PROVIDER_TOKEN: provider.token,
  })
  expect(config).toMatchObject({ lsp: false, formatter: false })
  expect(permission).toEqual({ "*": "deny" })
})

test("keeps every inherited tool blocked after Activate once", () => {
  const permission = JSON.parse(
    makeAstraTuiLaunchSpec("/workspace", "activate-once", authority, control).env.OPENCODE_PERMISSION!,
  )

  expect(permission).toEqual({ "*": "deny" })
})

test("passes only host-neutral terminal variables to the OpenCode child", () => {
  expect(
    astraChildEnvironment({
      HOME: "/home/astra",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_TOKEN: "secret",
      HTTPS_PROXY: "http://proxy.invalid",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    }),
  ).toEqual({ HOME: "/home/astra", PATH: "/usr/bin:/bin", TERM: "xterm-256color" })
})

test("seals a private workspace-bound authority before TUI launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-authority-workspace-"))
  const report = await scanWorkspace(root)
  expect(report.completeness).toBe("complete")

  const sealed = await createAstraSessionAuthorityFile(
    { status: "opened", mode: "read-only", report },
    {
      async revalidateWorkspacePreflight() {
        return { matched: true, report }
      },
      async revalidateGitRepositoryBaseline() {
        throw new Error("Git revalidation must not run for a non-Git session")
      },
    },
  )

  try {
    const [content, fileFacts, directoryFacts] = await Promise.all([
      readFile(sealed.path),
      stat(sealed.path),
      stat(sealed.directory),
    ])
    expect(fileFacts.mode & 0o777).toBe(0o600)
    expect(directoryFacts.mode & 0o777).toBe(0o700)
    expect(sealed.digest).toBe(`sha256:${createHash("sha256").update(content).digest("hex")}`)
    expect(sealed.authority.workspace.root).toBe(root)

    const parsed = parseAstraSessionAuthority(JSON.parse(content.toString("utf8")))
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        mode: "read-only",
        effectPolicy: "deny",
        workspace: { root, identity: report.identity, securityDigest: report.securityDigest },
        repositoryBaseline: null,
      },
    })
  } finally {
    await Promise.all([
      rm(sealed.directory, { recursive: true, force: true }),
      rm(root, { recursive: true, force: true }),
    ])
  }
})

test("refuses to create an authority after the workspace becomes stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-stale-authority-"))
  const report = await scanWorkspace(root)
  try {
    const failure: unknown = await createAstraSessionAuthorityFile(
      { status: "opened", mode: "activate-once", report },
      {
        async revalidateWorkspacePreflight() {
          return { matched: false, reason: "security_digest_changed", report }
        },
        async revalidateGitRepositoryBaseline() {
          throw new Error("Git must not run after stale workspace authority")
        },
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("Expected stale authority creation to fail")
    expect(failure.message).toContain("workspace authority became stale")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removes the private authority directory when writing the authority fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "astra-authority-write-root-"))
  const report = await scanWorkspace(root)
  const parent = await mkdtemp(join(tmpdir(), "astra-authority-write-parent-"))
  const directory = join(parent, "authority")
  try {
    const failure: unknown = await createAstraSessionAuthorityFile(
      { status: "opened", mode: "read-only", report },
      {
        async revalidateWorkspacePreflight() {
          return { matched: true, report }
        },
        async revalidateGitRepositoryBaseline() {
          throw new Error("Git revalidation must not run for a non-Git session")
        },
        async createAuthorityDirectory() {
          await mkdir(directory, { mode: 0o700 })
          return directory
        },
        async writeAuthorityFile() {
          throw new Error("simulated authority write failure")
        },
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(stat(directory)).rejects.toThrow()
  } finally {
    await Promise.all([rm(parent, { recursive: true, force: true }), rm(root, { recursive: true, force: true })])
  }
})

const authority = {
  path: "/tmp/astra-authority.json",
  digest: `sha256:${"a".repeat(64)}`,
} as const

const control = {
  socketPath: "/tmp/astra-control.sock",
  token: "x".repeat(43),
} as const

const provider = {
  socketPath: "/tmp/astra-provider.sock",
  token: "y".repeat(43),
} as const
