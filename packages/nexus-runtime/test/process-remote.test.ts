import { expect, test } from "bun:test"
import { join } from "node:path"
import { Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Processes } from "../src/processes"
import { ProcessTables } from "../src/process-remote"
import { NexusApplication } from "../src/application"
import { storeFixture } from "./fixture/store"
import { conversationFixture } from "./fixture/conversation"

test("operator process reads relay once per tracked runner, preserve placement, and report unreachable tables", async () => {
  await using dir = await tmpdir()
  const requests: string[] = []
  const calls: Array<{ tool: string; input: Schema.Json; runner: string }> = []
  const created = new Map<string, string>()
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    requests.push(request.method + " " + path)
    if (path.includes("/conversations/"))
      return Response.json({
        conversation: conversationFixture({
          default_runner: { executor_public_id: path.endsWith("/other") ? "offline" : "remote", presence: "connected" },
        }),
      })
    if (path.endsWith("/executors/offline")) return Response.json({ error: { code: "not_found" } }, { status: 404 })
    if (path.endsWith("/executors/remote"))
      return Response.json({
        executor: {
          public_id: "remote",
          kind: "runner",
          status: "active",
          service_roles: ["runner"],
          presence: "connected",
          services: {
            runner: {
              tools: [],
              documents: [],
              environment: { root: "/remote/project", directories: ["/remote/project"] },
            },
          },
        },
      })
    if (path.endsWith("/runs") && request.method === "POST") {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          run: Schema.Struct({
            steps: Schema.Array(
              Schema.Struct({
                tool: Schema.Struct({
                  name: Schema.String,
                  input: Schema.MutableJson,
                  executor_context: Schema.MutableJson,
                  route: Schema.Struct({ runner_executor_public_id: Schema.String }),
                }),
              }),
            ),
          }),
        }),
      )(await request.json())
      const step = body.run.steps[0]!.tool
      expect(step.executor_context).toEqual({
        "opencode.environment": { root: "/remote/project", directories: ["/remote/project"] },
      })
      calls.push({ tool: step.name, input: step.input, runner: step.route.runner_executor_public_id })
      const id = "run-" + calls.length
      created.set(id, step.name)
      return Response.json(
        {
          run: { public_id: id, status: "created" },
          receipt: { accepted_task_keys: ["call_tool"], deliverable_task_key: "call_tool" },
        },
        { status: 201 },
      )
    }
    if (path.endsWith("/start")) return Response.json({ run: { public_id: path.split("/").at(-2), status: "running" } })
    if (path.endsWith("/tasks/call_tool")) {
      const tool = created.get(path.split("/").at(-3)!)
      return Response.json({
        task: {
          key: "call_tool",
          kind: "tool_task",
          status: "completed",
          lifetime: "conversation",
          wake: "auto",
          after: [],
          waiting_on: [],
          result: { is_error: false },
          structured_content:
            tool === "list_processes"
              ? { processes: [{ id: "p1", status: "running" }] }
              : { process: { id: "p1", status: "running" }, path: "/remote/p1.log", lines: ["ready"] },
        },
      })
    }
    return Response.json({ error: { code: "unexpected_request" } }, { status: 400 })
  })
  const table = new Processes(join(dir.path, "processes"))
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "local" },
    () => ({}),
  )
  application.lifecycle.adopt("workspace", "one")
  application.lifecycle.adopt("workspace", "two")
  application.lifecycle.adopt("workspace", "other")
  const remote = new ProcessTables(table, application, new AbortController().signal)
  try {
    await table.start()
    const listing = await remote.list()
    expect(listing.processes).toEqual([{ id: "p1", status: "running", runner: "remote" }])
    expect(listing.unreachable).toEqual([{ runner: "offline", error: expect.any(String) }])
    expect(calls).toEqual([{ tool: "list_processes", input: {}, runner: "remote" }])
    expect(await remote.log("p1", 40, "remote")).toEqual({
      process: { id: "p1", status: "running", runner: "remote" },
      path: "/remote/p1.log",
      lines: ["ready"],
    })
    expect(calls.at(-1)).toEqual({ tool: "process_log", input: { id: "p1", lines: 40 }, runner: "remote" })
    await expect(remote.log("p1", 40)).rejects.toThrow("name a runner")
    expect(requests.filter((value) => value.endsWith("/stop"))).toEqual([])
  } finally {
    await table.close()
    fixture.server.stop(true)
  }
})
