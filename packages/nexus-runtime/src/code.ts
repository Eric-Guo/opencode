import type { JsonObject, JsonValue } from "@cybros/agent"
import { CodeMode, Extension, Tool } from "@opencode/codemode"
import { Effect, Schema } from "effect"
import { compileToolSchema, toolInputRefusal } from "./tool-schema"
import { isDeepStrictEqual } from "node:util"
import { OperationRefused, type CodeOperation } from "./claim-control"
import { codeBinding } from "./code-settings"

const Declaration = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  canonical: Schema.optional(Schema.String),
  input_schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  parameters: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  function: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      canonical: Schema.optional(Schema.String),
      parameters: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
  route: Schema.optional(Schema.Struct({ kind: Schema.String, tool_name: Schema.optional(Schema.String) })),
})
const Input = Schema.Record(Schema.String, Schema.MutableJson)

/** Native OpenCode language semantics; Nexus remains the owner of every accepted operation. */
export async function runCode(
  source: string,
  params: JsonValue,
  declarations: JsonValue[],
  operation: CodeOperation,
  signal: AbortSignal,
  defaults: JsonObject = {},
  limits: CodeMode.ExecutionLimits = {},
) {
  if (Buffer.byteLength(source) > 262144) throw new Error("Code source exceeds 256 KiB.")
  if (Buffer.byteLength(JSON.stringify({ source, params, declarations, defaults })) > 8388608)
    throw new Error("Code context exceeds 8 MiB.")

  const bindings: Array<Schema.Json | undefined> = []
  const catalog = declarations.flatMap((entry) => {
    const declared = Schema.decodeUnknownOption(Declaration)(entry)
    if (declared._tag === "None") return []
    const row = declared.value
    const name = row.function?.name ?? row.name
    const canonical =
      row.route?.kind === "mcp" ? undefined : (row.route?.tool_name ?? row.canonical ?? row.function?.canonical ?? name)
    if (canonical === "code") {
      bindings.push((row.function?.parameters ?? row.parameters ?? row.input_schema)?.$id)
      return []
    }
    if (!name) throw new Error("Invalid tool declaration.")
    const schema = row.function?.parameters ?? row.parameters ?? row.input_schema
    return [
      {
        name,
        description: row.function?.description ?? row.description ?? name,
        input: (schema ?? { type: "object" }) as Tool.JsonSchema,
        validator: compileToolSchema(schema ?? { type: "object" }),
      },
    ]
  })
  const names = catalog.map((entry) => entry.name)
  if (!bindings.length || bindings.some((binding) => binding !== codeBinding))
    throw new Error(
      "unsupported_binding: The frozen code binding is unsupported; create new work with the current declaration.",
    )
  if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in the frozen catalog.")

  signal.throwIfAborted()
  const owner = new AbortController()
  const active = AbortSignal.any([signal, owner.signal])
  const state: { next: number; failure?: unknown; selected?: JsonValue } = { next: 0 }
  const content: JsonObject[] = []
  const outputLimit = Math.min(limits.maxOutputBytes ?? 1048576, 1048576)
  const append = (block: JsonObject) => {
    if (Buffer.byteLength(JSON.stringify([...content, block])) > outputLimit)
      throw new Error("Code output exceeds its byte limit.")

    content.push(block)
  }
  const resources = new Map<string, JsonObject>()
  const accepting = new Set<Promise<unknown>>()
  const pending = new Map<string, { outcome: Promise<JsonValue>; settled: boolean; released: boolean }>()
  const modelTools = Array.isArray(defaults.tools)
    ? defaults.tools.filter((name): name is string => typeof name === "string" && names.includes(name))
    : names
  const start = async (value: unknown) => {
    active.throwIfAborted()
    const request = prepareOperation(Schema.decodeUnknownSync(Input)(value), names, modelTools)
    if (Buffer.byteLength(JSON.stringify(request)) > 1048576) throw new Error("Operation request exceeds 1 MiB.")
    const key = "op_" + state.next++
    const acceptance = operation(key, request).catch((error: unknown) => {
      state.failure = error
      owner.abort(error)
      throw error
    })
    accepting.add(acceptance)
    const accepted = await acceptance.finally(() => accepting.delete(acceptance))
    if (
      accepted.event.type !== "operation" ||
      accepted.event.key !== key ||
      !isDeepStrictEqual(accepted.event.request, request) ||
      !!accepted.event.receipt === !!accepted.event.refusal
    ) {
      const error = new Error("Accepted operation differs from the pending request or has no receipt/refusal.")
      state.failure = error
      owner.abort(error)
      throw error
    }
    const entry = { outcome: Promise.resolve<JsonValue>(null), settled: false, released: false }
    entry.outcome = accepted.outcome
      .then((outcome) => {
        entry.settled = true
        if (Buffer.byteLength(JSON.stringify(outcome)) > 8388608) throw new Error("Operation events exceed 8 MiB.")
        if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
          for (const block of Array.isArray(outcome.content) ? outcome.content : []) {
            if (block && typeof block === "object" && !Array.isArray(block) && block.type === "resource_link")
              resources.set(String(block.uri), block)
          }
          if (request.kind === "background" && outcome.status === "completed" && !outcome.is_error)
            for (const released of Array.isArray(outcome.released_operations) ? outcome.released_operations : []) {
              const target = typeof released === "string" ? pending.get(released) : undefined
              if (!target) throw new Error("Background receipt names an unknown operation.")
              target.released = true
            }
        }
        return outcome
      })
      .catch((error: unknown) => {
        entry.settled = true
        if (!(error instanceof OperationRefused)) {
          state.failure = error
          owner.abort(error)
        }
        throw error
      })
    void entry.outcome.catch(() => {})
    pending.set(key, entry)
    return { operation_key: key }
  }
  const wait = (value: unknown) => {
    const input = Schema.decodeUnknownSync(Schema.Struct({ operation_key: Schema.String }))(value)
    const entry = pending.get(input.operation_key)
    if (!entry) throw new Error("Unknown operation: " + input.operation_key)
    return entry.outcome
  }
  const invoke = async (request: JsonObject) => wait(await start(request))
  const runtime = CodeMode.make({
    onConsole: (text) => append({ type: "text", text }),
    tools: Object.fromEntries(
      catalog.map((entry) => [
        entry.name,
        Tool.make({
          description: entry.description,
          input: entry.input,
          output: Schema.MutableJson,
          execute: (input) =>
            Effect.tryPromise({
              try: () => {
                const args = Schema.decodeUnknownSync(Input)(input)
                const invalid = toolInputRefusal(entry.validator, args)
                if (invalid) throw new Error("InvalidToolInput: " + invalid)
                return invoke({ kind: "tool", name: entry.name, input: args })
              },
              catch: (error) => error,
            }),
        }),
      ]),
    ),
    extensions: [
      Extension.make({
        name: "nexus",
        globals: {
          nexus: {
            start,
            wait: Extension.async(wait),
            ...Object.fromEntries(
              ["model", "ask", "steps", "replace", "cancel", "join", "background"].map((kind) => [
                kind,
                async (input: JsonValue = {}) => invoke({ kind, input }),
              ]),
            ),
          },
          text(value: unknown) {
            append({ type: "text", text: Schema.decodeUnknownSync(Schema.String)(value) })
          },
          value(output: unknown) {
            const selected = Schema.decodeUnknownSync(Schema.MutableJson)(output)
            if (Buffer.byteLength(JSON.stringify(selected)) > outputLimit)
              throw new Error("Code output exceeds its byte limit.")

            state.selected = selected
          },
          resource(value: unknown) {
            const block = Schema.decodeUnknownSync(Input)(value)
            const observed = typeof block.uri === "string" ? resources.get(block.uri) : undefined
            if (
              !observed ||
              Object.entries(block).some(([key, value]) => key !== "type" && !isDeepStrictEqual(observed[key], value))
            )
              throw new Error("Resource was not observed by this invocation.")
            append({ ...block, type: "resource_link" })
          },
        },
      }),
    ],
    limits: { timeoutMs: 600000, maxOutputBytes: 1048576, ...limits },
  })
  try {
    const result = await Effect.runPromise(runtime.execute(source, { params }), { signal: active }).catch(
      (error: unknown) => {
        if (state.failure) throw state.failure
        signal.throwIfAborted()
        throw error
      },
    )
    if (state.failure) throw state.failure
    if (!result.ok) throw new Error(result.error.kind + ": " + result.error.message)
    const output = {
      content,
      structured_content: result.valueAbsent
        ? (state.selected ?? null)
        : Schema.decodeUnknownSync(Schema.MutableJson)(result.value),
      ...(result.truncated || result.warnings?.length
        ? {
            metadata: {
              ...(result.truncated ? { truncated: true } : {}),
              ...(result.warnings?.length
                ? { warnings: result.warnings.map((warning) => ({ kind: warning.kind, message: warning.message })) }
                : {}),
            },
          }
        : {}),
    }
    if (Buffer.byteLength(JSON.stringify(output)) > outputLimit) throw new Error("Code output exceeds its byte limit.")

    return output
  } finally {
    if (!signal.aborted) await Promise.allSettled([...accepting])
    // Ending the interpreter interrupts local waits. Cancel only work still owned by this invocation.
    if (!signal.aborted && !state.failure)
      await Promise.all(
        [...pending]
          .filter(([, entry]) => !entry.settled && !entry.released)
          .map(([key]) => operation("op_" + state.next++, { kind: "cancel", input: { operation_key: key } })),
      )
    owner.abort()
  }
}

