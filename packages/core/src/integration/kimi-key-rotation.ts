export * as KimiKeyRotation from "./kimi-key-rotation.js"

import { Connection } from "@opencode/schema/connection"
import { Integration } from "@opencode/schema/integration"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Hash } from "@opencode/util/hash"
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Bus } from "../bus.js"
import { KV } from "../kv.js"
import { KimiEnvironment } from "./kimi-environment.js"

export const integrationID = Integration.ID.make("kimi-for-coding")
export const cooldown = 5 * 60 * 60 * 1000

const Slot = Schema.Struct({
  fingerprint: Schema.String,
  unavailableUntil: Schema.optional(Schema.Number),
})

const RotationState = Schema.Struct({
  selected: Schema.optional(Schema.String),
  slots: Schema.Record(Schema.String, Slot),
})
type RotationState = typeof RotationState.Type

type RuntimeSlot = {
  readonly name: string
  readonly fingerprint: string
}

export type Failure = {
  readonly previous: Connection.EnvInfo
  readonly promoted?: Connection.EnvInfo
  readonly unavailableUntil: number
  readonly earliestAvailableAt: number
}

export interface Interface {
  /** Returns distinct configured Kimi environment connections with the sticky selection first. */
  readonly connections: (registered: readonly string[]) => Effect.Effect<Connection.EnvInfo[]>
  /** Marks the exact key used by a failed request unavailable and promotes one eligible backup. */
  readonly fail: (input: {
    readonly connection: Connection.EnvInfo
    readonly fingerprint: string
  }) => Effect.Effect<Failure | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KimiKeyRotation") {}

const stateKey = "integration:kimi-for-coding:key-rotation"
const decodeState = Schema.decodeUnknownOption(RotationState)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const kv = yield* KV.Service
    const lock = Semaphore.makeUnsafe(1)

    const load = Effect.fnUntraced(function* () {
      return Option.getOrElse(decodeState(yield* kv.get(stateKey)), () => ({ slots: {} }))
    })

    const save = (previous: RotationState, next: RotationState) =>
      isDeepStrictEqual(previous, next) ? Effect.void : kv.set(stateKey, next)

    const switched = (previous: string | undefined, promoted: string | undefined) => {
      if (!previous || !promoted || previous === promoted) return Effect.void
      return bus
        .publish(
          Integration.Event.ConnectionSwitched,
          {
            integrationID,
            previous: connection(previous),
            promoted: connection(promoted),
          },
          { global: true },
        )
        .pipe(Effect.asVoid)
    }

    return Service.of({
      connections: Effect.fn("KimiKeyRotation.connections")((registered) =>
        lock.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const runtime = runtimeSlots(registered)
            const stored = yield* load()
            const reconciled = reconcile(stored, runtime)
            const promoted = select(reconciled, runtime, now)
            yield* save(stored, promoted.state)
            yield* switched(reconciled.selected, promoted.state.selected)
            return runtime
              .toSorted(
                (a, b) => Number(b.name === promoted.state.selected) - Number(a.name === promoted.state.selected),
              )
              .map((slot) => connection(slot.name))
          }),
        ),
      ),
      fail: Effect.fn("KimiKeyRotation.fail")((input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const runtime = runtimeSlots(KimiEnvironment.names())
            const stored = yield* load()
            const reconciled = reconcile(stored, runtime)
            if (runtime.length < 2) {
              yield* save(stored, reconciled)
              return undefined
            }
            const failed = runtime.find((slot) => slot.name === input.connection.name)
            if (!failed || failed.fingerprint !== input.fingerprint) {
              yield* save(stored, reconciled)
              return undefined
            }

            const existing = reconciled.slots[failed.name]
            const unavailableUntil =
              existing?.unavailableUntil !== undefined && existing.unavailableUntil > now
                ? existing.unavailableUntil
                : now + cooldown
            const unavailable = {
              ...reconciled,
              slots: {
                ...reconciled.slots,
                [failed.name]: { fingerprint: failed.fingerprint, unavailableUntil },
              },
            }
            const promoted = select(unavailable, runtime, now)
            yield* save(stored, promoted.state)
            yield* switched(reconciled.selected, promoted.state.selected)

            const selected = promoted.state.selected
            const backup =
              selected && selected !== failed.name && eligible(promoted.state.slots[selected], now)
                ? connection(selected)
                : undefined
            return {
              previous: connection(failed.name),
              ...(backup ? { promoted: backup } : {}),
              unavailableUntil,
              earliestAvailableAt: Math.min(
                ...runtime.map((slot) => promoted.state.slots[slot.name]?.unavailableUntil ?? now),
              ),
            }
          }),
        ),
      ),
    })
  }),
)

function runtimeSlots(registered: readonly string[]) {
  const configured = KimiEnvironment.names().flatMap((name) => {
    if (!registered.includes(name)) return []
    const value = process.env[name]
    if (!value?.trim()) return []
    return [{ name, fingerprint: Hash.sha256(value) } satisfies RuntimeSlot]
  })
  const seen = new Set<string>()
  return configured.filter((slot) => {
    if (seen.has(slot.fingerprint)) return false
    seen.add(slot.fingerprint)
    return true
  })
}

function reconcile(state: RotationState, runtime: readonly RuntimeSlot[]): RotationState {
  const selected =
    state.selected && runtime.some((slot) => slot.name === state.selected) ? state.selected : runtime[0]?.name
  return {
    ...(selected ? { selected } : {}),
    slots: Object.fromEntries(
      runtime.map((slot) => {
        const stored = state.slots[slot.name]
        return [slot.name, stored?.fingerprint === slot.fingerprint ? stored : { fingerprint: slot.fingerprint }]
      }),
    ),
  }
}

function select(state: RotationState, runtime: readonly RuntimeSlot[], now: number) {
  const selected = state.selected
  if (!selected || eligible(state.slots[selected], now)) return { state }
  const promoted = runtime.find((slot) => slot.name !== selected && eligible(state.slots[slot.name], now))
  if (!promoted) return { state }
  return { state: { ...state, selected: promoted.name } }
}

function eligible(slot: typeof Slot.Type | undefined, now: number) {
  return slot !== undefined && (slot.unavailableUntil === undefined || slot.unavailableUntil <= now)
}

function connection(name: string): Connection.EnvInfo {
  return { type: "env", name }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node] })
