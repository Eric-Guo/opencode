import { fileDiff } from "@opencode/core/tool/plugin/file-diff"
import type { CommitTask, JsonObject } from "@cybros/agent"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  writeFile,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { deflateSync, inflateSync } from "node:zlib"
import { Schema } from "effect"
import { runGit } from "./runner-git"
import { missing } from "./storage"

const Entry = Schema.Struct({ mode: Schema.Literals(["100644", "100755", "120000", "160000"]), hash: Schema.String })
const Manifest = Schema.Record(Schema.String, Entry)
type Manifest = Record<string, typeof Entry.Type>
const WorkingEntry = Schema.Struct({ ...Entry.fields, stat: Schema.optional(Schema.String) })
const Working = Schema.Record(Schema.String, WorkingEntry)
type Working = Record<string, typeof WorkingEntry.Type>
export type CheckpointOptions = {
  protectedRoots?: readonly string[]
  maxFileBytes?: number
  maxTreeBytes?: number
  captureTimeoutMs?: number
  retentionDays?: number
}
type RestoreResult = Omit<CommitTask, "claim_token"> & { metadata: { checkpoint: { hash: string; store: string } } }
type Capture = {
  hash: string
  store: string
  root: string
  run_public_id: string
  task_key: string
  captured_at: string
  files: number
  skipped: string[]
  nested: string[]
  outside: string[]
  ignored: string[]
}
export class CaptureLimit extends Error {
  constructor(
    readonly bytes: number,
    readonly files: number,
  ) {
    super("Checkpoint tree exceeds the capture budget.")
  }
}
const queues = new Map<string, Promise<void>>()

/** Complete, content-addressed trees independent of the project's Git index and object database. */
export class CheckpointStore {
  readonly id: string
  readonly path: string
  constructor(
    readonly directory: string,
    readonly root: string,
    readonly options: CheckpointOptions = {},
  ) {
    this.id = digest(root).slice(0, 16)
    this.path = join(directory, this.id, "checkpoints.sqlite3")
  }

  capture(run: string, task: string, signal: AbortSignal, targets: string[] = []) {
    return this.operation(signal, async (db, check) => {
      const previous = db.prepare("SELECT message FROM records WHERE run = ? AND ordinal = 0").get(run)
      if (previous) return JSON.parse(String(previous.message)) as Capture
      return this.captureInto(db, run, task, 0, check, signal, targets)
    })
  }

