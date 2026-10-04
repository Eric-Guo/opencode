export * as DatabaseProcessOwner from "./process-owner.js"

import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { ProcessOwner } from "@opencode/util/process-owner"
import { mkdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"

/** Linux executable servers share one execution owner per file database, independent of PID/network namespaces. */
export const acquire = Effect.fn("DatabaseProcessOwner.acquire")(function* (filename = ":memory:") {
  if (filename === ":memory:" || process.platform !== "linux") return filename
  const path = isAbsolute(filename) ? filename : join((yield* Global.Service).data, filename)
  const canonical = yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (existing?.isFile() && existing.nlink > 1)
        throw new Error("Server database ownership does not support hard-linked databases")
      return existing ? realpath(path) : join(await realpath(dirname(path)), basename(path))
    },
    catch: (cause) => cause,
  })
  yield* ProcessOwner.lease(
    canonical + ".owner",
    "Another server owns this database. Connect to that server or select a separate database with OPENCODE_DB.",
  )
  return canonical
})
