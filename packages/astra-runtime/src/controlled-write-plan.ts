import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"

export const demoMarkerName = ".astra-demo-marker"

export type ControlledWritePlan = Readonly<{
  operationId: string
  createdAt: string
  workspaceRoot: string
  relativePath: typeof demoMarkerName
  content: string
  contentDigest: string
}>

export function createControlledWritePlan(
  workspaceRoot: string,
  operationId: string = randomUUID(),
  createdAt: string = new Date().toISOString(),
): ControlledWritePlan {
  if (new Date(Date.parse(createdAt)).toISOString() !== createdAt) {
    throw new TypeError("Controlled write creation time must be a canonical UTC timestamp")
  }
  const content = `Astra controlled host write\noperation_id=${operationId}\n`
  return {
    operationId,
    createdAt,
    workspaceRoot: resolve(workspaceRoot),
    relativePath: demoMarkerName,
    content,
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  }
}
