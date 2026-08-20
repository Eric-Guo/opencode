import { describe, expect, test } from "bun:test"
import { hasCustomAgent, isNativeAgentID, resolveAgent, selectableAgents } from "./agent"

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
    expect(hasCustomAgent([{ name: "build", native: true }, { name: "plan" }])).toBe(false)
  })

  test("detects custom agents when metadata is missing", () => {
    expect(hasCustomAgent([{ name: "build" }, { name: "xiaotian" }])).toBe(true)
  })
})

test("classifies native agent IDs", () => {
  expect(isNativeAgentID("build")).toBe(true)
  expect(isNativeAgentID("xiaotian")).toBe(false)
})

test("filters agents hidden locally or by SSO", () => {
  expect(
    selectableAgents(
      [
        { name: "build", mode: "primary", hidden: false },
        { name: "bid-assistant", mode: "primary", hidden: false },
        { name: "internal", mode: "primary", hidden: true },
        { name: "explore", mode: "subagent", hidden: false },
      ],
      ["bid-assistant"],
    ).map((agent) => agent.name),
  ).toEqual(["build"])
})

const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]
const rows: { name: string; agents: { name: string }[]; requested?: string; expected: string }[] = [
  { name: "the requested available agent", agents, requested: "custom", expected: "custom" },
  { name: "build without a request", agents, requested: undefined, expected: "build" },
  { name: "build for a missing agent", agents, requested: "missing", expected: "build" },
  {
    name: "the first agent when build is unavailable",
    agents: [{ name: "custom" }],
    requested: "missing",
    expected: "custom",
  },
]

test.each(rows)("resolveAgent uses $name", (row) => {
  expect(resolveAgent(row.agents, row.requested)?.name).toBe(row.expected)
})
