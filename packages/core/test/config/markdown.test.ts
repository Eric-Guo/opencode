import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"

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
