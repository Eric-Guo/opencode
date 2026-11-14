import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { scheduler } from "node:timers/promises"
import { Schema } from "effect"
import { APIError, type CommitTask, type JsonObject } from "@cybros/agent"
import { atomic } from "./storage"
import { resolvePath } from "./file-read"
import { OwnedProcess } from "./owned-process"
import { ProcessOutput } from "./process-output"
import { ProcessTables } from "./process-remote"
import { openWrite, type RunnerContext, type RunnerTool } from "./extensions"
import type { ExtensionModule } from "./extension-manager"

type Result = Omit<CommitTask, "claim_token">
type Caller = Pick<RunnerContext, "workspace" | "conversation" | "run">
type Snapshot = ReturnType<ProcessRow["snapshot"]>
const runFile = promisify(execFile)
const read = {
  kind: "read_only",
  destructive: false,
  effect_scope: "closed",
  idempotency: "intrinsic",
  reconciliation: "none",
} as const

class ProcessRow extends EventEmitter {
  stoppedBy: string | null = null
  stopper: string | null = null
  retired = false
  readonly started = new Date().toISOString()
  readonly owner: string

  constructor(
    readonly id: string,
    readonly command: string,
    readonly directory: string,
    readonly name: string | null,
    readonly caller: Caller,
    readonly process: OwnedProcess,
    readonly output: ProcessOutput,
  ) {
    super()
    this.owner = caller.conversation ?? caller.run
  }

  get live() {
    return !this.process.leaderExited || !this.output.ended
  }
  get key() {
    return JSON.stringify([this.caller.workspace, this.owner])
  }
  snapshot() {
    return {
      id: this.id,
      name: this.name,
      command: this.command,
      workdir: this.directory,
      owner: this.owner,
      run_public_id: this.caller.run,
      pid: this.process.pid,
      started_at: this.started,
      status: this.live ? (this.stoppedBy ? "stopping" : "running") : "exited",
      exit_status: this.process.status,
      signal: this.process.signal,
      stopped_by: this.stoppedBy,
      ready_line: this.output.ready,
      last_line: this.output.last,
      log_path: this.output.path,
      leader_exited: this.process.leaderExited,
      output_open: !this.output.ended,
    }
  }
}

/** A daemon owns the groups; a conversation owns access to them. Claims only start/wait. */
export class Processes {
  private readonly rows = new Map<string, ProcessRow>()
  private readonly exits = new Map<string, Snapshot>()
  private readonly notices = new Map<string, string[]>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly pump = new Map<
    string,
    {
      post: NonNullable<RunnerContext["processProgress"]>
      lines: string[]
      dropped: number
      exited: boolean
      exit: number | null
      denied: boolean
    }
  >()
  private sequence = 0
  private reserved = 0
  private closed = false
  private queue = Promise.resolve()
  private orphans: Schema.Json[] = []
  issue?: string

  constructor(
    readonly storage: string,
    private readonly limit = 8,
  ) {}

