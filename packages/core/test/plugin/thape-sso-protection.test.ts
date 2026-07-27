import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode-ai/schema/tool"
import { REDACTED, redact } from "@opencode-ai/core/plugin/thape-sso-protection"

describe("ThapeSsoProtection", () => {
  test("redacts API keys from nested tool results", () => {
    expect(
      redact(
        {
          text: "token=opencode-secret",
          nested: ["opencode-secret", { url: "https://example.test/opencode-secret" }],
          unchanged: 1,
        },
        ["opencode-secret"],
      ),
    ).toEqual({
      text: `token=${REDACTED}`,
      nested: [REDACTED, { url: `https://example.test/${REDACTED}` }],
      unchanged: 1,
    })
  })

  test("preserves Tool.Error behavior while redacting", () => {
    const error = redact(
      new Tool.Error({
        message: "token=opencode-secret",
        metadata: { nested: ["opencode-secret"] },
      }),
      ["opencode-secret"],
    )

    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toBe(`token=${REDACTED}`)
    expect(error.metadata).toEqual({ nested: [REDACTED] })
  })
})
