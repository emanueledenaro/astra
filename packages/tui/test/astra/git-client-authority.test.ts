import { expect, test } from "bun:test"
import { createAstraGitClientAuthority } from "../../src/astra/git-client-authority"

test("advances only along the exact parent-verified baseline chain", () => {
  const first = digest("a")
  const second = digest("b")
  const authority = createAstraGitClientAuthority(first)

  expect(authority.advance(first, second)).toBeTrue()
  expect(authority.current()).toBe(second)
})

test("invalidates a mismatched baseline transition", () => {
  const authority = createAstraGitClientAuthority(digest("a"))

  expect(authority.advance(digest("c"), digest("b"))).toBeFalse()
  expect(authority.current()).toBeNull()
})

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`
}
