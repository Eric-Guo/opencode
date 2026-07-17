import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260703090000_reset_v2_event_rename_sweep",
  // These tables contain disposable beta projections and event history. SQLite
  // deletes a large event table row by row, so roll it aside in constant time.
  foreignKeys: false,
  up(tx) {
    return Effect.gen(function* () {
      yield* startupTrace("deleting session_input")
      yield* tx.run(`DELETE FROM \`session_input\`;`)
      yield* startupTrace("deleting session_message")
      yield* tx.run(`DELETE FROM \`session_message\`;`)
      yield* startupTrace("dropping obsolete event indexes")
      yield* tx.run(`DROP INDEX IF EXISTS \`event_aggregate_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`event_aggregate_type_seq_idx\`;`)
      yield* startupTrace("renaming obsolete event table")
      yield* tx.run(`ALTER TABLE \`event\` RENAME TO \`__discard_event_20260703090000\`;`)
      yield* startupTrace("renaming obsolete event sequence table")
      yield* tx.run(`ALTER TABLE \`event_sequence\` RENAME TO \`__discard_event_sequence_20260703090000\`;`)
      yield* startupTrace("creating replacement event tables")
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`,
      )
      yield* startupTrace("event history rollover complete")
      // `created` column is added by the generated 20260703181610_event_created_column
      // migration, which runs after this wipe (NOT NULL without default is safe on the
      // emptied table).
    })
  },
} satisfies DatabaseMigration.Migration

function startupTrace(message: string) {
  if (process.env.OPENCODE_STARTUP_TRACE !== "1") return Effect.void
  return Effect.sync(() => console.log(`[database] reset history: ${message}`))
}
