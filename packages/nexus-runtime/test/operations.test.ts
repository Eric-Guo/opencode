import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonObject } from "@cybros/agent"
import { NexusApplication } from "../src/application"
import { Configuration } from "../src/configuration"
import { ExtensionManager } from "../src/extension-manager"
import { register } from "../dev/extension"
import descriptor from "../dev/extension.json"
import { storeFixture } from "./fixture/store"
import { conversationFixture, inputFixture, turnFixture } from "./fixture/conversation"

test("idle target, result and regeneration use the latest turn in a multi-turn conversation", async () => {
  const active = { public_id: "original", source: "original", status: "completed", content: "Latest", active: true }
  const queries: (string | null)[] = []
  const envelopes: unknown[] = []
  const fixture = storeFixture(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture() })
    if (url.pathname.endsWith("/turns")) {
      const before = url.searchParams.get("before_position")
      queries.push(before)
      const position = before ? 1 : 0
      return Response.json({
        turns: [turnFixture(position, { kind: "direct_reply", active_variant: active })],
        pagination: { before_position: position, after_position: position },
      })
    }
    if (url.pathname.endsWith("/turns/turn-1/variants"))
      return Response.json({ turn: { public_id: "turn-1", inherited: false }, variants: [active] })
    if (url.pathname.endsWith("/events"))
      return Response.json({ events: [], pagination: { next_after: null, watermark: 0 } })
    if (url.pathname.endsWith("/regeneration_receipt"))
      return Response.json({ error: { code: "not_found" } }, { status: 404 })
    if (url.pathname.endsWith("/turns/turn-1/regeneration")) {
      envelopes.push(await request.json())
      return Response.json(
        { turn: { public_id: "turn-1", status: "pending" }, variant: { ...active, public_id: "regenerated" } },
        { status: 202 },
      )
    }
  })
  const app = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  try {
    expect(
      await app.operations.command({ action: "target", host: "conversation", host_type: "conversation" }),
    ).toMatchObject({ turn: "turn-1", variant: "original" })
    expect(await app.operations.command({ action: "result", conversation: "conversation" })).toMatchObject({
      execution: { turn_public_id: "turn-1", variant_public_id: "original" },
      content: "Latest",
    })
    await expect(
      app.operations.command({ action: "regenerate", conversation: "conversation", turn: "turn-0", key: "old" }),
    ).rejects.toThrow("tail turn")
    const intent = { source: "explicit", model: "anthropic/sonnet", constraint: "route", alternatives: [] }
    expect(
      await app.operations.command({
        action: "regenerate",
        conversation: "conversation",
        turn: "turn-1",
        key: "new",
        model: intent.model,
        model_selection: intent,
        fallback_models: [],
      }),
    ).toMatchObject({ turn_public_id: "turn-1", variant: { public_id: "regenerated" } })
    expect(envelopes).toEqual([
      { regeneration: { model: { model: intent.model }, model_selection: intent, fallback_models: [] } },
    ])
    expect(queries).toEqual(Array(4).fill("2147483647"))
  } finally {
    fixture.server.stop(true)
  }
})

