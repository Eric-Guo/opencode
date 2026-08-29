import { expect } from "bun:test"
import { rm, stat } from "node:fs/promises"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

it.live("creates and restores session directories through Core before providing the session location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const directory = path.join(tmp.path, "agent7777", "agent7777")
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      config: { directory: tmp.path, project: false },
      fs: { filewatcher: false },
      models: { fetch: false },
    })

    yield* Effect.promise(async () => {
      const response = await handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ location: { directory } }),
        }),
      )
      expect(response.status).toBe(200)
      const created = Schema.decodeUnknownSync(SessionResponse)(await response.json())
      expect(created.data.location.directory).toBe(directory)
      expect((await stat(directory)).isDirectory()).toBe(true)

      await rm(directory, { recursive: true })
      const restored = await handler(new Request(`http://opencode.local/api/session/${created.data.id}`))
      expect(restored.status).toBe(200)
      expect(Schema.decodeUnknownSync(SessionResponse)(await restored.json()).data.location.directory).toBe(directory)
      expect((await stat(directory)).isDirectory()).toBe(true)

      // This endpoint also passes through SessionLocationMiddleware.
      await rm(directory, { recursive: true })
      const switched = await handler(
        new Request(`http://opencode.local/api/session/${created.data.id}/agent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "build" }),
        }),
      )
      expect(switched.status).toBe(204)
      expect((await stat(directory)).isDirectory()).toBe(true)

      const missing = Session.ID.create()
      const unknown = await handler(
        new Request(`http://opencode.local/api/session/${missing}/agent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "build" }),
        }),
      )
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID: missing })
    })
  }),
)
