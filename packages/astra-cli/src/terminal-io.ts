import { createInterface } from "node:readline/promises"
import type { EffectApproval, WorkspaceDecision, WorkspaceGateIO } from "./workspace-gate"

export type TerminalOverrides = Readonly<{
  decision?: WorkspaceDecision
  approval?: EffectApproval
}>

export function createTerminalIO(overrides: TerminalOverrides) {
  let terminal: ReturnType<typeof createInterface> | null = null
  const question = async (prompt: string) => {
    terminal ??= createInterface({ input: process.stdin, output: process.stdout })
    return (await terminal.question(prompt)).trim()
  }

  const io: WorkspaceGateIO = {
    write: (line) => console.log(line),
    async chooseWorkspaceDecision(activationAllowed, gitInspectionAllowed) {
      if (overrides.decision) return overrides.decision
      while (true) {
        const choices = gitInspectionAllowed
          ? "Choose [R] read-only, [G] inspect Git, [Q] exit: "
          : activationAllowed
            ? "Choose [R] read-only, [A] activate once, [Q] exit: "
            : "Choose [R] read-only, [Q] exit: "
        const answer = (await question(choices)).toLowerCase()
        if (answer === "r" || answer === "read-only") return "read-only"
        if (gitInspectionAllowed && (answer === "g" || answer === "inspect-git")) return "inspect-git"
        if (answer === "q" || answer === "exit") return "exit"
        if (activationAllowed && (answer === "a" || answer === "activate-once")) return "activate-once"
      }
    },
    async approveControlledWrite() {
      if (overrides.approval) return overrides.approval
      const answer = await question("Type APPROVE to create the exact demo marker, or anything else to deny: ")
      return answer === "APPROVE" ? "approve" : "deny"
    },
  }

  return {
    io,
    close() {
      terminal?.close()
    },
  }
}
