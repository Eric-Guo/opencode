import { expect, test } from "bun:test"
import { telegramPreview, telegramRender } from "../src/telegram-render"

test("Telegram renders Markdown with literal HTML, safe links and identical visible fallback", () => {
  const chunks = telegramRender(
    "# Heading\n\n**bold** and *italic* with ~~gone~~ &copy; &amp; <b>raw</b>.\n\n[good](https://example.test/?a=1&b=2) [bad](javascript:alert)\n\n```ts\na < b\n```\n",
  )
  expect(chunks).toHaveLength(1)
  expect(chunks[0].text).toBe(
    "Heading\n\nbold and italic with gone © & <b>raw</b>.\n\ngood bad (javascript:alert)\n\na < b\n",
  )
  expect(chunks[0].html).toContain("<b>Heading</b>")
  expect(chunks[0].html).toContain("&lt;b&gt;raw&lt;/b&gt;")
  expect(chunks[0].html).toContain('<a href="https://example.test/?a=1&amp;b=2">good</a>')
  expect(chunks[0].html).not.toContain('href="javascript:')
  expect(chunks[0].html).toContain('<pre><code class="language-ts">a &lt; b\n</code></pre>')
})

test("Telegram Markdown chunks preserve graphemes and balance each chunk's formatting", () => {
  const source = "👩‍👩‍👧‍👦".repeat(20)
  const chunks = telegramRender("**" + source + "**", 32)
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(source)
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(32)
    expect(chunk.text.length % "👩‍👩‍👧‍👦".length).toBe(0)
    expect(chunk.html).toBe("<b>" + chunk.text + "</b>")
  }
  const pathological = "a" + "\u0301".repeat(100)
  expect(
    telegramRender(pathological, 32)
      .map((chunk) => chunk.text)
      .join(""),
  ).toBe(pathological)
  expect(telegramRender("**literal**\n\n", 32, true)).toEqual([{ text: "**literal**\n\n", html: "**literal**\n\n" }])
})

test("Telegram flattens tables and task lists without injecting unsupported tags", () => {
  const output = telegramRender("- [x] Ready\n- [ ] Waiting\n\n| Name | State |\n| --- | --- |\n| **A** | Fine |")[0]
  expect(output.text).toBe("• [x] Ready\n• [ ] Waiting\n\nName | State\nA | Fine")
  expect(output.html).not.toContain("<table")
  expect(output.html).not.toContain("<input")
})

test("Telegram prefers late paragraph boundaries and limits previews without splitting graphemes", () => {
  const paragraph = "a".repeat(18) + "\n\n" + "b".repeat(20)
  expect(telegramRender(paragraph, 32, true).map((row) => row.text)).toEqual([
    "a".repeat(18) + "\n",
    "\n" + "b".repeat(20),
  ])
  const line = "a".repeat(18) + "\n" + "b".repeat(20)
  expect(telegramRender(line, 32, true).map((row) => row.text)).toEqual(["a".repeat(18) + "\n", "b".repeat(20)])
  expect(telegramPreview("👩‍👩‍👧‍👦".repeat(3), 20)).toBe("👩‍👩‍👧‍👦…")
})
