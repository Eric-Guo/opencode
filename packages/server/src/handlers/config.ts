import { Config } from "@opencode/core/config"
import { ShellSelect } from "@opencode/core/shell/select"
import { Info } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.get", () => Config.Service.use((config) => config.entries()))
    .handle(
      "config.preferences",
      Effect.fn(function* () {
        const config = yield* Config.Service
        if (!config.preferences) return yield* Effect.die(new Error("Config preferences are unavailable"))
        return yield* config.preferences().pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.updatePreferences",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.updatePreferences) return yield* Effect.die(new Error("Config preference updates are unavailable"))
        return yield* config.updatePreferences(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    )
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
