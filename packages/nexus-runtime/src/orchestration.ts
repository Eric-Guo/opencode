import type { ExecutorClient, JsonObject, JsonValue } from "@cybros/agent"
import { ClaimOperations } from "./claim-control"

export type OperationHandle = { operation_key: string }
export type Orchestration = {
  start(key: string, request: JsonObject): Promise<OperationHandle>
  wait(handle: OperationHandle): Promise<JsonValue>
  ask(key: string, prompt: string, options?: string[]): Promise<JsonValue>
  run(program: {
    code: string
    params?: JsonValue
  }): Promise<{ content: JsonObject[]; structured_content: JsonValue; metadata?: JsonObject }>
}

/** Constructed at the claim boundary; extensions receive capabilities without transport credentials. */
export function claimOrchestration(
  task: ReturnType<ExecutorClient["inboxTask"]>,
  token: string,
  signal: AbortSignal,
): Orchestration {
  const operations = new ClaimOperations(task, token, signal)
  const pending = new Map<string, Promise<JsonValue>>()
  return {
    async start(key, request) {
      const accepted = await operations.submit(key, request)
      pending.set(key, accepted.outcome)
      return { operation_key: key }
    },
    wait(handle) {
      const outcome = pending.get(handle.operation_key)
      if (!outcome) throw new Error("Unknown operation: " + handle.operation_key)
      return outcome
    },
    ask(key, prompt, options) {
      return operations.question(key, { kind: "ask", input: { prompt, ...(options ? { options } : {}) } })
    },
    async run(program) {
      const snapshot = await task.operations(token, {}, { signal })
      if (snapshot.trace.length)
        throw new Error(
          "The previous execution state is unavailable; inspect its accepted work before starting a new invocation.",
        )
      const { runCode } = await import("./code")
      return runCode(
        program.code,
        program.params ?? {},
        snapshot.context.tools,
        (key, request) => operations.submit(key, request),
        signal,
        snapshot.context.model_defaults,
      )
    },
  }
}