  async start() {
    await mkdir(this.storage, { recursive: true, mode: 0o700 })
    const stored = await readFile(join(this.storage, "state.json"), "utf8").catch(() => "{}")
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          processes: Schema.optional(
            Schema.Array(
              Schema.Struct({
                id: Schema.String,
                pid: Schema.Int,
                pgid: Schema.Int,
                guard_pid: Schema.optional(Schema.Int),
                command: Schema.String,
                started_at: Schema.String,
              }),
            ),
          ),
        }),
      ),
    )(stored)
    await rm(join(this.storage, "state.json"), { force: true })
    if (decoded._tag === "None") {
      this.issue = "The previous process state could not be read."
      return
    }
    for (const row of decoded.value.processes ?? []) {
      if (row.pid <= 1 || row.pgid <= 1) continue
      const actual = await runFile("ps", ["-o", "pgid=", "-p", String(row.guard_pid ?? row.pid)], {
        timeout: 2000,
      }).catch(() => undefined)
      if (!actual || Number(actual.stdout.trim()) !== row.pgid) continue
      // The recorded identity must still belong to this group before either signal.
      signalGroup(row.pgid, "SIGTERM")
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        try {
          process.kill(-row.pgid, 0)
        } catch {
          break
        }
        await scheduler.wait(Math.max(0, Math.min(50, deadline - Date.now())))
      }
      const remains = await runFile("ps", ["-o", "pgid=", "-p", String(row.guard_pid ?? row.pid)], {
        timeout: 2000,
      }).catch(() => undefined)
      if (remains && Number(remains.stdout.trim()) === row.pgid) signalGroup(row.pgid, "SIGKILL")
      this.orphans.push({ ...row, reaped: true })
    }
  }

  list() {
    return [...this.rows.values()].map((row) => row.snapshot())
  }
  takeOrphans() {
    const rows = this.orphans
    this.orphans = []
    return rows
  }

  async launch(input: { command: string; workdir: string; name?: string; wait_for?: string }, context: RunnerContext) {
    if (this.closed) throw new Error("The daemon is stopping; nothing new can be started.")
    if (this.rows.size + this.reserved >= this.limit)
      throw new Error(
        `${this.limit} processes are already running, which is the limit; stop one with stop_process first:\n` +
          this.list().map(render).join("\n"),
      )
    const id = "p" + ++this.sequence
    this.reserved++
    try {
      if (context.processProgress)
        this.pump.set(id, {
          post: context.processProgress,
          lines: [],
          dropped: 0,
          exited: false,
          exit: null,
          denied: false,
        })
      const output = new ProcessOutput(join(this.storage, id + ".log"), input.wait_for, (line) => {
        if (context.processProgress) this.line(id, context.processProgress, line)
        this.rows.get(id)?.emit("change")
      })
      const child = new OwnedProcess(input.command, input.workdir, {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(?:BUNDLE_|RUBYOPT$|RUBYLIB$|GEM_HOME$|GEM_PATH$)/.test(key),
          ),
        ),
        PYTHONUNBUFFERED: "1",
      })
      const row = new ProcessRow(id, input.command, input.workdir, input.name ?? null, context, child, output)
      child.output.on("data", (chunk: Buffer) => output.append(chunk))
      child.output.once("end", () => {
        output.end()
        this.retire(row)
        row.emit("change")
      })
      child.output.once("error", () => {
        output.end()
        this.retire(row)
        row.emit("change")
      })
      child.on("change", () => {
        this.retire(row)
        row.emit("change")
      })
      await child.started
      if (this.closed) {
        await child.close()
        output.end()
        throw new Error("The daemon is stopping; nothing new can be started.")
      }
      this.rows.set(id, row)
      this.retire(row)
      await this.persist()
      return row
    } catch (error) {
      this.pump.delete(id)
      throw error
    } finally {
      this.reserved--
    }
  }

  async stop(id: string, caller: Caller, wait = true) {
    const row = this.fetch(id, caller, "stop")
    row.stoppedBy ??= caller.run
    row.stopper ??= JSON.stringify([
      caller.workspace,
      caller.run === "user" ? "user" : (caller.conversation ?? caller.run),
    ])
    row.process.terminate()
    const pending = this.track(this.ladder(row, 5000))
    if (wait) await pending
    return row.snapshot()
  }

  release(workspace: string, conversation: string) {
    const rows = [...this.rows.values()].filter(
      (row) => row.caller.workspace === workspace && row.owner === conversation,
    )
    for (const row of rows) {
      row.stoppedBy ??= "conversation_ended"
      row.stopper ??= row.key
      row.process.terminate()
      this.track(this.ladder(row, 5000))
    }
    return rows.map((row) => row.id)
  }

  async close() {
    this.closed = true
    const rows = [...this.rows.values()]
    for (const row of rows) {
      row.stoppedBy ??= "shutdown"
      row.process.terminate()
    }
    await Promise.all(rows.map((row) => this.ladder(row, 2000)))
    await Promise.allSettled(this.pending)
    await this.queue
    await rm(join(this.storage, "state.json"), { force: true })
    this.pump.clear()
  }

  async log(id: string, count = 100) {
    const row = this.rows.get(id)
    const snapshot = row?.snapshot() ?? this.exits.get(id)
    if (!snapshot) return
    const text = row
      ? row.output.lines(count, 64 * 1024)
      : await ProcessOutput.tail(snapshot.log_path, count, 64 * 1024)
    return { process: snapshot, path: snapshot.log_path, lines: text ? text.split("\n") : [] }
  }

  async read(id: string, caller: Caller, count = 50): Promise<Result> {
    const gone = this.exits.get(id)
    if (gone)
      return {
        content: goneMessage(gone) + "\n\n" + ((await ProcessOutput.tail(gone.log_path, count)) || "(no output)"),
        structured_content: gone,
        is_error: true,
      }
    const row = this.fetch(id, caller, "read")
    return {
      content: render(row.snapshot()) + "\n\n" + (row.output.lines(count) || "(no output)"),
      structured_content: row.snapshot(),
    }
  }

  takeNotices(caller: Caller) {
    const key = JSON.stringify([caller.workspace, caller.conversation ?? caller.run])
    const notices = this.notices.get(key) ?? []
    this.notices.delete(key)
    return notices
  }

  async tick() {
    await Promise.all(
      [...this.pump].map(async ([id, entry]) => {
        if (entry.denied || (!entry.lines.length && !entry.exited)) return
        const lines: string[] = []
        let bytes = 0
        for (const line of entry.lines.toReversed()) {
          bytes += Buffer.byteLength(line) + 1
          if (bytes > 48 * 1024) break
          lines.unshift(line)
        }
        if (entry.dropped)
          lines.unshift(`[… ${entry.dropped} earlier lines dropped: the process outran the frame cadence …]`)
        entry.lines = []
        entry.dropped = 0
        await entry
          .post({ process_id: id, lines, ...(entry.exited ? { exit: entry.exit } : {}) })
          .catch((error: unknown) => {
            if (error instanceof APIError && [401, 403, 404, 409].includes(error.status)) entry.denied = true
          })
        if (entry.exited) this.pump.delete(id)
      }),
    )
  }

  private fetch(id: string, caller: Caller, verb: string) {
    const row = this.rows.get(id)
    if (!row) {
      const gone = this.exits.get(id)
      throw new Error(
        gone
          ? goneMessage(gone)
          : `no process ${id}; ` +
            (this.rows.size ? "known: " + [...this.rows.keys()].join(", ") : "nothing has been started"),
      )
    }
    if (caller.run !== "user" && row.key !== JSON.stringify([caller.workspace, caller.conversation ?? caller.run]))
      throw new Error(
        `${label(row.snapshot())} belongs to ${row.caller.conversation ? "conversation" : "run"} ${row.owner}; only its runs, or the person, may ${verb} it`,
      )
    return row
  }

  private retire(row: ProcessRow) {
    if (row.live || row.retired || !this.rows.has(row.id)) return
    row.retired = true
    this.rows.delete(row.id)
    const snapshot = row.snapshot()
    this.exits.set(row.id, snapshot)
    if (this.exits.size > 8) this.exits.delete(this.exits.keys().next().value!)
    if (row.stopper !== row.key && row.owner !== "user")
      this.notices.set(row.key, [
        ...(this.notices.get(row.key) ?? []),
        `NOTE: process ${label(snapshot)} (pid ${snapshot.pid}) exited with ${exitPhrase(snapshot)}, ${how(snapshot)}. Its log: ${snapshot.log_path}`,
      ])
    row.output.exit(
      `[nexus] ${label(snapshot)}: leader exited with ${exitPhrase(snapshot)}, ${how(snapshot)}; the group ended at ${new Date().toISOString()}`,
    )
    const entry = this.pump.get(row.id)
    if (entry) {
      entry.exited = true
      entry.exit = snapshot.exit_status
    }
    // A foreground command that closes its output has finished. Detached daemons
    // are outside this table; explicit stops still make the final group signal.
    this.track(row.stoppedBy ? row.process.close() : row.process.release())
    void this.persist()
  }

  private async ladder(row: ProcessRow, grace: number) {
    await wait(row, () => row.process.leaderExited, grace)
    await row.process.close()
    await wait(row, () => row.output.ended, 1000)
    row.output.end()
    this.retire(row)
  }

  private line(id: string, post: NonNullable<RunnerContext["processProgress"]>, line: string) {
    const entry = this.pump.get(id) ?? { post, lines: [], dropped: 0, exited: false, exit: null, denied: false }
    this.pump.set(id, entry)
    if (entry.denied) return
    entry.lines.push(line)
    if (entry.lines.length > 512) {
      entry.lines.shift()
      entry.dropped++
    }
  }

  private track<A>(pending: Promise<A>) {
    this.pending.add(pending)
    void pending
      .catch((error: unknown) => {
        this.issue = error instanceof Error ? error.message : String(error)
      })
      .finally(() => this.pending.delete(pending))
    return pending
  }

  private persist() {
    if (this.closed) return this.queue
    const rows = [...this.rows.values()].map((row) => ({
      id: row.id,
      pid: row.process.pid,
      pgid: row.process.pgid,
      guard_pid: row.process.pgid,
      command: row.command,
      started_at: row.started,
    }))
    this.queue = this.queue
      .then(() => atomic(join(this.storage, "state.json"), { processes: rows }))
      .catch((error: unknown) => {
        this.issue = error instanceof Error ? error.message : String(error)
      })
    return this.queue
  }
}

