import type { NexusRuntime } from "@opencode/nexus-runtime"
import { Flag } from "@opencode/core/flag"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/schema/schema"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Context, Effect, Schema, Stream } from "effect"
import { NexusRun } from "@opencode/schema/nexus-run"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
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
      .handleRaw("nexus.run", () =>
        Effect.gen(function* () {
          const runtime = yield* gated
          const input = yield* HttpServerRequest.schemaBodyJson(NexusRun.Input).pipe(
            Effect.mapError(() => new InvalidRequestError({ message: "Invalid Nexus run request." })),
          )
          const signal = new AbortController()
          const stream = Stream.fromAsyncIterable(runtime.runPrompt(input, signal.signal), (error) => error).pipe(
            Stream.map((event) => "data: " + JSON.stringify(event) + "\n\n"),
            Stream.ensuring(Effect.sync(() => signal.abort())),
            Stream.encodeText,
          )
          return HttpServerResponse.stream(stream, {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
          })
        }),
      )
      .handle("nexus.extensions", () => call((runtime) => Promise.resolve(runtime.extensions())))
      .handle("nexus.configureExtension", (ctx) => call((runtime) => runtime.configureExtension(ctx.payload)))
      .handle("nexus.status", () => Effect.map(gated, (runtime) => runtime.status()))
      .handle("nexus.pair", (ctx) => call((runtime) => runtime.pair(ctx.payload)))
      .handle("nexus.disconnect", () => call((runtime) => runtime.disconnect()))
      .handle("nexus.login", () => call(async (runtime) => ({ url: await runtime.login() })))
      .handle("nexus.account", () => call((runtime) => runtime.account()))
      .handle("nexus.logout", () => call((runtime) => runtime.logout()))
      .handle("nexus.operator", (ctx) => call((runtime) => runtime.operator(ctx.payload)))
      .handle("nexus.manage", (ctx) =>
        call(async (runtime) =>
          Schema.decodeUnknownSync(Schema.Json)(
            await runtime.manage(ctx.payload, ctx.headers["x-nexus-origin"], ctx.headers["x-nexus-member-token"]),
          ),
        ),
      )
      .handle("nexus.catalog", (ctx) => call((runtime) => runtime.catalog(ctx.query.kind, ctx.query.after)))
      .handle("nexus.runners", () => call((runtime) => runtime.runners()))
      .handle("nexus.modes", (ctx) =>
        call((runtime) => runtime.modes(ctx.payload.workspace, ctx.payload.conversation, ctx.payload.patch)),
      )
      .handle("nexus.grant", (ctx) =>
        call((runtime) =>
          runtime.grant(ctx.payload.workspace, ctx.payload.conversation, ctx.payload.run, ctx.payload.task),
        ),
      )
      .handle("nexus.policy", (ctx) =>
        call((runtime) =>
          runtime.policy(ctx.payload.workspace, ctx.payload.conversation, undefined, ctx.payload.model),
        ),
      )
  }),
)
