import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerProcess } from "../../server-process"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fnUntraced(function* (input) {
    if (input.service && input.stdio) return yield* Effect.fail(new Error("--service and --stdio cannot be combined"))
    const sharing = Option.getOrUndefined(input.workspaceSharing)
    if (sharing !== undefined && !sharing.trim())
      return yield* Effect.fail(new Error("--workspace-sharing requires a nonempty absolute directory"))
    if (sharing !== undefined && (input.service || input.stdio))
      return yield* Effect.fail(new Error("Workspace sharing requires foreground serve, without --service or --stdio"))
    if (sharing !== undefined && Option.isSome(input.hostname) && input.hostname.value !== "127.0.0.1")
      return yield* Effect.fail(new Error("Workspace sharing only exposes owner-local loopback HTTP"))
    return yield* ServerProcess.run({
      workspaceSharing: sharing,
      mode: input.service ? "service" : input.stdio ? "stdio" : "default",
      hostname: Option.getOrUndefined(input.hostname),
      port: Option.getOrUndefined(input.port),
      cors: input.cors.length > 0 ? input.cors : undefined,
      allowRemoteAudio: input.allowRemoteAudio,
    })
  }),
)
