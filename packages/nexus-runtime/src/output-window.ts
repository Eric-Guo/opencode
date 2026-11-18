const maxBytes = 50 * 1024
const maxLines = 2000

export function outputHead(text: string) {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()

  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const cost = Buffer.byteLength(line) + (kept.length ? 1 : 0)
    if (kept.length === maxLines || bytes + cost > maxBytes) break

    bytes += cost
    kept.push(line)
  }

  return {
    text: kept.join("\n"),
    truncation:
      kept.length < lines.length
        ? {
            truncated: true,
            truncated_by: kept.length === maxLines ? "lines" : "bytes",
            total_bytes: Buffer.byteLength(text),
            total_lines: lines.length,
            output_bytes: bytes,
            output_lines: kept.length,
            first_line_exceeds_limit: !kept.length,
            last_line_partial: false,
            max_bytes: maxBytes,
            max_lines: maxLines,
          }
        : null,
  }
}
