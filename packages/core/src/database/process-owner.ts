export * as DatabaseProcessOwner from "./process-owner.js"

import { Context, Effect, Exit, Layer, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Global } from "@opencode/util/global"
import { chmod, mkdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { sqliteLayer } from "#sqlite"

/** Executable servers share one execution owner per file database, independent of PID/network namespaces. */
export const acquire = Effect.fn("DatabaseProcessOwner.acquire")(function* (filename = ":memory:") {
  if (filename === ":memory:") return filename
  const path = isAbsolute(filename) ? filename : join((yield* Global.Service).data, filename)
  const canonical = yield* Effect.tryPromise(async () => {
    await mkdir(dirname(path), { recursive: true })
    const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing?.isFile() && existing.nlink > 1)
      throw new Error("Server database ownership does not support hard-linked databases")
    return existing ? realpath(path) : join(await realpath(dirname(path)), basename(path))
  })
  yield* lease(
    canonical + ".owner.sqlite",
    "Another server owns this database. Connect to that server or select a separate database with OPENCODE_DB.",
  )
  return canonical
})

/** A permanent sidecar lock, held by the caller's scope. It must never be unlinked or replaced. */
export const lease = Effect.fn("DatabaseProcessOwner.lease")(function* (lock: string, message: string) {
  const scope = yield* Scope.fork(yield* Scope.Scope)
  yield* Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(sqliteLayer({ filename: lock, disableWAL: true }), scope)
    if (process.platform !== "win32") yield* Effect.tryPromise(() => chmod(lock, 0o600))
    const sql = Context.get(context, SqlClient.SqlClient)
    yield* sql.unsafe("PRAGMA busy_timeout = 0")
    yield* sql
      .unsafe("BEGIN IMMEDIATE")
      .pipe(
        Effect.mapError((cause) =>
          cause.reason._tag === "LockTimeoutError"
            ? Object.assign(new Error(message, { cause }), { name: "ProcessOwnerBusy" })
            : cause,
        ),
      )
  }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))))
})
