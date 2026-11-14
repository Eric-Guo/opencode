import type { JsonObject, JsonValue } from "@cybros/agent"
import { Schema } from "effect"
import { OperationRefused } from "./claim-control"
import { codeBinding } from "./code-settings"
import { codeDriver } from "./code-driver"

const Declaration = Schema.Struct({
  name: Schema.optional(Schema.String),
  canonical: Schema.optional(Schema.String),
  input_schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  parameters: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  function: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      canonical: Schema.optional(Schema.String),
      parameters: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
  route: Schema.optional(Schema.Struct({ kind: Schema.String, tool_name: Schema.optional(Schema.String) })),
})
const Input = Schema.Record(Schema.String, Schema.MutableJson)
const Output = Schema.Struct({
  content: Schema.Array(Input),
  structured_content: Schema.optional(Schema.MutableJson),
})

const Snapshot = Schema.Struct({
  status: Schema.Literals(["request", "observe", "finished", "failed"]),
  requests: Schema.Array(Schema.Struct({ key: Schema.String, request: Input })),
  pending: Schema.Array(Schema.String),
  result: Schema.NullOr(Output),
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
})

async function engine() {
  const { newQuickJSWASMModuleFromVariant } = await import("quickjs-emscripten-core")
  return newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-singlefile-cjs-release-sync"))
}
const shared: { engine?: ReturnType<typeof engine> } = {}

/** Each invocation owns an isolated heap. Host work never runs inside its computation budget. */
export async function runCode(
  source: string,
  params: JsonValue,
  declarations: JsonValue[],
  operation: (key: string, request: JsonObject) => Promise<JsonValue>,
  signal: AbortSignal,
  defaults: JsonObject = {},
  limits: { computeMs?: number; heapBytes?: number } = {},
) {
  const computeMs = limits.computeMs ?? 1000
  const heapBytes = limits.heapBytes ?? 64 * 1024 * 1024
  if (![computeMs, heapBytes].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error("Computation and heap limits must be positive integers.")
  if (Buffer.byteLength(source) > 262144) throw new Error("Code source exceeds 256 KiB.")
  if (Buffer.byteLength(JSON.stringify({ source, params, declarations, defaults })) > 8388608)
    throw new Error("Code context exceeds 8 MiB.")

  const bindings: Array<Schema.Json | undefined> = []
  const names = declarations.flatMap((entry) => {
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
    return [name]
  })
  if (!bindings.length || bindings.some((binding) => binding !== codeBinding))
    throw new Error(
      "unsupported_binding: The frozen code binding is unsupported; create new work with the current declaration.",
    )
  if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in the frozen catalog.")

  signal.throwIfAborted()
  const runtime = (await (shared.engine ??= engine())).newRuntime()
  runtime.setMemoryLimit(heapBytes)
  const context = runtime.newContext()
  const budget = { deadline: 0, interrupted: false }
  runtime.setInterruptHandler(() => {
    budget.interrupted = signal.aborted || performance.now() > budget.deadline
    return budget.interrupted
  })
  const evaluate = (code: string) => {
    signal.throwIfAborted()
    budget.deadline = performance.now() + computeMs
    budget.interrupted = false
    const result = context.evalCode(code)
    if (result.error) {
      const error = context.dump(result.error)
      result.error.dispose()
      signal.throwIfAborted()
      if (budget.interrupted) throw new Error("execution_limit: JavaScript execution exceeded its time limit")
      throw new Error("host_event_error: " + JSON.stringify(error))
    }
    try {
      while (runtime.hasPendingJob()) {
        signal.throwIfAborted()
        if (performance.now() > budget.deadline)
          throw new Error("execution_limit: JavaScript execution exceeded its time limit")
        const jobs = runtime.executePendingJobs(1)
        if (jobs.error) {
          const error = context.dump(jobs.error)
          jobs.error.dispose()
          throw new Error("host_event_error: " + JSON.stringify(error))
        }
      }
      signal.throwIfAborted()
      if (budget.interrupted) throw new Error("execution_limit: JavaScript execution exceeded its time limit")
      return context.typeof(result.value) === "string" ? context.getString(result.value) : "null"
    } finally {
      result.value.dispose()
    }
  }
  const capability = crypto.randomUUID() + crypto.randomUUID()
  const invoke = (command: string, value: JsonValue = null) =>
    evaluate(
      `JSON.stringify(__nexus_codemode(${JSON.stringify(capability)},${JSON.stringify(command)},${JSON.stringify(value)}))`,
    )
  const pending = new Map<string, Promise<JsonObject>>()
  const resources = new Map<string, JsonObject>()
  const aborted = Promise.withResolvers<never>()
  const cancel = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", cancel, { once: true })
  // The race is observed even when cancellation happens during evaluation rather than a host wait.
  void aborted.promise.catch(() => {})

  try {
    evaluate(codeDriver)
    invoke("start", { source, params, tools: names.map((name) => ({ name })), model_defaults: defaults })
    while (true) {
      const encoded = invoke("snapshot")
      if (Buffer.byteLength(encoded) > 1048576) throw new Error("Code output or pending requests exceeds 1 MiB.")
      const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(encoded)
      if (snapshot.status === "failed") throw new Error(snapshot.error!.code + ": " + snapshot.error!.message)
      if (snapshot.status === "finished") {
        const output = snapshot.result!
        for (const block of output.content) {
          if (block.type !== "resource_link") continue
          const observed = typeof block.uri === "string" ? resources.get(block.uri) : undefined
          if (
            !observed ||
            Object.entries(block).some(
              ([key, value]) => key !== "type" && JSON.stringify(observed[key]) !== JSON.stringify(value),
            )
          )
            throw new Error("Resource was not observed by this invocation.")
        }
        return {
          content: output.content.map((block) => ({ ...block })),
          ...(output.structured_content === undefined ? {} : { structured_content: output.structured_content }),
        }
      }
      // Accept the entire issued batch before supplying any observation, including immediately settled tools.
      if (snapshot.requests.length) {
        for (const request of snapshot.requests) {
          invoke("event", { type: "operation", key: request.key, request: request.request, receipt: {} })
          const operationRequest =
            request.request.kind === "steps" && Array.isArray(request.request.input)
              ? { ...request.request, input: { steps: request.request.input } }
              : request.request
          pending.set(
            request.key,
            Promise.resolve()
              .then(() => operation(request.key, operationRequest))
              .then(
                (outcome): JsonObject => {
                  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
                    for (const block of Array.isArray(outcome.content) ? outcome.content : []) {
                      if (block && typeof block === "object" && !Array.isArray(block) && block.type === "resource_link")
                        resources.set(String(block.uri), block)
                    }
                  }
                  return { type: "observation", key: request.key, outcome }
                },
                (error: unknown): JsonObject => ({
                  type: "observation",
                  key: request.key,
                  refusal:
                    error instanceof OperationRefused
                      ? error.refusal
                      : {
                          code: "operation_failed",
                          message: error instanceof Error ? error.message : "Operation failed.",
                        },
                }),
              ),
          )
        }
        continue
      }
      const event = await Promise.race([...pending.values(), aborted.promise])
      if (Buffer.byteLength(JSON.stringify([event])) > 8388608) throw new Error("Operation events exceed 8 MiB.")
      pending.delete(String(event.key))
      invoke("event", event)
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    context.dispose()
    runtime.dispose()
  }
}
