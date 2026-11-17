import { lstat } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { searchProcess } from "./search-process"

export async function findFiles(path: string, glob: string, limit: number, signal: AbortSignal) {
  let parent = path
  let repository = false
  while (true) {
    if (
      await lstat(join(parent, ".git")).then(
        () => true,
        () => false,
      )
    ) {
      repository = true
      break
    }
    if (dirname(parent) === parent) break
    parent = dirname(parent)
  }
  const pattern = glob.includes("/") && !glob.startsWith("/") && !glob.startsWith("**/") ? "**/" + glob : glob
  const parameters = [
    "--glob",
    "--color=never",
    "--hidden",
    "--print0",
    ...(repository ? [] : ["--no-require-git"]),
    "--max-results",
    String(limit),
    ...(glob.includes("/") ? ["--full-path"] : []),
    "--",
    pattern,
    path,
  ]
  const executable = Bun.which("fd", { PATH: process.env.PATH }) ?? Bun.which("fdfind", { PATH: process.env.PATH })
  if (!executable)
    return { is_error: true, content: "fd not found on PATH (looked for fd, fdfind). Install fd to use find." }

  const child = await searchProcess(executable, parameters, path, signal, 0)
  const paths: string[] = []
  const display: string[] = []
  let count = 0
  let totalBytes = 0
  let outputBytes = 0
  let truncated = false
  let firstLineExceedsLimit = false
  for await (const record of child.records()) {
    if (record.overflow) return { is_error: true, content: "fd output record exceeded 51200 bytes" }
    if (!record.content.length) continue

    const raw = record.content.toString()
    const file = relative(path, raw) + (/[\\/]$/.test(raw) ? "/" : "")
    const line = JSON.stringify(file).slice(1, -1)
    const bytes = Buffer.byteLength(line)
    totalBytes += bytes + (count ? 1 : 0)
    count++
    if (!truncated) {
      const cost = bytes + (display.length ? 1 : 0)
      if (outputBytes + cost > 51200) {
        truncated = true
        firstLineExceedsLimit = display.length === 0
      }
      if (!truncated) {
        paths.push(file)
        display.push(line)
        outputBytes += cost
      }
    }
    if (count >= limit) break
  }
  const outcome = await child.result
  signal.throwIfAborted()
  if (!count && outcome.status !== 0)
    return { is_error: true, content: outcome.stderr || "fd exited with code " + outcome.status }

  const limitReached = count >= limit
  const notices = [
    limitReached
      ? `${limit} results limit reached. ${limit < 1000 ? "Use limit=" + Math.min(1000, limit * 2) + " for more, or refine pattern" : "Refine pattern or path to reduce results"}`
      : "",
    truncated ? "50.0KB limit reached" : "",
  ].filter(Boolean)
  return {
    content: count
      ? display.join("\n") + (notices.length ? "\n\n[" + notices.join(". ") + "]" : "")
      : "No files found matching pattern under " + path,
    structured_content: {
      limit_reached: limitReached,
      truncated,
      ...(paths.some((file, i) => file !== display[i]) ? { paths } : {}),
      ...(limitReached ? { result_limit_reached: true } : {}),
      ...(truncated
        ? {
            truncation: {
              truncated: true,
              truncated_by: "bytes",
              total_lines: count,
              total_bytes: totalBytes,
              output_lines: display.length,
              output_bytes: outputBytes,
              last_line_partial: false,
              first_line_exceeds_limit: firstLineExceedsLimit,
              max_lines: 2147483648,
              max_bytes: 51200,
            },
          }
        : {}),
    },
  }
}
