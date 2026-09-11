import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Bus } from "@opencode/core/bus"
import { KimiEnvironment } from "@opencode/core/integration/kimi-environment"
import { KimiKeyRotation } from "@opencode/core/integration/kimi-key-rotation"
import { KV } from "@opencode/core/kv"
import { Event } from "@opencode/schema/event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Hash } from "@opencode/util/hash"
import { withEnv } from "./fixture/env"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(KimiKeyRotation.node))

describe("KimiKeyRotation", () => {
  it.effect("rotates through every key in numeric order and recovers after the pool is exhausted", () => {
    const keys = Array.from({ length: 12 }, (_, index) => `account-${index + 1}`)
    return withKeys(
      keys,
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        const names = KimiEnvironment.names()
        expect(names).toEqual(keys.map((_, index) => KimiEnvironment.name(index)))
        expect(yield* rotation.connections(names)).toHaveLength(12)

        yield* Effect.forEach(keys, (key, index) =>
          Effect.gen(function* () {
            const failure = yield* rotation.fail({
              connection: { type: "env", name: names[index]! },
              fingerprint: Hash.sha256(key),
            })
            expect(failure?.promoted).toEqual(
              index === keys.length - 1 ? undefined : { type: "env", name: names[index + 1] },
            )
            expect(failure?.earliestAvailableAt).toBe(index === keys.length - 1 ? KimiKeyRotation.cooldown : 0)
          }),
        )

        expect((yield* rotation.connections(names))[0]?.name).toBe("KIMI_API_KEY_12")
        yield* TestClock.adjust(KimiKeyRotation.cooldown)
        expect((yield* rotation.connections(names))[0]?.name).toBe("KIMI_API_KEY_12")
        expect(
          yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY_12" },
            fingerprint: Hash.sha256(keys[11]!),
          }),
        ).toMatchObject({ promoted: { type: "env", name: "KIMI_API_KEY" } })
      }),
    )
  })

  it.effect("skips missing and duplicate keys throughout the pool", () =>
    withKeys(
      [undefined, "account-b", "account-b", "account-d", "account-d", " "],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY_4" },
        ])
        expect(
          yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY_2" },
            fingerprint: Hash.sha256("account-b"),
          }),
        ).toMatchObject({ promoted: { type: "env", name: "KIMI_API_KEY_4" } })
      }),
    ),
  )

  it.effect("reconciles removed slots and rejects failures from replaced keys", () =>
    withKeys(
      ["account-a", "account-b", "account-c", "account-d"],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiEnvironment.names())
        yield* Effect.forEach(["account-a", "account-b", "account-c"], (key, index) =>
          rotation.fail({
            connection: { type: "env", name: KimiEnvironment.name(index) },
            fingerprint: Hash.sha256(key),
          }),
        )
        expect((yield* rotation.connections(KimiEnvironment.names()))[0]?.name).toBe("KIMI_API_KEY_4")

        delete process.env.KIMI_API_KEY_3
        delete process.env.KIMI_API_KEY_4
        process.env.KIMI_API_KEY_2 = "new-account-b"
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])
        expect(
          yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY_2" },
            fingerprint: Hash.sha256("account-b"),
          }),
        ).toBeUndefined()
        expect((yield* rotation.connections(KimiEnvironment.names()))[0]?.name).toBe("KIMI_API_KEY_2")
      }),
    ),
  )

  it.effect("rotates from A to B for exactly five hours and keeps B selected", () =>
    withKeys(
      ["account-a", "account-b"],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
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
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])

        yield* TestClock.adjust(KimiKeyRotation.cooldown)
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
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
      ["account-a", "account-b"],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiEnvironment.names())
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
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY" },
        ])
      }),
    ),
  )

  it.effect("serializes concurrent failures from the same account", () =>
    withKeys(
      ["account-a", "account-b"],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiEnvironment.names())
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
      ["account-a", "account-b"],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        yield* rotation.connections(KimiEnvironment.names())
        yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY" },
          fingerprint: Hash.sha256("account-a"),
        })
        yield* rotation.fail({
          connection: { type: "env", name: "KIMI_API_KEY_2" },
          fingerprint: Hash.sha256("account-b"),
        })

        process.env.KIMI_API_KEY = "account-a-replaced"
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([
          { type: "env", name: "KIMI_API_KEY" },
          { type: "env", name: "KIMI_API_KEY_2" },
        ])
      }),
    ),
  )

  it.effect("loads sticky selection and cooldowns after the service restarts", () =>
    withKeys(
      ["account-a", "account-b", "account-c", "account-d"],
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
          yield* rotation.connections(KimiEnvironment.names())
          return yield* Effect.forEach(["account-a", "account-b", "account-c"], (key, index) =>
            rotation.fail({
              connection: { type: "env", name: KimiEnvironment.name(index) },
              fingerprint: Hash.sha256(key),
            }),
          )
        }).pipe(Effect.provide(fresh()))

        expect(failure.at(-1)?.unavailableUntil).toBe(KimiKeyRotation.cooldown)
        expect(
          yield* Effect.gen(function* () {
            const rotation = yield* KimiKeyRotation.Service
            return yield* rotation.connections(KimiEnvironment.names())
          }).pipe(Effect.provide(fresh())),
        ).toEqual([
          { type: "env", name: "KIMI_API_KEY_4" },
          { type: "env", name: "KIMI_API_KEY" },
          { type: "env", name: "KIMI_API_KEY_2" },
          { type: "env", name: "KIMI_API_KEY_3" },
        ])
      }),
    ),
  )

  it.effect("keeps single-key behavior for missing or duplicate backups", () =>
    withKeys(
      ["account-a", undefined],
      Effect.gen(function* () {
        const rotation = yield* KimiKeyRotation.Service
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([{ type: "env", name: "KIMI_API_KEY" }])
        expect(
          yield* rotation.fail({
            connection: { type: "env", name: "KIMI_API_KEY" },
            fingerprint: Hash.sha256("account-a"),
          }),
        ).toBeUndefined()

        process.env.KIMI_API_KEY_2 = "account-a"
        expect(yield* rotation.connections(KimiEnvironment.names())).toEqual([{ type: "env", name: "KIMI_API_KEY" }])
      }),
    ),
  )
})

function withKeys<A, E, R>(keys: readonly (string | undefined)[], effect: Effect.Effect<A, E, R>) {
  return Effect.suspend(() =>
    withEnv(
      {
        ...Object.fromEntries(KimiEnvironment.names().map((name) => [name, undefined])),
        ...Object.fromEntries(keys.map((key, index) => [KimiEnvironment.name(index), key])),
      },
      () => effect,
    ),
  )
}
