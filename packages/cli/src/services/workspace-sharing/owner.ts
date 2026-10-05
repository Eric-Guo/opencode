export * as FileSharing from "./owner"

import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readlink, realpath, rm, unlink } from "node:fs/promises"
import path from "node:path"
import { directory, id, initialize, privateRead, publish, rootDirectory } from "./files"

export type RunInput = {
  directory: string
  message: string
  format: "default" | "json"
  auto: boolean
  model?: string
  agent?: string
  title?: string
  thinking?: boolean
}
export type RunTask = {
  version: 1
  id: string
  ownerID: string
  hash: string
  sessionID: string
  messageID: string
  input: RunInput
  state: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "indeterminate"
  created: number
  updated: number
  starts: number
  exitCode?: number
  reason?: string
}
export type Result = {
  state: "completed" | "failed" | "cancelled" | "indeterminate"
  exitCode: number
  stdout: string
  stderr: string
  reason?: string
}
export type Adapter = {
  run(task: RunTask, signal: AbortSignal): Promise<Result>
  sessions(directory: string, limit: number): Promise<unknown[]>
}
export type Command =
  | { op: "run"; input: RunInput }
  | { op: "status" | "result" | "cancel"; taskID: string }
  | { op: "sessions"; directory: string; limit: number }
  | { op: "ping" }
export type Reply = {
  id: string
  ownerID: string
  hash: string
  task?: RunTask
  sessions?: unknown[]
  active?: number
  maxActive?: number
  error?: string
}
type Owner = { id: string; pid: number; pidNamespace: string; netNamespace: string; workspace: string; created: number }
export type Lease = { root: string; owner: Owner; release(): Promise<void> }
type Envelope = { version: 1; id: string; ownerID: string; command: Command }
const outputLimit = 1024 * 1024
const terminalStates = new Set<RunTask["state"]>(["completed", "failed", "cancelled", "indeterminate"])

function bounded(value: unknown, name: string, limit: number) {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit) throw new Error(`Invalid ${name}`)
  return value
}

function command(input: unknown): Command {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid sharing command")
  const value = input as Record<string, unknown>
  if (value.op === "ping" && Object.keys(value).length === 1) return { op: "ping" }
  if ((value.op === "status" || value.op === "result" || value.op === "cancel") && Object.keys(value).length === 2)
    return { op: value.op, taskID: id(value.taskID) }
  if (value.op === "sessions" && Object.keys(value).length === 3) {
    if (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)
      throw new Error("Invalid session limit")
    return { op: "sessions", directory: bounded(value.directory, "directory", 4096), limit: Number(value.limit) }
  }
  if (value.op !== "run" || Object.keys(value).length !== 2 || !value.input || typeof value.input !== "object")
    throw new Error("Unsupported sharing command")
  const run = value.input as Record<string, unknown>
  if (
    Object.keys(run).some(
      (key) => !["directory", "message", "format", "auto", "model", "agent", "title", "thinking"].includes(key),
    )
  )
    throw new Error("Unsupported run option")
  if (
    (run.format !== "default" && run.format !== "json") ||
    typeof run.auto !== "boolean" ||
    (run.thinking !== undefined && typeof run.thinking !== "boolean")
  )
    throw new Error("Invalid run options")
  const message = bounded(run.message, "message", 16_384)
  if (!message.trim()) throw new Error("A message is required")
  return {
    op: "run",
    input: {
      directory: bounded(run.directory, "directory", 4096),
      message,
      format: run.format,
      auto: run.auto,
      ...(run.model === undefined ? {} : { model: bounded(run.model, "model", 256) }),
      ...(run.agent === undefined ? {} : { agent: bounded(run.agent, "agent", 128) }),
      ...(run.title === undefined ? {} : { title: bounded(run.title, "title", 512) }),
      ...(run.thinking === undefined ? {} : { thinking: run.thinking }),
    },
  }
}

function hash(value: Command) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

