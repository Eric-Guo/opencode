import { describe, expect, test } from "bun:test"
import { hasCustomAgent, isNativeAgentID, resolveAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(
      hasCustomAgent([
        { name: "build", native: true },
        { name: "xiaotian", native: false },
      ]),
    ).toBe(true)
  })

  test("ignores built-in agents when metadata is missing", () => {
    expect(
      hasCustomAgent([
        { name: "build", native: true },
        { name: "plan" },
      ]),
    ).toBe(false)
  })

  test("detects custom agents when metadata is missing", () => {
    expect(hasCustomAgent([{ name: "build" }, { name: "xiaotian" }])).toBe(true)
  })
})

test("classifies native agent IDs", () => {
  expect(isNativeAgentID("build")).toBe(true)
  expect(isNativeAgentID("xiaotian")).toBe(false)
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})
