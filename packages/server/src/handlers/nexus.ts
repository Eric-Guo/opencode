import type { NexusRuntime } from "@opencode/nexus-runtime"
import { Flag } from "@opencode/core/flag"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/schema/schema"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Context, Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const NexusHost = Context.Reference<{ get: () => Promise<NexusRuntime> } | null>("@opencode/server/NexusHost", {
  defaultValue: () => null,
})

export const nexusEnabled = Effect.gen(function* () {
  const global = yield* Global.Service
  const locations = yield* LocationServiceMap.Service
  return yield* Flag.enabled("nexus_runtime").pipe(
    Effect.provide(locations.get({ directory: AbsolutePath.make(global.home) })),
  )
})

export const NexusHandler = HttpApiBuilder.group(Api, "server.nexus", (handlers) =>
  Effect.gen(function* () {
    const host = yield* NexusHost
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const enabled = nexusEnabled.pipe(
      Effect.provideService(Global.Service, global),
      Effect.provideService(LocationServiceMap.Service, locations),
      Effect.orDie,
    )
    const gated = Effect.gen(function* () {
      if (!host)
        return yield* new ServiceUnavailableError({
          service: "nexus",
          message: "Nexus requires the managed OpenCode service.",
        })
      if (!(yield* enabled))
        return yield* new ForbiddenError({ message: "Enable experimental.nexus_runtime in the service configuration." })
      return yield* Effect.tryPromise({
        try: host.get,
        catch: () => new ServiceUnavailableError({ service: "nexus", message: "Could not load the Nexus runtime." }),
      })
    })
    const call = <T>(run: (runtime: NexusRuntime) => Promise<T>) =>
      Effect.flatMap(gated, (runtime) =>
        Effect.tryPromise({
          try: () => run(runtime),
          catch: (cause) =>
            new InvalidRequestError({ message: cause instanceof Error ? cause.message : "Nexus request failed." }),
        }),
      )
    return handlers
      .handle("nexus.status", () => Effect.map(gated, (runtime) => runtime.status()))
      .handle("nexus.pair", (ctx) => call((runtime) => runtime.pair(ctx.payload)))
      .handle("nexus.disconnect", () => call((runtime) => runtime.disconnect()))
      .handle("nexus.login", () => call(async (runtime) => ({ url: await runtime.login() })))
      .handle("nexus.account", () => call((runtime) => runtime.account()))
      .handle("nexus.logout", () => call((runtime) => runtime.logout()))
      .handle("nexus.catalog", (ctx) => call((runtime) => runtime.catalog(ctx.query.kind, ctx.query.after)))
      .handle("nexus.runners", () => call((runtime) => runtime.runners()))
      .handle("nexus.modes", (ctx) =>
        call((runtime) => runtime.modes(ctx.payload.workspace, ctx.payload.conversation, ctx.payload.patch)),
      )
      .handle("nexus.policy", (ctx) =>
        call((runtime) => runtime.policy(ctx.payload.workspace, ctx.payload.conversation)),
      )
  }),
)
