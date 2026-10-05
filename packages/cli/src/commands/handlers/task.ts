import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { FileSharing } from "../../services/workspace-sharing/owner"

export default Runtime.handler(Commands.commands.task, (input) =>
  Effect.gen(function* () {
    const root = Option.getOrUndefined(input.workspaceSharing)
    if (!root) throw new Error("task commands require --workspace-sharing")
    const client = yield* Effect.tryPromise(() => FileSharing.connect(root))
    const reply = yield* Effect.tryPromise(() => client.request({ op: input.operation, taskID: input.taskID }))
    if (reply.error || !reply.task) throw new Error(reply.error ?? "Task not found")
    const output =
      input.operation === "result" &&
      reply.task.starts > 0 &&
      ["completed", "failed", "cancelled"].includes(reply.task.state)
        ? yield* Effect.tryPromise(() => client.output(input.taskID))
        : undefined
    process.stdout.write(JSON.stringify({ ...reply.task, ...(output ? { output } : {}) }) + "\n")
  }),
)