  static async discover(directory: string, id?: string) {
    if (id !== undefined && !/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid checkpoint store.")
    const files = id
      ? [id]
      : await readdir(directory).catch((error) => {
          if (missing(error)) return []
          throw error
        })
    const roots: string[] = []
    for (const file of files.filter((file) => /^[a-f0-9]{16}$/.test(file))) {
      const path = join(directory, file, "checkpoints.sqlite3")
      if (
        !(await lstat(path).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        continue
      const root = await Promise.resolve()
        .then(() => {
          const db = new DatabaseSync(path, { readOnly: true })
          try {
            return db.prepare("SELECT json_extract(message, '$.root') AS root FROM records LIMIT 1").get()?.root
          } finally {
            db.close()
          }
        })
        .catch(() => undefined)
      if (typeof root === "string" && digest(root).slice(0, 16) === file) roots.push(root)
    }
    return roots
  }

  records(run?: string, signal = new AbortController().signal) {
    return this.operation(signal, async (db) =>
      (run === undefined
        ? db.prepare("SELECT message FROM records ORDER BY run, ordinal").all()
        : db.prepare("SELECT message FROM records WHERE run = ? ORDER BY ordinal").all(run)
      ).map((row) => JSON.parse(String(row.message)) as Capture),
    )
  }

  changed(from: string, to: string | undefined, signal: AbortSignal) {
    return this.operation(signal, async (db, check) => {
      const read = (hash: string) => {
        const saved = db.prepare("SELECT manifest FROM trees WHERE hash = ?").get(hash)
        if (!saved) throw new Error("checkpoint_unknown: " + hash)
        return Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(String(saved.manifest))
      }
      const before = read(from)
      const current = to ?? (await this.captureInto(db, "review", "review", -1, check, signal)).hash
      return differences(before, read(current))
    })
  }

  prune(now = Date.now(), signal = new AbortController().signal) {
    return this.operation(signal, async (db) => {
      db.exec("BEGIN IMMEDIATE")
      try {
        const removed = db
          .prepare("DELETE FROM records WHERE created_at < ?")
          .run(now - (this.options.retentionDays ?? 7) * 86400000).changes
        db.exec("DELETE FROM trees WHERE hash NOT IN (SELECT hash FROM records)")
        db.exec(
          "DELETE FROM blobs WHERE hash NOT IN (SELECT json_extract(value, '$.hash') FROM trees, json_each(trees.manifest))",
        )
        db.exec("COMMIT")
        db.exec("VACUUM")
        return Number(removed)
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    })
  }

  restore(hash: string, run: string, task: string, signal: AbortSignal): Promise<RestoreResult | undefined> {
    return this.operation(signal, async (db, check): Promise<RestoreResult | undefined> => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Unknown runner checkpoint.")
      const saved = db.prepare("SELECT manifest FROM trees WHERE hash = ?").get(hash)
      if (!saved) return undefined
      const target = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(String(saved.manifest))
      if (Object.keys(target).some((path) => this.excluded(join(this.root, path))))
        throw new Error("Restore refused: protected root inside the checkpoint.")
      const ordinal = Number(
        db.prepare("SELECT coalesce(max(ordinal), 0) + 1 AS ordinal FROM records WHERE run = ?").get(run)!.ordinal,
      )
      const undo = await this.captureInto(db, run, task, ordinal, check, signal)
      try {
        const current = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
          String(db.prepare("SELECT manifest FROM trees WHERE hash = ?").get(undo.hash)!.manifest),
        )
        const nested = Object.entries(current)
          .filter(([, entry]) => entry.mode === "160000")
          .map(([path]) => path)
        const selected: Manifest = Object.fromEntries(
          Object.entries(target).filter(
            ([path, entry]) =>
              entry.mode !== "160000" && !nested.some((nested) => beneath(path, nested) || beneath(nested, path)),
          ),
        )
        nested.forEach((path) => {
          selected[path] = current[path]
        })
        const changed = [...new Set([...Object.keys(current), ...Object.keys(selected)])].filter(
          (path) => current[path]?.hash !== selected[path]?.hash || current[path]?.mode !== selected[path]?.mode,
        )
        // An undo is durable before any file changes, including a refused restore.
        for (const path of changed.filter((path) => !current[path])) await this.obstruction(path, current, check)
        for (const path of changed.toSorted((a, b) => b.split(sep).length - a.split(sep).length)) {
          check()
          if (!current[path] || current[path].mode === "160000") continue
          await unlink(join(this.root, path))
          let parent = dirname(join(this.root, path))
          while (parent !== this.root) {
            if (
              !(await rmdir(parent).then(
                () => true,
                () => false,
              ))
            )
              break
            parent = dirname(parent)
          }
        }
        for (const path of changed) {
          check()
          const entry = selected[path]
          if (!entry || entry.mode === "160000") continue
          const full = join(this.root, path)
          const blob = db.prepare("SELECT data, compressed FROM blobs WHERE hash = ?").get(entry.hash)
          if (!blob || !(blob.data instanceof Uint8Array)) throw new Error("Checkpoint content is missing.")
          const bytes = blob.compressed ? inflateSync(blob.data) : blob.data
          await mkdir(dirname(full), { recursive: true })
          await rmdir(full).catch((error) => {
            if (!missing(error)) throw error
          })
          if (entry.mode === "120000") {
            await symlink(Buffer.from(bytes).toString(), full)
            continue
          }
          const temporary = join(dirname(full), ".checkpoint-" + crypto.randomUUID())
          const handle = await open(temporary, "wx", entry.mode === "100755" ? 0o755 : 0o644)
          try {
            await handle.writeFile(bytes)
            await handle.chmod(entry.mode === "100755" ? 0o755 : 0o644)
            await handle.close()
            check()
            await rename(temporary, full)
          } finally {
            await handle.close()
            await unlink(temporary).catch((error) => {
              if (!missing(error)) throw error
            })
          }
        }
        const working: Working = {}
        for (const [path, entry] of Object.entries(selected)) {
          const info = await lstat(join(this.root, path))
          working[path] = {
            ...entry,
            stat: JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev, info.mode]),
          }
        }
        db.prepare("INSERT OR REPLACE INTO working(singleton, entries) VALUES (1, ?)").run(JSON.stringify(working))
        const removed = changed.filter((path) => !selected[path]).length
        return {
          content:
            "Restored " +
            (changed.length - removed) +
            " files to " +
            hash +
            (removed ? " (" + removed + " removed)" : "") +
            "; undo with " +
            undo.hash,
          structured_content: { restored: hash, undo: undo.hash, files: changed.length - removed, removed, nested },
          metadata: { checkpoint: { hash: undo.hash, store: this.id } },
        }
      } catch (error) {
        signal.throwIfAborted()
        return {
          is_error: true,
          content:
            (error instanceof Error && error.message.startsWith("Restore refused:")
              ? "restore_refused: "
              : "restore_failed: ") +
            (error instanceof Error ? error.message : String(error)) +
            "; the tree before this call is " +
            undo.hash,
          structured_content: { undo: undo.hash },
          metadata: { checkpoint: { hash: undo.hash, store: this.id } },
        }
      }
    })
  }