async function owner(root: string): Promise<Owner> {
  await directory(path.join(root, "worker.lock"))
  const value = JSON.parse(await privateRead(path.join(root, "worker.lock", "owner.json"))) as Owner
  id(value.id)
  return value
}

async function workspace(file: string, base: string) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await realpath(file)) !== file)
    throw new Error("Expected a canonical workspace directory")
  const relative = path.relative(base, file)
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await lstat(file)).isDirectory()
  )
    throw new Error("Task directory is outside the owner's workspace")
}

export async function acquire(root: string, base: string): Promise<Lease> {
  const canonical = await realpath(base)
  await initialize(root, ["requests", "replies", "tasks", "outputs"])
  const lock = path.join(root, "worker.lock")
  await mkdir(lock, { mode: 0o700 }).catch(() => {
    throw new Error("Workspace sharing owner exists; automatic takeover is forbidden")
  })
  const identity: Owner = {
    id: randomUUID(),
    pid: process.pid,
    pidNamespace: process.platform === "linux" ? await readlink("/proc/self/ns/pid") : "unavailable",
    netNamespace: process.platform === "linux" ? await readlink("/proc/self/ns/net") : "unavailable",
    workspace: canonical,
    created: Date.now(),
  }
  await publish(lock, "owner.json", identity)
  const state = { released: false }
  return {
    root,
    owner: identity,
    async release() {
      if (state.released) return
      if ((await owner(root)).id !== identity.id) throw new Error("Owner identity changed; refusing release")
      await rm(lock, { recursive: true })
      state.released = true
    },
  }
}

export async function connect(root: string, options: { timeoutMs?: number; pollMs?: number } = {}) {
  await rootDirectory(root)
  for (const name of ["requests", "replies", "tasks", "outputs"]) await directory(path.join(root, name))
  const identity = await owner(root).catch(() => {
    throw new Error("Workspace sharing owner unavailable; start serve explicitly")
  })
  return {
    owner: identity,
    async request(input: Command, requestID: string = randomUUID()): Promise<Reply> {
      id(requestID)
      const parsed = command(input)
      const digest = hash(parsed)
      await rootDirectory(root)
      const current = await owner(root).catch(() => {
        throw new Error("Workspace sharing owner unavailable; no automatic takeover")
      })
      if (current.id !== identity.id) throw new Error("Workspace sharing owner changed; reconnect explicitly")
      const value: Envelope = { version: 1, id: requestID, ownerID: identity.id, command: parsed }
      const requests = path.join(root, "requests")
      if (
        (await readdir(requests)).length >= 4096 &&
        !(await lstat(path.join(requests, `${requestID}.json`)).catch(() => undefined))
      )
        throw new Error("Workspace request capacity reached; no automatic deletion")
      await publish(requests, `${requestID}.json`, value).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
        if ((await privateRead(path.join(requests, `${requestID}.json`), 65_536, true)) !== JSON.stringify(value))
          throw new Error("Request ID conflict; retry the same payload and owner")
      })
      const deadline = Date.now() + (options.timeoutMs ?? 5_000)
      while (Date.now() < deadline) {
        const raw = await privateRead(path.join(root, "replies", `${requestID}.json`)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          },
        )
        if (raw) {
          const reply = JSON.parse(raw) as Reply
          if (reply.id !== requestID || reply.ownerID !== identity.id || reply.hash !== digest)
            throw new Error("Reply identity conflict")
          if (parsed.op !== "run" && parsed.op !== "cancel") {
            await unlink(path.join(requests, `${requestID}.json`)).catch(() => {})
            await unlink(path.join(root, "replies", `${requestID}.json`)).catch(() => {})
          }
          return reply
        }
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50))
      }
      throw new Error(
        `Workspace sharing owner unavailable or outcome unknown. Retry request ID ${requestID}; no takeover was attempted.`,
      )
    },
    async output(taskID: string): Promise<Pick<Result, "stdout" | "stderr">> {
      id(taskID)
      await rootDirectory(root)
      await directory(path.join(root, "outputs"))
      return JSON.parse(await privateRead(path.join(root, "outputs", `${taskID}.json`), outputLimit))
    },
  }
}

