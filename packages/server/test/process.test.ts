import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { HttpServer } from "effect/unstable/http"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live("serves browser and desktop compatibility endpoints", () =>
  Effect.gen(function* () {
    const server = yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      config: {
        content: JSON.stringify({
          username: "Test User",
          clerk_code: "123456",
          agents: {
            build: {
              permissions: [{ action: "websearch", resource: "*", effect: "allow" }],
            },
          },
        }),
      },
    })
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

    const health = yield* Effect.promise(() =>
      fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
        headers: {
          authorization: `Basic ${btoa("opencode:secret")}`,
          origin: "http://localhost:3000",
        },
      }),
    )

    expect(health.status).toBe(200)
    expect(health.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(yield* Effect.promise(() => health.json())).toMatchObject({ version: "test-version" })

    const config = yield* Effect.promise(() =>
      fetch(new URL("/global/config", HttpServer.formatAddress(server.address)), {
        headers: {
          authorization: `Basic ${btoa("opencode:secret")}`,
          origin: "http://localhost:3000",
        },
      }),
    )

    const configBody = yield* Effect.promise(() => config.json())
    expect({ status: config.status, body: configBody }).toMatchObject({ status: 200 })
    expect(config.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(configBody).toMatchObject({
      username: "Test User",
      clerk_code: "123456",
      agents: {
        build: {
          permissions: [{ action: "websearch", resource: "*", effect: "allow" }],
        },
      },
    })

    const directory = path.resolve(import.meta.dir, "..")
    const filesUrl = new URL("/file", HttpServer.formatAddress(server.address))
    filesUrl.searchParams.set("path", "test")
    filesUrl.searchParams.set("directory", directory)
    const files = yield* Effect.promise(() =>
      fetch(filesUrl, {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      }),
    )
    expect(files.status).toBe(200)
    expect(yield* Effect.promise(() => files.json())).toContainEqual(
      expect.objectContaining({
        name: "process.test.ts",
        path: "test/process.test.ts",
        absolute: path.join(directory, "test/process.test.ts"),
        type: "file",
        ignored: false,
      }),
    )

    const contentUrl = new URL("/file/content", HttpServer.formatAddress(server.address))
    contentUrl.searchParams.set("path", "package.json")
    contentUrl.searchParams.set("directory", directory)
    const content = yield* Effect.promise(() =>
      fetch(contentUrl, {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      }),
    )
    expect(content.status).toBe(200)
    expect(yield* Effect.promise(() => content.json())).toMatchObject({
      type: "text",
      content: expect.stringContaining('"name": "@opencode-ai/server"'),
    })
  }),
)
