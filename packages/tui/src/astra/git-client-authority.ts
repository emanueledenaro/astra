const digestPattern = /^sha256:[0-9a-f]{64}$/

export type AstraGitClientAuthority = Readonly<{
  current: () => `sha256:${string}` | null
  advance: (
    expectedCurrentSnapshotDigest: `sha256:${string}`,
    verifiedNextSnapshotDigest: `sha256:${string}`,
  ) => boolean
  invalidate: () => void
}>

/** Tracks only the verified baseline chain issued by the authenticated parent. */
export function createAstraGitClientAuthority(
  initialSnapshotDigest: string | null | undefined,
): AstraGitClientAuthority {
  let current = digest(initialSnapshotDigest) ? initialSnapshotDigest : null

  const invalidate = () => {
    current = null
  }

  return {
    current: () => current,
    invalidate,
    advance(expectedCurrentSnapshotDigest, verifiedNextSnapshotDigest) {
      if (
        current !== expectedCurrentSnapshotDigest ||
        !digest(expectedCurrentSnapshotDigest) ||
        !digest(verifiedNextSnapshotDigest)
      ) {
        invalidate()
        return false
      }
      current = verifiedNextSnapshotDigest
      return true
    },
  }
}

export function matchesAstraGitClientAuthority(
  authority: AstraGitClientAuthority | undefined,
  expectedSnapshotDigest: string | undefined,
  candidate: string,
) {
  return authority
    ? authority.current() === candidate
    : expectedSnapshotDigest === undefined || expectedSnapshotDigest === candidate
}

function digest(input: unknown): input is `sha256:${string}` {
  return typeof input === "string" && digestPattern.test(input)
}
