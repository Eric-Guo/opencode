import { CodeMode, Tool } from "@opencode/codemode"
import { Effect, Schema } from "effect"
import { execute } from "./runner"

export async function runCode(directory: string, source: string, signal: AbortSignal) {
  const file = (name: "read" | "ls") =>
    Tool.make({
      description: name === "read" ? "Read a UTF-8 file" : "List a directory",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.String,
      execute: (input) =>
        Effect.tryPromise((inner) => execute(directory, name, input, AbortSignal.any([signal, inner]))),
    })
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: source,
      tools: { read: file("read"), ls: file("ls") },
      limits: { timeoutMs: 10000, maxToolCalls: 64, maxOutputBytes: 65536 },
    }),
    { signal },
  )
  if (!result.ok) throw new Error(result.error.message)
  return JSON.stringify(result.value)
}
