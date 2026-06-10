export * as ServerDiscovery from "./server-discovery"

import { makeRuntime } from "@/effect/run-service"
import { ServerAuth } from "@/server/auth"
import { Global } from "@opencode-ai/core/global"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import path from "path"

export const file = path.join(Global.Path.state, "server.json")

const Entry = Schema.Struct({
  url: Schema.String,
  pid: Schema.Number,
})
type Entry = typeof Entry.Type
const decodeEntry = Schema.decodeUnknownOption(Entry)

export interface Interface {
  readonly write: (url: URL) => Effect.Effect<void>
  readonly remove: () => Effect.Effect<void>
  readonly find: () => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CliServerDiscovery") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const read = Effect.fn("CliServerDiscovery.read")(function* () {
      return readSync()
    })

    const remove = Effect.fn("CliServerDiscovery.remove")(function* () {
      const entry = yield* read()
      if (entry?.pid !== process.pid) return
      unlinkIgnoreSync()
    })

    const removeStale = Effect.fn("CliServerDiscovery.removeStale")(function* (entry: Entry) {
      const current = yield* read()
      if (current?.pid !== entry.pid || current.url !== entry.url) return
      unlinkIgnoreSync()
    })

    return Service.of({
      write: Effect.fn("CliServerDiscovery.write")(function* (url) {
        yield* Effect.sync(() => {
          mkdirSync(path.dirname(file), { recursive: true })
          writeFileSync(file, JSON.stringify({ url: localURL(url).toString(), pid: process.pid }), {
            encoding: "utf8",
            mode: 0o600,
          })
        })
      }),
      remove,
      find: Effect.fn("CliServerDiscovery.find")(function* () {
        const entry = yield* read()
        if (!entry) return undefined
        const url = yield* healthy(entry.url)
        if (url) return url
        yield* removeStale(entry)
      }),
    })
  }),
)

export const defaultLayer = layer

const { runPromise } = makeRuntime(Service, defaultLayer)

export const find = () => runPromise((discovery) => discovery.find())

export function removeSync() {
  const entry = readSync()
  if (entry?.pid !== process.pid) return
  unlinkIgnoreSync()
}

function unlinkIgnoreSync() {
  try {
    unlinkSync(file)
  } catch {}
}

function readSync() {
  try {
    return Option.getOrUndefined(decodeEntry(JSON.parse(readFileSync(file, "utf8"))))
  } catch {
    return undefined
  }
}

function healthy(input: string) {
  return Effect.tryPromise({
    try: async () => {
      const url = new URL(input)
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
      const response = await fetch(new URL("/global/health", url), {
        headers: ServerAuth.headers(),
        signal: AbortSignal.timeout(1000),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as unknown
      if (typeof body === "object" && body !== null && "healthy" in body && body.healthy === true) {
        return url.toString()
      }
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}

function localURL(url: URL) {
  const result = new URL(url)
  if (result.hostname === "0.0.0.0") result.hostname = "127.0.0.1"
  if (result.hostname === "::") result.hostname = "::1"
  return result
}
