import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, readlink, rm } from "node:fs/promises"
import path from "node:path"
import { directory, id, initialize, privateRead, publish, rootDirectory } from "./files"
export { initialize } from "./files"

// Experimental same-UID transport. Only the fixed fake executor is admitted.
// Namespace/PID metadata never grants permission to reclaim an owner.
export type Command =
  | { op: "ping" | "sessions" }
  | { op: "submit"; text: string; durationMs: number; sessionId?: string }
  | { op: "query" | "result" | "cancel"; taskId: string }

export type Task = {
  id: string
  sessionId: string
  text: string
  durationMs: number
  state: "queued" | "running" | "completed" | "cancelled"
  result: string | null
  starts: number
}

export type Reply = {
  id: string
  ownerId: string
  hash: string
  task?: Task
  sessions?: string[]
  error?: string
  active?: number
  maxActive?: number
  pidNamespace?: string
  netNamespace?: string
}

type Envelope = { version: 1; id: string; ownerId: string; command: Command }
type Owner = { id: string; pid: number; startedAt: number; pidNamespace: string; netNamespace: string }
const maxBytes = 65_536

function parseCommand(input: unknown): Command {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid command")
  const value = input as Record<string, unknown>
  const keys = Object.keys(value)
  if (value.op === "ping" || value.op === "sessions") {
    if (keys.length !== 1) throw new Error("Unexpected command fields")
    return { op: value.op }
  }
  if (value.op === "query" || value.op === "result" || value.op === "cancel") {
    if (keys.length !== 2) throw new Error("Unexpected command fields")
    return { op: value.op, taskId: id(value.taskId) }
  }
  if (value.op !== "submit" || keys.some((key) => !["op", "text", "durationMs", "sessionId"].includes(key)))
    throw new Error("Unsupported command; this prototype only runs the fixed fake executor")
  if (typeof value.text !== "string" || value.text.length > 4096) throw new Error("Invalid fake task text")
  if (
    typeof value.durationMs !== "number" ||
    !Number.isInteger(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > 60_000
  )
    throw new Error("Invalid fake task duration")
  return {
    op: "submit",
    text: value.text,
    durationMs: value.durationMs,
    ...(value.sessionId === undefined ? {} : { sessionId: id(value.sessionId) }),
  }
}

function digest(command: Command) {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex")
}

async function readOwner(root: string): Promise<Owner> {
  await directory(path.join(root, "worker.lock"))
  const value = JSON.parse(await privateRead(path.join(root, "worker.lock", "owner.json"))) as Owner
  id(value.id)
  return value
}

export async function connect(root: string, options: { timeoutMs?: number; pollMs?: number } = {}) {
  await rootDirectory(root)
  await directory(path.join(root, "requests"))
  await directory(path.join(root, "replies"))
  const owner = await readOwner(root).catch(() => {
    throw new Error("Workspace sharing service unavailable; start its owner explicitly")
  })
  return {
    owner,
    async request(input: Command, requestId: string = randomUUID()): Promise<Reply> {
      id(requestId)
      const command = parseCommand(input)
      const hash = digest(command)
      const envelope: Envelope = { version: 1, id: requestId, ownerId: owner.id, command }
      await rootDirectory(root)
      const current = await readOwner(root).catch(() => {
        throw new Error("Workspace sharing service unavailable; no automatic takeover")
      })
      if (current.id !== owner.id) throw new Error("Workspace sharing owner changed; reconnect explicitly")
      if (
        (await readdir(path.join(root, "requests"))).length >= 4096 &&
        !(await lstat(path.join(root, "requests", `${requestId}.json`)).catch(() => undefined))
      )
        throw new Error("Prototype request limit reached; no automatic cleanup or replay")
      await publish(path.join(root, "requests"), `${requestId}.json`, envelope).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
          const existing = await privateRead(path.join(root, "requests", `${requestId}.json`), maxBytes, true)
          if (existing !== JSON.stringify(envelope))
            throw new Error("Request ID conflict; retries must keep the same payload and owner")
        },
      )
      const deadline = Date.now() + (options.timeoutMs ?? 2_000)
      while (Date.now() < deadline) {
        const raw = await privateRead(path.join(root, "replies", `${requestId}.json`)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          },
        )
        if (raw) {
          const reply = JSON.parse(raw) as Reply
          if (reply.id !== requestId || reply.ownerId !== owner.id || reply.hash !== hash)
            throw new Error("Reply identity conflict")
          return reply
        }
        await Bun.sleep(options.pollMs ?? 20)
      }
      throw new Error(
        `Workspace sharing service unavailable or outcome unknown; retry the same request ID: ${requestId}. No takeover was attempted.`,
      )
    },
  }
}

