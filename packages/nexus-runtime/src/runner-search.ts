import { lstat, open } from "node:fs/promises"
import { basename, relative } from "node:path"
import { Schema } from "effect"
import type { CommitTask, JsonObject } from "@cybros/agent"
import { grepMatches } from "./runner-grep"
import { findFiles } from "./runner-find"
import { readablePath } from "./file-read"

const Input = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
  glob: Schema.optional(Schema.String),
  include: Schema.optional(Schema.String),
  ignoreCase: Schema.optional(Schema.Boolean),
  literal: Schema.optional(Schema.Boolean),
  context: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
})

export async function runnerSearch(
  root: string,
  name: "grep" | "find",
  input: JsonObject,
  signal: AbortSignal,
): Promise<Omit<CommitTask, "claim_token">> {
  const args = Schema.decodeUnknownSync(Input)(input)
  const path = await readablePath(root, args.path || ".")
  const info = await lstat(path)
  const limit = args.limit ?? (name === "grep" ? 100 : 1000)
  if (name === "find") {
    if (!info.isDirectory()) throw new Error("Expected a search directory.")
    return findFiles(path, args.pattern, limit, signal)
  }
  if (limit > 500) throw new Error("Grep limit must not exceed 500.")
  const result = await grepMatches(path, { ...args, glob: args.glob ?? args.include }, limit, signal)
  if ("error" in result) return { is_error: true, content: result.error }
  const matches = result.matches
  const skipped = result.oversized
    ? result.oversized + " match(es) skipped: output line over 51200 bytes. Use read tool on the file instead"
    : ""
  if (!result.count)
    return {
      content: skipped ? "No matches found\n\n[" + skipped + "]" : "No matches found in " + path,
      ...(result.oversized ? { structured_content: { oversized_lines_skipped: result.oversized } } : {}),
    }
  const context = args.context ?? 0
  let clipped = false
  const trim = (text: string) => {
    const line = text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "")
    const characters = Array.from(line)
    if (characters.length <= 500) return line
    clipped = true
    return characters.slice(0, 500).join("") + "... [truncated]"
  }
  const files = [...new Set(matches.filter((match) => context || match.text === undefined).map((match) => match.path))]
  const windows = new Map<string, Map<number, string>>()
  if (files.length)
    for (const file of files)
      windows.set(
        file,
        await contextLines(
          file,
          matches
            .filter((match) => match.path === file)
            .map((match) => [Math.max(1, match.line - context), match.line + context]),
          signal,
        ).catch(() => {
          signal.throwIfAborted()
          return new Map<number, string>()
        }),
      )
  const lines = matches.flatMap((match) => {
    const from = relative(path, match.path)
    const display = info.isDirectory() && from && !from.startsWith("..") ? from : basename(match.path)
    if (!context && match.text !== undefined) return [display + ":" + match.line + ": " + trim(match.text)]
    const lines = windows.get(match.path)!
    if (!lines?.has(match.line)) return [display + ":" + match.line + ": (unable to read file)"]
    return Array.from({ length: context * 2 + 1 }, (_, index) => match.line - context + index).flatMap((line) => {
      const text = lines.get(line)
      const separator = line === match.line ? ":" : "-"
      return text === undefined ? [] : [display + separator + line + separator + " " + trim(text)]
    })
  })
  const rendered = bounded(lines)
  const notices = [
    result.limitReached
      ? `${limit} matches limit reached. ${limit < 500 ? "Use limit=" + Math.min(500, limit * 2) + " for more, or refine pattern" : "Refine pattern to reduce matches"}`
      : "",
    rendered.truncated ? "50 KiB limit reached" : "",
    clipped ? "Some lines truncated to 500 chars. Use read tool to see full lines" : "",
    skipped,
  ].filter(Boolean)
  return {
    content: rendered.content + (notices.length ? "\n\n[" + notices.join(". ") + "]" : ""),
    structured_content: {
      match_limit_reached: result.limitReached,
      lines_truncated: clipped,
      truncated: rendered.truncated,
      ...(result.oversized ? { oversized_lines_skipped: result.oversized } : {}),
    },
  }
}

function bounded(lines: string[]) {
  let bytes = 0
  const content: string[] = []
  for (const line of lines) {
    const cost = Buffer.byteLength(line) + (content.length ? 1 : 0)
    if (bytes + cost > 51200) return { content: content.join("\n"), truncated: true }
    bytes += cost
    content.push(line)
  }
  return { content: content.join("\n"), truncated: false }
}

async function contextLines(path: string, ranges: number[][], signal: AbortSignal) {
  const lines = new Map<number, string>()
  const last = Math.max(...ranges.map((range) => range[1]))
  const file = await open(path, "r")
  let line = 1
  let current = Buffer.alloc(0)
  let carriage = false
  const finish = () => {
    if (ranges.some(([from, to]) => line >= from && line <= to)) lines.set(line, current.toString())
    line++
    current = Buffer.alloc(0)
  }
  try {
    const chunk = Buffer.alloc(16384)
    while (line <= last) {
      signal.throwIfAborted()
      const result = await file.read(chunk, 0, chunk.length)
      if (!result.bytesRead) {
        finish()
        break
      }
      for (const byte of chunk.subarray(0, result.bytesRead)) {
        if (carriage && byte === 10) {
          carriage = false
          continue
        }
        carriage = byte === 13
        if (byte === 10 || byte === 13) {
          finish()
          if (line > last) break
          continue
        }
        if (current.length < 2004 && ranges.some(([from, to]) => line >= from && line <= to))
          current = Buffer.concat([current, Buffer.from([byte])])
      }
    }
    return lines
  } finally {
    await file.close()
  }
}
