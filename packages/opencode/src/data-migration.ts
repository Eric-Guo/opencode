import { Context, Effect, Layer } from "effect"
import { Database } from "./storage/db"
import { DataMigrationTable } from "./data-migration.sql"
import * as Log from "@opencode-ai/core/util/log"
import { asc, eq, gt, inArray } from "drizzle-orm"
import { MessageTable, SessionTable } from "./session/session.sql"
import type { SessionID } from "./session/schema"

export type Migration<R = never> = {
  name: string
  run: Effect.Effect<void, unknown, R>
}

const log = Log.create({ service: "data-migration" })

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/DataMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const migrations: Migration[] = [
      {
        name: "session_usage_from_messages",
        run: Effect.gen(function* () {
          type Usage = {
            cost: number
            tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
          }

          for (let cursor: SessionID | undefined; ; ) {
            const sessions = yield* Effect.sync(() =>
              Database.use((db) =>
                db
                  .select({ id: SessionTable.id })
                  .from(SessionTable)
                  .where(cursor ? gt(SessionTable.id, cursor) : undefined)
                  .orderBy(asc(SessionTable.id))
                  .limit(100)
                  .all(),
              ),
            )
            if (sessions.length === 0) return

            yield* Effect.sync(() =>
              Database.transaction((db) => {
                const usageBySession = new Map<SessionID, Usage>(
                  sessions.map((session) => [
                    session.id,
                    { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                  ]),
                )

                for (const row of db
                  .select({ session_id: MessageTable.session_id, data: MessageTable.data })
                  .from(MessageTable)
                  .where(inArray(MessageTable.session_id, sessions.map((session) => session.id)))
                  .all()) {
                  if (row.data.role !== "assistant") continue

                  const current = usageBySession.get(row.session_id)
                  if (!current) continue
                  current.cost += row.data.cost
                  current.tokens.input += row.data.tokens.input
                  current.tokens.output += row.data.tokens.output
                  current.tokens.reasoning += row.data.tokens.reasoning
                  current.tokens.cache.read += row.data.tokens.cache.read
                  current.tokens.cache.write += row.data.tokens.cache.write
                }

                for (const [sessionID, value] of usageBySession) {
                  db.update(SessionTable)
                    .set({
                      cost: value.cost,
                      tokens_input: value.tokens.input,
                      tokens_output: value.tokens.output,
                      tokens_reasoning: value.tokens.reasoning,
                      tokens_cache_read: value.tokens.cache.read,
                      tokens_cache_write: value.tokens.cache.write,
                    })
                    .where(eq(SessionTable.id, sessionID))
                    .run()
                }
              }),
            )

            cursor = sessions.at(-1)?.id
            yield* Effect.sleep("10 millis")
          }
        }),
      },
    ]

    yield* Effect.gen(function* () {
      if (migrations.length === 0) return

      // Migrations run in a background fiber, so they must be resumable until
      // their completion row is written.
      for (const migration of migrations) {
        const completed = Database.use((db) =>
          db
            .select({ name: DataMigrationTable.name })
            .from(DataMigrationTable)
            .where(eq(DataMigrationTable.name, migration.name))
            .get(),
        )
        if (completed) continue

        log.info("running data migration", { name: migration.name })
        yield* migration.run
        Database.use((db) =>
          db
            .insert(DataMigrationTable)
            .values({ name: migration.name, time_completed: Date.now() })
            .onConflictDoNothing()
            .run(),
        )
      }
    }).pipe(
      Effect.tapCause((cause) => Effect.logError("failed to run data migrations", { cause })),
      Effect.ignore,
      Effect.forkScoped,
    )
    return Service.of({})
  }),
)

export const defaultLayer = layer

export * as DataMigration from "./data-migration"
