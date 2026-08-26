export * as KimiKeyRotation from "./kimi-key-rotation.js"

import { Connection } from "@opencode-ai/schema/connection"
import { Integration } from "@opencode-ai/schema/integration"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Hash } from "@opencode-ai/util/hash"
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Bus } from "../bus.js"
import { KV } from "../kv.js"

export const integrationID = Integration.ID.make("kimi-for-coding")
export const primary = "KIMI_API_KEY"
export const secondary = "KIMI_API_KEY_2"
export const environmentNames = [primary, secondary] as const
export const cooldown = 5 * 60 * 60 * 1000

export const EnvironmentName = Schema.Literals(environmentNames)
export type EnvironmentName = typeof EnvironmentName.Type

const Slot = Schema.Struct({
  fingerprint: Schema.String,
  unavailableUntil: Schema.optional(Schema.Number),
})

const RotationState = Schema.Struct({
  selected: Schema.optional(EnvironmentName),
  slots: Schema.Struct({
    [primary]: Schema.optional(Slot),
    [secondary]: Schema.optional(Slot),
  }),
})
type RotationState = typeof RotationState.Type

type RuntimeSlot = {
  readonly name: EnvironmentName
  readonly value: string
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

    const switched = (previous: EnvironmentName | undefined, promoted: EnvironmentName | undefined) => {
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
            const runtime = runtimeSlots(environmentNames)
            const stored = yield* load()
            const reconciled = reconcile(stored, runtime)
            if (runtime.length !== 2 || !Schema.is(EnvironmentName)(input.connection.name)) {
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
  const configured = environmentNames.flatMap((name) => {
    if (!registered.includes(name)) return []
    const value = process.env[name]
    if (!value?.trim()) return []
    return [{ name, value, fingerprint: Hash.sha256(value) } satisfies RuntimeSlot]
  })
  const first = configured.find((slot) => slot.name === primary)
  return configured.filter((slot) => slot.name !== secondary || slot.value !== first?.value)
}

function reconcile(state: RotationState, runtime: readonly RuntimeSlot[]): RotationState {
  const current = (name: EnvironmentName) => runtime.find((slot) => slot.name === name)
  const slot = (name: EnvironmentName) => {
    const found = current(name)
    if (!found) return undefined
    const stored = state.slots[name]
    return stored?.fingerprint === found.fingerprint
      ? stored
      : {
          fingerprint: found.fingerprint,
        }
  }
  const selected = state.selected && current(state.selected) ? state.selected : runtime[0]?.name
  const primarySlot = slot(primary)
  const secondarySlot = slot(secondary)
  return {
    ...(selected ? { selected } : {}),
    slots: {
      ...(primarySlot ? { [primary]: primarySlot } : {}),
      ...(secondarySlot ? { [secondary]: secondarySlot } : {}),
    },
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

function connection(name: EnvironmentName): Connection.EnvInfo {
  return { type: "env", name }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node] })
