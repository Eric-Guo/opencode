import { searchProcess } from "./search-process"
import { Schema } from "effect"
import { dirname } from "node:path"

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
  const executable = Bun.which("rg", { PATH: process.env.PATH })
  if (!executable)
    return {
      error:
        "ripgrep (rg) was not found on PATH. Install ripgrep (e.g. brew install ripgrep or apt install ripgrep) to use grep",
    }

  const child = await searchProcess(
    executable,
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
    dirname(path),
    signal,
    10,
  )
  const matches: { path: string; line: number; text?: string }[] = []
  let count = 0
  let oversized = 0
  for await (const record of child.records()) {
    if (record.overflow) oversized++
    if (!record.overflow) {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Event))(record.content.toString())
      if (decoded._tag === "Some" && decoded.value.type === "match") {
        count++
        const data = decoded.value.data
        if (data?.path?.text && data.line_number !== undefined)
          matches.push({ path: data.path.text, line: data.line_number, text: data.lines?.text })
      }
    }
    if (count >= limit) break
  }
  const outcome = await child.result
  signal.throwIfAborted()
  if (count < limit && outcome.status !== 0 && outcome.status !== 1)
    return { error: outcome.stderr || "ripgrep exited with code " + outcome.status }

  return { matches, count, oversized, limitReached: count >= limit }
}
