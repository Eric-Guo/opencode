import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { AuthV2 } from "@opencode-ai/core/auth"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const withAuth = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R | AuthV2.Service>) =>
  effect.pipe(
    Effect.provide(AuthV2.layer),
    Effect.provide(AppFileSystem.defaultLayer),
    Effect.provide(Global.layerWith({ data: dir })),
  )

describe("AuthV2", () => {
  it.live("stores api credentials", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      const account = yield* withAuth(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* AuthV2.Service
          return yield* auth.create({
            serviceID: AuthV2.ServiceID.make("anthropic"),
            credential: new AuthV2.ApiKeyCredential({ type: "api", key: "sk-test" }),
          })
        }),
      )

      const active = yield* withAuth(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* AuthV2.Service
          return yield* auth.active(AuthV2.ServiceID.make("anthropic"))
        }),
      )

      expect(active?.id).toBe(account.id)
      expect(active?.credential).toEqual({ type: "api", key: "sk-test" })
    }),
  )
})
