import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "@opencode-ai/core/auth"
import { tmpdir } from "./fixture/tmpdir"

const withAuth = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R | Auth.Service>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(Auth.layer, FSUtil.defaultLayer, EventV2.defaultLayer, Global.layerWith({ data: dir })),
    ),
  )

describe("Auth", () => {
  test("stores api credentials", async () => {
    await using tmp = await tmpdir()
    const account = await Effect.runPromise(
      withAuth(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return yield* auth.create({
            serviceID: Auth.ServiceID.make("anthropic"),
            credential: new Auth.ApiKeyCredential({ type: "api", key: "sk-test" }),
          })
        }),
      ) as Effect.Effect<Auth.Info | undefined, Auth.FileWriteError, never>,
    )
    const active = await Effect.runPromise(
      withAuth(
        tmp.path,
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return yield* auth.active(Auth.ServiceID.make("anthropic"))
        }),
      ) as Effect.Effect<Auth.Info | undefined, Auth.FileWriteError, never>,
    )

    expect(account).toBeDefined()
    expect(active?.id).toBe(account?.id)
    expect(active?.credential).toEqual({ type: "api", key: "sk-test" })
  })
})
