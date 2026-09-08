import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260908065408_project_my_todo",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`project_id\` integer;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`project_name\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`work_package_id\` integer;`)
    })
  },
}

export default migration
