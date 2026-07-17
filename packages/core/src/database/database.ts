export * as Database from "./database.js"

import { EffectDrizzleSqlite } from "./drizzle.js"
import { sqliteLayer, supportsForeignKeyToggle, supportsTuningPragmas } from "#sqlite"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { Global } from "@opencode-ai/util/global"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration.js"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/storage/Database") {}

// The bootstrap lock is scoped to the database being built, never to this
// module: on workerd every Durable Object in an isolate shares module state, and
// releasing a shared semaphore resumes the waiting object's fiber inside the
// releasing object's I/O context, where its first storage call is rejected as
// cross-object I/O.
const databaseLayer = (lock: Effect.Effect<Semaphore.Semaphore>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* startupTrace("creating client")
      const db = yield* makeDatabase
      yield* startupTrace("client created")

      if (supportsTuningPragmas) {
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
      }
      yield* startupTrace("applying migrations")
      const semaphore = yield* lock
      yield* semaphore.withPermit(DatabaseMigration.apply(db))
      yield* startupTrace("migrations applied")
      // Durable Object SQLite always enforces foreign keys and rejects the pragma.
      if (supportsForeignKeyToggle) {
        yield* startupTrace("enabling foreign keys")
        yield* db.run("PRAGMA foreign_keys = ON")
      }

      return { db }
    }).pipe(Effect.orDie),
  )

// Two instances over one file bootstrap the same schema, so file databases
// share a lock per path. Each in-memory database is its own connection.
const locks = new Map<string, Semaphore.Semaphore>()

function lockFor(filename: string) {
  const existing = locks.get(filename)
  if (existing) return existing
  const lock = Semaphore.makeUnsafe(1)
  locks.set(filename, lock)
  return lock
}

export function layer(options: Options = { path: ":memory:" }) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const provide = (filename: string) =>
        databaseLayer(filename === ":memory:" ? Semaphore.make(1) : Effect.succeed(lockFor(filename))).pipe(
          Layer.provide(sqliteLayer({ filename, enableForeignKeyConstraints: false })),
        )
      const filename = options.path ?? ":memory:"
      if (filename === ":memory:" || isAbsolute(filename)) return provide(filename)
      const global = yield* Global.Service
      return provide(join(global.data, filename))
    }),
  )
}

// The database service over an injected SqlClient, for runtimes that receive
// database storage instead of opening a filesystem path. Any client provided
// here still goes through the pragma guards and migrations; Global is required
// because migrations may read it (the v1 import). The lock is created per build
// because every Durable Object builds this layer over its own storage.
export const layerFromClient: Layer.Layer<Service, never, SqlClient.SqlClient | Global.Service> = databaseLayer(
  Semaphore.make(1),
)

function startupTrace(message: string) {
  if (process.env.OPENCODE_STARTUP_TRACE !== "1") return Effect.void
  return Effect.sync(() => console.log(`[database] ${message}`))
}

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [Global.node] })
}

/** `configured`, but over an injected SqlClient layer instead of a filesystem path. */
export function configuredClient(client: Layer.Layer<SqlClient.SqlClient>) {
  return makeGlobalNode({
    service: Service,
    layer: layerFromClient.pipe(Layer.provide(client)),
    deps: [Global.node],
  })
}

export const node = configured({ path: ":memory:" })
