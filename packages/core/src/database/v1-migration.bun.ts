export * as V1Migration from "./v1-migration.js"

import { Cause, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Database } from "./database.js"
import { SessionMessageTable, SessionTable } from "../session/sql.js"
import { SessionMessage } from "../session/message.js"
import { SessionSchema } from "../session/schema.js"
import { KVTable } from "../kv/sql.js"
import { EventSequenceTable } from "../event/sql.js"
import { eq, sql } from "drizzle-orm"
import { Global } from "@opencode-ai/util/global"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Database as SQLiteDatabase } from "bun:sqlite"
import { Project } from "@opencode-ai/schema/project"

export * from "./v1-transform.js"
import { transformSession, type SourceMessage, type SourcePart } from "./v1-transform.js"

type Progress = {
  readonly label: string
  readonly numerator?: number
  readonly denominator?: number
}

export type Status =
  | { readonly status: "required" | "completed" }
  | { readonly status: "running"; readonly progress: Progress }
  | { readonly status: "error"; readonly error: string }

type RunResult = {
  readonly status: "completed"
}

type Options = {
  readonly nextDatabasePath?: string
}

type MigrationState = { readonly phase: "sessions"; readonly cursor?: string } | { readonly phase: "completed" }

type RuntimeState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly progress: Progress }
  | { readonly status: "error"; readonly error: string }

type NextProject = {
  readonly id: string
  readonly worktree: string
  readonly vcs: string | null
  readonly name: string | null
  readonly icon_url: string | null
  readonly icon_url_override: string | null
  readonly icon_color: string | null
  readonly time_created: number
  readonly time_updated: number
  readonly time_initialized: number | null
  readonly sandboxes: string
  readonly commands: string | null
}

type NextColumns<A> = Record<keyof A, "required" | "nullable" | { readonly fallback: keyof A & string }>

const NEXT_PROJECT_COLUMNS = {
  id: "required",
  worktree: "required",
  vcs: "nullable",
  name: "nullable",
  icon_url: "nullable",
  icon_url_override: { fallback: "icon_url" },
  icon_color: "nullable",
  time_created: "required",
  time_updated: "required",
  time_initialized: "nullable",
  sandboxes: "required",
  commands: "nullable",
} satisfies NextColumns<NextProject>

type NextSession = {
  readonly id: string
  readonly project_id: string
  readonly workspace_id: string | null
  readonly parent_id: string | null
  readonly fork_session_id: string | null
  readonly fork_boundary: string | null
  readonly slug: string
  readonly directory: string
  readonly path: string | null
  readonly title: string | null
  readonly version: string
  readonly share_url: string | null
  readonly summary_additions: number | null
  readonly summary_deletions: number | null
  readonly summary_files: number | null
  readonly summary_diffs: string | null
  readonly metadata: string | null
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_reasoning: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
  readonly revert: string | null
  readonly permission: string | null
  readonly agent: string | null
  readonly model: string | null
  readonly time_created: number
  readonly time_updated: number
  readonly time_compacting: number | null
  readonly time_archived: number | null
  readonly time_suspended: number | null
}

const NEXT_SESSION_COLUMNS = {
  id: "required",
  project_id: "required",
  workspace_id: "nullable",
  parent_id: "nullable",
  fork_session_id: "nullable",
  fork_boundary: "nullable",
  slug: "required",
  directory: "required",
  path: "nullable",
  title: "nullable",
  version: "required",
  share_url: "nullable",
  summary_additions: "nullable",
  summary_deletions: "nullable",
  summary_files: "nullable",
  summary_diffs: "nullable",
  metadata: "nullable",
  cost: "required",
  tokens_input: "required",
  tokens_output: "required",
  tokens_reasoning: "required",
  tokens_cache_read: "required",
  tokens_cache_write: "required",
  revert: "nullable",
  permission: "nullable",
  agent: "nullable",
  model: "nullable",
  time_created: "required",
  time_updated: "required",
  time_compacting: "nullable",
  time_archived: "nullable",
  time_suspended: "nullable",
} satisfies NextColumns<NextSession>