export async function startWorker(root: string, options: { concurrency?: number; pollMs?: number } = {}) {
  const concurrency = options.concurrency ?? 2
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
    throw new Error("Prototype concurrency must be 1 or 2")
  await initialize(root)
  const lock = path.join(root, "worker.lock")
  await mkdir(lock, { mode: 0o700 }).catch(() => {
    throw new Error("Workspace sharing owner exists; refusing takeover, even if its PID or heartbeat is unavailable")
  })
  const owner: Owner = {
    id: randomUUID(),
    pid: process.pid,
    startedAt: Date.now(),
    pidNamespace: process.platform === "linux" ? await readlink("/proc/self/ns/pid") : "unavailable",
    netNamespace: process.platform === "linux" ? await readlink("/proc/self/ns/net") : "unavailable",
  }
  await publish(lock, "owner.json", owner)
  const dbPath = path.join(root, "tasks.sqlite")
  const seed = await open(dbPath, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
    await privateRead(dbPath, 64 * 1024 * 1024)
  })
  await seed?.close()
  for (const suffix of ["-wal", "-shm"]) {
    await privateRead(dbPath + suffix, 64 * 1024 * 1024).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, text TEXT NOT NULL, durationMs INTEGER NOT NULL, state TEXT NOT NULL, result TEXT, starts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, reply TEXT NOT NULL);`)
  const active = new Map<string, AbortController>()
  const seen = new Set<string>()
  const state = { stopping: false, maxActive: 0, fatal: undefined as unknown }
  const task = (taskId: string) => db.query<Task, [string]>("SELECT * FROM tasks WHERE id = ?").get(taskId) ?? undefined
  const finish = (taskId: string, status: Task["state"], result: string | null) => {
    db.query("UPDATE tasks SET state = ?, result = ? WHERE id = ? AND state = 'running'").run(status, result, taskId)
  }
  const execute = (item: Task) => {
    const controller = new AbortController()
    active.set(item.id, controller)
    state.maxActive = Math.max(state.maxActive, active.size)
    db.query("UPDATE tasks SET state = 'running', starts = starts + 1 WHERE id = ?").run(item.id)
    const timer = setTimeout(() => {
      finish(item.id, "completed", `fake:${item.text}`)
      active.delete(item.id)
    }, item.durationMs)
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        finish(item.id, "cancelled", null)
        active.delete(item.id)
      },
      { once: true },
    )
  }
  const handle = (envelope: Envelope): Reply => {
    const hash = digest(envelope.command)
    const reply: Reply = { id: envelope.id, ownerId: owner.id, hash }
    if (envelope.ownerId !== owner.id) return { ...reply, error: "wrong_owner" }
    const previous = db
      .query<{ hash: string; reply: string }, [string]>("SELECT hash, reply FROM requests WHERE id = ?")
      .get(envelope.id)
    if (previous)
      return previous.hash === hash ? (JSON.parse(previous.reply) as Reply) : { ...reply, error: "request_id_conflict" }
    const command = envelope.command
    if (command.op === "ping")
      Object.assign(reply, {
        active: active.size,
        maxActive: state.maxActive,
        pidNamespace: owner.pidNamespace,
        netNamespace: owner.netNamespace,
      })
    if (command.op === "sessions")
      reply.sessions = db
        .query<{ sessionId: string }, []>("SELECT DISTINCT sessionId FROM tasks ORDER BY sessionId")
        .all()
        .map((row) => row.sessionId)
    if (
      command.op === "submit" &&
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks").get()!.count >= 128
    ) {
      reply.error = "prototype_task_limit"
    }
    if (command.op === "submit" && !reply.error) {
      const sessionId = command.sessionId ?? `session-${envelope.id}`
      db.query("INSERT INTO tasks (id, sessionId, text, durationMs, state) VALUES (?, ?, ?, ?, 'queued')").run(
        envelope.id,
        sessionId,
        command.text,
        command.durationMs,
      )
      reply.task = task(envelope.id)
    }
    if (command.op === "query" || command.op === "result" || command.op === "cancel") {
      if (command.op === "cancel") {
        active.get(command.taskId)?.abort()
        db.query("UPDATE tasks SET state = 'cancelled' WHERE id = ? AND state = 'queued'").run(command.taskId)
      }
      reply.task = task(command.taskId)
      if (!reply.task) reply.error = "task_not_found"
    }
    db.query("INSERT INTO requests (id, hash, reply) VALUES (?, ?, ?)").run(envelope.id, hash, JSON.stringify(reply))
    return reply
  }
  const loop = (async () => {
    while (!state.stopping) {
      await rootDirectory(root)
      await directory(path.join(root, "requests"))
      await directory(path.join(root, "replies"))
      if ((await readOwner(root)).id !== owner.id) throw new Error("Owner identity changed; stopping without takeover")
      for (const name of (await readdir(path.join(root, "requests"))).sort()) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name) || seen.has(name)) continue
        const envelope = await privateRead(path.join(root, "requests", name))
          .then((raw) => {
            const value = JSON.parse(raw) as Envelope
            if (value.version !== 1 || `${id(value.id)}.json` !== name) throw new Error("Invalid envelope")
            id(value.ownerId)
            return { version: 1 as const, id: value.id, ownerId: value.ownerId, command: parseCommand(value.command) }
          })
          .catch(() => undefined)
        if (!envelope) continue
        const reply = db.transaction(() => handle(envelope))()
        await publish(path.join(root, "replies"), name, reply, true)
        seen.add(name)
      }
      db.query<Task, [number]>("SELECT * FROM tasks WHERE state = 'queued' ORDER BY rowid LIMIT ?")
        .all(concurrency - active.size)
        .forEach(execute)
      await Bun.sleep(options.pollMs ?? 20)
    }
  })().catch((error: unknown) => {
    state.fatal = error
    state.stopping = true
    active.forEach((controller) => controller.abort())
    // Keep the marker on unexpected failure. Neither TTL nor PID absence permits takeover.
  })
  const stopped = { promise: undefined as Promise<void> | undefined }
  return {
    owner,
    health: () => ({ active: active.size, maxActive: state.maxActive, fatal: state.fatal }),
    stop() {
      if (stopped.promise) return stopped.promise
      stopped.promise = (async () => {
        state.stopping = true
        await loop
        active.forEach((controller) => controller.abort())
        db.query("UPDATE tasks SET state = 'cancelled' WHERE state = 'queued'").run()
        db.close()
        if (state.fatal) return
        if ((await readOwner(root)).id === owner.id) await rm(lock, { recursive: true })
      })()
      return stopped.promise
    },
  }
}
