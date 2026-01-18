import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "@opencode/core/config/markdown"

const invalidYaml = `---
description: Use when the user needs to crawl pages. Keywords: crawl, scrape
---
body`

describe("ConfigMarkdown.parse", () => {
  test("recovers unquoted-colon frontmatter via the sanitize fallback", () => {
    const parsed = ConfigMarkdown.parse(invalidYaml)
    expect(parsed.data.description).toBe("Use when the user needs to crawl pages. Keywords: crawl, scrape")
    expect(parsed.content.trim()).toBe("body")
  })

  test("recovers the same content again after a previous failed parse", () => {
    // gray-matter caches by content before parsing; a poisoned entry used to
    // make every later parse of the same text return silently without data.
    expect(() => ConfigMarkdown.parse("---\ndescription: [unclosed\n---\nbody")).toThrow()
    const parsed = ConfigMarkdown.parse(invalidYaml)
    expect(parsed.data.description).toBe("Use when the user needs to crawl pages. Keywords: crawl, scrape")
  })

  test("keeps throwing for the same unparseable content on every call", () => {
    const input = "---\ndescription: [unclosed\n---\nbody"
    expect(() => ConfigMarkdown.parse(input)).toThrow()
    expect(() => ConfigMarkdown.parse(input)).toThrow()
  })

  test("parses plain content without frontmatter", () => {
    const parsed = ConfigMarkdown.parse("just body")
    expect(parsed.content).toBe("just body")
    expect(parsed.data).toEqual({})
  })
})

describe("ConfigMarkdown", () => {
  test("substitutes environment variables before parsing frontmatter and content", () => {
    process.env.OPENCODE_TEST_MARKDOWN_VALUE = "configured"
    const parsed = ConfigMarkdown.parse(
      `---\ndescription: "{env:OPENCODE_TEST_MARKDOWN_VALUE}"\n---\nUse {env:OPENCODE_TEST_MARKDOWN_VALUE} and {env:OPENCODE_TEST_MARKDOWN_MISSING}.`,
    )
    delete process.env.OPENCODE_TEST_MARKDOWN_VALUE

    expect(parsed.data.description).toBe("configured")
    expect(parsed.content.trim()).toBe("Use configured and .")
  })
})
