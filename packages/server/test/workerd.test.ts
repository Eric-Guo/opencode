import { expect } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { makeDurableObjectStorage } from "../../core/test/fixture/durable-object-storage"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerWorkerd } from "../src/workerd"

// Covers the profile's replacement graph composing and the database booting
// through the injected Durable Object storage.
it.live("boots the workerd profile and admits sessions without creating local directories", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const directory = path.join(tmp.path, "remote-workspace")
    const handler = yield* ServerWorkerd.create({
      storage: makeDurableObjectStorage(),
      password: "secret",
      app: { version: "workerd-test" },
      config: { content: "{}" },
    })

    const unauthorized = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/info")))
    expect(unauthorized.status).toBe(401)

    const status = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/info", {
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }),
      ),
    )
    expect(status.status).toBe(200)

    const body: unknown = yield* Effect.promise(() => status.json())
    expect(body).toMatchObject({ version: "workerd-test" })

    const session = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa("opencode:secret")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ location: { directory } }),
        }),
      ),
    )
    expect(session.status).toBe(200)
    expect(yield* Effect.promise(() => session.json())).toMatchObject({ data: { location: { directory } } })
    expect(existsSync(directory)).toBe(false)
  }),
)
