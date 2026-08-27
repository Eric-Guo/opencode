import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration.js"
import type { SourceMessage, SourcePart, TransformInput } from "../v1-transform.js"

const previousV2Marker = "20260730195856_optional_session_title"

const migration: DatabaseMigration.Migration = {
  id: "20260804233008_loose_psylocke",
  up(tx) {
    return Effect.gen(function* () {
      // This marker identifies the completed pre-split V2 lineage. Its V2 tables
      // are canonical, so rename them in place instead of replaying the V1 squash.
      if (yield* tx.get(sql`SELECT id FROM migration WHERE id = ${previousV2Marker}`)) {
        const v1Only = yield* tx.get(sql`
          SELECT 1
          FROM message
          WHERE NOT EXISTS (
            SELECT 1 FROM session_message WHERE session_message.session_id = message.session_id
          )
          LIMIT 1
        `)
        yield* tx.run(`DROP INDEX IF EXISTS \`session_project_idx\`;`)
        yield* tx.run(`DROP INDEX IF EXISTS \`session_workspace_idx\`;`)
        yield* tx.run(`DROP INDEX IF EXISTS \`session_parent_idx\`;`)
        yield* tx.run(`DROP INDEX IF EXISTS \`session_time_suspended_idx\`;`)
        // Bun defaults to legacy ALTER behavior. Startup disables foreign keys,
        // so explicitly retarget references to the renamed canonical table.
        const legacy = yield* tx.get<{ legacy_alter_table: number }>(sql`PRAGMA legacy_alter_table`)
        yield* tx.run(sql`PRAGMA legacy_alter_table = OFF`)
        yield* tx
          .run(`ALTER TABLE \`session\` RENAME TO \`session_v2\`;`)
          .pipe(
            Effect.ensuring(
              tx
                .run(`PRAGMA legacy_alter_table = ${legacy?.legacy_alter_table === 1 ? "ON" : "OFF"}`)
                .pipe(Effect.orDie),
            ),
          )
        yield* tx.run(`CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
        yield* tx.run(`CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
        yield* tx.run(`CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
        yield* tx.run(
          `CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;`,
        )
        yield* tx.run(`DROP TABLE IF EXISTS \`data_migration\`;`)
        yield* tx.run(`DROP TABLE IF EXISTS \`session_context_epoch\`;`)
        yield* tx.run(`DROP TABLE IF EXISTS \`session_input\`;`)
        if (v1Only) yield* migrateLegacyHistory(tx)
        return
      }

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`instruction_blob\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`instruction_entry\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text,
          \`removed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_instruction_entry_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`__new_instruction_entry\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text,
          \`removed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_instruction_entry_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__new_instruction_entry\` (
          \`session_id\`, \`key\`, \`value\`, \`removed\`, \`time_created\`, \`time_updated\`
        )
        SELECT \`session_id\`, \`key\`, \`value\`, \`removed\`, \`time_created\`, \`time_updated\`
        FROM \`instruction_entry\`;
      `)
      yield* tx.run(`DROP TABLE \`instruction_entry\`;`)
      yield* tx.run(`ALTER TABLE \`__new_instruction_entry\` RENAME TO \`instruction_entry\`;`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`__new_instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__new_instruction_state\` (
          \`session_id\`, \`epoch_start\`, \`through_seq\`, \`initial_values\`, \`current_values\`
        )
        SELECT \`session_id\`, \`epoch_start\`, \`through_seq\`, \`initial_values\`, \`current_values\`
        FROM \`instruction_state\`;
      `)
      yield* tx.run(`DROP TABLE \`instruction_state\`;`)
      yield* tx.run(`ALTER TABLE \`__new_instruction_state\` RENAME TO \`instruction_state\`;`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_pending\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`delivery\` text,
          \`admitted_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_pending_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`__new_session_pending\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`delivery\` text,
          \`admitted_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_pending_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__new_session_pending\` (
          \`id\`, \`session_id\`, \`type\`, \`data\`, \`delivery\`, \`admitted_seq\`, \`time_created\`
        )
        SELECT \`id\`, \`session_id\`, \`type\`, \`data\`, \`delivery\`, \`admitted_seq\`, \`time_created\`
        FROM \`session_pending\`;
      `)
      yield* tx.run(`DROP TABLE \`session_pending\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_pending\` RENAME TO \`session_pending\`;`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_v2\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_boundary\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`time_suspended\` integer,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      if (
        !(yield* tx.all<{ name: string }>(`PRAGMA table_info(\`event\`)`)).some((column) => column.name === "created")
      )
        yield* tx.run(`ALTER TABLE \`event\` ADD \`created\` integer DEFAULT 0 NOT NULL;`)
      // Some pre-launch V2 builds stored image-only history here while sharing the V1 database path.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_message_retained\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO \`session_message_retained\` (
          \`id\`, \`session_id\`, \`type\`, \`seq\`, \`time_created\`, \`time_updated\`, \`data\`
        )
        SELECT \`id\`, \`session_id\`, \`type\`, \`seq\`, \`time_created\`, \`time_updated\`, \`data\`
        FROM \`session_message\`;
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`session_message_retained_session_seq_idx\`
        ON \`session_message_retained\` (\`session_id\`, \`seq\`);
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`__new_session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`DROP TABLE \`session_message\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_message\` RENAME TO \`session_message\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_pending_session_delivery_seq_idx\` ON \`session_pending\` (\`session_id\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_pending_session_compaction_idx\` ON \`session_pending\` (\`session_id\`) WHERE "session_pending"."type" = 'compaction';`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_pending_session_admitted_seq_idx\` ON \`session_pending\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;`,
      )
      yield* tx.run(`DROP TABLE IF EXISTS \`data_migration\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_context_epoch\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_input\`;`)
    })
  },
}

