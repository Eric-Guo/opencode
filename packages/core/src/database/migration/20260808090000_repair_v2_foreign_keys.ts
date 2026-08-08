import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const migration: DatabaseMigration.Migration = {
  id: "20260808090000_repair_v2_foreign_keys",
  foreignKeys: false,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`__new_instruction_entry_v2_fk\` (
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
        INSERT INTO \`__new_instruction_entry_v2_fk\` (
          \`session_id\`, \`key\`, \`value\`, \`removed\`, \`time_created\`, \`time_updated\`
        )
        SELECT \`session_id\`, \`key\`, \`value\`, \`removed\`, \`time_created\`, \`time_updated\`
        FROM \`instruction_entry\`;
      `)
      yield* tx.run(`DROP TABLE \`instruction_entry\`;`)
      yield* tx.run(`ALTER TABLE \`__new_instruction_entry_v2_fk\` RENAME TO \`instruction_entry\`;`)
      yield* tx.run(`
        CREATE TABLE \`__new_instruction_state_v2_fk\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__new_instruction_state_v2_fk\` (
          \`session_id\`, \`epoch_start\`, \`through_seq\`, \`initial_values\`, \`current_values\`
        )
        SELECT \`session_id\`, \`epoch_start\`, \`through_seq\`, \`initial_values\`, \`current_values\`
        FROM \`instruction_state\`;
      `)
      yield* tx.run(`DROP TABLE \`instruction_state\`;`)
      yield* tx.run(`ALTER TABLE \`__new_instruction_state_v2_fk\` RENAME TO \`instruction_state\`;`)
      yield* tx.run(`
        CREATE TABLE \`__new_session_pending_v2_fk\` (
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
        INSERT INTO \`__new_session_pending_v2_fk\` (
          \`id\`, \`session_id\`, \`type\`, \`data\`, \`delivery\`, \`admitted_seq\`, \`time_created\`
        )
        SELECT \`id\`, \`session_id\`, \`type\`, \`data\`, \`delivery\`, \`admitted_seq\`, \`time_created\`
        FROM \`session_pending\`;
      `)
      yield* tx.run(`DROP TABLE \`session_pending\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_pending_v2_fk\` RENAME TO \`session_pending\`;`)
      yield* tx.run(
        `CREATE INDEX \`session_pending_session_delivery_seq_idx\` ON \`session_pending\` (\`session_id\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_compaction_idx\` ON \`session_pending\` (\`session_id\`) WHERE "session_pending"."type" = 'compaction';`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_admitted_seq_idx\` ON \`session_pending\` (\`session_id\`,\`admitted_seq\`);`,
      )
    })
  },
}

export default migration