type NextMessage = {
  readonly id: string
  readonly session_id: string
  readonly type: SessionMessage.Type
  readonly seq: number
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

const lock = Semaphore.makeUnsafe(1)
const MIGRATION_STATE_KEY = "migration.v1-v2"
const EVENT_DELETE_BATCH_SIZE = 1_000
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
let runtimeState: RuntimeState = { status: "idle" }
export function retainedMessages(db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const tables = new Set(
      (yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'part', 'session_message_retained')`,
      )).map((table) => table.name),
    )
    if (tables.has("session_message_retained")) {
      const retained = yield* db.all<NextMessage>(sql`
        SELECT id, session_id, type, seq, time_created, time_updated, data
        FROM session_message_retained
        WHERE session_id = ${sessionID}
        ORDER BY seq
      `)
      if (retained.length > 0)
        return retained.flatMap((message) => {
          const data = Option.getOrUndefined(decodeJson(message.data))
          return data !== null && typeof data === "object" && !Array.isArray(data) ? [{ ...message, data }] : []
        })
    }
    if (!tables.has("message") || !tables.has("part")) return []
    const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
    if (!session) return []
    const messages = yield* db.all<SourceMessage>(
      sql`SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ${sessionID}`,
    )
    if (messages.length === 0) return []
    return transformSession({
      session,
      messages,
      parts: yield* db.all<SourcePart>(
        sql`SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ${sessionID}`,
      ),
    }).messages
  }).pipe(Effect.orDie)
}

export function status(): Effect.Effect<Status, never, Database.Service> {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    if (!(yield* hasLegacySessions(db))) return { status: "completed" as const }
    const state = yield* readState(db)
    if (runtimeState.status === "running") return runtimeState
    if (runtimeState.status === "error") return runtimeState
    if (state?.phase === "completed") return { status: "completed" as const }
    return { status: "required" as const }
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    runtimeState = { status: "running", progress: { label: "Clearing old events" } }
    yield* run().pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.sync(() => {
            runtimeState = { status: "error", error: errorText(Cause.squash(cause)) }
          }).pipe(Effect.andThen(Effect.logError("V1 migration failed", { cause }))),
        onSuccess: () =>
          Effect.sync(() => {
            runtimeState = { status: "idle" }
          }),
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

function errorText(input: unknown): string {
  if (!(input instanceof Error)) return String(input)
  const cause = input.cause
  return cause === undefined ? input.message : `${input.message}\nCaused by: ${errorText(cause)}`
}

function updateProgress(progress: Progress) {
  if (runtimeState.status === "running") runtimeState = { status: "running", progress }
}

export function run(options: Options = {}): Effect.Effect<RunResult, never, Database.Service | Global.Service> {
  return lock.withPermit(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const global = yield* Global.Service
      yield* recoverRetainedMessages(db)
      const state = yield* readState(db)
      if (state?.phase === "completed") return { status: "completed" as const }
      if (!(yield* hasLegacySessions(db))) return { status: "completed" as const }
      const retainedTable = yield* db.get(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_message_retained'`,
      )
      const retainedSessions = new Set(
        (retainedTable
          ? yield* db.all<{ session_id: string }>(sql`SELECT DISTINCT session_id FROM session_message_retained`)
          : []
        ).map((session) => session.session_id),
      )
      const now = Date.now()
      yield* db.run(sql`
          INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes)
          VALUES (${Project.ID.global}, ${path.parse(global.data).root}, ${now}, ${now}, '[]')
        `)
      if (state === undefined)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              while (true) {
                yield* tx.run(sql`
                    DELETE FROM event
                    WHERE rowid IN (SELECT rowid FROM event LIMIT ${EVENT_DELETE_BATCH_SIZE})
                  `)
                const deleted = (yield* tx.get<{ value: number }>(sql`SELECT changes() AS value`))?.value ?? 0
                if (deleted < EVENT_DELETE_BATCH_SIZE) break
                yield* Effect.yieldNow
              }
              yield* tx
                .insert(KVTable)
                .values({ key: MIGRATION_STATE_KEY, value: { phase: "sessions" } })
                .run()
            }),
          )
          .pipe(Effect.orDie)
      const sourceTotal = yield* countNextSessions(nextPath(options, global.data))
      const legacyTotal = (yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM session`))?.value ?? 0
      const cursor = state?.phase === "sessions" ? state.cursor : undefined
      const migrated =
        cursor !== undefined
          ? ((yield* db.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM session WHERE id >= ${cursor}`))
              ?.value ?? 0)
          : 0
      const denominator = sourceTotal + legacyTotal
      updateProgress({ label: "Migrating sessions", numerator: migrated, denominator })
      yield* importNextDatabase(db, nextPath(options, global.data), (completed) => {
        updateProgress({ label: "Migrating sessions", numerator: migrated + completed, denominator })
      })
      updateProgress({ label: "Migrating sessions", numerator: migrated + sourceTotal, denominator })
      const projects = new Set(
        (yield* db.all<{ id: string }>(sql`SELECT id FROM project`)).map((project) => project.id),
      )
      while (true) {
        const state = yield* readState(db)
        const cursorValue = state?.phase === "sessions" ? state.cursor : undefined
        const nextID = yield* db.get<{ id: string; project_id: string }>(
          cursorValue === undefined
            ? sql`SELECT id, project_id FROM session ORDER BY id DESC LIMIT 1`
            : sql`SELECT id, project_id FROM session WHERE id < ${cursorValue} ORDER BY id DESC LIMIT 1`,
        )
        if (!nextID) break
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(KVTable)
                .values({ key: MIGRATION_STATE_KEY, value: { phase: "sessions", cursor: nextID.id } })
                .onConflictDoUpdate({
                  target: KVTable.key,
                  set: { value: { phase: "sessions", cursor: nextID.id }, time_updated: Date.now() },
                })
                .run()
              const projectID = projects.has(nextID.project_id) ? nextID.project_id : Project.ID.global
              if (projectID !== nextID.project_id)
                yield* Effect.logWarning("Reassigned V1 session with missing project", {
                  sessionID: nextID.id,
                  projectID: nextID.project_id,
                })
              yield* tx.run(sql`
                  INSERT OR IGNORE INTO session_v2 (
                    id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
                    summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived
                  )
                  SELECT
                    id, ${projectID}, workspace_id, parent_id, slug, directory, path, title, version, share_url,
                    summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived
                  FROM session
                  WHERE id = ${nextID.id}
                `)
              const next = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(nextID.id)))
                .get()
              if (!next) return yield* Effect.die(new Error(`Failed to copy V1 session ${nextID.id}`))
              const sourceMessages = yield* tx.all<SourceMessage>(
                sql`SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ${next.id}`,
              )
              if (sourceMessages.length === 0 && retainedSessions.has(next.id)) return
              const sourceParts = yield* tx.all<SourcePart>(
                sql`SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ${next.id}`,
              )
              const transformed = transformSession({ session: next, messages: sourceMessages, parts: sourceParts })
              yield* Effect.forEach(transformed.warnings, (warning) =>
                Effect.logWarning("Skipped V1 migration row", warning),
              )
              yield* tx.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, next.id)).run()
              yield* Effect.forEach(transformed.messages, (message) =>
                tx
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.make(message.id),
                    session_id: SessionSchema.ID.make(message.session_id),
                    type: message.type,
                    seq: message.seq,
                    time_created: message.time_created,
                    time_updated: message.time_updated,
                    data: sql`${JSON.stringify(message.data)}`,
                  })
                  .run(),
              )
              yield* tx
                .update(SessionTable)
                .set({ ...transformed.session, time_updated: next.time_updated })
                .where(eq(SessionTable.id, next.id))
                .run()
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: next.id, seq: transformed.watermark })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: transformed.watermark, owner_id: null },
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        if (runtimeState.status === "running")
          runtimeState = {
            status: "running",
            progress: {
              label: "Migrating sessions",
              numerator: (runtimeState.progress.numerator ?? 0) + 1,
              denominator,
            },
          }
        yield* Effect.yieldNow
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(KVTable)
              .values({ key: MIGRATION_STATE_KEY, value: { phase: "completed" } })
              .onConflictDoUpdate({
                target: KVTable.key,
                set: { value: { phase: "completed" }, time_updated: Date.now() },
              })
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* recoverRetainedMessages(db)
      return { status: "completed" as const }
    }).pipe(Effect.orDie),
  )
}

