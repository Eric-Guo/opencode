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
    const db = yield* makeDatabase

    // Configure lock handling before any pragma that may need a write lock.
    // In particular, switching journal mode can otherwise block startup behind
    // a connection left alive by a previous desktop sidecar on Windows.
    yield* db.run("PRAGMA busy_timeout = 5000")
    const journal = yield* db.get<{ journal_mode: string }>("PRAGMA journal_mode")
    if (journal?.journal_mode.toLowerCase() !== "wal") yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  // Database owns WAL setup so it runs only after busy_timeout is configured.
  return databaseLayer.pipe(Layer.provide(layer({ filename, disableWAL: true })))
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
