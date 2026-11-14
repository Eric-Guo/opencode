import { spawn } from "node:child_process"
import { Schema } from "effect"

const Event = Schema.Struct({
  type: Schema.String,
  data: Schema.optional(
    Schema.Struct({
      path: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
      lines: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
      line_number: Schema.optional(Schema.Int),
    }),
  ),
})

/** Bound each rg JSON event before parsing, so one giant match cannot fail the whole search. */
export async function grepMatches(
  path: string,
  input: { pattern: string; glob?: string; literal?: boolean; ignoreCase?: boolean },
  limit: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const child = spawn(
    "rg",
    [
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
      ...(input.ignoreCase ? ["--ignore-case"] : []),
      ...(input.literal ? ["--fixed-strings"] : []),
      ...(input.glob ? ["--glob", input.glob] : []),
      "--",
      input.pattern,
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true },
  )
  const ended = new Promise<{ status: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ status: null, error }))
    child.once("close", (status) => resolve({ status }))
  })
  let stderr = Buffer.alloc(0)
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-8192)
  })
  const matches: { path: string; line: number; text?: string }[] = []
  let count = 0
  let oversized = 0
  let prefix = Buffer.alloc(0)
  let overflow = false
  const consume = (chunk: Buffer, complete: boolean) => {
    if (prefix.length + chunk.length > 51200) overflow = true
    if (!overflow) prefix = Buffer.concat([prefix, chunk])
    if (!complete) return
    if (overflow) oversized++
    if (!overflow) {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Event))(prefix.toString())
      if (decoded._tag === "Some" && decoded.value.type === "match") {
        count++
        const data = decoded.value.data
        if (data?.path?.text && data.line_number !== undefined)
          matches.push({ path: data.path.text, line: data.line_number, text: data.lines?.text })
      }
    }
    prefix = Buffer.alloc(0)
    overflow = false
  }
  try {
    for await (const chunk of child.stdout) {
      signal.throwIfAborted()
      const bytes = Buffer.from(chunk)
      let at = 0
      while (at < bytes.length && count < limit) {
        const newline = bytes.indexOf(10, at)
        consume(bytes.subarray(at, newline < 0 ? bytes.length : newline + 1), newline >= 0)
        at = newline < 0 ? bytes.length : newline + 1
      }
      if (count >= limit) {
        child.kill()
        break
      }
    }
    if (count < limit && (prefix.length || overflow)) consume(Buffer.alloc(0), true)
    const outcome = await ended
    signal.throwIfAborted()
    if (outcome.error || (count < limit && outcome.status !== 0 && outcome.status !== 1)) {
      if (outcome.error && "code" in outcome.error && outcome.error.code === "ENOENT")
        return {
          error:
            "ripgrep (rg) was not found on PATH. Install ripgrep (e.g. brew install ripgrep or apt install ripgrep) to use grep",
        }
      return {
        error: stderr.toString().trim() || outcome.error?.message || "ripgrep exited with code " + outcome.status,
      }
    }
    return { matches, count, oversized, limitReached: count >= limit }
  } finally {
    child.kill()
    await ended
  }
}
