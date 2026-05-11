#!/usr/bin/env bun

import { rmSync } from "fs"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import { eq } from "drizzle-orm"

const args = new Map(
  Bun.argv.slice(2).flatMap((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    return match ? [[match[1], match[2]] as const] : []
  }),
)

const sessions = Number(args.get("sessions") ?? 10_000)
const messages = Number(args.get("messages") ?? 20)
const batch = Number(args.get("batch") ?? 1_000)
const dbPath = path.resolve(args.get("db") ?? path.join("/tmp", "opencode-session-usage-bench.db"))
const keep = args.get("keep") === "true"

if (!keep) rmSync(dbPath, { force: true })
process.env.OPENCODE_DB = dbPath

const started = performance.now()
const [{ Database }, { SessionTable, MessageTable }] = await Promise.all([
  import("../src/storage/db"),
  import("../src/session/session.sql"),
])

const now = Date.now()
const expectedCost = sessions * messages * 0.001
const db = Database.Client().$client

console.log(`database: ${dbPath}`)
console.log(`seed: ${sessions.toLocaleString()} sessions x ${messages.toLocaleString()} assistant messages`)

db.transaction(() => {
  db.query(
    `INSERT INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands)
     VALUES ($id, $worktree, NULL, $name, NULL, NULL, NULL, $time, $time, $time, $sandboxes, NULL)`,
  ).run({
    $id: "global",
    $worktree: process.cwd(),
    $name: "bench",
    $time: now,
    $sandboxes: JSON.stringify([]),
  })
})()

const insertSession = db.query(
  `INSERT INTO session (
    id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
    summary_additions, summary_deletions, summary_files, summary_diffs, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
    revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived
  ) VALUES (
    $id, 'global', NULL, NULL, $slug, $directory, $path, $title, 'bench', NULL,
    NULL, NULL, NULL, NULL, 0,
    0, 0, 0, 0, 0,
    NULL, NULL, NULL, NULL, $time, $time, NULL, NULL
  )`,
)
const insertMessage = db.query(
  `INSERT INTO message (id, session_id, time_created, time_updated, data)
   VALUES ($id, $session, $time, $time, $data)`,
)

for (let offset = 0; offset < sessions; offset += batch) {
  const end = Math.min(offset + batch, sessions)
  db.transaction(() => {
    for (let i = offset; i < end; i++) {
      const sessionID = `ses_bench_${i.toString().padStart(8, "0")}`
      insertSession.run({
        $id: sessionID,
        $slug: `bench-${i}`,
        $directory: process.cwd(),
        $path: ".",
        $title: `Bench ${i}`,
        $time: now + i,
      })
      for (let j = 0; j < messages; j++) {
        insertMessage.run({
          $id: `msg_bench_${i.toString().padStart(8, "0")}_${j.toString().padStart(4, "0")}`,
          $session: sessionID,
          $time: now + i + j,
          $data: JSON.stringify({
            role: "assistant",
            time: { created: now + i + j, completed: now + i + j + 1 },
            parentID: `msg_parent_${i.toString().padStart(8, "0")}_${j.toString().padStart(4, "0")}`,
            modelID: "bench-model",
            providerID: "bench-provider",
            mode: "build",
            agent: "bench",
            path: { cwd: process.cwd(), root: process.cwd() },
            cost: 0.001,
            tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
          }),
        })
      }
    }
  })()
  console.log(`seeded ${end.toLocaleString()} sessions`)
}

console.log(`seed time: ${Math.round(performance.now() - started).toLocaleString()}ms`)

const [{ DataMigration }, { DataMigrationTable }] = await Promise.all([
  import("../src/data-migration"),
  import("../src/data-migration.sql"),
])
const runtime = ManagedRuntime.make(DataMigration.defaultLayer)
const migrationStarted = performance.now()
await runtime.runPromise(Effect.gen(function* () {
  return yield* DataMigration.Service
}))

for (;;) {
  const completed = Database.use((db) =>
    db
      .select({ name: DataMigrationTable.name })
      .from(DataMigrationTable)
      .where(eq(DataMigrationTable.name, "session_usage_from_messages"))
      .get(),
  )
  if (completed) break
  await Bun.sleep(100)
}

const migrationMs = performance.now() - migrationStarted
const totals = db
  .query(`SELECT COUNT(*) AS sessions, SUM(cost) AS cost, SUM(tokens_input) AS input FROM session`)
  .get() as { sessions: number; cost: number; input: number }

await runtime.dispose()
Database.close()

console.log(`migration time: ${Math.round(migrationMs).toLocaleString()}ms`)
console.log(`total time: ${Math.round(performance.now() - started).toLocaleString()}ms`)
console.log(`result: ${totals.sessions.toLocaleString()} sessions, cost=${totals.cost}, input=${totals.input}`)
console.log(`expected: cost=${expectedCost}, input=${sessions * messages * 100}`)
