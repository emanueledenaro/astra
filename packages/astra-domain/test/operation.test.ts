import { describe, expect, test } from "bun:test"
import { Operation } from "../src"
import {
  activeOperationStates,
  isActiveOperationState,
  isTerminalOperationState,
  operationEvents,
  operationSemanticKey,
  operationStates,
  operationTransitions,
  projectOperationEvent,
  terminalOperationStates,
  type OperationState,
} from "../src/operation"
import {
  expectedActiveOperationStates,
  expectedOperationStates,
  expectedOperationTransitions,
  expectedSemanticKeys,
  expectedTerminalOperationStates,
} from "./operation-transition.fixture"

describe("Operation transition projector", () => {
  test("matches and accepts the independent ADR-0002 transition fixture", () => {
    expect(
      JSON.stringify(operationTransitions.map((transition) => [transition.from, transition.event, transition.to])),
    ).toBe(JSON.stringify(expectedOperationTransitions))

    for (const [from, event, to] of expectedOperationTransitions) {
      expect(projectOperationEvent(from, event)).toEqual({
        accepted: true,
        from,
        event,
        state: to,
      })
    }
  })

  test("rejects every unlisted transition without changing state", () => {
    const legal = new Set(expectedOperationTransitions.map(([from, event]) => `${from}\0${event}`))

    for (const state of [null, ...operationStates] as const) {
      for (const event of operationEvents) {
        if (legal.has(`${state}\0${event}`)) continue

        const result = projectOperationEvent(state, event)
        expect(result.accepted).toBeFalse()
        expect(result.state).toBe(state)
      }
    }
  })

  test("rejects all events after a terminal state", () => {
    for (const state of terminalOperationStates) {
      for (const event of operationEvents) {
        expect(projectOperationEvent(state, event)).toEqual({
          accepted: false,
          code: "terminal_state",
          state,
          event,
        })
      }
    }
  })

  test("reaches succeeded only from independent verification", () => {
    const successTransitions = operationTransitions.filter((transition) => transition.to === "succeeded")

    expect(successTransitions).toEqual([{ from: "verifying", event: "verification.passed", to: "succeeded" }])
    expect(projectOperationEvent("dispatched", "effect.observed")).toEqual({
      accepted: true,
      from: "dispatched",
      event: "effect.observed",
      state: "effect_observed",
    })
  })

  test("records observed completion without claiming independent verification", () => {
    expect(projectOperationEvent("dispatched", "effect.completed")).toEqual({
      accepted: true,
      from: "dispatched",
      event: "effect.completed",
      state: "completed",
    })
    expect(operationSemanticKey("completed")).toBe("COMPLETED")
    expect(operationSemanticKey("completed")).not.toBe("VERIFIED")
    expect(isTerminalOperationState("completed")).toBeTrue()
  })

  test("admits an Operation only from the absent state", () => {
    expect(projectOperationEvent(null, "operation.admitted")).toEqual({
      accepted: true,
      from: null,
      event: "operation.admitted",
      state: "proposed",
    })
    expect(projectOperationEvent("proposed", "operation.admitted")).toEqual({
      accepted: false,
      code: "illegal_transition",
      state: "proposed",
      event: "operation.admitted",
    })
  })

  test("routes uncertain dispatch, effect, verification, and recovery to reconciliation", () => {
    const ambiguousCases = [
      ["dispatch_pending", "dispatch.claim_unknown"],
      ["dispatched", "effect.unknown"],
      ["verifying", "verification.unknown"],
      ["rolling_back", "recovery.unknown"],
    ] as const

    for (const [state, event] of ambiguousCases) {
      const result = projectOperationEvent(state, event)
      expect(result.accepted).toBeTrue()
      expect(result.state).toBe("reconciliation_required")
    }
  })

  test("permits retry only after a named no-effect proof and fresh authorization", () => {
    const transitionsToAuthorized = operationTransitions.filter((transition) => transition.to === "authorized")

    expect(transitionsToAuthorized).toEqual([
      { from: "proposed", event: "policy.allow", to: "authorized" },
      { from: "awaiting_approval", event: "approval.granted", to: "authorized" },
      { from: "dispatch_pending", event: "dispatch.proved_unclaimed", to: "authorized" },
      {
        from: "reconciliation_required",
        event: "probe.proved_no_effect_and_retry_authorized",
        to: "authorized",
      },
    ])
  })

  test("requires no-effect cleanup proof for cancellation after dispatch", () => {
    expect(projectOperationEvent("dispatched", "operation.cancelled")).toEqual({
      accepted: false,
      code: "illegal_transition",
      state: "dispatched",
      event: "operation.cancelled",
    })
    expect(projectOperationEvent("dispatched", "cancellation.completed_without_effect")).toEqual({
      accepted: true,
      from: "dispatched",
      event: "cancellation.completed_without_effect",
      state: "cancelled",
    })
  })

  test("records rollback only after a linked recovery is verified", () => {
    const transitionsToRollback = operationTransitions.filter((transition) => transition.to === "rolled_back")

    expect(transitionsToRollback).toEqual([{ from: "rolling_back", event: "recovery.verified", to: "rolled_back" }])
    expect(projectOperationEvent("effect_observed", "recovery.operation_linked").state).toBe("rolling_back")
  })

  test("contains the complete ADR-0002 state surface", () => {
    expect(operationStates.join("\0")).toBe(expectedOperationStates.join("\0"))
    expect(activeOperationStates.join("\0")).toBe(expectedActiveOperationStates.join("\0"))
    expect(terminalOperationStates.join("\0")).toBe(expectedTerminalOperationStates.join("\0"))
    expect(operationTransitions).toHaveLength(51)
  })

  test("keeps accepted state values inside the canonical state set", () => {
    const states = new Set<OperationState>(operationStates)
    expect(
      operationTransitions.every((transition) => transition.from === null || states.has(transition.from)),
    ).toBeTrue()
    expect(operationTransitions.every((transition) => states.has(transition.to))).toBeTrue()
  })

  test("partitions active and terminal states without overlap", () => {
    expect(
      operationStates.every((state) => isActiveOperationState(state) !== isTerminalOperationState(state)),
    ).toBeTrue()
  })

  test("uses VERIFIED only for succeeded", () => {
    expect(Object.fromEntries(operationStates.map((state) => [state, operationSemanticKey(state)]))).toEqual(
      expectedSemanticKeys,
    )
    expect(operationStates.filter((state) => operationSemanticKey(state) === "VERIFIED")).toEqual(["succeeded"])
  })

  test("exposes the complete topology through the package root namespace", () => {
    expect(Operation.operationStates).toEqual(expectedOperationStates)
    expect(Operation.operationTransitions).toEqual(operationTransitions)
    expect(Operation.projectOperationEvent("verifying", "verification.passed").state).toBe("succeeded")
  })

  test("accepts the canonical same-state facts without inventing progress", () => {
    const sameStateFacts = operationTransitions.filter(
      (transition) => transition.from !== null && transition.from === transition.to,
    )

    expect(sameStateFacts).toHaveLength(10)
    for (const fact of sameStateFacts) {
      expect(projectOperationEvent(fact.from, fact.event)).toEqual({
        accepted: true,
        from: fact.from,
        event: fact.event,
        state: fact.to,
      })
    }
  })
})
