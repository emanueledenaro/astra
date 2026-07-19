import { expect, test } from "bun:test"
import type { ParentProviderCredentialBroker } from "../src/provider-credential-broker"
import type { AstraSkillActivationControl } from "../src/skill-activation-control"
import { makeAstraProviderSessionDependencies } from "../src/tui-launcher"

test("wires provider chat to the exact parent-owned skill control instance", () => {
  const skillBundleSource = {
    async takePromptBundle() {
      return { status: "none" as const }
    },
  } satisfies Pick<AstraSkillActivationControl, "takePromptBundle">
  const credentialBroker = {
    async issueForSession() {
      return {
        ok: false as const,
        error: {
          code: "credential_unavailable" as const,
          message: "Anthropic API credential is unavailable." as const,
        },
      }
    },
    revoke() {
      return false
    },
    takeForParentTransport() {
      return {
        ok: false as const,
        error: {
          code: "credential_invalid" as const,
          message: "Credential handle is invalid or expired." as const,
        },
      }
    },
  } satisfies ParentProviderCredentialBroker

  const dependencies = makeAstraProviderSessionDependencies(credentialBroker, skillBundleSource)

  expect(dependencies.skillBundleSource).toBe(skillBundleSource)
  expect(dependencies.credentialBroker).toBe(credentialBroker)
})
