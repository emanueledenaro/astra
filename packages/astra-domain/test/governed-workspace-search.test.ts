import { describe, expect, test } from "bun:test"
import {
  governedWorkspaceSearchQueryLimitBytes,
  governedWorkspaceSearchTaskID,
  parseGovernedWorkspaceSearchRequest,
} from "../src/governed-workspace-search"

describe("governed workspace search contract", () => {
  test("accepts exact printable UTF-8 bytes including shell metacharacters", () => {
    const query = "$(touch /tmp/nope); * ? [x] ' \\\" café"
    const parsed = parseGovernedWorkspaceSearchRequest({ taskID: governedWorkspaceSearchTaskID, query })

    expect(parsed).toEqual({
      ok: true,
      value: { taskID: governedWorkspaceSearchTaskID, query, queryBytes: Buffer.byteLength(query) },
    })
    if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBeTrue()
  })

  test("enforces the fixed task and exact object shape", () => {
    expect(parseGovernedWorkspaceSearchRequest({ taskID: "shell", query: "needle" })).toEqual({
      ok: false,
      issue: "invalid_task",
    })
    expect(
      parseGovernedWorkspaceSearchRequest({ taskID: governedWorkspaceSearchTaskID, query: "needle", argv: [] }),
    ).toEqual({ ok: false, issue: "invalid_shape" })
    expect(
      parseGovernedWorkspaceSearchRequest({ taskID: governedWorkspaceSearchTaskID, query: "needle", queryBytes: 1 }),
    ).toEqual({ ok: false, issue: "invalid_shape" })
  })

  test("rejects empty, control-bearing, malformed, and oversized queries", () => {
    expect(parseGovernedWorkspaceSearchRequest({ taskID: governedWorkspaceSearchTaskID, query: "" })).toEqual({
      ok: false,
      issue: "empty_query",
    })
    expect(parseGovernedWorkspaceSearchRequest({ taskID: governedWorkspaceSearchTaskID, query: "a\nb" })).toEqual({
      ok: false,
      issue: "unsafe_query",
    })
    expect(parseGovernedWorkspaceSearchRequest({ taskID: governedWorkspaceSearchTaskID, query: "\ud800" })).toEqual({
      ok: false,
      issue: "unsafe_query",
    })
    expect(
      parseGovernedWorkspaceSearchRequest({
        taskID: governedWorkspaceSearchTaskID,
        query: "é".repeat(governedWorkspaceSearchQueryLimitBytes / 2 + 1),
      }),
    ).toEqual({ ok: false, issue: "query_too_large" })
  })

  test("rejects accessor-backed and exotic request objects without evaluating them", () => {
    let reads = 0
    const accessor = { taskID: governedWorkspaceSearchTaskID }
    Object.defineProperty(accessor, "query", {
      enumerable: true,
      get() {
        reads++
        return "needle"
      },
    })

    expect(parseGovernedWorkspaceSearchRequest(accessor)).toEqual({ ok: false, issue: "invalid_shape" })
    expect(parseGovernedWorkspaceSearchRequest(Object.create({}))).toEqual({
      ok: false,
      issue: "invalid_shape",
    })
    expect(reads).toBe(0)
  })
})