test("terminal runs capture placement, ask for approval and return before the shell exits", async () => {
  const requests: { path: string; method: string; body?: unknown; key: string | null }[] = []
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname

    requests.push({
      path,
      method: request.method,
      body: request.body ? await request.json() : undefined,
      key: request.headers.get("idempotency-key"),
    })

    if (path.endsWith("/profile"))
      return Response.json({
        member: { public_id: "main", kind: "agent", handle: "main", role: "member" },
        credential: { plane: "member" },
        measured_at: "now",
        configuration: {
          tool_definitions: [],
          kernel_tools: [],
          runner_executor_public_ids: ["runner"],
          mcp_tools: [],
          fallback_models: [],
          approval_rules: [],
        },
      })
    if (path.endsWith("/executors"))
      return Response.json({
        executors: [
          {
            public_id: "runner",
            kind: "agent",
            status: "active",
            service_roles: ["runner"],
            presence: "connected",
            services: {
              runner: {
                environment: { root: "/project" },
                tools: [{ name: "terminal", effect_profile: {} }],
                documents: [],
              },
            },
          },
        ],
      })
    if (path.endsWith("/runs") && request.method === "GET") {
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        kind: "standalone",
        order: "desc",
        after: "cursor",
        limit: "20",
      })
      return Response.json({
        runs: ["not-terminal", "missing", "terminal-run", "ended"].map((public_id) => ({
          public_id,
          status: "running",
          created_at: "created",
        })),
        pagination: { next_after: "older" },
      })
    }
    if (path.endsWith("/runs/missing")) return Response.json({ error: { code: "not_found" } }, { status: 404 })
    if (path.endsWith("/runs/ended"))
      return Response.json({
        run: {
          public_id: "ended",
          status: "completed",
          tasks: [
            {
              key: "call_tool",
              tool_name: "terminal",
              kind: "tool_task",
              status: "completed",
              lifetime: "run",
              wake: "none",
            },
          ],
        },
      })
    if (path.endsWith("/runs"))
      return Response.json(
        {
          run: { public_id: "terminal-run", status: "pending" },
          receipt: { accepted_task_keys: ["terminal"], steps: [], resolution_tokens: {} },
        },
        { status: 201 },
      )
    if (path.endsWith("/runs/terminal-run/start"))
      return Response.json({ error: { code: "not_startable" } }, { status: 409 })
    if (path.endsWith("/runs/terminal-run") || path.endsWith("/runs/not-terminal"))
      return Response.json({
        run: {
          public_id: path.endsWith("/not-terminal") ? "not-terminal" : "terminal-run",
          status: "running",
          tasks: [
            {
              key: "terminal",
              kind: "tool_task",
              status: "dispatched",
              tool_name: path.endsWith("/not-terminal") ? "bash" : "terminal",
              lifetime: "conversation",
              wake: "auto",
              visibility: "collapsed",
            },
          ],
        },
      })
    if (path.endsWith("/tasks/terminal/realtime"))
      return Response.json({
        realtime: {
          status: request.method === "PUT" ? "active" : "waiting",
          reason: null,
          connection_id: "connection",
          offer_sdp: "offer",
          answer_sdp: request.method === "PUT" ? "answer" : null,
          max_age_ms: request.method === "PUT" ? 1000 : 0,
        },
      })

    return Response.json({ error: { code: "unexpected_request" } }, { status: 400 })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "default", agent: "main", runner: "runner" },
    () => ({}),
  )

  try {
    expect(
      await application.operations.command({
        action: "terminal.open",
        workspace: "selected",
        runner: "runner",
        key: "one",
      }),
    ).toEqual({ run: "terminal-run", task: "terminal" })
    expect(requests.find((row) => row.path.endsWith("/runs"))).toEqual({
      path: "/agent_api/v1/workspaces/selected/runs",
      method: "POST",
      key: "one",
      body: {
        run: {
          steps: [
            {
              tool: {
                name: "terminal",
                key: "terminal",
                input: {},
                route: { kind: "runner", runner_executor_public_id: "runner" },
                executor_context: { "opencode.environment": { root: "/project", directories: [], anchor: null } },
              },
            },
          ],
          approval_mode: "ask",
          prompt_mechanism: "raw",
          default_runner_executor_public_id: "runner",
          approval_rules: [],
        },
      },
    })
    expect(requests.at(-1)?.path).toBe("/agent_api/v1/workspaces/selected/runs/terminal-run/start")
    expect(
      await application.operations.command({ action: "terminal.list", workspace: "selected", after: "cursor" }),
    ).toEqual({
      items: [
        { run: "terminal-run", task: "terminal", status: "dispatched", created: "created" },
        { run: "ended", task: "call_tool", status: "completed", created: "created" },
      ],
      next: "older",
    })
    const target = { workspace: "selected", run: "terminal-run", task: "terminal" }

    expect(await application.operations.command({ action: "terminal.realtime", ...target })).toMatchObject({
      status: "waiting",
      offer_sdp: "offer",
    })
    expect(
      await application.operations.command({
        action: "terminal.answer",
        ...target,
        connection_id: "connection",
        sdp: "answer",
      }),
    ).toMatchObject({ status: "active", answer_sdp: "answer" })
    expect(requests.at(-1)).toMatchObject({
      path: "/agent_api/v1/workspaces/selected/runs/terminal-run/tasks/terminal/realtime",
      method: "PUT",
      body: { connection_id: "connection", sdp: "answer" },
    })
    await expect(
      application.operations.command({ action: "terminal.realtime", ...target, run: "not-terminal" }),
    ).rejects.toThrow("Unknown terminal task")
  } finally {
    fixture.server.stop(true)
  }
})

