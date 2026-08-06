import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Base64 } from "../src/prompt.js"

describe("Prompt.Base64", () => {
  const decode = Schema.decodeUnknownSync(Base64)

  test("accepts large attachments", () => {
    const value = "A".repeat(6_000_000)
    expect(decode(value)).toBe(value)
  })

  test.each(["A", "AAA===", "AA=A", "A A="])("rejects invalid base64 %p", (value) => {
    expect(() => decode(value)).toThrow()
  })
})
