import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live("waits for plugin initialization before listing agents", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir("opencode-agent-endpoint-")),
    (tmp) =>
      Effect.gen(function* () {
        const server = yield* ServerProcess.start<never, never>({
          hostname: "127.0.0.1",
          port: 0,
          password: "secret",
          app: { version: "test-version" },
          database: { path: ":memory:" },
          config: { directory: tmp.path },
          fs: { filewatcher: false },
        })
        const url = new URL("/api/agent", HttpServer.formatAddress(server.address))
        url.searchParams.set("location[directory]", tmp.path)
        const response = yield* Effect.promise(() =>
          fetch(url, { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
        )

        expect(response.status).toBe(200)
        const body: unknown = yield* Effect.promise(() => response.json())
        if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("Expected an agent list response")
        expect(body["data"].some((agent) => isRecord(agent) && agent["id"] === "build")).toBeTrue()
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
