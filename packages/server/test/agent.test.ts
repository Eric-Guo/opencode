import { expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { serveRoutes } from "./fixture/routes"

it.live("lists and retrieves loaded agents", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-agent-endpoint-")))
    const server = yield* serveRoutes({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      models: { fetch: false },
      config: { directory: tmp.path },
      fs: { filewatcher: false },
    })
    yield* server.pluginsLoaded(tmp.path)

    const url = new URL("/api/agent", "http://opencode.local")
    url.searchParams.set("location[directory]", tmp.path)
    const response = yield* Effect.promise(() => server.fetch(url))
    expect(response.status).toBe(200)

    const body = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Agent.Info) }))(
      yield* Effect.promise(() => response.json()),
    )
    expect(body.data.some((agent) => agent.id === "build")).toBeTrue()

    url.pathname = "/api/agent/build"
    const found = yield* Effect.promise(() => server.fetch(url))
    expect(found.status).toBe(200)

    const agent = Schema.decodeUnknownSync(Schema.Struct({ data: Agent.Info }))(
      yield* Effect.promise(() => found.json()),
    )
    expect(agent.data.id).toBe(Agent.ID.make("build"))

    url.pathname = "/api/agent/missing"
    const missing = yield* Effect.promise(() => server.fetch(url))
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.json())).toMatchObject({
      _tag: "AgentNotFoundError",
      agentID: "missing",
    })
  }),
)
