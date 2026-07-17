export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sqliteLayer } from "#sqlite"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "../global"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const databaseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* startupTrace("creating client")
    const db = yield* makeDatabase
    yield* startupTrace("client created")

    yield* startupTrace("setting journal mode")
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* startupTrace("setting synchronous mode")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* startupTrace("setting busy timeout")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* startupTrace("setting cache size")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* startupTrace("checkpointing WAL")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* startupTrace("applying migrations")
    yield* DatabaseMigration.apply(db)
    yield* startupTrace("migrations applied")
    yield* startupTrace("enabling foreign keys")
    yield* db.run("PRAGMA foreign_keys = ON")

    return { db }
  }).pipe(Effect.orDie),
)

export function layer(options?: Options) {
  return Layer.suspend(() => {
    const provide = (filename: string) =>
      databaseLayer.pipe(Layer.provide(sqliteLayer({ filename, enableForeignKeyConstraints: false })))
    if (options?.path === ":memory:" || (options?.path && isAbsolute(options.path))) return provide(options.path)
    if (options?.path) return provide(join(Global.Path.data, options.path))
    return provide(join(Global.Path.data, "opencode-eric_dev.db"))
  })
}

function startupTrace(message: string) {
  if (process.env.OPENCODE_STARTUP_TRACE !== "1") return Effect.void
  return Effect.sync(() => console.log(`[database] ${message}`))
}

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [] })
}

export const node = configured({ path: ":memory:" })
