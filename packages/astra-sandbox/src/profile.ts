const profile = `
(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write*
  (literal "/dev/null")
  (literal (param "RUNTIME_SCRATCH"))
  (subpath (param "RUNTIME_SCRATCH"))
  (literal (param "CREATE_TARGET")))
(deny file-read*)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read*
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal (param "SEALED_EXECUTABLE"))
  (subpath (param "WORKSPACE_ROOT"))
  (subpath (param "RUNTIME_SCRATCH"))
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/private/var/db/timezone")
  (literal "/private/etc/localtime"))
(deny process-fork)
(deny process-exec)
(allow process-exec (literal (param "SEALED_EXECUTABLE")))
`

export function buildSeatbeltInvocation(
  input: Readonly<{
    sandboxPath: string
    sealedExecutable: string
    workspaceRoot: string
    runtimeScratch: string
    createTarget: string
    arguments: ReadonlyArray<string>
  }>,
) {
  return [
    input.sandboxPath,
    "-D",
    `SEALED_EXECUTABLE=${input.sealedExecutable}`,
    "-D",
    `WORKSPACE_ROOT=${input.workspaceRoot}`,
    "-D",
    `RUNTIME_SCRATCH=${input.runtimeScratch}`,
    "-D",
    `CREATE_TARGET=${input.createTarget}`,
    "-p",
    profile,
    input.sealedExecutable,
    ...input.arguments,
  ] as const
}
