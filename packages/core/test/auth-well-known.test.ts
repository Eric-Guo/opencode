import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Substitution } from "@opencode-ai/core/substitution"
import { AuthWellKnown } from "@opencode-ai/core/auth-well-known"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const withAuthWellKnown = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R | AuthWellKnown.Service>) =>
  effect.pipe(
    Effect.provide(AuthWellKnown.layer),
    Effect.provide(AppFileSystem.defaultLayer),
    Effect.provide(Global.layerWith({ data: dir })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(Substitution.defaultLayer),
  )

describe("AuthWellKnown", () => {
  it.live("stores well-known credentials", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withAuthWellKnown(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* AuthWellKnown.Service
          yield* auth.set("https://example.com/", new AuthWellKnown.Entry({ key: "TEST_TOKEN", token: "secret" }))
        }),
      )

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "well-known.json")).json())).toEqual({
        "https://example.com": {
          key: "TEST_TOKEN",
          token: "secret",
        },
      })
    }),
  )

  it.live("migrates legacy well-known auth records", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "auth.json"),
          JSON.stringify({
            "https://example.com": {
              type: "wellknown",
              key: "TEST_TOKEN",
              token: "secret",
            },
          }),
        ),
      )

      const entry = yield* withAuthWellKnown(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* AuthWellKnown.Service
          return yield* auth.get("https://example.com/")
        }),
      )

      expect(entry).toEqual({
        key: "TEST_TOKEN",
        token: "secret",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "well-known.json")).json())).toEqual({
        "https://example.com": {
          key: "TEST_TOKEN",
          token: "secret",
        },
      })
    }),
  )

  it.live("loads config documents", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "well-known.json"),
          JSON.stringify({
            "https://example.com": {
              key: "TEST_TOKEN",
              token: "secret",
            },
          }),
        ),
      )

      const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value as typeof fetch
      const originalToken = process.env.TEST_TOKEN
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const fakeFetch = Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
              if (url === "https://example.com/.well-known/opencode") {
                return Promise.resolve(
                  Response.json({
                    config: { instructions: ["local"] },
                    remote_config: {
                      url: "https://remote.example.com/config",
                      headers: {
                        authorization: "Bearer {env:TEST_TOKEN}",
                      },
                    },
                  }),
                )
              }
              if (url === "https://remote.example.com/config") {
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret")
                return Promise.resolve(Response.json({ model: "remote/model" }))
              }
              return Promise.resolve(new Response(null, { status: 404 }))
            },
            { preconnect: originalFetch.preconnect },
          )
          Object.defineProperty(globalThis, "fetch", { value: fakeFetch, configurable: true, writable: true })
        }),
        () =>
          Effect.sync(() => {
            Object.defineProperty(globalThis, "fetch", { value: originalFetch, configurable: true, writable: true })
            if (originalToken === undefined) delete process.env.TEST_TOKEN
            else process.env.TEST_TOKEN = originalToken
          }),
      )

      const result = yield* withAuthWellKnown(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* AuthWellKnown.Service
          return yield* auth.configs()
        }),
      )

      expect(process.env.TEST_TOKEN).toBeUndefined()
      expect(result).toEqual([
        {
          url: "https://example.com",
          source: "https://example.com/.well-known/opencode",
          dir: "https://example.com/.well-known",
          content: { instructions: ["local"] },
        },
        {
          url: "https://remote.example.com/config",
          source: "https://remote.example.com/config",
          dir: "https://remote.example.com",
          content: { model: "remote/model" },
        },
      ])
    }),
  )
})
