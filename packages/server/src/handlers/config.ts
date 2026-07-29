import { Config } from "@opencode-ai/core/config"
import { GlobalConfig } from "@opencode-ai/protocol/groups/config"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers.handle(
    "config.get",
    Effect.fn(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      const info = new Config.Info(
        Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : []))),
      )
      const encoded = yield* Schema.encodeEffect(Config.Info)(info).pipe(Effect.orDie)
      const username = Config.latest(entries, "username")
      const clerkCode = Config.latest(entries, "clerk_code")

      const response = Object.fromEntries(
        Object.entries({
          ...encoded,
          model:
            typeof encoded.model === "string"
              ? encoded.model
              : encoded.model && `${encoded.model.providerID}/${encoded.model.model}`,
          plugin: encoded.plugins?.map((plugin) =>
            typeof plugin === "string" ? plugin : [plugin.package, plugin.options ?? {}],
          ),
          username,
          clerk_code: clerkCode,
        }).filter((entry) => entry[1] !== undefined),
      )
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GlobalConfig))(JSON.stringify(response)).pipe(
        Effect.orDie,
      )
    }),
  ),
)
