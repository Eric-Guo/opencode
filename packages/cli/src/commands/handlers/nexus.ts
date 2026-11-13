import { OpenCode } from "@opencode/client/promise"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { resolve } from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(
  Commands.commands.nexus,
  Effect.fn("cli.nexus")(function* (input) {
    const server = yield* ServerConnection.resolve({ mismatch: "ignore" })
    const nexus = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
      .experimental.nexus
    if (input.action === "pair") {
      if (Option.isNone(input.url) || Option.isNone(input.model))
        return yield* Effect.fail(new Error("Pairing requires --url and --model."))
      const settings = {
        origin: input.url.value,
        model: input.model.value,
        workspace: Option.getOrElse(input.workspace, () => ""),
        directory: resolve(Option.getOrElse(input.directory, () => process.cwd())),
      }
      const status = yield* Effect.tryPromise(() => nexus.pair(settings))
      if (status.pairing) process.stdout.write(status.pairing.url + "\n" + status.pairing.code + "\n")
      return
    }
    if (input.action === "login") {
      const login = yield* Effect.tryPromise(() => nexus.login())
      process.stdout.write(login.url + "\n")
      return
    }
    if (input.action === "logout") {
      yield* Effect.tryPromise(() => nexus.logout())
      return
    }
    const result = yield* Effect.tryPromise(async () => {
      if (input.action === "disconnect") return nexus.disconnect()
      if (input.action === "schedules" || input.action === "memory" || input.action === "mcp")
        return nexus.catalog({ kind: input.action, after: Option.getOrUndefined(input.after) })
      if (input.action === "account") return nexus.account()
      if (input.action === "runners") return nexus.runners()
      return nexus.status()
    })
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  }),
)
