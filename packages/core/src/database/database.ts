export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

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
    yield* startupTrace("enabling foreign keys")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* startupTrace("checkpointing WAL")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* startupTrace("applying migrations")
    yield* DatabaseMigration.apply(db)
    yield* startupTrace("migrations applied")

    return { db }
  }).pipe(Effect.orDie),
)

function startupTrace(message: string) {
  if (process.env.OPENCODE_STARTUP_TRACE !== "1") return Effect.void
  return Effect.sync(() => console.log(`[database] ${message}`))
}

export function layerFromPath(filename: string) {
  return databaseLayer.pipe(Layer.provide(layer({ filename })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  return join(Global.Path.data, "opencode-eric_dev.db")
}

// Resolve the database path lazily so tests and embedders that set
// Flag.OPENCODE_DB after module evaluation still control the storage target.
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => layerFromPath(path())),
  deps: [],
})
