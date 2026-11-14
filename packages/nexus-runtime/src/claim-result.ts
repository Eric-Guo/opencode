import type { CommitTask, JsonValue } from "@cybros/agent"

export type ClaimResult = Omit<CommitTask, "claim_token" | "outcome"> & { outcome: "completed" | "failed" }

// Nexus's snapshot bound is 1 MiB. Reserve 64 KiB for the settlement envelope.
const bound = 1048576 - 65536
const truncated = "\n\n[result truncated to fit the server's size bound]"

export function claimResult(result: ClaimResult): ClaimResult {
  const escaped = { nul: false }
  const content = storable(result.content ?? "", escaped)
  const output: ClaimResult = {
    ...result,
    content: escaped.nul
      ? append(content, "\n\n[U+0000 bytes in this output are written as \\u0000: the kernel stores none]")
      : content,
    ...(result.structured_content === undefined ? {} : { structured_content: storable(result.structured_content) }),
    ...(result.metadata
      ? {
          metadata: Object.fromEntries(
            Object.entries(result.metadata).map(([key, value]) => [text(key), storable(value)]),
          ),
        }
      : {}),
    ...(result.title === undefined ? {} : { title: text(result.title) }),
  }
  if (fits(output)) return output

  if (output.structured_content !== undefined) {
    delete output.structured_content
    output.content = append(
      output.content!,
      "\n\n[structured content omitted: the result exceeded the server's size bound]",
    )
  }
  if (fits(output)) return output

  const value =
    typeof output.content === "string"
      ? output.content
      : Array.isArray(output.content)
        ? output.content
            .flatMap((block) =>
              block &&
              typeof block === "object" &&
              !Array.isArray(block) &&
              block.type === "text" &&
              typeof block.text === "string"
                ? [block.text]
                : [],
            )
            .join("\n")
        : JSON.stringify(output.content)
  let low = 0
  let high = value.length
  while (low < high) {
    const length = Math.ceil((low + high) / 2)
    if (fits({ content: value.slice(-length).toWellFormed() + truncated })) {
      low = length
      continue
    }
    high = length - 1
  }
  return { ...output, content: (low ? value.slice(-low).toWellFormed() : "") + truncated }
}

function fits(result: Pick<ClaimResult, "content" | "structured_content">) {
  return (
    Buffer.byteLength(JSON.stringify({ content: result.content, structured_content: result.structured_content })) <=
    bound
  )
}

function append(value: JsonValue, note: string): JsonValue {
  return typeof value === "string"
    ? value + note
    : Array.isArray(value)
      ? [...value, { type: "text", text: note }]
      : JSON.stringify(value) + note
}

function text(value: string) {
  return value.toWellFormed().replaceAll("\0", "\\u0000")
}

function storable(value: JsonValue, escaped?: { nul: boolean }): JsonValue {
  if (typeof value === "string") {
    if (escaped && value.includes("\0")) escaped.nul = true
    return text(value)
  }
  if (Array.isArray(value)) return value.map((entry) => storable(entry, escaped))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [text(key), storable(entry, escaped)]))
}