export async function start(lease: Lease, adapter: Adapter, options: { pollMs?: number; concurrency?: number } = {}) {
  const concurrency = options.concurrency ?? 2
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
    throw new Error("Workspace concurrency must be 1 or 2")
  const tasks = new Map<string, RunTask>()
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  const seen = new Set<string>()
  const state = { stopping: false, maxActive: 0, fatal: undefined as unknown, blocked: undefined as string | undefined }
  const pending = new Map<string, Promise<void>>()
  const update = (taskID: string, change: (previous: RunTask | undefined) => RunTask) => {
    const write = (pending.get(taskID) ?? Promise.resolve()).then(async () => {
      const next = change(tasks.get(taskID))
      await publish(path.join(lease.root, "tasks"), `${taskID}.json`, next, true)
      tasks.set(taskID, next)
    })
    pending.set(taskID, write)
    return write
  }
  for (const name of await readdir(path.join(lease.root, "tasks"))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name)) continue
    const task = JSON.parse(await privateRead(path.join(lease.root, "tasks", name))) as RunTask
    if (`${id(task.id)}.json` !== name || task.version !== 1) throw new Error("Invalid persisted task")
    tasks.set(task.id, task)
    if (!terminalStates.has(task.state))
      await update(task.id, (previous) => ({
        ...previous!,
        state: "indeterminate",
        reason: "Previous owner did not establish a terminal outcome; task was not replayed",
        updated: Date.now(),
      }))
  }
  if ([...tasks.values()].some((task) => task.state === "indeterminate"))
    state.blocked = "An earlier execution outcome is unknown; new task admission remains blocked"

  const execute = async (task: RunTask) => {
    const controller = new AbortController()
    await update(task.id, (previous) => ({
      ...previous!,
      state: "running",
      starts: previous!.starts + 1,
      updated: Date.now(),
    }))
    const done = Promise.resolve()
      .then(() => adapter.run(tasks.get(task.id)!, controller.signal))
      .then(async (result) => {
        await publish(
          path.join(lease.root, "outputs"),
          `${task.id}.json`,
          { stdout: result.stdout, stderr: result.stderr },
          true,
          outputLimit,
        )
        if (result.state === "indeterminate")
          state.blocked = result.reason ?? "An execution outcome is unknown; new task admission is blocked"
        await update(task.id, (previous) => ({
          ...previous!,
          state: result.state,
          exitCode: result.exitCode,
          reason: result.reason,
          updated: Date.now(),
        }))
      })
      .catch(async (error: unknown) => {
        state.blocked = "An execution outcome is unknown; new task admission is blocked"
        await update(task.id, (previous) => ({
          ...previous!,
          state: "indeterminate",
          reason: error instanceof Error ? error.message : String(error),
          updated: Date.now(),
        }))
      })
      .finally(() => {
        active.delete(task.id)
      })
    active.set(task.id, { controller, done })
    state.maxActive = Math.max(state.maxActive, active.size)
  }
  const handle = async (envelope: Envelope): Promise<Reply> => {
    const reply: Reply = { id: envelope.id, ownerID: lease.owner.id, hash: hash(envelope.command) }
    if (envelope.ownerID !== lease.owner.id) return { ...reply, error: "wrong_owner" }
    const input = envelope.command
    if (input.op === "ping") return { ...reply, active: active.size, maxActive: state.maxActive }
    if (input.op === "sessions") {
      await workspace(input.directory, lease.owner.workspace)
      return { ...reply, sessions: await adapter.sessions(input.directory, input.limit) }
    }
    if (input.op === "run") {
      if (state.blocked) return { ...reply, error: state.blocked }
      await workspace(input.input.directory, lease.owner.workspace)
      const prior = tasks.get(envelope.id)
      if (prior)
        return prior.hash === reply.hash && prior.ownerID === lease.owner.id
          ? { ...reply, task: prior }
          : { ...reply, error: "task_id_conflict" }
      if (tasks.size >= 128) return { ...reply, error: "workspace_task_capacity" }
      await update(envelope.id, () => ({
        version: 1,
        id: envelope.id,
        hash: reply.hash,
        ownerID: lease.owner.id,
        sessionID: Session.ID.create(),
        messageID: SessionMessage.ID.create(),
        input: input.input,
        state: "queued",
        created: Date.now(),
        updated: Date.now(),
        starts: 0,
      }))
      return { ...reply, task: tasks.get(envelope.id) }
    }
    const task = tasks.get(input.taskID)
    if (!task) return { ...reply, error: "task_not_found" }
    if (input.op === "cancel" && !terminalStates.has(task.state)) {
      const running = active.get(task.id)
      await update(task.id, (previous) => ({
        ...previous!,
        state: running ? "cancelling" : "cancelled",
        updated: Date.now(),
      }))
      running?.controller.abort()
    }
    return { ...reply, task: tasks.get(task.id) }
  }
  const loop = (async () => {
    while (!state.stopping) {
      await rootDirectory(lease.root)
      if ((await owner(lease.root)).id !== lease.owner.id)
        throw new Error("Owner identity changed; stopping without takeover")
      await directory(path.join(lease.root, "requests"))
      const names = (await readdir(path.join(lease.root, "requests"))).sort()
      const current = new Set(names)
      for (const name of seen) if (!current.has(name)) seen.delete(name)
      for (const name of names) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name) || seen.has(name)) continue
        const envelope = await privateRead(path.join(lease.root, "requests", name))
          .then((raw) => {
            const value = JSON.parse(raw) as Envelope
            if (value.version !== 1 || `${id(value.id)}.json` !== name) throw new Error("Invalid request")
            id(value.ownerID)
            return { ...value, command: command(value.command) }
          })
          .catch(() => undefined)
        if (!envelope) continue
        const reply = await handle(envelope).catch(
          (error: unknown): Reply => ({
            id: envelope.id,
            ownerID: lease.owner.id,
            hash: hash(envelope.command),
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        const bounded =
          Buffer.byteLength(JSON.stringify(reply)) <= 65_536
            ? reply
            : {
                id: reply.id,
                ownerID: reply.ownerID,
                hash: reply.hash,
                error: "Reply exceeds the transport size limit; request fewer sessions with --max-count",
              }
        await publish(path.join(lease.root, "replies"), name, bounded, true)
        seen.add(name)
      }
      if (state.stopping) break
      if (state.blocked) {
        for (const task of tasks.values())
          if (task.state === "queued")
            await update(task.id, (previous) => ({
              ...previous!,
              state: "indeterminate",
              reason: "Not dispatched: owner blocked after an unknown execution outcome",
              updated: Date.now(),
            }))
      }
      for (const task of [...tasks.values()]
        .filter((task) => task.state === "queued" && task.ownerID === lease.owner.id)
        .slice(0, concurrency - active.size))
        await execute(task)
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50))
    }
  })().catch((error: unknown) => {
    state.fatal = error
    state.stopping = true
    active.forEach((task) => task.controller.abort())
  })
  const stopped = { value: undefined as Promise<void> | undefined }
  return {
    health: () => ({ active: active.size, maxActive: state.maxActive, fatal: state.fatal }),
    stop() {
      if (stopped.value) return stopped.value
      stopped.value = (async () => {
        state.stopping = true
        await loop
        active.forEach((task) => task.controller.abort())
        await Promise.all([...active.values()].map((task) => task.done))
        for (const task of tasks.values())
          if (task.state === "queued")
            await update(task.id, (previous) => ({ ...previous!, state: "cancelled", updated: Date.now() }))
        if (state.fatal) throw state.fatal
      })()
      return stopped.value
    },
  }
}