export default migration

function migrateLegacyHistory(tx: Parameters<DatabaseMigration.Migration["up"]>[0]) {
  return Effect.gen(function* () {
    const { transformSession } = yield* Effect.promise(() => import("../v1-transform.js"))
    const decodeModel = Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({ id: Schema.String, providerID: Schema.String, variant: Schema.optional(Schema.String) }),
      ),
    )
    // The pre-split database shared session metadata between V1 and V2. Only
    // convert V1-only histories; existing V2 messages and events are canonical.
    const sessions = yield* tx.all<Omit<TransformInput["session"], "model"> & { model: string | null }>(sql`
      SELECT id, agent, model FROM session_v2
      WHERE EXISTS (SELECT 1 FROM message WHERE message.session_id = session_v2.id)
        AND NOT EXISTS (SELECT 1 FROM session_message WHERE session_message.session_id = session_v2.id)
    `)
    yield* Effect.forEach(sessions, (session) =>
      Effect.gen(function* () {
        const transformed = transformSession({
          session: { ...session, model: session.model === null ? null : yield* decodeModel(session.model) },
          messages: yield* tx.all<SourceMessage>(sql`
            SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ${session.id}
          `),
          parts: yield* tx.all<SourcePart>(sql`
            SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ${session.id}
          `),
        })
        if (transformed.warnings.length)
          return yield* Effect.fail(
            new Error(`Cannot migrate V1 history for ${session.id}: ${transformed.warnings[0]?.reason}`),
          )
        yield* Effect.forEach(transformed.messages, (message) =>
          tx.run(sql`
            INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
            VALUES (${message.id}, ${session.id}, ${message.type}, ${message.seq},
                    ${message.time_created}, ${message.time_updated}, ${JSON.stringify(message.data)})
          `),
        )
        yield* tx.run(sql`
          UPDATE session_v2 SET
            agent = ${transformed.session.agent},
            model = ${transformed.session.model === null ? null : JSON.stringify(transformed.session.model)},
            cost = ${transformed.session.cost},
            tokens_input = ${transformed.session.tokens_input},
            tokens_output = ${transformed.session.tokens_output},
            tokens_reasoning = ${transformed.session.tokens_reasoning},
            tokens_cache_read = ${transformed.session.tokens_cache_read},
            tokens_cache_write = ${transformed.session.tokens_cache_write},
            revert = NULL, time_compacting = NULL
          WHERE id = ${session.id}
        `)
        yield* tx.run(sql`
          INSERT INTO event_sequence (aggregate_id, seq)
          VALUES (${session.id}, ${transformed.watermark})
          ON CONFLICT (aggregate_id) DO UPDATE SET seq = MAX(event_sequence.seq, excluded.seq)
        `)
      }),
    )
  })
}
