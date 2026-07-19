import { describe, expect, test } from "bun:test"
import { ThapeSsoProtection } from "../../src/plugin/thape-sso-protection"

describe("ThapeSsoProtection", () => {
  test("accepts MCP tool results without legacy text fields", async () => {
    const previous = process.env.OPENCODE_API_KEY
    process.env.OPENCODE_API_KEY = "opencode-test-secret"
    try {
      const hook = (await ThapeSsoProtection())["tool.execute.after"]
      expect(hook).toBeDefined()
      if (!hook) return
      const output = { metadata: { value: "opencode-test-secret" } }
      await Reflect.apply(hook, undefined, [
        { tool: "plm-mcp_current_user", sessionID: "session", callID: "call", args: {} },
        output,
      ])
      expect(output).toEqual({ metadata: { value: "[REDACTED]" } })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = previous
    }
  })
})
