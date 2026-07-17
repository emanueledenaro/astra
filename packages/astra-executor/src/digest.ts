import { createHash } from "node:crypto"

export function digestReceipt(value: Readonly<Record<string, unknown>>) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Canonical JSON accepts only normalized JSON values")
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}
