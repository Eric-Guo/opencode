import { expect, test } from "bun:test"
import { claimResult } from "../src/claim-result"

test("claim results preserve typed values and escape PostgreSQL-unstorable text before bounding", () => {
  expect(
    claimResult({
      outcome: "completed",
      content: "unchanged",
      structured_content: { zero: 0, empty: "", no: false, nil: null },
    }),
  ).toEqual({
    outcome: "completed",
    content: "unchanged",
    structured_content: { zero: 0, empty: "", no: false, nil: null },
  })
  const result = claimResult({
    outcome: "completed",
    content: [
      { type: "text", text: "a\0b" },
      { type: "resource_link", uri: "nexus://uploads/file" },
    ],
    structured_content: { values: ["c\0d", false, null], "key\0": "value" },
    metadata: { checkpoint: { hash: "saved", store: "/project" } },
    title: "Result",
  })
  expect(result.content).toEqual([
    { type: "text", text: "a\\u0000b" },
    { type: "resource_link", uri: "nexus://uploads/file" },
    { type: "text", text: expect.stringContaining("U+0000 bytes") },
  ])
  expect(result.structured_content).toEqual({ values: ["c\\u0000d", false, null], "key\\u0000": "value" })
  expect(result.metadata).toEqual({ checkpoint: { hash: "saved", store: "/project" } })
})

test("oversized structured data yields to model text and escaped output fits the serialized settlement bound", () => {
  const structured = claimResult({
    outcome: "completed",
    content: "Useful model text",
    structured_content: { excessive: "x".repeat(1048576) },
  })
  expect(structured.structured_content).toBeUndefined()
  expect(structured.content).toContain("Useful model text")
  expect(structured.content).toContain("structured content omitted")
  const large = claimResult({
    outcome: "completed",
    content: '\0\n"😀'.repeat(300000) + "last diagnostic",
    is_error: true,
  })
  expect(Buffer.byteLength(JSON.stringify({ content: large.content }))).toBeLessThanOrEqual(1048576 - 65536)
  expect(large.content).toContain("last diagnostic")
  expect(large.content).toContain("result truncated")
  expect(large.is_error).toBe(true)
  expect(typeof large.content === "string" && large.content.includes("\0")).toBe(false)
  expect(typeof large.content === "string" && large.content.isWellFormed()).toBe(true)
})
