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

  test("recovers a frontmatter value that starts with a bracketed tag", () => {
    const parsed = ConfigMarkdown.parse("---\ndescription: [Team] Does a thing\ntools: [read, edit]\n---\nbody")
    expect(parsed.data.description).toBe("[Team] Does a thing")
    expect(parsed.data.tools).toEqual(["read", "edit"])
  })

  test("preserves flow mappings and flow sequences when repairing another field", () => {
    const parsed = ConfigMarkdown.parse(`---
description: Review changes. Keywords: review, audit
model: { providerID: example, model: chat, variant: high }
tools: { edit: false }
metadata: { "opencode/autoinvoke": false }
permissions: [{ action: edit, resource: "*", effect: deny }]
---
body`)
    expect(parsed.data.description).toBe("Review changes. Keywords: review, audit")
    expect(parsed.data.model).toEqual({ providerID: "example", model: "chat", variant: "high" })
    expect(parsed.data.tools).toEqual({ edit: false })
    expect(parsed.data.metadata).toEqual({ "opencode/autoinvoke": false })
    expect(parsed.data.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
    expect(parsed.content.trim()).toBe("body")
  })

  test("preserves nested flow collections, quoted delimiters, and inline comments during repair", () => {
    const parsed = ConfigMarkdown.parse(`---
description: Review changes. Keywords: review, audit
nested: [[read], [edit]]
tools: [read, edit] # comment: with colon
quoted: ["a]b", 'c''}d', don't]
---
body`)
    expect(parsed.data.description).toBe("Review changes. Keywords: review, audit")
    expect(parsed.data.nested).toEqual([["read"], ["edit"]])
    expect(parsed.data.tools).toEqual(["read", "edit"])
    expect(parsed.data.quoted).toEqual(["a]b", "c'}d", "don't"])
  })

  test("preserves multi-line flow collections while repairing fields before and after", () => {
    const parsed = ConfigMarkdown.parse(`---
description: Review changes. Keywords: review, audit
model: { providerID: example, # note: don't close } here
  model: chat,
  variant: high
} # trailing: comment
permissions: [{ action: edit,
resource: "*",
effect: deny }]
note: Remember: check tests
---
body`)
    expect(parsed.data.description).toBe("Review changes. Keywords: review, audit")
    expect(parsed.data.model).toEqual({ providerID: "example", model: "chat", variant: "high" })
    expect(parsed.data.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
    expect(parsed.data.note).toBe("Remember: check tests")
  })

  test("recovers leading bracketed and braced tags with colons or apostrophes", () => {
    const parsed = ConfigMarkdown.parse(`---
description: [Team: Core] Does a thing
summary: {Team} Review changes
owner: [User's] Follow up
model: { providerID: example, model: chat }
---
body`)
    expect(parsed.data.description).toBe("[Team: Core] Does a thing")
    expect(parsed.data.summary).toBe("{Team} Review changes")
    expect(parsed.data.owner).toBe("[User's] Follow up")
    expect(parsed.data.model).toEqual({ providerID: "example", model: "chat" })
  })

  test("preserves flow collections with CRLF line endings during repair", () => {
    const parsed = ConfigMarkdown.parse(
      "---\r\ndescription: Review changes. Keywords: review, audit\r\nmodel: { providerID: example, model: chat }\r\n---\r\nbody",
    )
    expect(parsed.data.description).toBe("Review changes. Keywords: review, audit")
    expect(parsed.data.model).toEqual({ providerID: "example", model: "chat" })
  })

  test("keeps block scalar headers with commented colons during repair", () => {
    const parsed = ConfigMarkdown.parse(`---
description: Review changes. Keywords: review, audit
prompt: |- # see: docs
  Review carefully.
---
body`)
    expect(parsed.data.description).toBe("Review changes. Keywords: review, audit")
    expect(parsed.data.prompt).toBe("Review carefully.")
  })

  test("still throws on unclosed or mismatched flow collections", () => {
    expect(() => ConfigMarkdown.parse("---\nmodel: { providerID: example\n---\nbody")).toThrow()
    expect(() => ConfigMarkdown.parse("---\ndescription: [Tag} text\n---\nbody")).toThrow()
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
