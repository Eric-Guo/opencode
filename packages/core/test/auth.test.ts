import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AccountV2 } from "@opencode-ai/core/account"
import { EventV2 } from "@opencode-ai/core/event"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

function testLayer(dir: string) {
  return AccountV2.layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provide(Global.layerWith({ data: dir })),
  )
}

describe("AccountV2", () => {
  it.live("stores api credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const auth = yield* AccountV2.Service
          const account = yield* auth.create({
            serviceID: AccountV2.ServiceID.make("anthropic"),
            credential: new AccountV2.ApiKeyCredential({ type: "api", key: "sk-test" }),
          })
          if (!account) return
          const active = yield* auth.active(AccountV2.ServiceID.make("anthropic"))
          expect(active?.id).toBe(account.id)
          expect(active?.credential).toEqual({ type: "api", key: "sk-test" })
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )
})
