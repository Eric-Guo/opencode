import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ServerProcess } from "../../src/process"

export const startServer = Effect.fnUntraced(function* (directory: string, user?: string) {
  const server = yield* ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password: "secret",
    app: { version: "test-version" },
    database: { path: ":memory:" },
    config: { directory, user },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return {
    base: HttpServer.formatAddress(server.address),
    headers: { authorization: `Basic ${btoa("opencode:secret")}` },
  }
})
