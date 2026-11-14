import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { CommitTask, JsonObject } from "@cybros/agent"
import { readablePath } from "./file-read"

export async function listDirectory(
  root: string,
  input: JsonObject,
  signal: AbortSignal,
): Promise<Omit<CommitTask, "claim_token">> {
  const path = await readablePath(root, typeof input.path === "string" ? input.path : ".")
  const limit = typeof input.limit === "number" ? input.limit : 500
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Listing limit must be a positive integer.")
  const entries = (await readdir(path)).sort((a, b) => {
    signal.throwIfAborted()
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0
  })
  const selected: string[] = []
  let entryLimit = false
  for (const entry of entries) {
    signal.throwIfAborted()
    if (selected.length >= limit) {
      entryLimit = true
      break
    }
    const info = await stat(join(path, entry)).catch(() => undefined)
    if (info) selected.push(entry + (info.isDirectory() ? "/" : ""))
  }
  if (!selected.length) return { content: "(empty directory: " + path + ")" }
  const lines: string[] = []
  let size = 0
  for (const line of selected) {
    const bytes = Buffer.byteLength(line) + (lines.length ? 1 : 0)
    if (size + bytes > 51200) break
    size += bytes
    lines.push(line)
  }
  const truncated = lines.length !== selected.length
  const notices = [
    entryLimit ? `${limit} entries limit reached. Use limit=${limit * 2} for more` : "",
    truncated ? "50.0KB limit reached" : "",
  ].filter(Boolean)
  return {
    content: lines.join("\n") + (notices.length ? "\n\n[" + notices.join(". ") + "]" : ""),
    ...(entryLimit || truncated
      ? {
          structured_content: {
            ...(entryLimit ? { entry_limit_reached: true } : {}),
            ...(truncated
              ? {
                  truncation: {
                    truncated: true,
                    truncated_by: "bytes",
                    total_lines: selected.length,
                    total_bytes: Buffer.byteLength(selected.join("\n")),
                    output_lines: lines.length,
                    output_bytes: size,
                    last_line_partial: false,
                    first_line_exceeds_limit: false,
                    max_lines: Number.MAX_SAFE_INTEGER,
                    max_bytes: 51200,
                  },
                }
              : {}),
          },
        }
      : {}),
  }
}
