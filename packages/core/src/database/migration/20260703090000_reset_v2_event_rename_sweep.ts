import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260703090000_reset_v2_event_rename_sweep",
  // These tables contain disposable beta projections and event history. With
  // foreign keys enabled, SQLite deletes large Windows databases row by row.
  // Disabling enforcement around the transaction enables its truncate path.
  foreignKeys: false,
  up(tx) {
    return Effect.gen(function* () {
      yield* startupTrace("deleting session_input")
      yield* tx.run(`DELETE FROM \`session_input\`;`)
      yield* startupTrace("deleting session_message")
      yield* tx.run(`DELETE FROM \`session_message\`;`)
      yield* startupTrace("deleting event")
      yield* tx.run(`DELETE FROM \`event\`;`)
      yield* startupTrace("deleting event_sequence")
      yield* tx.run(`DELETE FROM \`event_sequence\`;`)
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