function wait(row: ProcessRow, condition: () => boolean, milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (condition() || milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      row.off("change", change)
      signal?.removeEventListener("abort", abort)
    }
    const change = () => {
      if (condition()) {
        finish()
        resolve()
      }
    }
    const abort = () => {
      finish()
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      finish()
      resolve()
    }, milliseconds)
    row.on("change", change)
    signal?.addEventListener("abort", abort, { once: true })
    change()
    if (signal?.aborted) abort()
  })
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM"))) throw error
  }
}
function label(row: Snapshot) {
  return row.id + (row.name ? ` (${row.name})` : "")
}
function exitPhrase(row: Snapshot) {
  return row.exit_status !== null
    ? `status ${row.exit_status}`
    : row.signal
      ? `signal ${row.signal}`
      : "an unknown status"
}
function how(row: Snapshot) {
  if (!row.stopped_by) return "on its own"
  if (row.stopped_by === "user") return "stopped by the person"
  if (row.stopped_by === "shutdown") return "stopped by the daemon shutting down"
  if (row.stopped_by === "conversation_ended") return "stopped when its conversation ended here"
  return "stopped by run " + row.stopped_by
}
function goneMessage(row: Snapshot) {
  return `${label(row)} exited with ${exitPhrase(row)}, ${how(row)}; the entry is gone — start_process again gives a new id. Its log: ${row.log_path}`
}
function render(row: Snapshot) {
  return `${row.id}  ${row.status}${row.status === "exited" ? ` (${exitPhrase(row)})` : ""}  pid ${row.pid}  owner ${row.owner}${row.run_public_id !== row.owner ? "  run " + row.run_public_id : ""}  ${row.name ?? row.command.slice(0, 60)}  (${row.workdir})${row.ready_line ? "\n    " + row.ready_line : ""}`
}

