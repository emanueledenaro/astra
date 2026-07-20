import { parseAstraLaunchpadDecision } from "@astra/domain/launchpad"

export type AstraLaunchpadRoutingDependencies = Readonly<{
  createProject: () => Promise<number>
  openWorkspace: (path: string) => Promise<number>
  openSystem: () => Promise<number>
}>

export async function routeAstraLaunchpadDecision(
  input: unknown,
  dependencies: AstraLaunchpadRoutingDependencies,
): Promise<number> {
  const decision = parseAstraLaunchpadDecision(input)
  if (!decision.ok) return 1
  if (decision.value.kind === "create-project") return dependencies.createProject()
  if (decision.value.kind === "open-workspace") return dependencies.openWorkspace(decision.value.path)
  if (decision.value.kind === "open-system") return dependencies.openSystem()
  if (decision.value.kind === "continue-session") return 1
  return 0
}
