import { Config } from "@opencode-ai/core/config"
import { Info } from "@opencode-ai/schema/config"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      "config.global",
      Effect.fn(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        const info = new Info(
          Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : []))),
        )
        const encoded = yield* Schema.encodeEffect(Info)(info).pipe(Effect.orDie)
        const username = Config.latest(entries, "username")
        const clerkCode = Config.latest(entries, "clerk_code")

        return Object.fromEntries(
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
      }),
    ),
)
