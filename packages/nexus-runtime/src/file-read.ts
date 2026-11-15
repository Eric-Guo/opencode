import { ToolInputError } from "./tool-error"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

export function resolvePath(root: string, path: string) {
  return resolve(root, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path)
}

export async function readablePath(root: string, path: string) {
  const absolute = resolvePath(root, path)
  return realpath(absolute).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT" ||
      absolute.normalize("NFD") === absolute
    )
      throw error
    return realpath(absolute.normalize("NFD"))
  })
}

export async function readWindow(path: string, signal: AbortSignal, offset = 1, limit?: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new ToolInputError("Expected a regular file.")
    return await scanWindow(
      (async function* () {
        const chunk = Buffer.alloc(16384)
        while (true) {
          signal.throwIfAborted()
          const read = await file.read(chunk, 0, chunk.length)
          if (!read.bytesRead) return
          yield chunk.subarray(0, read.bytesRead)
        }
      })(),
      signal,
      offset,
      limit,
    )
  } finally {
    await file.close()
  }
}

export function readEditorWindow(content: string, signal: AbortSignal, offset = 1, limit = 2000) {
  if (!content && offset > 1) throw new ToolInputError(`Offset ${offset} is beyond end of file.`)
  return scanWindow(
    (async function* () {
      yield Buffer.from(content)
    })(),
    signal,
    1,
    limit,
    offset,
  )
}

/** Scan in fixed-size blocks, retaining only complete lines in the requested output window. */
async function scanWindow(
  chunks: AsyncIterable<Buffer>,
  signal: AbortSignal,
  offset = 1,
  limit?: number,
  editorOffset?: number,
) {
  const start = Math.max(1, offset)
  if (!Number.isSafeInteger(start) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)))
    throw new ToolInputError("Read offset and limit must be integers; limit must be positive.")
  const lines: string[] = []
  const maximum = 50 * 1024
  let line = 1
  let total = 0
  let bytes = 0
  let retained = 0
  let selectedLines = 0
  let selectedBytes = 0
  let prefix = Buffer.alloc(0)
  let firstBytes = 0
  let truncated: "bytes" | "lines" | undefined
  let ended = false
  let seen = false
  const selected = () => line >= start && (limit === undefined || line < start + limit)
  const finish = () => {
    total++
    if (selected()) {
      selectedLines++
      selectedBytes += bytes + (selectedLines > 1 ? 1 : 0)
      if (selectedLines === 1) firstBytes = bytes
      if (!truncated) {
        const text = prefix.toString("utf8")
        const size = Buffer.byteLength(text) + (lines.length ? 1 : 0)
        if (selectedLines === 1 && prefix.length === bytes) firstBytes = Buffer.byteLength(text)
        if (lines.length >= 2000) truncated = "lines"
        else if (prefix.length < bytes || retained + size > maximum) truncated = "bytes"
        else {
          lines.push(text)
          retained += size
        }
      }
    }
    line++
    bytes = 0
    prefix = Buffer.alloc(0)
  }
  signal.throwIfAborted()
  for await (const value of chunks) {
    signal.throwIfAborted()
    seen = true
    let at = 0
    while (at < value.length) {
      const newline = value.indexOf(10, at)
      const end = newline < 0 ? value.length : newline
      const piece = value.subarray(at, end)
      bytes += piece.length
      if (selected() && !truncated && prefix.length <= maximum - retained)
        prefix = Buffer.concat([prefix, piece.subarray(0, Math.max(0, maximum - retained + 1 - prefix.length))])
      ended = newline >= 0
      if (ended) finish()
      at = end + 1
    }
  }
  if (!seen || !ended) finish()
  if (start > total) throw new ToolInputError(`Offset ${start} is beyond end of file (${total} lines total).`)
  const from = editorOffset ?? start
  const next = from + lines.length
  const content =
    !lines.length && truncated === "bytes"
      ? `[Line ${from} is ${firstBytes} bytes, exceeds 50 KiB limit. Use bash to read a byte range.]`
      : lines.join("\n") +
        (editorOffset !== undefined
          ? truncated || total > (limit ?? 2000)
            ? `\n\n[Showing lines ${from}-${next - 1}${truncated === "bytes" ? " (50 KiB limit)" : ""}; more lines remain. Use offset=${next} to continue.]`
            : ""
          : truncated
            ? `\n\n[Showing lines ${from}-${next - 1} of ${total}${truncated === "bytes" ? " (50 KiB limit)" : ""}. Use offset=${next} to continue.]`
            : limit !== undefined && next <= total
              ? `\n\n[${total - next + 1} more lines in file. Use offset=${next} to continue.]`
              : "")
  return {
    content,
    ...(truncated
      ? {
          structured_content: {
            truncation: {
              truncated: true,
              truncated_by: truncated,
              output_lines: lines.length,
              output_bytes: retained,
              total_lines: selectedLines,
              total_bytes: selectedBytes,
              last_line_partial: false,
              first_line_exceeds_limit: !lines.length && truncated === "bytes",
              max_lines: 2000,
              max_bytes: maximum,
            },
          },
        }
      : {}),
  }
}
