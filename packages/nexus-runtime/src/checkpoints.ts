import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { atomic, missing } from "./storage"
import { destination, mutate, readText } from "./mutation"
import type { HostTools } from "./host"

const Text = Schema.Struct({
  kind: Schema.Literal("file"),
  path: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  mode: Schema.Number,
})
const Tree = Schema.Struct({
  kind: Schema.Literal("tree"),
  before: Schema.String,
  after: Schema.String,
  pathsFrom: Schema.optional(Schema.String),
  pathsTo: Schema.optional(Schema.String),
})
const Entry = Schema.Struct({
  root: Schema.String,
  run: Schema.String,
  task: Schema.String,
  change: Schema.Union([Text, Tree]),
})
type Entry = typeof Entry.Type

export class Checkpoints {
  constructor(
    private readonly directory: string,
    readonly root: string,
  ) {}

  async save(run: string, task: string, change: Entry["change"]) {
    const entry = { root: this.root, run, task, change }
    const hash = createHash("sha256").update(JSON.stringify(entry)).digest("hex")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await atomic(join(this.directory, hash + ".json"), entry)
    return { hash, store: this.root }
  }

  private async read(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Unknown runner checkpoint.")
    const entry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry))(
      await readFile(join(this.directory, hash + ".json"), "utf8"),
    )
    if (entry.root !== this.root) throw new Error("Checkpoint belongs to a different directory.")
    return entry
  }

  async records(run: string) {
    const files = await readdir(this.directory).catch((error) => {
      if (missing(error)) return []
      throw error
    })
    const records = []
    for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      const hash = file.slice(0, -5)
      const entry = await this.read(hash)
      if (entry.run === run) records.push({ hash, store: this.root, present: true, task_key: entry.task })
    }
    return { content: JSON.stringify(records), structured_content: { records } }
  }

  async restore(hash: string, run: string, task: string, signal: AbortSignal, host?: HostTools) {
    const { change } = await this.read(hash)
    signal.throwIfAborted()
    if (change.kind === "tree") {
      if (!host) throw new Error("Git snapshots are unavailable.")
      const current = await host.capture(this.root, signal)
      if (!current) throw new Error("Could not capture the undo checkpoint.")
      const undo = await this.save(run, task, {
        kind: "tree",
        before: current,
        after: change.before,
        pathsFrom: change.pathsFrom ?? change.before,
        pathsTo: change.pathsTo ?? change.after,
      })
      await host.restoreTree(this.root, change.before, change.after, current, signal, change.pathsFrom, change.pathsTo)
      return { content: "Restored changed project files.", metadata: { checkpoint: undo } }
    }
    const file = await destination(this.root, change.path)
    const info = await stat(file).catch((error) => {
      if (missing(error)) return null
      throw error
    })
    const current = info ? await readText(file, signal) : null
    if (current !== change.after || (info && (info.mode & 0o777) !== (change.mode & 0o777)))
      throw new Error("The file has changed since this checkpoint.")
    const undo = await this.save(run, task, {
      ...change,
      before: current,
      after: change.before,
      mode: info?.mode ?? change.mode,
    })
    if (change.before !== null)
      await mutate(this.root, "write", { path: change.path, content: change.before }, signal, undefined, change.mode)
    else if (info) await unlink(file)
    return { content: "Restored " + change.path, metadata: { checkpoint: undo } }
  }
}