function prepareOperation(request: JsonObject, names: string[], modelTools: string[]): JsonObject {
  const model = (value: JsonValue | undefined) => {
    const input = Schema.decodeUnknownSync(Input)(value)
    const tools =
      input.tools === undefined ? modelTools : Schema.decodeUnknownSync(Schema.Array(Schema.String))(input.tools)
    if (tools.some((name) => !names.includes(name))) throw new Error("Tool is outside this program's callable catalog.")
    return { ...input, tools: [...tools] }
  }
  const steps = (value: JsonValue): JsonValue => {
    if (!Array.isArray(value)) return value
    return value.map((value): JsonValue => {
      if (Array.isArray(value)) return steps(value)
      const step = Schema.decodeUnknownSync(Input)(value)
      if (step.tool !== undefined) {
        const tool = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(step.tool)
        if (!names.includes(tool.name)) throw new Error("Tool is outside this program's callable catalog.")
      }
      return {
        ...step,
        ...(step.model === undefined ? {} : { model: model(step.model) }),
        ...(step.parallel === undefined ? {} : { parallel: steps(step.parallel) }),
      }
    })
  }
  if (request.kind === "tool") {
    if (typeof request.name !== "string" || !names.includes(request.name))
      throw new Error("Tool is outside this program's callable catalog.")
    return request
  }
  if (request.kind === "model") return { ...request, input: model(request.input) }
  if (["steps", "replace", "background"].includes(String(request.kind))) {
    const input = Array.isArray(request.input)
      ? { steps: request.input }
      : Schema.decodeUnknownSync(Input)(request.input)
    return { ...request, input: { ...input, ...(input.steps === undefined ? {} : { steps: steps(input.steps) }) } }
  }
  return request
}
