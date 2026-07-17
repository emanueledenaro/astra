export type AstraCliTarget =
  | Readonly<{ kind: "no-workspace" }>
  | Readonly<{ kind: "system" }>
  | Readonly<{ kind: "workspace"; path: string; source: "direct" | "open-alias" }>

export type AstraArgumentResult =
  | Readonly<{ ok: true; target: AstraCliTarget }>
  | Readonly<{ ok: false; reason: string }>

/** Parses the public command target without reading or resolving any path. */
export function parseAstraArguments(values: ReadonlyArray<string>): AstraArgumentResult {
  if (values.length === 0) return { ok: true, target: { kind: "no-workspace" } }

  if (values[0] === "system") {
    if (values.length === 1) return { ok: true, target: { kind: "system" } }
    return { ok: false, reason: "The `system` command does not accept arguments or flags." }
  }

  if (values[0] === "open") return parseOpenAlias(values)

  if (values.length !== 1) return { ok: false, reason: "A direct workspace target accepts exactly one path." }
  if (!isPath(values[0])) {
    return { ok: false, reason: "Expected no argument, `system`, a workspace path, or `open <path>`." }
  }
  return { ok: true, target: { kind: "workspace", path: values[0], source: "direct" } }
}

function parseOpenAlias(values: ReadonlyArray<string>): AstraArgumentResult {
  if (values.length !== 2 || !isPath(values[1])) {
    return { ok: false, reason: "The `open` command requires exactly one workspace path." }
  }
  return { ok: true, target: { kind: "workspace", path: values[1], source: "open-alias" } }
}

function isPath(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith("-")
}