export function processTools(table: Processes): RunnerTool[] {
  const definitions: Array<{
    name: string
    description?: string
    properties?: JsonObject
    required?: string[]
    write?: boolean
  }> = [
    {
      name: "start_process",
      description:
        "Start a long-running foreground server or watcher that stays alive after this call, owned by this machine and conversation. No stdin or TTY. Returns its ID, readiness, log path and recent output. Use list_processes first, read_process for later output and stop_process when done.",
      write: true,
      properties: {
        command: {
          type: "string",
          description: "Foreground shell command; do not use -d, --daemon, nohup or a trailing &.",
        },
        workdir: { type: "string" },
        name: { type: "string" },
        wait_for: { type: "string", description: "Answer when an output line contains this text, case insensitive." },
        wait_seconds: { type: "number", minimum: 0, maximum: 60 },
      },
      required: ["command"],
    },
    {
      name: "list_processes",
      description:
        "List all processes started on this machine, including other conversations. Check before starting a server that may already be running.",
    },
    {
      name: "read_process",
      description: "Read the latest output and status of a process owned by this conversation.",
      properties: { id: { type: "string" }, tail_lines: { type: "integer", minimum: 1, maximum: 500 } },
      required: ["id"],
    },
    {
      name: "stop_process",
      description:
        "Stop a process owned by this conversation: TERM, then KILL after a few seconds, for the whole process group.",
      write: true,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    { name: "process_log" },
  ]
  return definitions.map((entry) => ({
    role: "runner",
    internalTimeout: entry.name === "start_process",
    definition: {
      name: entry.name,
      effect_profile: entry.write ? openWrite : read,
      ...(entry.description
        ? {
            description: entry.description,
            input_schema: {
              type: "object",
              properties: entry.properties ?? {},
              required: entry.required ?? [],
              additionalProperties: false,
            },
          }
        : {}),
    },
    async execute(input, context): Promise<Result> {
      try {
        if (entry.name === "list_processes") {
          const rows = table.list()
          return {
            content: rows.length ? rows.map(render).join("\n") : "(no processes)",
            structured_content: { processes: rows },
          }
        }
        if (entry.name === "start_process") {
          const value = Schema.decodeUnknownSync(
            Schema.Struct({
              command: Schema.String,
              workdir: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
              wait_for: Schema.optional(Schema.String),
              wait_seconds: Schema.optional(Schema.Number),
            }),
          )(input)
          if (!value.command.trim()) return { content: "command is required", is_error: true }
          const workdir = resolvePath(context.directory, value.workdir || ".")
          if (!(await stat(workdir).catch(() => undefined))?.isDirectory())
            return { content: "Working directory does not exist: " + workdir, is_error: true }
          const budget = Math.max(0, Math.min(60, value.wait_seconds ?? 10))
          const row = await table.launch(
            {
              command: value.command,
              workdir,
              name: value.name?.trim()
                ? Buffer.from(value.name.trim())
                    .subarray(0, 64)
                    .toString("utf8")
                    .replace(/\ufffd$/, "")
                : undefined,
              wait_for: value.wait_for?.trim() || undefined,
            },
            context,
          )
          await wait(row, () => row.process.leaderExited || row.output.readyMatched, budget * 1000, context.signal)
          if (row.process.leaderExited)
            await wait(
              row,
              () => row.output.ended,
              Math.min(100, Math.max(0, Date.parse(row.started) + budget * 1000 - Date.now())),
              context.signal,
            )
          const snapshot = row.snapshot()
          const verdict =
            snapshot.status === "exited"
              ? `exited with ${exitPhrase(snapshot)}${snapshot.exit_status === 0 ? " — a process that exits during the wait is not running; run servers in the foreground (no -d, --daemon, nohup or &)" : ""}`
              : snapshot.leader_exited
                ? `the command exited with ${exitPhrase(snapshot)} but something it started still holds its output — the group is tracked as running, and stop_process ends all of it`
                : row.output.readyMatched
                  ? "ready: " + snapshot.ready_line
                  : value.wait_for
                    ? `still starting after ${budget}s (no line contained ${JSON.stringify(value.wait_for)} yet; read_process later)`
                    : snapshot.ready_line
                      ? "first line: " + snapshot.ready_line
                      : `started (waited ${budget}s)`
          return {
            content: `${snapshot.id} (pid ${snapshot.pid}) ${snapshot.status}${snapshot.name ? " — " + snapshot.name : ""}\n${verdict}\nlog: ${snapshot.log_path}\nworkdir: ${workdir}\n\n${row.output.lines(30) || "(no output yet — a program that buffers stdout prints nothing until it flushes)"}`,
            structured_content: snapshot,
            ...(snapshot.status === "exited" && snapshot.exit_status !== 0 ? { is_error: true } : {}),
          }
        }
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.String,
            tail_lines: Schema.optional(Schema.Int),
            lines: Schema.optional(Schema.Int),
          }),
        )(input)
        if (entry.name === "read_process")
          return await table.read(value.id, context, Math.max(1, Math.min(500, value.tail_lines ?? 50)))
        if (entry.name === "process_log") {
          const result = await table.log(value.id, Math.max(1, Math.min(2000, value.lines ?? 100)))
          return result
            ? {
                content: render(result.process) + "\n\n" + (result.lines.join("\n") || "(no output)"),
                structured_content: result,
              }
            : { content: "no process " + value.id, is_error: true }
        }
        const row = await table.stop(value.id, context)
        return { content: `${label(row)} stopped: exited with ${exitPhrase(row)}`, structured_content: row }
      } catch (error) {
        context.signal.throwIfAborted()
        return { content: error instanceof Error ? error.message : String(error), is_error: true }
      }
    },
  }))
}