test("development controls use the connected application, exact run identities and the agent ownership boundary", async () => {
  const requests: { path: string; method: string; body?: unknown }[] = []
  const baseTask = {
    kind: "model_task",
    lifetime: "run",
    wake: "foreground",
    after: [],
    waiting_on: [],
    approval: null,
  }
  const settled: JsonObject[] = [
    { key: "absorbed", status: "failed", on_failure: "absorb" },
    { key: "resolved", status: "timed_out", failure_resolution: "abandoned" },
  ]
  const costHold = {
    key: "budget",
    status: "failed",
    kind: "model_task",
    on_failure: "absorb",
    error: { key: "conversation_cost_limit_reached" },
  }
  let tasks: JsonObject[] = settled
  const directory = await mkdtemp(join(tmpdir(), "nexus-dev-"))
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname
    requests.push({ path, method: request.method, body: request.body ? await request.json() : undefined })

    if (path.endsWith("/conversations/conversation"))
      return Response.json({ conversation: conversationFixture({ active_turn_public_id: "new-turn" }) })
    if (path.endsWith("/conversations/foreign"))
      return Response.json({ conversation: conversationFixture({ answering_user_public_id: "other" }) })
    if (path.endsWith("/runs/old") || path.endsWith("/runs/foreign") || path.endsWith("/runs/old/stop"))
      return Response.json({
        run: {
          public_id: path.includes("/foreign") ? "foreign" : "old",
          status: request.method === "GET" ? "running" : "stopped",
          turn: { status: "running", conversation_public_id: path.includes("/foreign") ? "foreign" : "conversation" },
          tasks: tasks.map((task) => ({ ...baseTask, ...task })),
        },
      })
    if (/\/tasks\/(budget|named)\/(retry|abandon)$/.test(path))
      return Response.json({ task: { ...baseTask, key: path.split("/").at(-2), status: "waiting" } })
    if (path.endsWith("/inputs/queued") && request.method === "PATCH")
      return Response.json({ input: inputFixture({ public_id: "queued", text: "corrected", lock_version: 3 }) })
    return Response.json({ error: { code: "unexpected_request" } }, { status: 400 })
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "runner" },
    () => ({}),
  )
  const manager = new ExtensionManager(
    new Configuration(join(directory, "config.json")),
    [{ descriptor, register }],
    directory,
    new AbortController().signal,
    async () => {},
    () => application,
  )

  try {
    await expect(manager.command("dev", { action: "run.stop", run: "old" })).rejects.toThrow("not loaded")
    await manager.start()
    expect(manager.list()[0]).toMatchObject({ active: true, ready: true, tools: [] })
    expect(await manager.command("dev", { action: "run.stop", run: "old", force: true })).toMatchObject({
      public_id: "old",
      status: "stopped",
    })
    expect(requests.filter((request) => request.method !== "GET")).toEqual([
      { path: "/agent_api/v1/workspaces/workspace/runs/old/stop", method: "POST", body: { force: true } },
    ])

    await expect(manager.command("dev", { action: "run.stop", run: "foreign" })).rejects.toThrow("another agent")
    await expect(manager.command("dev", { action: "stop", conversation: "foreign" })).rejects.toThrow("another agent")
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1)

    await expect(manager.command("dev", { action: "retry", run: "old" })).rejects.toThrow("No task")
    tasks = [...settled, costHold]
    await manager.command("dev", { action: "retry", run: "old" })
    expect(requests.at(-1)?.path).toEndWith("/tasks/budget/retry")
    tasks = [...tasks, { key: "uncertain", status: "uncertain" }]
    await expect(manager.command("dev", { action: "abandon", run: "old" })).rejects.toThrow("budget, uncertain")
    await manager.command("dev", { action: "abandon", run: "old", task: "named" })
    expect(requests.at(-1)?.path).toEndWith("/tasks/named/abandon")

    await manager.command("dev", {
      action: "input.edit",
      conversation: "conversation",
      input: "queued",
      version: 2,
      text: "corrected",
      delivery: "queue",
    })
    expect(requests.at(-1)?.body).toEqual({
      input: { expected_lock_version: 2, text: "corrected", delivery_mode: "queue" },
    })
    await expect(
      manager.command("dev", { action: "regenerate", conversation: "conversation", turn: "turn" }),
    ).rejects.toThrow()
  } finally {
    await manager.close()
    fixture.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("shared submissions capture the current surface policy and retain it on retry", async () => {
  const submitted: JsonObject[] = []
  const policy = { calls: 0 }
  const fixture = storeFixture(async (request) => {
    const path = new URL(request.url).pathname

    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: conversationFixture() })
    if (path.endsWith("/inputs") && request.method === "POST") {
      const body = (await request.json()) as { input: JsonObject }
      submitted.push(body.input)
      return Response.json({ input: inputFixture(body.input) }, { status: 202 })
    }
  })
  const application = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "local" },
    () => ({}),
    undefined,
    async () => {
      policy.calls++
      return {
        model: "model",
        fallback_models: [],
        agent_configuration: {},
        tools: ["read"],
        executor_contexts: { remote: { "opencode.directory": "/remote/project" } },
      }
    },
  )

  try {
    const command = { action: "say", conversation: "conversation", key: "one-input", text: "Read the project" }

    await application.operations.command(command)
    await application.operations.command(command)
    expect(policy.calls).toBe(1)
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toEqual(submitted[0])
    expect(submitted[0]).toMatchObject({
      tool_names: ["read"],
      executor_contexts: { remote: { "opencode.directory": "/remote/project" } },
    })
  } finally {
    fixture.server.stop(true)
  }
})

