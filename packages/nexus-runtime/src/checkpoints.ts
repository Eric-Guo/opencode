import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { atomic, missing } from "./storage"
import type { CommitTask, JsonObject } from "@cybros/agent"
import { resolvePath } from "./file-read"
import { CheckpointStore, CaptureLimit, type CheckpointOptions } from "./checkpoint-store"
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
const flags = new Map<string, { key: JsonObject; correlated: boolean }>()

export class Checkpoints {
  constructor(
    private readonly directory: string,
    readonly root: string,
    private readonly options: CheckpointOptions = {},
  ) {}

  get id() {
    return new CheckpointStore(this.directory, this.root, this.options).id
  }

  async observe(
    run: string,
    task: string,
    input: JsonObject,
    signal: AbortSignal,
    action: () => Promise<Omit<CommitTask, "claim_token">>,
  ) {
    const store = new CheckpointStore(this.directory, this.root, this.options)
    const key = JSON.stringify([this.directory, this.root, run])
    if (!flags.has(key)) {
      const captured = await store
        .capture(run, task, signal, typeof input.path === "string" ? [resolvePath(this.root, input.path)] : [])
        .catch((error: unknown) => {
          signal.throwIfAborted()
          if (error instanceof CaptureLimit)
            return { skipped: "tree_too_large", bytes: error.bytes, files: error.files }
          return undefined
        })
      if (captured && !flags.has(key))
        flags.set(key, {
          correlated: false,
          key:
            "hash" in captured
              ? {
                  hash: captured.hash,
                  store: captured.store,
                  ...(captured.outside.length ? { outside: captured.outside } : {}),
                  ...(captured.ignored.length ? { ignored: captured.ignored } : {}),
                }
              : captured,
        })
    }
    const result = await action()
    const captured = flags.get(key)
    const checkpoint = captured && !captured.correlated ? captured.key : undefined
    if (captured) captured.correlated = true
    const review = await store.review(run, signal).catch(() => {
      signal.throwIfAborted()
      return undefined
    })
    const metadata = {
      ...result.metadata,
      ...(checkpoint ? { checkpoint } : {}),
      ...(review ? { "rho.changes": review } : {}),
    }
    return {
      ...result,
      ...(Buffer.byteLength(JSON.stringify(metadata)) <= 65536
        ? { metadata }
        : checkpoint
          ? { metadata: { ...result.metadata, checkpoint } }
          : {}),
    }
  }

  capture(run: string, task: string, signal: AbortSignal) {
    return new CheckpointStore(this.directory, this.root, this.options).capture(run, task, signal)
  }

  async prune(now?: number) {
    const roots = await CheckpointStore.discover(this.directory)
    const removed = await Promise.all(
      [...new Set([this.root, ...roots])].map((root) =>
        new CheckpointStore(this.directory, root, this.options).prune(now),
      ),
    )
    return removed.reduce((total, count) => total + count, 0)
  }

  async forStore(id: string) {
    if (id === this.id || id === this.root) return this
    const roots = await CheckpointStore.discover(this.directory, id)
    return roots[0] ? this.forRoot(roots[0]) : undefined
  }

  async query(input: JsonObject, signal: AbortSignal): Promise<Omit<CommitTask, "claim_token">> {
    const keys = Object.keys(input)
      .filter((key) => key !== "store")
      .sort()
      .join(",")
    if (!["", "run_public_id", "checkpoint", "from,to"].includes(keys))
      return {
        is_error: true,
        content: "invalid_arguments: checkpoints takes {}, {run_public_id}, {checkpoint} or {from, to}",
      }
    const selected =
      input.store === undefined ? this : typeof input.store === "string" ? await this.forStore(input.store) : undefined
    if (!selected) return { is_error: true, content: "checkpoint_store_unknown: " + input.store }
    if (keys === "" || keys === "run_public_id") {
      const roots = input.store === undefined ? await CheckpointStore.discover(this.directory) : [selected.root]
      const result = await Promise.all(
        [...new Set([selected.root, ...roots])].map((root) =>
          this.forRoot(root).records(typeof input.run_public_id === "string" ? input.run_public_id : undefined),
        ),
      )
      const records = result.flatMap((result) => result.structured_content.records)
      return { content: records.length ? JSON.stringify(records) : "No checkpoints.", structured_content: { records } }
    }
    const store = new CheckpointStore(this.directory, selected.root, this.options)
    if (keys === "from,to") {
      if (typeof input.from !== "string" || typeof input.to !== "string") throw new Error("Expected checkpoint hashes.")
      const changed = await store.changed(input.from, input.to, signal)
      return { content: renderChanges(changed), structured_content: { changed } }
    }
    if (typeof input.checkpoint !== "string") throw new Error("Expected a checkpoint hash.")
    const record = (await store.records()).find((record) => record.hash === input.checkpoint)
    if (!record) return { is_error: true, content: "checkpoint_unknown: " + input.checkpoint }
    const changed = await store.changed(record.hash, undefined, signal)
    return { content: renderChanges(changed), structured_content: { record: { ...record, present: true }, changed } }
  }

  forRoot(root: string, protectedRoots = this.options.protectedRoots) {
    return root === this.root && protectedRoots === this.options.protectedRoots
      ? this
      : new Checkpoints(this.directory, root, { ...this.options, protectedRoots })
  }

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

  async records(run?: string) {
    const files = await readdir(this.directory).catch((error) => {
      if (missing(error)) return []
      throw error
    })
    const records = []
    for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      const hash = file.slice(0, -5)
      const entry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry))(
        await readFile(join(this.directory, file), "utf8"),
      )
      if (entry.root === this.root && (run === undefined || entry.run === run))
        records.push({ hash, store: this.root, present: true, task_key: entry.task })
    }
    const captured = await new CheckpointStore(this.directory, this.root, this.options).records(run)
    const combined = [...records, ...captured.map((record) => ({ ...record, present: true }))]
    return { content: JSON.stringify(combined), structured_content: { records: combined } }
  }

  async restore(hash: string, run: string, task: string, signal: AbortSignal, host?: HostTools) {
    const restored = await new CheckpointStore(this.directory, this.root, this.options).restore(hash, run, task, signal)
    if (restored) return restored
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

function renderChanges(changed: { status: string; path: string }[]) {
  return changed.length ? changed.map((row) => row.status + "  " + row.path).join("\n") : "No changes."
}