function recoverRetainedMessages(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const tables = new Set(
      (yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message_retained')`,
      )).map((table) => table.name),
    )
    if (!tables.has("session_message_retained")) return
    const sessions = yield* db.all<{ session_id: string }>(
      tables.has("message")
        ? sql`
            SELECT retained.session_id
            FROM session_message_retained retained
            INNER JOIN session_v2 ON session_v2.id = retained.session_id
            WHERE NOT EXISTS (
              SELECT 1 FROM session_message current WHERE current.session_id = retained.session_id
            ) AND NOT EXISTS (
              SELECT 1 FROM message legacy WHERE legacy.session_id = retained.session_id
            )
            GROUP BY retained.session_id
          `
        : sql`
            SELECT retained.session_id
            FROM session_message_retained retained
            INNER JOIN session_v2 ON session_v2.id = retained.session_id
            WHERE NOT EXISTS (
              SELECT 1 FROM session_message current WHERE current.session_id = retained.session_id
            )
            GROUP BY retained.session_id
          `,
    )
    yield* Effect.forEach(sessions, (session) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
              INSERT OR IGNORE INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
              SELECT id, session_id, type, seq, time_created, time_updated, data
              FROM session_message_retained
              WHERE session_id = ${session.session_id}
            `)
            const watermark = yield* tx.get<{ value: number }>(sql`
              SELECT MAX(seq) AS value FROM session_message WHERE session_id = ${session.session_id}
            `)
            if (watermark?.value === undefined) return
            yield* tx.run(sql`
              INSERT INTO event_sequence (aggregate_id, seq, owner_id)
              VALUES (${session.session_id}, ${watermark.value}, NULL)
              ON CONFLICT (aggregate_id) DO UPDATE SET seq = excluded.seq, owner_id = NULL
            `)
          }),
        )
        .pipe(
          Effect.orDie,
          Effect.tap(() => Effect.logInfo("Recovered retained V2 session history", session)),
        ),
    )
  }).pipe(Effect.orDie)
}

function nextPath(options: Options, data: string) {
  if (options.nextDatabasePath) return options.nextDatabasePath
  if (process.env.OPENCODE_DB === ":memory:") return undefined
  return path.join(data, "opencode-next.db")
}

function openNextDatabase(sourcePath: string) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      return new sqlite.Database(sourcePath, { readonly: true, strict: true })
    }),
    (source) => Effect.sync(() => source.close()),
  )
}

function countNextSessions(sourcePath: string | undefined) {
  if (!sourcePath || !existsSync(sourcePath)) return Effect.succeed(0)
  return Effect.scoped(
    Effect.gen(function* () {
      const source = yield* openNextDatabase(sourcePath)
      if (!isNextDatabase(source)) return 0
      return source.query<{ value: number }, []>("SELECT COUNT(*) AS value FROM session").get()?.value ?? 0
    }),
  )
}

function importNextDatabase(
  db: Database.Interface["db"],
  sourcePath: string | undefined,
  onProgress: (completed: number) => void,
): Effect.Effect<void, unknown> {
  if (!sourcePath || !existsSync(sourcePath)) return Effect.void
  return Effect.scoped(
    Effect.gen(function* () {
      const source = yield* openNextDatabase(sourcePath)
      if (!isNextDatabase(source)) {
        yield* Effect.logWarning("Skipped incompatible opencode-next.db", { path: sourcePath })
        return
      }
      source.run("BEGIN")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (source.inTransaction) source.run("ROLLBACK")
        }),
      )
      const projects = new Map(
        selectNextRows<NextProject>(source, "project", NEXT_PROJECT_COLUMNS).map((project) => [project.id, project]),
      )
      const sessions = selectNextRows<NextSession>(source, "session", NEXT_SESSION_COLUMNS)
      for (const [index, session] of sessions.entries()) {
        const project = projects.get(session.project_id)
        const projectID = project ? session.project_id : Project.ID.global
        if (!project) {
          yield* Effect.logWarning("Reassigned previous V2 session with missing project", {
            sessionID: session.id,
            projectID: session.project_id,
          })
        }
        const messages = source
          .query<
            NextMessage,
            [string]
          >("SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq")
          .all(session.id)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (project)
                yield* tx.run(sql`
                  INSERT OR IGNORE INTO project (
                    id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
                    time_created, time_updated, time_initialized, sandboxes, commands
                  ) VALUES (
                    ${project.id}, ${project.worktree}, ${project.vcs}, ${project.name}, ${project.icon_url},
                    ${project.icon_url_override}, ${project.icon_color}, ${project.time_created}, ${project.time_updated},
                    ${project.time_initialized}, ${project.sandboxes}, ${project.commands}
                  )
                `)
              const existing = yield* tx
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(session.id)))
                .get()
              if (existing) return
              yield* tx.run(sql`
                INSERT INTO session_v2 (
                  id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory,
                  path, title, version, share_url, summary_additions, summary_deletions, summary_files,
                  summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
                  tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting,
                  time_archived, time_suspended
                ) VALUES (
                  ${session.id}, ${projectID}, ${session.workspace_id}, ${session.parent_id},
                  ${session.fork_session_id}, ${session.fork_boundary}, ${session.slug}, ${session.directory},
                  ${session.path}, ${session.title}, ${session.version}, ${session.share_url},
                  ${session.summary_additions}, ${session.summary_deletions}, ${session.summary_files},
                  ${session.summary_diffs}, ${session.metadata}, ${session.cost}, ${session.tokens_input},
                  ${session.tokens_output}, ${session.tokens_reasoning}, ${session.tokens_cache_read},
                  ${session.tokens_cache_write}, ${session.revert}, ${session.permission}, ${session.agent},
                  ${session.model}, ${session.time_created}, ${session.time_updated}, ${session.time_compacting},
                  ${session.time_archived}, ${session.time_suspended}
                )
              `)
              yield* Effect.forEach(messages, (message) =>
                tx
                  .insert(SessionMessageTable)
                  .values({
                    id: SessionMessage.ID.make(message.id),
                    session_id: SessionSchema.ID.make(message.session_id),
                    type: message.type as SessionMessage.Type,
                    seq: message.seq,
                    time_created: message.time_created,
                    time_updated: message.time_updated,
                    data: sql`${message.data}`,
                  })
                  .run(),
              )
              yield* tx
                .insert(EventSequenceTable)
                .values({ aggregate_id: session.id, seq: messages.at(-1)?.seq ?? -1 })
                .onConflictDoUpdate({
                  target: EventSequenceTable.aggregate_id,
                  set: { seq: messages.at(-1)?.seq ?? -1, owner_id: null },
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        onProgress(index + 1)
        yield* Effect.yieldNow
      }
      source.run("COMMIT")
    }),
  )
}

function isNextDatabase(source: SQLiteDatabase) {
  const tables = new Set(
    source
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((table) => table.name),
  )
  return tables.has("project") && tables.has("session") && tables.has("session_message")
}

function selectNextRows<A>(source: SQLiteDatabase, table: "project" | "session", definition: NextColumns<A>) {
  const columns = new Set(
    source
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((column) => column.name),
  )
  const missing = Object.entries(definition)
    .filter(([column, strategy]) => strategy === "required" && !columns.has(column))
    .map(([column]) => column)
  if (missing.length)
    throw new Error(`Incompatible opencode-next.db: ${table} is missing required columns: ${missing.join(", ")}`)
  const projection = Object.entries(definition).map(([column, strategy]) => {
    if (columns.has(column)) return `"${column}"`
    if (
      typeof strategy === "object" &&
      strategy !== null &&
      "fallback" in strategy &&
      typeof strategy.fallback === "string" &&
      columns.has(strategy.fallback)
    )
      return `"${strategy.fallback}" AS "${column}"`
    return `NULL AS "${column}"`
  })
  return source
    .query<A, []>(`SELECT ${projection.join(", ")} FROM "${table}"${table === "session" ? ' ORDER BY "id" DESC' : ""}`)
    .all()
}

function readState(db: Database.Interface["db"]): Effect.Effect<MigrationState | undefined> {
  return db
    .select({ value: KVTable.value })
    .from(KVTable)
    .where(eq(KVTable.key, MIGRATION_STATE_KEY))
    .get()
    .pipe(
      Effect.map((row) => parseState(row?.value)),
      Effect.orDie,
    )
}

function parseState(input: unknown): MigrationState | undefined {
  if (!input || typeof input !== "object" || !("phase" in input)) return
  if (input.phase === "completed") return { phase: "completed" }
  if (input.phase !== "sessions") return
  if (!("cursor" in input) || input.cursor === undefined) return { phase: "sessions" }
  if (typeof input.cursor === "string") return { phase: "sessions", cursor: input.cursor }
}

function hasLegacySessions(db: Database.Interface["db"]) {
  return db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`).pipe(
    Effect.map((row) => row !== undefined),
    Effect.orDie,
  )
}
