import { projectOperationEvent, type OperationEvent, type OperationState } from "../src/operation"

const happyPath = [
  "operation.admitted",
  "policy.allow",
  "dispatch.requested",
  "executor.accepted",
  "effect.observed",
  "verification.started",
  "verification.passed",
] as const satisfies ReadonlyArray<OperationEvent>

const result = happyPath.reduce<Readonly<{ state: OperationState | null; lines: ReadonlyArray<string> }>>(
  (current, event) => {
    const transition = projectOperationEvent(current.state, event)
    if (!transition.accepted) {
      throw new Error(`Demo path rejected: ${transition.state} + ${transition.event} (${transition.code})`)
    }

    return {
      state: transition.state,
      lines: [...current.lines, `${transition.from} --${transition.event}--> ${transition.state}`],
    }
  },
  { state: null, lines: [] },
)

console.log("Astra Operation demo")
console.log(result.lines.join("\n"))
console.log(`verified=${result.state === "succeeded"}`)