export function processesExtension(storage: string): ExtensionModule {
  return {
    descriptor: {
      id: "nexus.processes",
      name: "Processes",
      description: "Own and inspect background servers and watchers.",
      default_enabled: true,
      configuration_version: 1,
      configuration_schema: { type: "object", properties: {}, additionalProperties: false },
      defaults: {},
    },
    async register(api) {
      const table = new Processes(join(storage, "processes"))
      await table.start()
      const cadence = setInterval(() => {
        void table.tick()
      }, 250)
      cadence.unref()
      api.onShutdown(async () => {
        clearInterval(cadence)
        await table.close()
      })
      processTools(table).forEach(api.registerTool)
      api.describeStatus(() => ({ ready: !table.issue, issues: table.issue ? [table.issue] : [] }))
      api.describeEnvironment(() =>
        table.list().length
          ? "Processes started earlier (a dev server, say) may still be running: call list_processes before starting one, and read_process to find its address."
          : undefined,
      )
      api.on("host.ended", (value) => {
        const ended = Schema.decodeUnknownSync(
          Schema.Struct({ workspace: Schema.String, conversation: Schema.String }),
        )(value)
        table.release(ended.workspace, ended.conversation)
      })
      api.onToolResult((context, result) => {
        const notices = table.takeNotices(context)
        if (!notices.length) return result
        const suffix = notices.join("\n")
        return {
          ...result,
          content:
            typeof result.content === "string"
              ? result.content + "\n\n" + suffix
              : [...(Array.isArray(result.content) ? result.content : []), { type: "text", text: suffix }],
        }
      })
      let remote: ProcessTables | undefined
      api.on("member.connected", () => {
        remote = new ProcessTables(table, api.application(), api.signal)
      })
      api.on("member.disconnected", () => {
        remote = undefined
      })
      for (const name of ["processes", "procs", "ps"])
        api.registerCommand(name, async (input) => {
          const value = Schema.decodeUnknownSync(
            Schema.Struct({ runner: Schema.optional(Schema.String), workspace: Schema.optional(Schema.String) }),
          )(input)
          if (remote) return remote.list(value.runner, value.workspace)
          if (value.runner) throw new Error("Remote process tables require a member connection.")
          return { processes: table.list(), orphans: table.takeOrphans(), unreachable: [] }
        })
      api.registerCommand("logs", async (input) => {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.String,
            lines: Schema.optional(Schema.Int),
            tail: Schema.optional(Schema.Int),
            runner: Schema.optional(Schema.String),
            workspace: Schema.optional(Schema.String),
          }),
        )(input)
        const lines = Math.max(1, Math.min(2000, value.lines ?? value.tail ?? 100))
        if (value.runner && !remote) throw new Error("Remote process tables require a member connection.")
        return (
          (await (remote
            ? remote.log(value.id, lines, value.runner, value.workspace)
            : table.log(value.id, lines))) ?? {
            error: "no process " + value.id,
          }
        )
      })
      api.registerCommand("kill", async (input) => {
        const value = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(input)
        return { process: await table.stop(value.id, { workspace: "", conversation: null, run: "user" }, false) }
      })
    },
  }
}