test("rewind refuses a Bot and fresh history mutations refuse an active turn before any fork or restore", async () => {
  const info = conversationFixture({ metadata: { "opencode.bot": "bot" } })
  const writes: string[] = []
  const fixture = storeFixture((request) => {
    const path = new URL(request.url).pathname
    if (request.method !== "GET") writes.push(path)
    if (path.endsWith("/conversations/conversation")) return Response.json({ conversation: info })
    if (path.endsWith("/regeneration_receipt")) return Response.json({ error: { code: "not_found" } }, { status: 404 })
    return Response.json({ error: { code: "unexpected_request" } }, { status: 400 })
  })
  const app = new NexusApplication(
    fixture.client,
    { workspace: "workspace", agent: "main", runner: "local" },
    () => ({}),
  )
  const rewind = { action: "rewind", conversation: "conversation", turn: "turn", key: "rewind", restore: false }
  try {
    await expect(app.operations.command(rewind)).rejects.toThrow("bot_conversation_required")
    info.metadata = {}
    info.active_turn_public_id = "running"
    await expect(app.operations.command(rewind)).rejects.toThrow("conversation_busy")
    await expect(app.operations.command({ ...rewind, action: "regenerate" })).rejects.toThrow("conversation_busy")
    expect(writes).toEqual([])
  } finally {
    fixture.server.stop(true)
  }
})
