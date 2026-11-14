import type { JsonObject } from "@cybros/agent"
import { createHash } from "node:crypto"
import { copyFile, mkdir, open } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Render Rho's fixed tail window from OpenCode's complete, file-backed shell capture. */
export async function bashOutput(
  path: string,
  signal: AbortSignal,
  artifacts = dirname(path),
): Promise<{ content: string; spill?: string; details: JsonObject }> {
  const file = await open(path, "r")
  const hash = createHash("sha256")
  let tail = Buffer.alloc(0)
  let boundary = true
  let total = 0
  let completed = 0
  let lastLineBytes = 0
  let openLine = false
  try {
    const chunk = Buffer.alloc(65536)
    while (true) {
      signal.throwIfAborted()
      const read = await file.read(chunk, 0, chunk.length)
      if (!read.bytesRead) break
      const bytes = chunk.subarray(0, read.bytesRead)
      hash.update(bytes)
      total += bytes.length
      for (const byte of bytes) {
        if (byte === 10) {
          completed++
          lastLineBytes = 0
          openLine = false
          continue
        }
        lastLineBytes++
        openLine = true
      }
      tail = Buffer.concat([tail, bytes])
      if (tail.length > 204800) {
        let start = tail.length - 102400
        while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++
        boundary = tail[start - 1] === 10
        tail = tail.subarray(start)
      }
    }
  } finally {
    await file.close()
  }
  const newline = tail.indexOf(10)
  const text = (!boundary && newline >= 0 ? tail.subarray(newline + 1) : tail).toString()
  const all = text.split("\n")
  if (text.endsWith("\n")) all.pop()
  const kept: string[] = []
  let size = 0
  let axis: "bytes" | "lines" | undefined
  let partial = false
  for (const line of all.toReversed()) {
    if (kept.length >= 2000) {
      axis = "lines"
      break
    }
    const cost = Buffer.byteLength(line) + (kept.length ? 1 : 0)
    if (size + cost > 51200) {
      axis = "bytes"
      break
    }
    kept.unshift(line)
    size += cost
  }
  if (!kept.length && all.length) {
    const bytes = Buffer.from(all.at(-1)!)
    let at = Math.max(0, bytes.length - 51200)
    while (at < bytes.length && (bytes[at] & 0xc0) === 0x80) at++
    const line = bytes.subarray(at).toString()
    kept.push(line)
    size = Buffer.byteLength(line)
    partial = true
  }
  const totalLines = completed + (openLine ? 1 : 0)
  const truncated = total > 51200 || totalLines > 2000
  const content = kept.join("\n")
  if (!truncated) return { content, spill: undefined, details: {} }
  const spill = join(artifacts, "bash-" + hash.digest("hex").slice(0, 16) + ".log")
  await mkdir(artifacts, { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
  await copyFile(path, spill)
  const truncatedBy = axis ?? (total > 51200 ? "bytes" : "lines")
  const footer = partial
    ? `Showing last ${formatSize(size)} of line ${totalLines} (line is ${formatSize(lastLineBytes)}). Full output: ${spill}`
    : `Showing lines ${totalLines - kept.length + 1}-${totalLines} of ${totalLines}${truncatedBy === "bytes" ? " (50.0KB limit)" : ""}. Full output: ${spill}`
  return {
    content: content + "\n\n[" + footer + "]",
    spill,
    details: {
      spill_path: spill,
      truncation: {
        truncated,
        truncated_by: truncatedBy,
        total_lines: totalLines,
        total_bytes: total,
        output_lines: kept.length,
        output_bytes: size,
        last_line_partial: partial,
        first_line_exceeds_limit: false,
        max_lines: 2000,
        max_bytes: 51200,
      },
    },
  }
}

function formatSize(bytes: number) {
  return bytes < 1024
    ? bytes + "B"
    : bytes < 1048576
      ? (bytes / 1024).toFixed(1) + "KB"
      : (bytes / 1048576).toFixed(1) + "MB"
}
