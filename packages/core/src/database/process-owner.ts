export * as DatabaseProcessOwner from "./process-owner.js"

import { Effect, Schema } from "effect"
import { Global } from "@opencode/util/global"
import { mkdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"

const Owner = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.String.check(Schema.isNonEmpty()),
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    platform: Schema.String,
    host: Schema.String,
    boot: Schema.String,
    pidNamespace: Schema.String,
    netNamespace: Schema.String,
    started: Schema.String,
  }),
)
const decodeOwner = Schema.decodeUnknownSync(Owner)
type Owner = typeof Owner.Type

function busy(message: string, cause?: unknown) {
  return Object.assign(new Error(message, { cause }), { name: "ProcessOwnerBusy" })
}

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
  yield* lease(
    canonical + ".owner",
    "Another server owns this database. Connect to that server or select a separate database with OPENCODE_DB.",
  )
  return canonical
})

/** Atomic directories, not kernel locks: overlay-backed executors may share files but not SQLite locks. */
export const lease = Effect.fn("DatabaseProcessOwner.lease")(function* (directory: string, message: string) {
  if (process.platform !== "linux") return
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const owner = await identity()
        const recovery = directory + ".recover"
        if (
          await stat(recovery)
            .then(() => true)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false
              throw error
            })
        )
          throw busy(message + " Ownership recovery is in progress or needs manual verification.")
        if (!(await create(directory))) {
          if (!(await expired(await readOwner(directory, message), owner)))
            throw busy(message + " Its owner is still alive.")
          // This independent atomic claim serializes stale reclaimers even when their kernel locks are isolated.
          if (!(await create(recovery))) throw busy(message + " Ownership recovery is already claimed.")
          try {
            if (!(await expired(await readOwner(directory, message), owner)))
              throw busy(message + " Its owner is still alive.")
            await rm(directory, { recursive: true })
            if (!(await create(directory))) throw busy(message + " Another owner won the publication race.")
          } finally {
            await rm(recovery, { recursive: true })
          }
        }
        await writeFile(join(directory, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 })
        return owner
      },
      catch: (cause) => cause,
    }),
    (owner) =>
      Effect.tryPromise({
        try: async () => {
          const current = await readOwner(directory, message)
          if (current.token === owner.token) await rm(directory, { recursive: true })
        },
        catch: (cause) => cause,
      }).pipe(Effect.catch((cause) => Effect.logWarning("Could not release process ownership marker", cause))),
  )
})

async function create(directory: string) {
  return mkdir(directory, { mode: 0o700 })
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw error
    })
}

async function readOwner(directory: string, message: string) {
  return readFile(join(directory, "owner.json"), "utf8")
    .then(decodeOwner)
    .catch((cause: unknown) => {
      throw busy(
        message + " Its ownership marker is incomplete or unreadable; verify the original owner before removing it.",
        cause,
      )
    })
}

async function identity(): Promise<Owner> {
  const [boot, pidNamespace, netNamespace, value] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink("/proc/self/ns/pid"),
    readlink("/proc/self/ns/net"),
    readFile("/proc/self/stat", "utf8"),
  ])
  if (value.slice(0, value.indexOf(" ")) !== String(process.pid))
    throw new Error("Linux /proc uses a different PID namespace; cannot safely own this database")
  return {
    token: randomUUID(),
    pid: process.pid,
    platform: process.platform,
    host: hostname(),
    boot: boot.trim(),
    pidNamespace,
    netNamespace,
    started: processStart(value),
  }
}

async function expired(previous: Owner, current: Owner) {
  if (
    previous.platform !== current.platform ||
    previous.host !== current.host ||
    previous.boot !== current.boot ||
    previous.pidNamespace !== current.pidNamespace ||
    previous.netNamespace !== current.netNamespace ||
    !/^\d+$/.test(previous.started)
  )
    throw busy(
      "Database or service ownership belongs to another execution domain. Stop it in its original environment or use a separate database; it will not be taken over automatically.",
    )
  const value = await readFile(`/proc/${previous.pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  return (
    value === undefined ||
    processStart(value) !== previous.started ||
    value.slice(value.lastIndexOf(")") + 2).split(" ")[0] === "Z"
  )
}

function processStart(value: string) {
  const started = value.slice(value.lastIndexOf(")") + 2).split(" ")[19]
  if (!started || !/^\d+$/.test(started)) throw new Error("Cannot establish Linux process identity")
  return started
}
