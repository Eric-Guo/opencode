import { expect } from "bun:test"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { Flag } from "@opencode/core/flag"
import { Context, Effect, Layer } from "effect"
import { NexusRuntime } from "@opencode/nexus-runtime"
import { OpenCode } from "@opencode/client/promise"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { createRoutes } from "../src/routes"

it.live("streams a structured Nexus refusal through the generated client and validates run input", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("nexus-http-")))
    const runtime = new NexusRuntime(directory.path)
    const context = yield* Layer.build(
      createRoutes(
        {
          app: { version: "test" },
          database: { path: ":memory:" },
          config: { directory: directory.path, project: false },
          models: { fetch: false },
          fs: { filewatcher: false },
        },
        () => [],
        [Global.node.replace(tempGlobalLayer)],
        { get: () => Promise.resolve(runtime) },
      ).pipe(Layer.provide(Layer.succeed(Flag.Overrides, "nexus_runtime")), Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const server = yield* Effect.acquireDisposable(
      Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })),
    )
    const client = OpenCode.make({ baseUrl: server.url.origin })
    const events = yield* Effect.promise(() =>
      Array.fromAsync(client.experimental.nexus.run({ key: "test", prompt: "hello" })),
    )
    expect(events).toEqual([
      {
        type: "result",
        subtype: "failed",
        is_error: true,
        exit_status: 1,
        status: "failed",
        reason: "Nexus is disconnected.",
        result: null,
      },
    ])
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/experimental/nexus/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "missing key" }),
        }),
      ),
    )
    expect(response.status).toBe(400)
    const memory = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/experimental/nexus/manage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "application.memory",
            conversation: "fixture",
            command: "ls",
            format: "json",
          }),
        }),
      ),
    )

    expect(memory.status).toBe(400)
    expect(yield* Effect.promise(() => memory.json())).toMatchObject({ message: "Nexus is disconnected." })
  }),
)
