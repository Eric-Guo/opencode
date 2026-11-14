import { Lexer, type MarkedToken, type Token } from "marked"
import { decodeHTML } from "entities"

type Tag = readonly [string, string]
type Span = { text: string; tags: readonly Tag[] }

/** Split visible Unicode text, keeping every HTML chunk balanced and its plain fallback identical. */
export function telegramRender(source: string, limit = 4096, plain = false) {
  if (limit < 32) throw new Error("Telegram chunk size must be at least 32.")
  const spans: Span[] = []
  const append = (text: string, tags: readonly Tag[] = []) => {
    if (text) spans.push({ text, tags })
  }
  const styled = (tags: readonly Tag[], name: string) =>
    tags.some((tag) => tag[0] === "<" + name + ">") ? tags : [...tags, ["<" + name + ">", "</" + name + ">"] as const]
  const children = (tokens: readonly Token[], tags: readonly Tag[] = []) => {
    for (const token of tokens) render(token as MarkedToken, tags)
  }
  const blocks = (tokens: readonly Token[], tags: readonly Tag[] = []) => {
    for (const [index, token] of tokens.filter((token) => token.type !== "space" && token.type !== "def").entries()) {
      if (index) append("\n\n")
      render(token as MarkedToken, tags)
    }
  }
  const render = (token: MarkedToken, tags: readonly Tag[]) => {
    switch (token.type) {
      case "text":
        if (token.tokens) children(token.tokens, tags)
        else append(decodeHTML(token.text), tags)
        return
      case "escape":
        append(token.text, tags)
        return
      case "html":
        append(decodeHTML(token.text), tags)
        return
      case "paragraph":
        children(token.tokens, tags)
        return
      case "heading":
      case "strong":
        children(token.tokens, styled(tags, "b"))
        return
      case "em":
        children(token.tokens, styled(tags, "i"))
        return
      case "del":
        children(token.tokens, styled(tags, "s"))
        return
      case "codespan":
        append(token.text, [["<code>", "</code>"]])
        return
      case "code": {
        const language = token.lang?.split(/\s+/)[0] ?? ""
        append(token.text + "\n", [
          [
            "<pre><code" + (/^[a-zA-Z0-9_+.-]{1,64}$/.test(language) ? ' class="language-' + language + '"' : "") + ">",
            "</code></pre>",
          ],
        ])
        return
      }
      case "blockquote":
        blocks(token.tokens, styled(tags, "blockquote"))
        return
      case "br":
        append("\n", tags)
        return
      case "hr":
        append("———", tags)
        return
      case "checkbox":
        append(token.checked ? "[x] " : "[ ] ", tags)
        return
      case "image":
        append(decodeHTML(token.text) + " (" + decodeHTML(token.href) + ")", tags)
        return
      case "link": {
        const destination = decodeHTML(token.href)
        const url = URL.parse(destination)
        const safe =
          url &&
          ((["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password) ||
            (url.protocol === "mailto:" && !!url.pathname))
        children(token.tokens, safe ? [...tags, ['<a href="' + escape(destination) + '">', "</a>"]] : tags)
        if (!safe) append(" (" + destination + ")", tags)
        return
      }
      case "list":
        token.items.forEach((item, index) => {
          if (index) append("\n", tags)
          append(token.ordered ? String(Number(token.start) + index) + ". " : "• ", tags)
          if (item.task) append(item.checked ? "[x] " : "[ ] ", tags)
          blocks(
            item.tokens.filter((token) => token.type !== "checkbox"),
            tags,
          )
        })
        return
      case "list_item":
        blocks(token.tokens, tags)
        return
      case "table":
        ;[token.header, ...token.rows].forEach((row, index) => {
          if (index) append("\n", tags)
          row.forEach((cell, column) => {
            if (column) append(" | ", tags)
            children(cell.tokens, tags)
          })
        })
        return
      case "space":
      case "def":
        return
    }
  }
  if (plain) append(source)
  else blocks(Lexer.lex(source, { gfm: true, breaks: false }))
  const trailing = source.match(/\n*$/)![0].length
  const ending = spans.at(-1)?.text.match(/\n*$/)?.[0].length ?? 0
  if (trailing > ending) append("\n".repeat(trailing - ending))
  const chunks: { text: string; html: string }[] = []
  const current = { text: "", html: "" }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const flush = () => {
    if (current.text) chunks.push({ ...current })
    current.text = ""
    current.html = ""
  }
  for (const span of spans) {
    let remaining = span.text
    while (remaining) {
      const budget = limit - current.text.length
      let length = 0
      for (const cluster of segmenter.segment(remaining)) {
        if (length + cluster.segment.length > budget) break
        length += cluster.segment.length
      }
      if (!length && !current.text) {
        for (const point of remaining) {
          if (length + point.length > budget) break
          length += point.length
        }
      }
      if (!length) {
        flush()
        continue
      }
      if (length < remaining.length) {
        const piece = remaining.slice(0, length)
        const count = [...piece].length
        const paragraph = piece.lastIndexOf("\n\n")
        const boundary =
          paragraph < 0 || [...piece.slice(0, paragraph)].length < count / 2 ? piece.lastIndexOf("\n") : paragraph
        if (boundary >= 0 && [...piece.slice(0, boundary)].length >= count / 2) length = boundary + 1
      }
      const piece = remaining.slice(0, length)
      current.text += piece
      current.html +=
        span.tags.map((tag) => tag[0]).join("") +
        escape(piece) +
        span.tags
          .toReversed()
          .map((tag) => tag[1])
          .join("")
      remaining = remaining.slice(length)
      if (remaining) flush()
    }
  }
  flush()
  return chunks
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export function telegramPreview(source: string, limit = 800) {
  if (source.length <= limit) return source
  let length = 0
  for (const cluster of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source)) {
    if (length + cluster.segment.length > Math.max(limit - 1, 0)) break
    length += cluster.segment.length
  }
  return limit > 0 ? source.slice(0, length) + "…" : ""
}
