import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "@opencode/core/config/markdown"
import matter from "gray-matter"

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
  test.each([
    { name: "valid", frontmatter: 'description: "Agent: prompt"' },
    { name: "sanitized", frontmatter: "description: Agent: prompt" },
  ])("does not retain distinct revisions with $name frontmatter", ({ frontmatter }) => {
    // gray-matter exposes its process-global cache without declaring its type.
    const cache = (matter as typeof matter & { cache: Record<string, unknown> }).cache
    const count = Object.keys(cache).length

    Array.from({ length: 200 }, (_, index) => {
      const body = `Revision ${index}\n${"x".repeat(16 * 1024)}`
      const parsed = ConfigMarkdown.parse(`---\n${frontmatter}\n---\n${body}`)

      expect(parsed.data.description).toBe("Agent: prompt")
      expect(parsed.content).toBe(body)
    })

    expect(Object.keys(cache)).toHaveLength(count)
  })

  test("repeatedly parses frontmatter that needs sanitizing", () => {
    const content = "---\ndescription: Repeated: prompt\n---\nBody"
    expect(ConfigMarkdown.parse(content).data.description).toBe("Repeated: prompt")
    expect(ConfigMarkdown.parse(content).data.description).toBe("Repeated: prompt")
  })

  test("repeatedly rejects invalid frontmatter", () => {
    const content = "---\ndescription: [invalid\n---\nBody"
    expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
    expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
  })

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
