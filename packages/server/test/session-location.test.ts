import { expect } from "bun:test"
import { rm, stat } from "node:fs/promises"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

it.live("creates the first session directory and returns 404 for deleted session locations", () =>
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
      const recorded = await handler(new Request(`http://opencode.local/api/session/${created.data.id}`))
      expect(recorded.status).toBe(200)
      expect(Schema.decodeUnknownSync(SessionResponse)(await recorded.json()).data.location.directory).toBe(directory)
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })

      const repeated = await handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: created.data.id, location: { directory } }),
        }),
      )
      expect(repeated.status).toBe(200)
      expect(Schema.decodeUnknownSync(SessionResponse)(await repeated.json()).data.id).toBe(created.data.id)
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })

      const second = await handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ location: { directory } }),
        }),
      )
      expect(second.status).toBe(200)
      expect(Schema.decodeUnknownSync(SessionResponse)(await second.json()).data.id).not.toBe(created.data.id)
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })

      // This endpoint needs the session's Location graph.
      const switched = await handler(
        new Request(`http://opencode.local/api/session/${created.data.id}/agent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "build" }),
        }),
      )
      expect(switched.status).toBe(404)
      expect(await switched.json()).toEqual({
        _tag: "LocationNotFoundError",
        location: { directory },
        message: `Location not found: ${directory}`,
      })
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })

      const transcribed = await handler(
        new Request(`http://opencode.local/api/audio/transcriptions/${created.data.id}`, {
          method: "POST",
          headers: { "content-type": "audio/mpeg" },
          body: new Uint8Array([1, 2, 3]),
        }),
      )
      expect(transcribed.status).toBe(404)
      expect(await transcribed.json()).toEqual({
        _tag: "LocationNotFoundError",
        location: { directory },
        message: `Location not found: ${directory}`,
      })
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })

      const debug = await handler(
        new Request("http://opencode.local/api/debug/agent/build/tool/read", {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
          body: JSON.stringify({ filePath: path.join(directory, "README.md") }),
        }),
      )
      expect(debug.status).toBe(404)
      expect(await debug.json()).toEqual({
        _tag: "LocationNotFoundError",
        location: { directory },
        message: `Location not found: ${directory}`,
      })
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })

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
