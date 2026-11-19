import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import { Schema } from "effect"
import { runDevelopment, type DevelopmentTerminal } from "../dev/terminal"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { NexusApplication } from "../src/application"
import { Checkpoints } from "../src/checkpoints"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { processesExtension } from "../src/processes"
import { conversationFixture, turnFixture } from "./fixture/conversation"
import { storeFixture } from "./fixture/store"

// Managed processes use POSIX process groups.
test.skipIf(process.platform === "win32")(
  "rewind and regeneration check the current and historical runner roots",
  async () => {
    await using dir = await tmpdir()
    const old = join(dir.path, "project")
    const other = join(dir.path, "project-next")
    const workdir = join(old, "server")
    await mkdir(workdir, { recursive: true })
    await mkdir(other)
    const file = join(old, "notes")
    await writeFile(file, "original")
    const signal = new AbortController().signal
    const stores = new Checkpoints(join(dir.path, "history"), other)
    const original = stores.forRoot(old)
    const capture = await original.capture("source", "write", signal)
    await writeFile(file, "edited")
    const processes = processesExtension(dir.path)
    const manager = new ExtensionManager(
      new Configuration(join(dir.path, "config.json")),
      [processes],
      other,
      signal,
      async () => {},
    )
    const local = { runner_executor_public_id: "local", run_public_id: "source", task_key: "write" }
    const saved = { hash: capture.hash, store: capture.store }
    const effects: { status: string; runners: JsonObject[] } = {
      status: "touched",
      runners: [{ ...local, checkpoint: saved }],
    }
    const info = conversationFixture({ default_runner: { executor_public_id: "local", presence: "connected" } })
    const writes: string[] = []
    const calls: { name: string; runner: string; input: JsonObject; key: string }[] = []
    const rule = { tool: "checkpoint_restore", verdict: "ask" }
    const fixture = storeFixture(async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "POST") writes.push(path)
      if (path.endsWith("/profile"))
        return Response.json({
          member: { public_id: "main", kind: "agent", handle: "main", role: "member" },
          credential: { plane: "member" },
          measured_at: "now",
          configuration: {
            tool_definitions: [],
            kernel_tools: [],
            runner_executor_public_ids: ["local"],
            mcp_tools: [],
            fallback_models: [],
            approval_rules: [rule],
          },
        })
      if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: info })
      if (path.endsWith("/regeneration_receipt"))
        return Response.json({ error: { code: "not_found" } }, { status: 404 })
      if (path.endsWith("/regeneration"))
        return Response.json({ error: { code: "conversation_busy" } }, { status: 409 })
      if (path.endsWith("/turns"))
        return Response.json({ turns: [turnFixture(0)], pagination: { before_position: 0, after_position: 0 } })
      if (path.endsWith("/variants"))
        return Response.json({
          turn: { public_id: "turn-0" },
          variants: [
            { public_id: "variant", source: "run", active: true, status: "completed", runner_effects: effects },
          ],
        })
      if (path.endsWith("/forks"))
        return Response.json(
          { conversation: conversationFixture({ public_id: "child" }), runner_effects: effects },
          { status: 201 },
        )
      if (path.endsWith("/runs")) {
        const body = (await request.json()) as {
          run: {
            approval_rules: JsonObject[]
            steps: { tool: { name: string; input: JsonObject; route: { runner_executor_public_id: string } } }[]
          }
        }
        const tool = body.run.steps[0].tool
        const key = request.headers.get("idempotency-key")
        if (!key || Buffer.byteLength(key) > 36)
          return Response.json({ error: { code: "parameter_invalid" } }, { status: 400 })
        expect(body.run.approval_rules).toEqual([{ ...rule, origin: "author" }])
        calls.push({ name: tool.name, runner: tool.route.runner_executor_public_id, input: tool.input, key })
        return Response.json(
          {
            run: { public_id: "restore", status: "pending" },
            receipt: { accepted_task_keys: ["call_tool"], steps: [], resolution_tokens: {} },
          },
          { status: 201 },
        )
      }
      if (path.endsWith("/start")) return Response.json({ error: { code: "not_startable" } }, { status: 409 })
      if (path.endsWith("/tasks/call_tool")) {
        const tool = calls.at(-1)!
        const result =
          tool.name === "checkpoints"
            ? await stores.query(tool.input, signal)
            : tool.runner === "local"
              ? await (await stores.forStore(String(tool.input.store)))!.restore(
                  String(tool.input.checkpoint),
                  "restore",
                  "call_tool",
                  signal,
                )
              : { metadata: { checkpoint: { hash: "remote-undo" } } }
        return Response.json({
          task: {
            key: "call_tool",
            kind: "tool_task",
            status: "completed",
            lifetime: "conversation",
            wake: "auto",
            visibility: "visible",
            result: { is_error: false },
            ...result,
          },
        })
      }
    })
    const app = new NexusApplication(
      fixture.client,
      { workspace: "workspace", agent: "main", runner: "local" },
      () => ({}),
    )
    app.environments.configure({ root: () => old, liveProcess: processes.liveIn, checkpoints: () => stores })
    const rewind = { action: "rewind", conversation: "conversation", turn: "turn-0", key: "rewind", restore: true }
    const regenerate = { ...rewind, action: "regenerate", key: "regenerate" }
    try {
      await manager.start()
      await manager
        .tools()
        .find((tool) => tool.definition.name === "start_process")!
        .execute(
          { command: "printf 'ready\\n'; read line", wait_for: "ready" },
          {
            workspace: "workspace",
            conversation: "conversation",
            run: "run",
            task: "start",
            directory: workdir,
            signal,
          },
        )
      await expect(app.operations.command(rewind)).rejects.toThrow("process_live")
      await expect(app.operations.command(regenerate)).rejects.toThrow("process_live")
      expect(writes).toEqual([])

      await app.environments.bind("workspace", "conversation", { root: other })
      expect(await app.operations.command({ ...rewind, restore: false })).toMatchObject({
        restoration: { status: "kept" },
      })
      expect(await app.operations.command(rewind)).toMatchObject({
        conversation: { public_id: "child" },
        restoration: { status: "failed", runners: [{ reason: "process_live" }] },
      })
      await expect(app.operations.command(regenerate)).rejects.toThrow("process_live")
      expect(calls).toEqual([])
      effects.runners = [local]
      expect(await app.operations.command(rewind)).toMatchObject({
        restoration: { status: "failed", runners: [{ reason: "process_live" }] },
      })
      expect(calls).toMatchObject([{ name: "checkpoints", runner: "local", input: { run_public_id: "source" } }])
      await app.operations.command(rewind)
      expect(calls[1].key).toBe(calls[0].key)
      effects.runners = [
        { ...local, checkpoint: saved },
        { ...local, runner_executor_public_id: "remote", checkpoint: saved },
      ]
      const output: string[] = []
      const errors: string[] = []
      const terminal: DevelopmentTerminal = {
        command: async (input) => Schema.decodeUnknownSync(Schema.MutableJson)(await app.operations.command(input)),
        write: (line) => {
          output.push(line.toString())
        },
        error: (line) => {
          errors.push(line)
        },
        signal,
      }
      expect(await runDevelopment(["rewind", "conversation", "turn-0"], terminal)).toBe(1)
      expect(output.join("")).toContain("conversation: child\nforked_from: turn-0\nrestoration: partial")
      expect(output.join("")).toContain("runner: local failed process_live")
      expect(output.join("")).toContain("runner: remote restored " + capture.hash + " (undo remote-undo)")
      expect(writes.filter((path) => path.endsWith("/regeneration"))).toEqual([])
      expect(writes.filter((path) => path.endsWith("/forks"))).toHaveLength(5)
      expect(await Bun.file(file).text()).toBe("edited")

      await manager.close()
      effects.runners = [{ ...local, checkpoint: saved }]
      expect(await app.operations.command(rewind)).toMatchObject({
        restoration: { status: "restored", runners: [{ checkpoint: capture.hash, undo: expect.any(String) }] },
      })
      expect(calls.map((call) => [call.name, call.runner])).toEqual([
        ["checkpoints", "local"],
        ["checkpoints", "local"],
        ["checkpoint_restore", "remote"],
        ["checkpoint_restore", "local"],
      ])
      expect(new Set(calls.map((call) => call.key)).size).toBe(3)
      expect(await Bun.file(file).text()).toBe("original")

      output.length = 0
      expect(await runDevelopment(["regenerate", "conversation", "turn-0"], terminal)).toBe(1)
      expect(output.join("")).toContain("restoration: restored\nrunner: local restored " + capture.hash + " (undo ")
      expect(errors).toContain("Regeneration refused: conversation_busy\n")
      expect(writes.at(-1)).toEndWith("/regeneration")
    } finally {
      await manager.close()
      fixture.server.stop(true)
    }
  },
)
