import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { importLegacyCredentials } from "@opencode-ai/core/database/migration/20260805200742_import_legacy_credentials"
import loosePsylocke from "@opencode-ai/core/database/migration/20260804233008_loose_psylocke"
import repairV2ForeignKeys from "@opencode-ai/core/database/migration/20260808090000_repair_v2_foreign_keys"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")

    await Effect.runPromise(
      Effect.all(
        [Database.layer({ path: filename }), Database.layer({ path: filename })].map((layer) =>
          Effect.scoped(Layer.build(layer)),
        ),
        { concurrency: "unbounded" },
      ),
    )
    expect(
      await Effect.runPromise(
        Database.Service.use((service) => service.db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)).pipe(
          Effect.provide(Database.layer({ path: filename })),
          Effect.scoped,
        ),
      ),
    ).toEqual({ foreign_keys: 1 })
  })

  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("bootstraps the current schema and records the migration registry", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)).toEqual(
          {
            name: "session_v2",
          },
        )
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_pending'`),
        ).toEqual({ name: "session_pending" })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("applies generic migrations once and records their order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        const input = [
          {
            id: "first",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
              tx.run(sql`CREATE TABLE applied (id text PRIMARY KEY)`),
          },
          {
            id: "second",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
              tx.run(sql`INSERT INTO applied (id) VALUES ('second')`),
          },
        ]

        yield* DatabaseMigration.applyOnly(db, input)
        yield* DatabaseMigration.applyOnly(db, input)

        expect(yield* db.all(sql`SELECT id FROM applied`)).toEqual([{ id: "second" }])
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY time_completed, id`)).toEqual([
          { id: "first" },
          { id: "second" },
        ])
      }),
    )
  })

  test("consolidates a prelaunch database that already added event timestamps", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_retained')`)
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, created integer DEFAULT 0 NOT NULL)`)
        yield* db.run(sql`
          CREATE TABLE session_message (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            type text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            data text NOT NULL,
            seq integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('msg_retained', 'ses_retained', 'user', 4, 1, 2, '{"text":"retained","time":{"created":1}}')
        `)
        yield* db.run(sql`
          CREATE TABLE session_pending (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            type text NOT NULL,
            data text NOT NULL,
            delivery text,
            admitted_seq integer NOT NULL,
            time_created integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
          VALUES ('msg_pending', 'ses_retained', 'user', '{}', 'steer', 5, 3)
        `)
        yield* db.run(sql`
          CREATE INDEX session_pending_session_delivery_seq_idx
          ON session_pending (session_id, delivery, admitted_seq)
        `)
        yield* db.run(sql`
          CREATE TABLE instruction_entry (
            session_id text NOT NULL,
            key text NOT NULL,
            value text,
            removed integer DEFAULT false NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            PRIMARY KEY (session_id, key),
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* db.run(sql`
          INSERT INTO instruction_entry (session_id, key, value, removed, time_created, time_updated)
          VALUES ('ses_retained', 'AGENTS.md', '{}', false, 1, 2)
        `)
        yield* db.run(sql`
          CREATE TABLE instruction_state (
            session_id text PRIMARY KEY,
            epoch_start integer NOT NULL,
            through_seq integer NOT NULL,
            initial_values text NOT NULL,
            current_values text NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* db.run(sql`
          INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values)
          VALUES ('ses_retained', 0, 4, '{}', '{}')
        `)
        yield* db.run(sql`CREATE TABLE data_migration (id text PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [loosePsylocke])

        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(event)`)).filter(
            (column) => column.name === "created",
          ),
        ).toHaveLength(1)
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)).toEqual(
          { name: "session_v2" },
        )
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'data_migration'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT id, seq, data FROM session_message_retained`)).toEqual({
          id: "msg_retained",
          seq: 4,
          data: '{"text":"retained","time":{"created":1}}',
        })
        expect(yield* db.get(sql`SELECT id FROM session_message`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM session_pending`)).toEqual({ id: "msg_pending" })
        expect(yield* db.get(sql`SELECT key FROM instruction_entry`)).toEqual({ key: "AGENTS.md" })
        expect(yield* db.get(sql`SELECT session_id FROM instruction_state`)).toEqual({
          session_id: "ses_retained",
        })
        expect(
          yield* Effect.forEach(["session_pending", "instruction_entry", "instruction_state"], (table) =>
            db
              .get<{ table: string }>(sql`PRAGMA foreign_key_list(${sql.identifier(table)})`)
              .pipe(Effect.map((row) => row?.table)),
          ),
        ).toEqual(["session_v2", "session_v2", "session_v2"])
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${loosePsylocke.id}`)).toEqual({
          id: loosePsylocke.id,
        })
      }),
    )
  })

  test("repairs V2 tables that retained legacy session foreign keys", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_v2 (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_legacy')`)
        yield* db.run(sql`INSERT INTO session_v2 (id) VALUES ('ses_v2')`)
        yield* db.run(sql`
          CREATE TABLE session_pending (
            id text PRIMARY KEY,
            session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            type text NOT NULL,
            data text NOT NULL,
            delivery text,
            admitted_seq integer NOT NULL,
            time_created integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
          VALUES ('msg_pending', 'ses_v2', 'user', '{}', 'steer', 1, 1)
        `)
        yield* db.run(sql`
          CREATE TABLE instruction_entry (
            session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            key text NOT NULL,
            value text,
            removed integer DEFAULT false NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            PRIMARY KEY (session_id, key)
          )
        `)
        yield* db.run(sql`
          INSERT INTO instruction_entry (session_id, key, value, removed, time_created, time_updated)
          VALUES ('ses_v2', 'AGENTS.md', '{}', false, 1, 2)
        `)
        yield* db.run(sql`
          CREATE TABLE instruction_state (
            session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
            epoch_start integer NOT NULL,
            through_seq integer NOT NULL,
            initial_values text NOT NULL,
            current_values text NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values)
          VALUES ('ses_v2', 0, 1, '{}', '{}')
        `)

        yield* DatabaseMigration.applyOnly(db, [repairV2ForeignKeys])

        expect(
          yield* Effect.forEach(["session_pending", "instruction_entry", "instruction_state"], (table) =>
            db
              .get<{ table: string }>(sql`PRAGMA foreign_key_list(${sql.identifier(table)})`)
              .pipe(Effect.map((row) => row?.table)),
          ),
        ).toEqual(["session_v2", "session_v2", "session_v2"])
        yield* db.run(sql`
          INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
          VALUES ('msg_new', 'ses_v2', 'user', '{}', 'steer', 2, 2)
        `)
        expect(yield* db.all(sql`SELECT id FROM session_pending ORDER BY admitted_seq`)).toEqual([
          { id: "msg_pending" },
          { id: "msg_new" },
        ])
        expect(yield* db.get(sql`SELECT key FROM instruction_entry`)).toEqual({ key: "AGENTS.md" })
        expect(yield* db.get(sql`SELECT session_id FROM instruction_state`)).toEqual({ session_id: "ses_v2" })
      }),
    )
  })

  test("imports legacy JSON credentials without changing the source file or existing credentials", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "auth.json")
    const content = JSON.stringify({
      openai: { type: "oauth", refresh: "refresh", access: "access", expires: 123, accountId: "account" },
      anthropic: { type: "api", key: "legacy-key", metadata: { region: "us" } },
      "https://example.com/": { type: "wellknown", key: "TOKEN", token: "wellknown-key" },
      invalid: { type: "unknown" },
    })
    await Bun.write(source, content)

    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const now = Date.now()
        yield* db.run(sql`
          INSERT INTO credential (id, integration_id, label, value, time_created, time_updated)
          VALUES ('existing', 'anthropic', 'Existing', ${JSON.stringify({ type: "key", key: "current-key" })}, ${now}, ${now})
        `)

        yield* db.transaction((tx) => importLegacyCredentials(tx, source))

        expect(yield* db.all(sql`SELECT integration_id, label, value FROM credential ORDER BY integration_id`)).toEqual(
          [
            {
              integration_id: "anthropic",
              label: "Existing",
              value: JSON.stringify({ type: "key", key: "current-key" }),
            },
            {
              integration_id: "https://example.com",
              label: "default",
              value: JSON.stringify({ type: "key", key: "wellknown-key" }),
            },
            {
              integration_id: "openai",
              label: "default",
              value: JSON.stringify({
                type: "oauth",
                methodID: "chatgpt-browser",
                refresh: "refresh",
                access: "access",
                expires: 123,
                metadata: { accountID: "account" },
              }),
            },
          ],
        )
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'wellknown:sources'`)).toEqual({
          value: JSON.stringify(["https://example.com"]),
        })
      }),
    )

    expect(await Bun.file(source).text()).toBe(content)
  })

  test("rolls back a failed migration without recording it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        const migration = {
          id: "failing",
          up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
            Effect.gen(function* () {
              yield* tx.run(sql`CREATE TABLE rolled_back (id text PRIMARY KEY)`)
              yield* Effect.fail(new Error("stop"))
            }),
        }

        expect((yield* Effect.exit(DatabaseMigration.applyOnly(db, [migration])))._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = 'failing'`)).toBeUndefined()
      }),
    )
  })

  test("suspends foreign keys outside migrations that rebuild referenced tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE)`,
        )
        yield* db.run(sql`INSERT INTO session VALUES ('session', 'title')`)
        yield* db.run(sql`INSERT INTO message VALUES ('message', 'session')`)

        yield* DatabaseMigration.applyOnly(db, [
          {
            id: "rebuild",
            foreignKeys: false,
            up: (tx) =>
              Effect.gen(function* () {
                yield* tx.run(sql`CREATE TABLE next_session (id text PRIMARY KEY, title text)`)
                yield* tx.run(sql`INSERT INTO next_session SELECT * FROM session`)
                yield* tx.run(sql`DROP TABLE session`)
                yield* tx.run(sql`ALTER TABLE next_session RENAME TO session`)
              }),
          },
        ])

        expect(yield* db.get(sql`SELECT id FROM message`)).toEqual({ id: "message" })
        expect(yield* db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
      }),
    )
  })

  test("imports an existing Drizzle migration journal once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, 'legacy', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "legacy" }])

        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(sql`UPDATE __drizzle_migrations SET name = 'ignored'`)
        yield* DatabaseMigration.applyOnly(db, [])
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }, { id: "legacy" }])
      }),
    )
  })
})
