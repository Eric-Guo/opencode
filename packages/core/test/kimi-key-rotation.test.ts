import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Bus } from "@opencode-ai/core/bus"
import { KimiKeyRotation } from "@opencode-ai/core/integration/kimi-key-rotation"
import { KV } from "@opencode-ai/core/kv"
import { Event } from "@opencode-ai/schema/event"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Hash } from "@opencode-ai/util/hash"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(KimiKeyRotation.node))

describe("KimiKeyRotation", () => {
  it.effect("rotates from A to B for exactly five hours and keeps B selected", () =>
    withKeys(
      "account-a",
      "account-b",
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY" },
          { type: "env", name: "KIMI_API_KEY_2" },
        ])

        const first = yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY" },
          fingerprint: Hash.sha256("account-a"),
        })
        expect(first).toMatchObject({
          previous: { type: "env", name: "KIMI_API_KEY" },
          promoted: { type: "env", name: "KIMI_API_KEY_2" },
          unavailableUntil: KimiKeyRotation.cooldown,
        })
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])

        yield* TestClock.adjust(KimiKeyRotation.cooldown)
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])

        expect(
          yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY_2" },
            fingerprint: Hash.sha256("account-b"),
          }),
        ).toMatchObject({ promoted: { type: "env", name: "KIMI_API_KEY" } })
      }),
    ),
  )

  it.effect("does not oscillate when both accounts are cooling down", () =>
    withKeys(
      "account-a",
      "account-b",
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiKeyRotation.environmentNames)
        yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY" },
          fingerprint: Hash.sha256("account-a"),
        })
        const second = yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY_2" },
          fingerprint: Hash.sha256("account-b"),
        })

        expect(second?.promoted).toBeUndefined()
        expect(second?.earliestAvailableAt).toBe(KimiKeyRotation.cooldown)
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])
      }),
    ),
  )

  it.effect("serializes concurrent failures from the same account", () =>
    withKeys(
      "account-a",
      "account-b",
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiKeyRotation.environmentNames)
        const failures = yield* Effect.all(
          Array.from({ length: 8 }, () =>
            rotation.fail({
              connection: { type: "env", name: "KIMI_API_KEY" },
              fingerprint: Hash.sha256("account-a"),
            }),
          ),
          { concurrency: "unbounded" },
        )

        expect(failures.every((failure) => failure?.promoted?.name === "KIMI_API_KEY_2")).toBe(true)
        expect(new Set(failures.map((failure) => failure?.unavailableUntil))).toEqual(
          new Set([KimiKeyRotation.cooldown]),
        )
      }),
    ),
  )

  it.effect("clears stale cooldown when an environment key changes", () =>
    withKeys(
      "account-a",
      "account-b",
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiKeyRotation.environmentNames)
        yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY" },
          fingerprint: Hash.sha256("account-a"),
        })
        yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY_2" },
          fingerprint: Hash.sha256("account-b"),
        })

        process.env.KIMI_API_KEY = "account-a-replaced"
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY" },
          { type: "env", name: "KIMI_API_KEY_2" },
        ])
      }),
    ),
  )

  it.effect("loads sticky selection and cooldowns after the service restarts", () =>
    withKeys(
      "account-a",
      "account-b",
      Effect.gen(function* () {
        const values = new Map<string, KV.Value>()
        const dependencies = Layer.merge(
          Layer.mock(KV.Service, {
            get: (key) => Effect.sync(() => values.get(key)),
            set: (key, value) => Effect.sync(() => values.set(key, value)).pipe(Effect.asVoid),
          }),
          Layer.mock(Bus.Service, {
            publish: (definition, data) =>
              Effect.sync(
                () =>
                  ({
                    id: Event.ID.create(),
                    created: 0,
                    type: definition.type,
                    data,
                  }) as unknown as Event.Payload<typeof definition>,
              ),
          }),
        )
        const fresh = () => Layer.fresh(KimiKeyRotation.layer.pipe(Layer.provide(dependencies)))

        const failure = yield* Effect.gen(function* () {
          const rotation = yield* KimiKeyRotation.Service
          yield* rotation.connections(KimiKeyRotation.environmentNames)
          return yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY" },
            fingerprint: Hash.sha256("account-a"),
          })
        }).pipe(Effect.provide(fresh()))

        expect(failure?.unavailableUntil).toBe(KimiKeyRotation.cooldown)
        expect(
          yield* Effect.gen(function* () {
            const rotation = yield* KimiKeyRotation.Service
            return yield* rotation.connections(KimiKeyRotation.environmentNames)
          }).pipe(Effect.provide(fresh())),
        ).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])
      }),
    ),
  )

  it.effect("keeps single-key behavior for missing or duplicate backups", () =>
    withKeys(
      "account-a",
      undefined,
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY" },
        ])
        expect(
          yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY" },
            fingerprint: Hash.sha256("account-a"),
          }),
        ).toBeUndefined()

        process.env.KIMI_API_KEY_2 = "account-a"
        expect(yield* rotation.connections(KimiKeyRotation.environmentNames)).toEqual([
          { type: "env", name: "KIMI_API_KEY" },
        ])
      }),
    ),
  )
})

function withKeys<A, E, R>(first: string, second: string | undefined, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ primary: process.env.KIMI_API_KEY, secondary: process.env.KIMI_API_KEY_2 })),
    () =>
      Effect.sync(() => {
        process.env.KIMI_API_KEY = first
        if (second === undefined) delete process.env.KIMI_API_KEY_2
        else process.env.KIMI_API_KEY_2 = second
      }).pipe(Effect.andThen(effect)),
    (previous) =>
      Effect.sync(() => {
        if (previous.primary === undefined) delete process.env.KIMI_API_KEY
        else process.env.KIMI_API_KEY = previous.primary
        if (previous.secondary === undefined) delete process.env.KIMI_API_KEY_2
        else process.env.KIMI_API_KEY_2 = previous.secondary
      }),
  )
}
