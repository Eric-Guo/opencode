import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Integration, LLM, SessionError } from "../src/index.js"

describe("SessionError", () => {
  test("exports one identified open envelope", () => {
    expect(SessionError.Error.ast.annotations?.identifier).toBe("Session.StructuredError")
    expect(Object.keys(SessionError).filter((key) => key !== "SessionError")).toEqual([
      "ConnectionFallbackRecovery",
      "Error",
      "Recovery",
    ])
  })

  test("round trips current and future error types through JSON", () => {
    const values: SessionError.Error[] = [
      { type: "provider.rate-limit", message: "Slow down" },
      { type: "provider.auth", message: "Authentication failed" },
      { type: "provider.future-condition", message: "A future provider failure" },
      { type: "unknown", message: "Unexpected" },
    ]
    const codec = Schema.fromJsonString(SessionError.Error)

    for (const value of values) {
      const encoded = Schema.encodeSync(codec)(value)
      expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(value)
    }
  })

  test("round trips connection fallback recovery metadata", () => {
    const value: SessionError.Error = {
      type: "provider.quota",
      message: "KIMI_API_KEY reached its rolling limit",
      recovery: {
        type: "connection-fallback",
        integrationID: Integration.ID.make("kimi-for-coding"),
        previous: { type: "env", name: "KIMI_API_KEY" },
        promoted: { type: "env", name: "KIMI_API_KEY_2" },
        unavailableUntil: 18_000_000,
      },
    }
    const codec = Schema.fromJsonString(SessionError.Error)

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(value))).toEqual(value)
  })

  test("accepts future fields while exposing only the stable envelope", () => {
    expect(
      Schema.decodeUnknownSync(SessionError.Error)({
        type: "provider.timeout",
        message: "Timeout",
        retryAfterMs: 2_500,
      }),
    ).toEqual({ type: "provider.timeout", message: "Timeout" })
  })

  test("rejects missing envelope fields", () => {
    expect(() => Schema.decodeUnknownSync(SessionError.Error)({ type: "provider.auth" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SessionError.Error)({ message: "Missing type" })).toThrow()
  })
})

test("FinishReason is the closed normalized provider set", () => {
  const reasons = ["stop", "length", "tool-calls", "content-filter", "error", "unknown"] as const
  expect(reasons.map((reason) => Schema.decodeUnknownSync(LLM.FinishReason)(reason))).toEqual([...reasons])
  expect(() => Schema.decodeUnknownSync(LLM.FinishReason)("other")).toThrow()
})
