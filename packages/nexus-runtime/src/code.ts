import { CodeMode, Extension } from "@opencode/codemode"
import type { JsonObject, JsonValue } from "@cybros/agent"
import { Effect, Schema } from "effect"
import { OperationRefused } from "./claim-control"

const Declaration = Schema.Struct({
  function: Schema.Struct({ name: Schema.String }),
  route: Schema.optional(Schema.Struct({ kind: Schema.String, tool_name: Schema.optional(Schema.String) })),
})
const Input = Schema.Record(Schema.String, Schema.MutableJson)
const Output = Schema.Struct({
  content: Schema.Array(Input),
  structured_content: Schema.optional(Schema.MutableJson),
})

export async function runCode(
  source: string,
  params: JsonValue,
  declarations: JsonValue[],
  operation: (key: string, request: JsonObject) => Promise<JsonValue>,
  signal: AbortSignal,
) {
  if (Buffer.byteLength(source) > 262144) throw new Error("Code source exceeds 256 KiB.")
  if (Buffer.byteLength(JSON.stringify({ params, declarations })) > 8388608)
    throw new Error("Code context exceeds 8 MiB.")

  const names = declarations.flatMap((entry) => {
    const declared = Schema.decodeUnknownOption(Declaration)(entry)

    if (declared._tag === "None") return []
    if (declared.value.function.name === "code" || declared.value.route?.tool_name === "code") return []

    return [declared.value.function.name]
  })
  const allowed = new Set(names)
  const kinds = new Set(["ask", "model", "wait", "steps", "background", "join", "replace", "cancel"])
  const pending = new Map<string, { released: boolean }>()
  const resources = new Set<string>()
  const output: { content: JsonObject[]; structured_content?: JsonValue } = { content: [] }
  const owner = new AbortController()
  const active = AbortSignal.any([signal, owner.signal])
  const bound = () => {
    if (Buffer.byteLength(JSON.stringify(output)) > 1048576) throw new Error("Code output exceeds 1 MiB.")
  }
  const bridge = {
    start(kind: string, name: string, value: unknown) {
      active.throwIfAborted()
      if (kind === "tool" ? !allowed.has(name) : !kinds.has(kind))
        throw new Error("Operation is outside the frozen catalog.")

      const input = kind === "steps" && Array.isArray(value) ? { steps: value } : value
      const request: JsonObject =
        kind === "tool"
          ? { kind, name, input: Schema.decodeUnknownSync(Input)(input) }
          : { kind, input: Schema.decodeUnknownSync(Input)(input) }
      const key = "code_" + crypto.randomUUID()
      const state = { released: false }

      pending.set(key, state)

      const promise = operation(key, request)
        .then(
          (outcome) => {
            if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
              for (const block of Array.isArray(outcome.content) ? outcome.content : []) {
                if (block && typeof block === "object" && !Array.isArray(block) && block.type === "resource_link")
                  resources.add(JSON.stringify(block))
              }

              if (kind === "background" && outcome.status === "completed" && !outcome.is_error) {
                for (const released of Array.isArray(outcome.released_operations) ? outcome.released_operations : []) {
                  if (typeof released !== "string" || !pending.has(released))
                    throw new Error("Invalid ownership transfer receipt.")
                  pending.get(released)!.released = true
                }
              }
            }

            return { ok: true, value: outcome }
          },
          (error: unknown) => ({
            ok: false,
            message: error instanceof Error ? error.message : "Operation failed.",
            ...(error instanceof OperationRefused ? { refusal: error.refusal } : {}),
          }),
        )
        .finally(() => pending.delete(key))

      return { key, wait: async () => promise }
    },
    text(value: string) {
      if (typeof value !== "string") throw new Error("text requires a string.")
      output.content.push({ type: "text", text: value })
      bound()
    },
    value(value: unknown) {
      output.structured_content = Schema.decodeUnknownSync(Schema.MutableJson)(value)
      bound()
    },
    resource(value: unknown) {
      const block = Schema.decodeUnknownSync(Input)(value)

      if (!resources.has(JSON.stringify(block))) throw new Error("Resource was not observed by this invocation.")

      output.content.push(block)
      bound()
    },
    finish() {
      if ([...pending.values()].some((state) => !state.released))
        throw new Error("Program returned with unjoined child operations.")

      bound()
      return output
    },
  }
  // Promise metadata and immutability belong inside the interpreter, where host objects are never shared.
  const prelude = `
const freeze = value => {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) freeze(value[key]);
    Object.freeze(value);
  }
  return value;
};
freeze(params);
const call = (kind, name, input) => {
  const handle = bridge.start(kind, name, input);
  const promise = handle.wait().then(result => {
    if (result.ok) return freeze(result.value);
    const error = new Error(result.message);
    if (result.refusal) error.refusal = freeze(result.refusal);
    throw error;
  });
  return Object.freeze({
    operation_key: handle.key,
    then: (yes, no) => promise.then(yes, no),
    catch: no => promise.catch(no),
    finally: done => promise.finally(done)
  });
};
const tools = {};
for (const name of names) tools[name] = input => call("tool", name, input);
Object.freeze(tools);
const nexus = {};
for (const kind of kinds) nexus[kind] = input => call(kind, "", input);
Object.freeze(nexus);
const text = value => bridge.text(value);
const value = value => bridge.value(value);
const resource = value => bridge.resource(value);
const returned = await (async () => { ${source}\n })();
if (returned !== undefined) value(returned);
return bridge.finish();`

  try {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: prelude,
        bindings: { params, names, kinds: [...kinds] },
        extensions: [Extension.make({ name: "nexus", globals: { bridge } })],
        limits: { timeoutMs: 600000, maxOutputBytes: 1048576 },
      }),
      { signal: active },
    )

    if (!result.ok) throw new Error(result.error.message)

    const decoded = Schema.decodeUnknownSync(Output)(result.value)

    return {
      content: decoded.content.map((block) => ({ ...block })),
      ...(decoded.structured_content === undefined ? {} : { structured_content: decoded.structured_content }),
    }
  } finally {
    owner.abort()
  }
}
