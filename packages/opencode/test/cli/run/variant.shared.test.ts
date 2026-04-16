import { describe, expect, test } from "bun:test"
import { cycleVariant, formatModelLabel, pickVariant, resolveVariant } from "../../../src/cli/cmd/run/variant.shared"
import type { SessionMessages } from "../../../src/cli/cmd/run/session.shared"

const model = {
  providerID: "openai",
  modelID: "gpt-5",
}

describe("run variant shared", () => {
  test("prefers cli then session then saved variants", () => {
    expect(resolveVariant("max", "high", "low", ["low", "high"])).toBe("max")
    expect(resolveVariant(undefined, "high", "low", ["low", "high"])).toBe("high")
    expect(resolveVariant(undefined, "missing", "low", ["low", "high"])).toBe("low")
  })

  test("cycles through variants and back to default", () => {
    expect(cycleVariant(undefined, ["low", "high"])).toBe("low")
    expect(cycleVariant("low", ["low", "high"])).toBe("high")
    expect(cycleVariant("high", ["low", "high"])).toBeUndefined()
    expect(cycleVariant(undefined, [])).toBeUndefined()
  })

  test("formats model labels", () => {
    expect(formatModelLabel(model, undefined)).toBe("gpt-5 · openai")
    expect(formatModelLabel(model, "high")).toBe("gpt-5 · openai · high")
  })

  test("picks the latest matching variant from raw session messages", () => {
    const msgs = [
      {
        info: {
          role: "user",
          model: {
            providerID: "openai",
            modelID: "gpt-5",
            variant: "high",
          },
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          model: {
            providerID: "anthropic",
            modelID: "sonnet",
            variant: "max",
          },
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          model: {
            providerID: "openai",
            modelID: "gpt-5",
            variant: "minimal",
          },
        },
        parts: [],
      },
    ] as unknown as SessionMessages

    expect(pickVariant(model, msgs)).toBe("minimal")
  })
})
