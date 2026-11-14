import { expect, test } from "bun:test"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Processes, processTools, processesExtension } from "../src/processes"
import { ProcessOutput } from "../src/process-output"
import type { RunnerContext } from "../src/extensions"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"

function context(directory: string, extra: Partial<RunnerContext> = {}): RunnerContext {
  return {
    workspace: "workspace",
    conversation: "conversation",
    run: "run",
    task: "start",
    directory,
    signal: new AbortController().signal,
    ...extra,
  }
}

const snapshot = Schema.Struct({
  id: Schema.String,
  pid: Schema.Int,
  status: Schema.String,
  leader_exited: Schema.Boolean,
  output_open: Schema.Boolean,
  workdir: Schema.String,
})

test.skipIf(process.platform === "win32")(
  "process tools preserve ownership after the claim, forward output, and stop the group",
  async () => {
    await using dir = await tmpdir()
    const table = new Processes(join(dir.path, "processes"))
    await table.start()
    const frames: Array<{ process_id: string; lines?: string[]; exit?: number | null }> = []
    const controller = new AbortController()
    const ctx = context(dir.path, {
      signal: controller.signal,
      processProgress: async (frame) => {
        frames.push(frame)
      },
    })
    const tools = processTools(table)
    const start = tools.find((tool) => tool.definition.name === "start_process")!
    const read = tools.find((tool) => tool.definition.name === "read_process")!
    const stop = tools.find((tool) => tool.definition.name === "stop_process")!
    const log = tools.find((tool) => tool.definition.name === "process_log")!
    try {
      const result = await start.execute(
        { command: "printf '\x1b[32mServer READY\x1b[0m\\n'; read line", wait_for: "ready", name: "server" },
        ctx,
      )
      expect(result.is_error).toBeUndefined()
      const row = Schema.decodeUnknownSync(snapshot)(result.structured_content)
      expect(row.status).toBe("running")
      expect(String(result.content)).toContain("ready: Server READY")
      controller.abort()
      expect(table.list()).toHaveLength(1)
      const stranger = context(dir.path, { conversation: "other" })
      expect((await read.execute({ id: row.id }, stranger)).is_error).toBe(true)
      expect((await stop.execute({ id: row.id }, stranger)).is_error).toBe(true)
      expect((await log.execute({ id: row.id }, stranger)).is_error).toBeUndefined()
      expect(log.definition.input_schema).toBeUndefined()
      expect(log.definition.description).toBeUndefined()
      await table.tick()
      expect(frames[0]?.lines).toEqual(["Server READY"])
      const stopped = await stop.execute({ id: row.id }, context(dir.path, { run: "next-run" }))
      expect(Schema.decodeUnknownSync(snapshot)(stopped.structured_content).status).toBe("exited")
      expect(table.list()).toEqual([])
      await table.tick()
      expect(frames.at(-1)).toHaveProperty("exit")
      expect(table.takeNotices(ctx)).toEqual([])
      const gone = await read.execute({ id: row.id }, context(dir.path))
      expect(gone.is_error).toBe(true)
      expect(String(gone.content)).toContain("the entry is gone")
      expect(String(gone.content)).toContain("Server READY")
    } finally {
      await table.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "an exited leader with an inherited output pipe remains tracked until group cleanup",
  async () => {
    await using dir = await tmpdir()
    const table = new Processes(join(dir.path, "processes"))
    await table.start()
    try {
      const row = await table.launch(
        { command: "(printf 'child ready\\n'; read line) <&0 & exit 0", workdir: dir.path },
        context(dir.path),
      )
      if (!row.process.leaderExited) await once(row.process, "change")
      expect(row.snapshot()).toMatchObject({
        leader_exited: true,
        output_open: true,
        status: "running",
        exit_status: 0,
      })
      expect(table.list()).toHaveLength(1)
      const final = await table.stop(row.id, context(dir.path))
      expect(final).toMatchObject({ status: "exited", leader_exited: true, output_open: false })
      expect(() => process.kill(row.process.pgid, 0)).toThrow()
    } finally {
      await table.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "natural exit notices, live limit, and conversation release use the daemon table",
  async () => {
    await using dir = await tmpdir()
    const table = new Processes(join(dir.path, "processes"), 1)
    await table.start()
    try {
      const tool = processTools(table).find((tool) => tool.definition.name === "start_process")!
      const done = await tool.execute({ command: "printf 'finished\\n'; exit 7" }, context(dir.path))
      expect(done.is_error).toBe(true)
      expect(table.takeNotices(context(dir.path, { conversation: "other" }))).toEqual([])
      expect(table.takeNotices(context(dir.path, { run: "next-run" }))[0]).toContain("status 7, on its own")
      expect(table.takeNotices(context(dir.path))).toEqual([])
      const running = await tool.execute(
        { command: "printf 'ready\\n'; read line", wait_for: "ready" },
        context(dir.path),
      )
      const id = Schema.decodeUnknownSync(snapshot)(running.structured_content).id
      const refused = await tool.execute({ command: "true", wait_seconds: 0 }, context(dir.path))
      expect(refused.is_error).toBe(true)
      expect(String(refused.content)).toContain("which is the limit")
      expect(table.release("other-workspace", "conversation")).toEqual([])
      expect(table.release("workspace", "conversation")).toEqual([id])
    } finally {
      await table.close()
    }
    expect(table.list()).toEqual([])
    expect(table.takeNotices(context(dir.path))).toEqual([])
  },
)

test("process output bounds memory, matches complete cleaned lines, rotates logs and survives log failure", async () => {
  await using dir = await tmpdir()
  const lines: string[] = []
  const output = new ProcessOutput(join(dir.path, "process.log"), "ready", (line) => lines.push(line), 128)
  output.append(Buffer.from("\x1b[32mREADY"))
  expect(output.readyMatched).toBe(false)
  output.append(Buffer.from("\x1b[0m\n"))
  expect(output.readyMatched).toBe(true)
  expect(output.ready).toBe("READY")
  output.append(Buffer.from("payload\n".repeat(60_000)))
  expect(Buffer.byteLength(output.lines(100_000))).toBeLessThanOrEqual(50 * 1024)
  output.append(Buffer.from("last line"))
  output.end()
  expect(output.last).toBe("last line")
  expect(lines.at(-1)).toBe("last line")
  expect(await readFile(join(dir.path, "process.log.1"), "utf8")).toContain("READY")
  expect(await ProcessOutput.tail(output.path, 2)).toBe("last line")
  const failed = new ProcessOutput(join(dir.path, "absent", "process.log"))
  failed.append(Buffer.from("still visible\n"))
  failed.end()
  expect(failed.error).toBeDefined()
  expect(failed.lines(10)).toBe("still visible")
})

test.skipIf(process.platform === "win32")(
  "restart drops stale state without signaling unrelated process identities",
  async () => {
    await using dir = await tmpdir()
    const storage = join(dir.path, "processes")
    await mkdir(storage)
    await writeFile(
      join(storage, "state.json"),
      JSON.stringify({
        processes: [
          { id: "p1", pid: process.pid, pgid: 2147483647, command: "unrelated", started_at: new Date().toISOString() },
        ],
      }),
    )
    const table = new Processes(storage)
    try {
      await table.start()
      expect(table.takeOrphans()).toEqual([])
      expect(table.list()).toEqual([])
      expect(await readFile(join(storage, "state.json")).catch(() => undefined)).toBeUndefined()
    } finally {
      await table.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "process extension appends each exit notice once to the owner's next tool result",
  async () => {
    await using dir = await tmpdir()
    const manager = new ExtensionManager(
      new Configuration(join(dir.path, "settings.json")),
      [processesExtension(dir.path)],
      dir.path,
      new AbortController().signal,
      async () => {},
    )
    try {
      await manager.start()
      const start = manager.tools().find((tool) => tool.definition.name === "start_process")!
      await start.execute({ command: "printf 'done\\n'; exit 0" }, context(dir.path))
      expect(await manager.toolResult(context(dir.path, { conversation: "other" }), { content: "unrelated" })).toEqual({
        content: "unrelated",
      })
      const result = await manager.toolResult(context(dir.path, { run: "later-run" }), {
        content: [{ type: "text", text: "file content" }],
      })
      expect(result.content).toEqual([
        { type: "text", text: "file content" },
        { type: "text", text: expect.stringContaining("NOTE: process p1") },
      ])
      expect(await manager.toolResult(context(dir.path), { content: "again" })).toEqual({ content: "again" })
      expect(await manager.command("processes", {})).toEqual({ processes: [], orphans: [], unreachable: [] })
      expect(await manager.command("logs", { id: "p1" })).toMatchObject({ process: { status: "exited" } })
      await start.execute({ command: "printf 'ready\\n'; read line", wait_for: "ready" }, context(dir.path))
      expect(await manager.describeEnvironment({})).toContain("call list_processes")
      await manager.emit("host.ended", { workspace: "workspace", conversation: "conversation" })
    } finally {
      await manager.close()
    }
  },
)
