import { describe, expect, test } from "bun:test"
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
})
