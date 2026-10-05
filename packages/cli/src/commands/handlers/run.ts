import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const { runNonInteractive, formatMessage, mergeInput } = yield* Effect.promise(() => import("../../run/run"))
    const separator = process.argv.indexOf("--", 2)
    const sharing = Option.getOrUndefined(input.workspaceSharing)
    if (sharing !== undefined) {
      if (Option.isSome(input.server) || input.standalone)
        throw new Error("--workspace-sharing cannot be combined with --server or --standalone")
      if (
        input.continue ||
        Option.isSome(input.session) ||
        input.fork ||
        input.file.length ||
        Option.isSome(input.messageID)
      )
        throw new Error(
          "Workspace sharing initially requires a new Session per task and does not support --continue, --session, --fork, --file or --message-id",
        )
      const { submit } = yield* Effect.promise(() => import("../../services/workspace-sharing/client"))
      const { readStdin } = yield* Effect.promise(() => import("../../util/io"))
      const message = mergeInput(
        formatMessage([...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))]),
        process.stdin.isTTY ? undefined : yield* Effect.promise(readStdin),
      )
      if (!message?.trim()) throw new Error("You must provide a message")
      return yield* Effect.tryPromise((signal) =>
        submit(
          sharing,
          {
            directory: process.cwd(),
            message,
            model: Option.getOrUndefined(input.model),
            agent: Option.getOrUndefined(input.agent),
            title: Option.getOrUndefined(input.title),
            thinking: input.thinking,
            format: input.format,
            auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
          },
          { requestID: Option.getOrUndefined(input.requestID), detach: input.detach, signal },
        ),
      )
    }
    if (input.detach || Option.isSome(input.requestID))
      throw new Error("--detach and --request-id require --workspace-sharing")
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        messageID: Option.getOrUndefined(input.messageID),
        message: [...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))],
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format: input.format,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    )
  }),
)