  review(run: string, signal: AbortSignal) {
    return this.operation(signal, async (db, check) => {
      const baseline = db.prepare("SELECT hash FROM records WHERE run = ? AND ordinal = 0").get(run)
      if (!baseline) return undefined
      const current = await this.captureInto(db, run, "review", -1, check, signal)
      const read = (hash: string) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
          String(db.prepare("SELECT manifest FROM trees WHERE hash = ?").get(hash)!.manifest),
        )
      const before = read(String(baseline.hash))
      const after = read(current.hash)
      const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .sort()
        .filter((path) => before[path]?.hash !== after[path]?.hash || before[path]?.mode !== after[path]?.mode)
      const files: JsonObject[] = []
      const result = {
        root: this.root,
        base: String(baseline.hash),
        captured_at: new Date().toISOString(),
        files,
        truncated: paths.length > 200,
      }
      const bytes = (entry: typeof Entry.Type | undefined) => {
        if (!entry) return Buffer.alloc(0)
        if (entry.mode === "160000") return Buffer.from(entry.hash)
        const blob = db.prepare("SELECT data, compressed FROM blobs WHERE hash = ?").get(entry.hash)!
        if (!(blob.data instanceof Uint8Array)) throw new Error("Checkpoint content is missing.")
        return Buffer.from(blob.compressed ? inflateSync(blob.data) : blob.data)
      }
      for (const path of paths.slice(0, 200)) {
        check()
        const old = bytes(before[path])
        const next = bytes(after[path])
        const status = !before[path]
          ? "A"
          : !after[path]
            ? "D"
            : before[path].mode.slice(0, 3) !== after[path].mode.slice(0, 3)
              ? "T"
              : "M"
        const binary =
          old.includes(0) ||
          next.includes(0) ||
          !Buffer.from(old.toString()).equals(old) ||
          !Buffer.from(next.toString()).equals(next)
        const diff = binary
          ? undefined
          : fileDiff(
              path,
              old.toString(),
              next.toString(),
              status === "A" ? "added" : status === "D" ? "deleted" : "modified",
            )
        const patch = diff
          ? (before[path] && after[path] && before[path].mode !== after[path].mode
              ? "old mode " + before[path].mode + "\nnew mode " + after[path].mode + "\n"
              : "") + diff.patch
          : undefined
        const file: JsonObject = {
          path,
          status,
          state: binary ? "binary" : Buffer.byteLength(patch!) > 32768 ? "too_large" : "text",
          ...(diff ? { additions: diff.additions, deletions: diff.deletions } : {}),
        }
        if (file.state === "text") file.patch = patch!
        files.push(file)
        if (Buffer.byteLength(JSON.stringify(result)) > 49152) {
          delete file.patch
          if (file.state === "text") file.state = "omitted"
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 49152) {
          files.pop()
          result.truncated = true
          break
        }
      }
      return result
    })
  }

  private async captureInto(
    db: DatabaseSync,
    run: string,
    task: string,
    ordinal: number,
    check: () => void,
    signal: AbortSignal,
    targets: string[] = [],
  ) {
    const root = await realpath(this.root)
    if (root !== this.root || this.excluded(root))
      throw new Error("Checkpoint root must be canonical and outside protected state.")
    const entries: Manifest = {}
    const working: Working = {}
    const saved = db.prepare("SELECT entries FROM working WHERE singleton = 1").get()
    const previous = saved ? Schema.decodeUnknownSync(Schema.fromJsonString(Working))(String(saved.entries)) : {}
    const seed = new Map<string, { mode: string; hash: string }>()
    const blobs = new Map<string, Buffer>()
    const skipped: string[] = []
    const nested: string[] = []
    let bytes = 0
    const changed = new Set<string>()
    const candidates: string[] = []
    let ignored = false
    const collect = async (directory: string) => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        check()
        const full = join(directory, item.name)
        if (this.excluded(full)) continue
        if (item.name === ".git") {
          if (directory === this.root) ignored = true
          continue
        }
        if (item.name === ".gitignore") ignored = true
        if (item.isDirectory()) {
          if (
            await lstat(join(full, ".git")).then(
              () => true,
              () => false,
            )
          ) {
            candidates.push(relative(this.root, full))
            continue
          }
          await collect(full)
          continue
        }
        if (item.isFile() || item.isSymbolicLink()) candidates.push(relative(this.root, full))
      }
    }
    await collect(this.root)
    const allowed = new Set(candidates)
    if (ignored) {
      const rules = join(dirname(this.path), "ignore-rules.git")
      if (
        !(await lstat(rules).then(
          () => true,
          () => false,
        ))
      )
        await runGit(this.root, ["init", "--bare", "--quiet", rules], signal)
      const project = await runGit(
        this.root,
        ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
        signal,
      ).catch(() => undefined)
      const exclude = project ? await readFile(project.stdout.trim()).catch(() => Buffer.alloc(0)) : Buffer.alloc(0)
      await writeFile(join(rules, "info", "exclude"), exclude)
      const query = await runGit(
        this.root,
        [
          "--git-dir=" + rules,
          "--work-tree=" + this.root,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ".",
        ],
        signal,
      )
      if (!saved) {
        const tracked = await runGit(this.root, ["ls-tree", "-r", "-z", "HEAD"], signal).catch(() => undefined)
        for (const line of tracked?.stdout.split("\0").filter(Boolean) ?? []) {
          const tab = line.indexOf("\t")
          const metadata = line.slice(0, tab).split(" ")
          seed.set(line.slice(tab + 1), { mode: metadata[0], hash: metadata[2] })
        }
      }
      allowed.clear()
      ;[...query.stdout.split("\0"), ...seed.keys(), ...Object.keys(previous)]
        .filter(Boolean)
        .forEach((path) => allowed.add(path.replace(/\/$/, "")))
    }
    const visit = async (directory: string) => {
      for (const item of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        check()
        const full = join(directory, item.name)
        if (item.name === ".git" || this.excluded(full)) continue
        const path = relative(this.root, full)
        const info = await lstat(full)
        if (info.isDirectory()) {
          if (
            await lstat(join(full, ".git")).then(
              () => true,
              () => false,
            )
          ) {
            if (!allowed.has(path) && ![...allowed].some((item) => item.startsWith(path + sep))) continue
            const head = await runGit(full, ["rev-parse", "HEAD"], signal)
            const status = await runGit(full, ["status", "--porcelain=v1", "--untracked-files=all"], signal)
            entries[path] = { mode: "160000", hash: head.stdout.trim() }
            working[path] = entries[path]
            if (previous[path]?.hash !== entries[path].hash || status.stdout) changed.add(path)
            nested.push(path)
            continue
          }
          await visit(full)
          continue
        }
        if (!allowed.has(path)) continue
        if (!info.isFile() && !info.isSymbolicLink()) {
          skipped.push(path)
          continue
        }
        if (!previous[path] && !seed.has(path) && info.size > (this.options.maxFileBytes ?? 2 * 1024 * 1024)) {
          skipped.push(path)
          changed.add(path)
          continue
        }
        const data = info.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full)
        check()
        const hash = digest(data)
        const mode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644"
        const stat = JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev, info.mode])
        const old = previous[path]
        const tracked = seed.get(path)
        const unchangedSeed =
          tracked?.mode === mode &&
          createHash(tracked.hash.length === 40 ? "sha1" : "sha256")
            .update("blob " + data.length + "\0")
            .update(data)
            .digest("hex") === tracked.hash
        if (
          !unchangedSeed &&
          (old?.hash !== hash || old?.mode !== mode || (old.stat !== undefined && old.stat !== stat))
        ) {
          bytes += data.length
          changed.add(path)
        }
        blobs.set(hash, data)
        entries[path] = { mode, hash }
        working[path] = { mode, hash, stat }
      }
    }
    await visit(this.root)
    ;[...Object.keys(previous), ...seed.keys()].filter((path) => !entries[path]).forEach((path) => changed.add(path))
    if (bytes > (this.options.maxTreeBytes ?? 256 * 1024 * 1024)) throw new CaptureLimit(bytes, changed.size)
    const manifest = JSON.stringify(
      Object.fromEntries(Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b))),
    )
    const hash = digest(manifest)
    const ignoredTargets: string[] = []
    for (const target of targets.filter((path) => beneath(path, this.root) && path !== this.root)) {
      const path = relative(this.root, target)
      if (this.excluded(target)) {
        ignoredTargets.push(path)
        continue
      }
      if (allowed.has(path) || !ignored) continue
      const result = await runGit(
        this.root,
        [
          "--git-dir=" + join(dirname(this.path), "ignore-rules.git"),
          "--work-tree=" + this.root,
          "check-ignore",
          "--no-index",
          "--",
          path,
        ],
        signal,
      ).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === 1) return { stdout: "" }
        throw error
      })
      if (result.stdout.trim()) ignoredTargets.push(path)
    }
    const now = Date.now()
    const record: Capture = {
      hash,
      store: this.id,
      root: this.root,
      run_public_id: run,
      task_key: task,
      captured_at: new Date(now).toISOString(),
      files: Object.keys(entries).length - nested.length,
      skipped,
      nested,
      outside: targets.filter((path) => !beneath(path, this.root)),
      ignored: ignoredTargets,
    }
    db.exec("BEGIN IMMEDIATE")
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO blobs(hash, data, compressed) VALUES (?, ?, ?)")
      for (const [hash, bytes] of blobs) {
        check()
        const compressed = deflateSync(bytes)
        insert.run(
          hash,
          compressed.length < bytes.length ? compressed : bytes,
          compressed.length < bytes.length ? 1 : 0,
        )
      }
      db.prepare("INSERT OR IGNORE INTO trees(hash, manifest) VALUES (?, ?)").run(hash, manifest)
      if (ordinal >= 0)
        db.prepare("INSERT INTO records(run, ordinal, hash, created_at, message) VALUES (?, ?, ?, ?, ?)").run(
          run,
          ordinal,
          hash,
          now,
          JSON.stringify(record),
        )
      db.prepare("INSERT OR REPLACE INTO working(singleton, entries) VALUES (1, ?)").run(JSON.stringify(working))
      db.exec("COMMIT")
      return record
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }

  private excluded(path: string) {
    return [this.directory, ...(this.options.protectedRoots ?? [])].some((root) => beneath(path, root))
  }

  private async obstruction(path: string, captured: Manifest, check: () => void) {
    const parts = path.split(sep)
    for (let count = 1; count <= parts.length; count++) {
      check()
      const prefix = parts.slice(0, count).join(sep)
      const info = await lstat(join(this.root, prefix)).catch((error) => {
        if (missing(error)) return undefined
        throw error
      })
      if (!info) return
      if (!info.isDirectory()) {
        if (!captured[prefix]) throw new Error("Restore refused: uncaptured path " + prefix)
        return
      }
    }
    const walk = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        check()
        const full = join(directory, item.name)
        if (item.isDirectory()) {
          await walk(full)
          continue
        }
        if (!captured[relative(this.root, full)])
          throw new Error("Restore refused: uncaptured path " + relative(this.root, full))
      }
    }
    await walk(join(this.root, path))
  }

  private operation<T>(signal: AbortSignal, action: (db: DatabaseSync, check: () => void) => Promise<T>): Promise<T> {
    const operation = (queues.get(this.path) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted()
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const db = new DatabaseSync(this.path)
      const deadline = Date.now() + (this.options.captureTimeoutMs ?? 30000)
      const check = () => {
        signal.throwIfAborted()
        if (Date.now() > deadline) throw new Error("Checkpoint capture timed out.")
      }
      try {
        db.exec(
          "PRAGMA busy_timeout = 30000; CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, data BLOB NOT NULL, compressed INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS trees(hash TEXT PRIMARY KEY, manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(run TEXT NOT NULL, ordinal INTEGER NOT NULL, hash TEXT NOT NULL REFERENCES trees(hash), created_at INTEGER NOT NULL, message TEXT NOT NULL, PRIMARY KEY(run, ordinal)); CREATE INDEX IF NOT EXISTS records_age ON records(created_at); CREATE TABLE IF NOT EXISTS working(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), entries TEXT NOT NULL)",
        )
        return await action(db, check)
      } finally {
        db.close()
      }
    })
    const completed = operation.then(
      () => {},
      () => {},
    )
    queues.set(this.path, completed)
    void completed.then(() => {
      if (queues.get(this.path) === completed) queues.delete(this.path)
    })
    return operation
  }
}

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
function beneath(path: string, root: string) {
  const from = relative(root, path)
  return !isAbsolute(from) && from !== ".." && !from.startsWith(".." + sep)
}

function differences(before: Manifest, after: Manifest) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((path) => {
    const left = before[path]
    const right = after[path]
    if (left?.hash === right?.hash && left?.mode === right?.mode) return []
    return [{ path, status: !left ? "A" : !right ? "D" : left.mode.slice(0, 3) !== right.mode.slice(0, 3) ? "T" : "M" }]
  })
}
