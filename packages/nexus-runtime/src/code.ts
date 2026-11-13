import { CodeMode, Extension, Tool } from "@opencode/codemode"
import type { JsonObject, JsonValue } from "@cybros/agent"
import { Effect, Schema } from "effect"

const Input = Schema.Record(Schema.String, Schema.MutableJson)
const Declaration = Schema.Struct({
  function: Schema.Struct({ name: Schema.String }),
  route: Schema.optional(Schema.Struct({ kind: Schema.String, tool_name: Schema.optional(Schema.String) })),
})

export async function runCode(
  source: string,
  params: JsonValue,
  declarations: JsonValue[],
  operation: (key: string, request: JsonObject) => Promise<JsonValue>,
  signal: AbortSignal,
) {
  // Use only the declarations that Nexus captured when it accepted this parent task.
  const tools = Object.fromEntries(
    declarations.flatMap((entry) => {
      const declared = Schema.decodeUnknownOption(Declaration)(entry)
      if (declared._tag === "None") return []
      const fn = declared.value.function
      const route = declared.value.route
      if (fn.name === "code" || (route?.kind === "runner" && route.tool_name === "code")) return []
      return [
        [
          fn.name,
          Tool.make({
            description: fn.name,
            input: Input,
            output: Schema.MutableJson,
            execute: (input) =>
              Effect.tryPromise(async () => {
                const result = await operation("code_" + crypto.randomUUID(), { kind: "tool", name: fn.name, input })
                // Existing programs consume read and ls as text. Other tools retain the complete Nexus outcome.
                if (route?.kind === "runner" && ["read", "ls"].includes(route.tool_name ?? fn.name)) {
                  if (
                    !result ||
                    typeof result !== "object" ||
                    Array.isArray(result) ||
                    result.is_error ||
                    result.status !== "completed"
                  )
                    throw new Error("Runner read failed.")
                  if (typeof result.output === "string") return result.output
                  if (Array.isArray(result.content))
                    return result.content
                      .flatMap((block) =>
                        block && typeof block === "object" && !Array.isArray(block) && typeof block.text === "string"
                          ? [block.text]
                          : [],
                      )
                      .join("\n")
                }
                return result
              }),
          }),
        ] as const,
      ]
    }),
  )
  const permitted = ["ask", "model", "wait", "steps", "background", "join", "replace", "cancel"]
  const nexus = Object.fromEntries(
    permitted.map((kind) => [
      kind,
      async (value: unknown) =>
        operation("code_" + crypto.randomUUID(), { kind, input: Schema.decodeUnknownSync(Input)(value) }),
    ]),
  )
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: source,
      bindings: { params },
      tools,
      extensions: [Extension.make({ name: "nexus", globals: { nexus } })],
      limits: { timeoutMs: 600000, maxToolCalls: 64, maxOutputBytes: 65536 },
    }),
    { signal },
  )
  if (!result.ok) throw new Error(result.error.message)
  return JSON.stringify(result.value) ?? ""
}
